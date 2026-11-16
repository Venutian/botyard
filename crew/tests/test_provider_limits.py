#!/usr/bin/env python3
"""STANDARDS.md rule 22, part 1: a provider-wide cap sets the whole provider aside until the provider's own
reset, and the run hands over to a model of another provider in the same run and session (16 November 2026:
a research bot met OpenRouter's "free-models-per-day-high-balance", which covers every :free model on the key)."""
import importlib.util
import json
import os
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.realpath(__file__))


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, '..', file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


fred = load('free_runner_p', 'free-runner.py')
limits = load('free_limits_p', 'free-limits.py')
CAP = 'Rate limit exceeded: free-models-per-day-high-balance.'
ROWS = [('openrouter/a:free', 'a', 'strong'), ('openrouter/b:free', 'b', 'strong'),
        ('nvidia/n1', 'n', 'strong'), ('opencode/o1-free', 'o', 'strong')]


class World:
    """A fake crew of bots and fallback that remembers what is set aside, like the real ones."""
    def __init__(self, rows, opencode='opencode'):
        self.rows, self.aside, self.OPENCODE = rows, {}, opencode
        self.FREE_LISTED = 'listed'

    def free_list(self): return self.rows
    def free_aside(self): return {m: {'until': u} for m, (u, _) in self.aside.items()}
    def free_family(self, model): return next((f for m, f, _ in self.rows if m == model), 'x')
    def read_json(self, *a): return {'at': 9e12}
    def setup(self): return self
    def outage(self, *a): return False
    def limits(self): return limits
    def set_free_aside(self, bots, model, why, until=None): self.aside[model] = (until, why)


class Detecting(unittest.TestCase):
    def test_which_errors_are_provider_wide(self):
        for text in (CAP, 'daily limit reached', 'You exceeded your daily quota',
                     'Antigravity quota reached on every model', 'quota exhausted for your account'):
            self.assertTrue(fred.provider_wide(text), text)
        for text in ('quota for this model', 'Too Many Requests: {"status":429}', 'model not found', '', None):
            self.assertFalse(fred.provider_wide(text), text)

    def test_the_provider_reset_comes_from_free_limits_else_the_next_utc_day(self):
        now = time.mktime(time.strptime('2026-11-16 09:35', '%Y-%m-%d %H:%M')) - time.timezone
        self.assertEqual(limits.reset_at('openrouter/a:free', now), int(now // 86400 + 1) * 86400 + 300)
        self.assertIsNone(limits.reset_at('nvidia/n1', now))
        world = World(ROWS)
        self.assertEqual(fred.provider_reset(world, 'nvidia/n1', now), fred.next_utc_day(now))

    def test_a_daily_cap_sets_the_whole_provider_aside_to_its_reset_and_no_other(self):
        world = World(ROWS)
        fred.set_aside(world, world, 'openrouter/a:free', CAP)
        self.assertEqual(set(world.aside), {'openrouter/a:free', 'openrouter/b:free'})
        self.assertEqual({u for u, _ in world.aside.values()}, {limits.reset_at('openrouter/a:free')})

    def test_a_quota_for_every_model_is_provider_wide_too(self):
        world = World(ROWS)
        fred.set_aside(world, world, 'opencode/o1-free', 'quota reached on every model')
        self.assertEqual(set(world.aside), {'opencode/o1-free'})
        world = World([('nvidia/n1', 'n', 'strong'), ('nvidia/n2', 'm', 'strong'), ('opencode/o', 'o', 'strong')])
        fred.set_aside(world, world, 'nvidia/n1', 'quota reached on every model')
        self.assertEqual(set(world.aside), {'nvidia/n1', 'nvidia/n2'})


class Handover(unittest.TestCase):
    def setUp(self):
        self.saved = fred.probe, fred.claim

    def tearDown(self):
        fred.probe, fred.claim = self.saved

    def test_the_ask_before_a_switch_learns_the_cap_and_lands_on_another_provider(self):
        world = World(ROWS)

        def probe(oc, model):
            if model.startswith('openrouter/'):
                fred.SAID[model] = CAP
                return 'out'
            return 'ok'
        fred.probe = probe
        fred.claim = lambda m: set()
        got, _ = fred.next_working(world, world)
        self.assertTrue(got.startswith(('nvidia/', 'opencode/')), got)
        self.assertEqual({m for m in world.aside}, {'openrouter/a:free', 'openrouter/b:free'})


class Run(unittest.TestCase):
    def run_main(self, rows, errors):
        with tempfile.TemporaryDirectory() as d:
            fake, counter = os.path.join(d, 'opencode'), os.path.join(d, 'count')
            with open(fake, 'w') as f:
                f.write(f'''#!{sys.executable}
import json, os, sys
n = int(open({counter!r}).read() or 0) if os.path.exists({counter!r}) else 0
open({counter!r}, "w").write(str(n + 1))
open({counter!r} + ".args", "a").write(json.dumps(sys.argv[1:]) + "\\n")
errors = {errors!r}
print(json.dumps({{"type": "step_start", "sessionID": "ses_1", "part": {{"snapshot": "s"}}}}))
if n < len(errors):
    print(json.dumps({{"type": "error", "error": {{"data": {{"message": errors[n]}}}}}}))
    sys.exit(1)
print(json.dumps({{"type": "text", "sessionID": "ses_1", "part": {{"text": "done"}}}}))
''')
            os.chmod(fake, 0o755)
            world = World(rows, fake)
            saved = (fred.load, fred.pause, fred.probe, fred.BUSY, fred.note, sys.argv, sys.stdin)
            fred.load = lambda *a: world
            fred.pause = lambda s: None
            fred.probe = lambda *a: 'ok'
            fred.BUSY = os.path.join(d, 'busy.json')
            fred.note = lambda line: None
            sys.argv = ['free-runner.py', 'run', '-m', rows[0][0]]
            sys.stdin = open(os.devnull)
            try:
                with open(os.devnull, 'w') as sink:
                    out, sys.stdout = sys.stdout, sink
                    try:
                        code = fred.main()
                    finally:
                        sys.stdout = out
            finally:
                fred.load, fred.pause, fred.probe, fred.BUSY, fred.note, sys.argv, sys.stdin = saved
            with open(counter + '.args') as f:
                calls = [json.loads(line) for line in f]
            return code, calls, world

    def test_a_fake_daily_cap_on_openrouter_sets_all_of_it_aside_and_the_same_run_goes_on_on_nvidia(self):
        code, calls, world = self.run_main(ROWS, [CAP])
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 2)
        self.assertEqual(set(world.aside), {'openrouter/a:free', 'openrouter/b:free'})
        second = calls[1]
        self.assertTrue(second[(second.index('-m') if '-m' in second else second.index('--model')) + 1].startswith(('nvidia/', 'opencode/')), second)
        self.assertEqual(second[second.index('--session') + 1], 'ses_1')

    def test_with_no_other_provider_the_bot_rests_and_does_not_fail(self):
        rows = [r for r in ROWS if r[0].startswith('openrouter/')]
        import io
        err, sys.stderr = sys.stderr, io.StringIO()
        try:
            code, calls, world = self.run_main(rows, [CAP, CAP])
            said = sys.stderr.getvalue()
        finally:
            sys.stderr = err
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 1)
        self.assertIn('resting', said)


if __name__ == '__main__':
    unittest.main()
