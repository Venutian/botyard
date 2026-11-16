#!/usr/bin/env python3
"""STANDARDS.md rule 22, part 3: a run whose limit is over 45 minutes is told at 80% of it to write its state, once,
in the same session; shorter runs are never interrupted and normal runs are not slowed."""
import importlib.util
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
import crew_set  # noqa: E402


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, '..', file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


fred = load('free_runner_n', 'free-runner.py')


class Due(unittest.TestCase):
    def test_the_point_is_80_percent_of_the_limit_and_only_over_45_minutes(self):
        at = 76 * 60 * 0.8
        self.assertFalse(fred.notice_due(0, 76, at - 1, False, True))
        self.assertTrue(fred.notice_due(0, 76, at, False, True))
        self.assertFalse(fred.notice_due(0, 76, at, False, False), 'it waits for the end of a step')
        self.assertTrue(fred.notice_due(0, 76, at + fred.NOTICE_WAIT, False, False), 'but not for ever')
        self.assertFalse(fred.notice_due(0, 76, at + 999, True, True), 'once only')
        for minutes in (0, 30, 45):
            self.assertFalse(fred.notice_due(0, minutes, 10 ** 6, False, True), minutes)

    def test_the_limit_comes_from_the_bots_file_through_the_environment(self):
        self.assertEqual(fred.run_minutes({'BOTYARD_RUN_MINUTES': '76'}), 76)
        self.assertEqual(fred.run_minutes({'BOTYARD_RUN_MINUTES': 'x'}), 0)
        self.assertEqual(fred.run_minutes({}), 0)
        places = crew_set.Places(env={'HOME': '/h', 'PATH': ''}, home='/h', crew='/h/.botyard/crew', projects='/h/work', codex='/x')
        files = crew_set.CrewSet(places=places)
        for slug in ('researcher', 'builder', 'checker', 'lead'):
            spec = files.spec(slug)
            env = files.build(slug, None, lambda: 'x/m')['config']['env']
            self.assertEqual(env['BOTYARD_RUN_MINUTES'], {'type': 'plain', 'value': str(spec['minutes'])}, slug)


class FakeWorld:
    def __init__(self, opencode):
        self.OPENCODE, self.FREE_LISTED = opencode, 'listed'

    def free_list(self): return [('x/m', 'f', 'strong')]
    def free_aside(self): return {}
    def free_family(self, m): return 'f'
    def read_json(self, *a): return {'at': 9e12}
    def setup(self): return self
    def outage(self, *a): return False
    def limits(self): return type('L', (), {'answered': lambda s, m: None})()
    def set_free_aside(self, *a, **k): pass


class Run(unittest.TestCase):
    def run_main(self, minutes, times):
        """A fake OpenCode that works through steps; the fake clock says `times` at each look (the first is the start)."""
        with tempfile.TemporaryDirectory() as d:
            fake, counter = os.path.join(d, 'opencode'), os.path.join(d, 'count')
            with open(fake, 'w') as f:
                f.write(f'''#!{sys.executable}
import json, os, sys, time
n = int(open({counter!r}).read() or 0) if os.path.exists({counter!r}) else 0
open({counter!r}, "w").write(str(n + 1))
open({counter!r} + ".args", "a").write(json.dumps(sys.argv[1:]) + "\\n")
open({counter!r} + ".prompts", "a").write(json.dumps(sys.stdin.read()) + "\\n")
print(json.dumps({{"type": "step_start", "sessionID": "ses_1", "part": {{"snapshot": "s"}}}}), flush=True)
print(json.dumps({{"type": "step_finish", "sessionID": "ses_1", "part": {{}}}}), flush=True)
if n == 0:
    time.sleep(2)    # a long step: the notice ends it at once
print(json.dumps({{"type": "text", "sessionID": "ses_1", "part": {{"text": "done"}}}}), flush=True)
''')
            os.chmod(fake, 0o755)
            ticks = iter(times)
            last = [times[-1]]
            world = FakeWorld(fake)
            saved = (fred.load, fred.pause, fred.probe, fred.BUSY, fred.note, fred.clock, sys.argv, sys.stdin, dict(os.environ))
            fred.load = lambda *a: world
            fred.probe = lambda *a: 'ok'
            fred.BUSY = os.path.join(d, 'busy.json')
            fred.note = lambda line: None
            fred.clock = lambda: next(ticks, last[0])
            os.environ['BOTYARD_RUN_MINUTES'] = str(minutes)
            sys.argv = ['free-runner.py', 'run', '-m', 'x/m']
            sys.stdin = open(os.devnull)
            try:
                with open(os.devnull, 'w') as sink:
                    out, sys.stdout = sys.stdout, sink
                    try:
                        code = fred.main()
                    finally:
                        sys.stdout = out
            finally:
                fred.load, fred.pause, fred.probe, fred.BUSY, fred.note, fred.clock, sys.argv, sys.stdin, env = saved
                os.environ.clear()
                os.environ.update(env)
            calls = [json.loads(line) for line in open(counter + '.args')]
            prompts = [json.loads(line) for line in open(counter + '.prompts')]
            return code, calls, prompts

    def test_a_fake_long_run_gets_the_notice_at_80_percent_in_the_same_session(self):
        # started at 0; the next look is 80% of 76 minutes later
        code, calls, prompts = self.run_main(76, [0, 76 * 60 * 0.8 + 1])
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[1][calls[1].index('--session') + 1], 'ses_1')
        self.assertIn('Write your state now', prompts[1])
        self.assertIn('76 minutes', prompts[1])
        self.assertNotIn('Write your state now', prompts[0])

    def test_before_80_percent_and_on_a_short_run_nothing_is_said(self):
        for minutes, now in ((76, 76 * 60 * 0.8 - 5), (45, 10 ** 6), (30, 10 ** 6)):
            code, calls, prompts = self.run_main(minutes, [0, now])
            self.assertEqual((code, len(calls)), (0, 1), (minutes, now))


if __name__ == '__main__':
    unittest.main()
