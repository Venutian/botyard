#!/usr/bin/env python3
"""STANDARDS.md: a prompt that outgrew the free model's context window is not a failure of the work, but the
model cannot take it. The run goes on in the same session on a model that can, instead of failing the run."""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

CREW = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(CREW, file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


os.environ['BOTYARD_HEAVY'] = 'heavy-launcher'
guards = load('guards', 'guards.py')
fred = load('free_runner', 'free-runner.py')


class ContextOverflow(unittest.TestCase):
    def test_the_real_overflow_is_recognised_and_the_variants_are(self):
        for text in ('Requested token count exceeds the model\'s maximum context length of 262144',
                     'Prompt is too long: 263829 tokens exceed the context window of 262144',
                     'token count exceeds the context limit', 'context window exceeded'):
            self.assertTrue(fred.context_error(text), text)
        for text in ('model is unavailable', 'Too Many Requests: {"status":429}', 'socket hang up', None, ''):
            self.assertFalse(fred.context_error(text), text)

    def run_main(self, errors):
        """Runs free-runner's main() against a fake OpenCode that fails with `errors` first, then works."""
        with tempfile.TemporaryDirectory() as d:
            fake = os.path.join(d, 'opencode')
            counter = os.path.join(d, 'count')
            prompts = os.path.join(d, 'prompts')
            with open(fake, 'w') as f:
                f.write(f'''#!{sys.executable}
import json, sys
n = int(open({counter!r}).read() or 0) if __import__("os").path.exists({counter!r}) else 0
open({counter!r}, "w").write(str(n + 1))
open({counter!r} + ".args", "a").write(json.dumps(sys.argv[1:]) + "\\n")
data = sys.stdin.read()
open({prompts!r}, "a").write(json.dumps(data) + "\\n")
errors = {errors!r}
print(json.dumps({{"type": "step_start", "sessionID": "ses_1", "part": {{"snapshot": "s"}}}}))
if n < len(errors):
    print(json.dumps({{"type": "error", "error": {{"data": {{"message": errors[n]}}}}}}))
    sys.exit(1)
print(json.dumps({{"type": "text", "sessionID": "ses_1", "part": {{"text": "done"}}}}))
''')
            os.chmod(fake, 0o755)

            class Bots:
                OPENCODE = fake
                FREE_LISTED = 'listed'
                def free_list(self): return [('x/m', 'f', 'strong')]
                def free_aside(self): return {}
                def free_family(self, m): return 'f'
                def read_json(self, *a): return {'at': 9e12}

            class Fallback:
                def setup(self): return Bots()
                def outage(self, *a): return False
                def limits(self):
                    class L:
                        def answered(self, m): pass
                    return L()
                def set_free_aside(self, *a, **k): self.aside = a

            fb = Fallback()
            waits = []
            saved = (fred.load, fred.pause, fred.probe, fred.BUSY, fred.note, sys.argv, sys.stdin)
            fred.load = lambda *a: fb
            fred.pause = waits.append
            fred.probe = lambda *a: 'ok'
            fred.BUSY = os.path.join(d, 'busy.json')
            fred.note = lambda line: None
            sys.argv = ['free-runner.py', 'run', '-m', 'x/m']
            sys.stdin = open(os.devnull)
            saved_env = {k: os.environ.get(k) for k in ('BOTYARD_FREE_PACE', 'BOTYARD_FREE_TIER', 'BOTYARD_CHECKER')}
            for k in saved_env:
                os.environ.pop(k, None)
            try:
                with open(os.devnull, 'w') as sink:
                    out, sys.stdout = sys.stdout, sink
                    try:
                        code = fred.main()
                    finally:
                        sys.stdout = out
            finally:
                fred.load, fred.pause, fred.probe, fred.BUSY, fred.note, sys.argv, sys.stdin = saved
                for k, v in saved_env.items():
                    if v is None:
                        os.environ.pop(k, None)
                    else:
                        os.environ[k] = v
            with open(counter + '.args') as f:
                calls = [json.loads(line) for line in f]
            with open(prompts) as f:
                got = [json.loads(line) for line in f if line.strip()]
            return code, waits, calls, got

    def test_a_context_overflow_is_not_a_failure_but_a_switch_in_the_same_session(self):
        with tempfile.TemporaryDirectory() as d:
            code, waits, calls, got = self.run_main(
                ['Requested token count exceeds the model\'s maximum context length of 262144'])
        self.assertEqual(code, 0)
        self.assertEqual(waits, [])
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0], ['run', '-m', 'x/m'])
        self.assertIn('--session', calls[1])
        self.assertEqual(calls[1][calls[1].index('--session') + 1], 'ses_1')
        self.assertEqual(len(got), 2)
        self.assertEqual(got[1], fred.CONTINUE)


if __name__ == '__main__':
    unittest.main()
