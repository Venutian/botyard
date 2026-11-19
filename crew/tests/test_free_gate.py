"""Every free run asks the studio's pace gate before its first model call (19 Nov 2026: free allowances drained overnight)."""
import importlib.util
import os
import tempfile
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('free_runner_gate', os.path.join(HERE, '..', 'free-runner.py'))
fred = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fred)


class Gate(unittest.TestCase):
    def setUp(self):
        self.gate = os.path.join(tempfile.mkdtemp(), 'gate.py')
        open(self.gate, 'w').write('')
        fred.note = lambda line: None

    def test_no_gate_named_goes(self):
        self.assertEqual(fred.paced({}), '')

    def test_a_hold_waits_then_goes(self):
        answers = iter([3, 3, 0])
        calls = []
        def run(cmd, **kw):
            calls.append(cmd)
            return types.SimpleNamespace(returncode=next(answers), stdout='pacing')
        waits = []
        self.assertEqual(fred.paced({'BOTYARD_FREE_PACE': self.gate, 'BOTYARD_CHECKER': '1'}, run=run, sleep=waits.append, clock=lambda: 0), '')
        self.assertEqual(len(waits), 2)
        self.assertEqual(calls[0][-3:], ['--kind', 'check', '--grant'])

    def test_a_long_hold_ends_the_run_with_the_reason(self):
        t = [0]
        def sleep(s):
            t[0] += s
        run = lambda cmd, **kw: types.SimpleNamespace(returncode=3, stdout='pacing the free allowance')
        got = fred.paced({'BOTYARD_FREE_PACE': self.gate, 'BOTYARD_FREE_TIER': 'light'}, run=run, sleep=sleep, clock=lambda: t[0])
        self.assertIn('pacing', got)
        self.assertGreaterEqual(t[0], fred.PACE_MOST)


if __name__ == '__main__':
    unittest.main()
