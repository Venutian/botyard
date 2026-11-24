#!/usr/bin/env python3
"""Tests for free run context handover: track tokens, hand over at 200k, resume fresh, context_error fresh session."""
import importlib.util
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, '..', file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


fred = load('free_runner_fh', 'free-runner.py')


class FakeWorld:
    def __init__(self, opencode):
        self.OPENCODE, self.FREE_LISTED = opencode, 'listed'

    def free_list(self):
        return [('x/m', 'f', 'strong')]

    def free_aside(self):
        return {}

    def free_family(self, m):
        return 'f'

    def read_json(self, *a):
        return {'at': 9e12}

    def setup(self):
        return self

    def outage(self, *a):
        return False

    def limits(self):
        return type('L', (), {'answered': lambda s, m: None})()

    def set_free_aside(self, *a, **k):
        pass


def make_fake_opencode(counter, session, tokens_per_step, include_error=False):
    """Generate fake opencode script that produces multiple step_finish in first run, then completes."""
    tokens_list_repr = repr(tokens_per_step)
    
    script = f'''#!{sys.executable}
import json, os, sys, time
n = int(open({counter!r}).read() or 0) if os.path.exists({counter!r}) else 0
open({counter!r}, "w").write(str(n + 1))
open({counter!r} + ".args", "a").write(json.dumps(sys.argv[1:]) + "\\n")
open({counter!r} + ".prompts", "a").write(json.dumps(sys.stdin.read()) + "\\n")

tokens_per_step = {tokens_list_repr}
session = "ses_1"

print(json.dumps({{"type": "step_start", "sessionID": session, "part": {{"snapshot": "s"}}}}), flush=True)

if n == 0:
    # First run: produce all step_finish events
    for tok in tokens_per_step:
        step_finish = {{
            "type": "step_finish",
            "sessionID": session,
            "part": {{
                "tokens": {{
                    "input": tok[0],
                    "output": tok[1],
                    "reasoning": tok[2],
                    "cache_read": tok[3],
                    "cache_write": tok[4]
                }}
            }}
        }}
        print(json.dumps(step_finish), flush=True)
    {f"time.sleep(2)" if not include_error else ""}
'''
    if include_error:
        script += '''    # Simulate context error after step_finish events
    error_event = {
        "type": "error",
        "sessionID": session,
        "error": {"data": {"message": "context length exceeded: 210000 tokens"}}
    }
    print(json.dumps(error_event), flush=True)
    sys.exit(1)
'''

    script += f'''else:
    # Subsequent runs: just finish
    pass

text_event = {{"type": "text", "sessionID": session, "part": {{"text": "done"}}}}
print(json.dumps(text_event), flush=True)
'''
    return script


class ContextTracking(unittest.TestCase):
    """Step 1: track context size from step_finish events and hand over at 200k."""

    def run_fake(self, minutes, times, tokens_per_step, model='x/m', session='ses_1'):
        """Run fake OpenCode that emits step_finish with token counts."""
        with tempfile.TemporaryDirectory() as d:
            fake = os.path.join(d, 'opencode')
            counter = os.path.join(d, 'count')
            with open(fake, 'w') as f:
                f.write(make_fake_opencode(counter, session, tokens_per_step))
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
            os.environ['BOTYARD_FREE_PACE'] = ''
            sys.argv = ['free-runner.py', 'run', '-m', model]
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

    def test_below_limit_no_handover(self):
        """Below 200k tokens, the run completes without handover."""
        tokens = [(50000, 1000, 0, 0, 0)] * 3
        times = [0, 100, 200, 300]
        code, calls, prompts = self.run_fake(76, times, tokens)
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 1, 'no handover, single session')

    def test_handover_at_200k_triggers_once(self):
        """At 200k tokens, exactly one handover occurs with state comment."""
        tokens = [
            (80000, 1000, 0, 0, 0),
            (80000, 1000, 0, 0, 0),
            (80000, 1000, 0, 0, 0),
        ]
        times = [0, 100, 200, 300, 400]
        code, calls, prompts = self.run_fake(76, times, tokens)
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 2, 'exactly one handover to new session')
        # Second call should NOT have --session (fresh session)
        self.assertNotIn('--session', calls[1], 'fresh session has no --session')
        # Second prompt should contain state summary
        self.assertIn('done', prompts[1].lower())
        self.assertIn('left', prompts[1].lower())
        self.assertIn('files', prompts[1].lower())

    def test_handover_only_once_per_session(self):
        """Handover fires only once even if tokens keep growing."""
        tokens = [(80000, 1000, 0, 0, 0)] * 4
        times = [0, 100, 200, 300, 400, 500]
        code, calls, prompts = self.run_fake(76, times, tokens)
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 2, 'only one handover')


class FreshSessionResume(unittest.TestCase):
    """Step 2: after handover, resume with without_session (fresh session)."""

    def run_fake_with_handover(self, minutes, times, tokens_per_step):
        with tempfile.TemporaryDirectory() as d:
            fake = os.path.join(d, 'opencode')
            counter = os.path.join(d, 'count')
            with open(fake, 'w') as f:
                f.write(make_fake_opencode(counter, 'ses_1', tokens_per_step))
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
            os.environ['BOTYARD_FREE_PACE'] = ''
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

    def test_resume_uses_without_session(self):
        """After handover, the new run starts without --session (fresh session)."""
        tokens = [(80000, 1000, 0, 0, 0)] * 3
        times = [0, 100, 200, 300, 400]
        code, calls, prompts = self.run_fake_with_handover(76, times, tokens)
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 2)
        self.assertNotIn('--session', calls[1], 'second run must be fresh session (no --session)')
        self.assertIn('-m', calls[1])
        self.assertEqual(calls[1][calls[1].index('-m') + 1], 'x/m')

    def test_state_comment_in_prompt(self):
        """The fresh session's prompt begins with the state comment."""
        tokens = [(80000, 1000, 0, 0, 0)] * 3
        times = [0, 100, 200, 300, 400]
        code, calls, prompts = self.run_fake_with_handover(76, times, tokens)
        self.assertEqual(len(prompts), 2)
        state_prompt = prompts[1]
        self.assertTrue(state_prompt.startswith('State:') or state_prompt.startswith('State ') or 'done' in state_prompt.lower(),
                        f'prompt should start with state comment: {state_prompt[:200]}')


class ContextErrorFreshSession(unittest.TestCase):
    """Step 2: context_error also starts a fresh session with state (or original prompt + note)."""

    def test_context_error_starts_fresh_session(self):
        """When context_error fires, run restarts with without_session and state."""
        with tempfile.TemporaryDirectory() as d:
            fake = os.path.join(d, 'opencode')
            counter = os.path.join(d, 'count')
            with open(fake, 'w') as f:
                f.write(make_fake_opencode(counter, 'ses_1', [(100000, 1000, 0, 0, 0)], include_error=True))
            os.chmod(fake, 0o755)
            ticks = iter([0, 100, 200])
            last = [200]
            world = FakeWorld(fake)
            saved = (fred.load, fred.pause, fred.probe, fred.BUSY, fred.note, fred.clock, sys.argv, sys.stdin, dict(os.environ))
            fred.load = lambda *a: world
            fred.probe = lambda *a: 'ok'
            fred.BUSY = os.path.join(d, 'busy.json')
            fred.note = lambda line: None
            fred.clock = lambda: next(ticks, last[0])
            os.environ['BOTYARD_RUN_MINUTES'] = '76'
            os.environ['BOTYARD_FREE_PACE'] = ''
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
            self.assertEqual(code, 0)
            self.assertEqual(len(calls), 2, 'context_error triggers fresh session')
            self.assertNotIn('--session', calls[1], 'fresh session after context_error')
            self.assertTrue(len(prompts[1]) > len(prompts[0]), 'second prompt should include state/note')


class NoChangeToOtherSwitches(unittest.TestCase):
    """Other switch reasons (loop, 429, outage) keep the same session."""

    def test_loop_keeps_session(self):
        """Looped calls keep the same session (existing behavior)."""
        with tempfile.TemporaryDirectory() as d:
            fake = os.path.join(d, 'opencode')
            counter = os.path.join(d, 'count')
            # Build script without f-string brace issues
            script_lines = [
                f'#!{sys.executable}',
                'import json, os, sys, time',
                f'n = int(open({counter!r}).read() or 0) if os.path.exists({counter!r}) else 0',
                f'open({counter!r}, "w").write(str(n + 1))',
                f'open({counter!r} + ".args", "a").write(json.dumps(sys.argv[1:]) + "\\n")',
                f'open({counter!r} + ".prompts", "a").write(json.dumps(sys.stdin.read()) + "\\n")',
                'print(json.dumps({"type": "step_start", "sessionID": "ses_1", "part": {"snapshot": "s"}}), flush=True)',
                'tool_event = {"type": "tool_use", "sessionID": "ses_1", "part": {"tool": "bash", "state": {"status": "completed", "input": {"command": "echo hello"}, "output": "hello"}}}',
                'print(json.dumps(tool_event), flush=True)',
                'print(json.dumps(tool_event), flush=True)',
                'print(json.dumps(tool_event), flush=True)',
                'print(json.dumps(tool_event), flush=True)',
                'print(json.dumps(tool_event), flush=True)',
                'print(json.dumps({"type": "step_finish", "sessionID": "ses_1", "part": {}}), flush=True)',
                'print(json.dumps({"type": "text", "sessionID": "ses_1", "part": {"text": "done"}}), flush=True)',
            ]
            script = '\n'.join(script_lines)
            with open(fake, 'w') as f:
                f.write(script)
            os.chmod(fake, 0o755)
            ticks = iter([0, 100, 200, 300])
            last = [300]
            world = FakeWorld(fake)
            saved = (fred.load, fred.pause, fred.probe, fred.BUSY, fred.note, fred.clock, sys.argv, sys.stdin, dict(os.environ))
            fred.load = lambda *a: world
            fred.probe = lambda *a: 'ok'
            fred.BUSY = os.path.join(d, 'busy.json')
            fred.note = lambda line: None
            fred.clock = lambda: next(ticks, last[0])
            os.environ['BOTYARD_RUN_MINUTES'] = '76'
            os.environ['BOTYARD_FREE_PACE'] = ''
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
            self.assertEqual(len(calls), 2, 'loop switches model but keeps session')
            self.assertIn('--session', calls[1], 'loop keeps same session')


class TestConstants(unittest.TestCase):
    def test_context_handover_constant(self):
        """CONTEXT_HANDOVER constant exists and is 200000."""
        self.assertEqual(fred.CONTEXT_HANDOVER, 200000)

    def test_per_model_override_dict(self):
        """CONTEXT_MAX_PER_MODEL dict exists for per-model overrides."""
        self.assertTrue(hasattr(fred, 'CONTEXT_MAX_PER_MODEL'))
        self.assertIsInstance(fred.CONTEXT_MAX_PER_MODEL, dict)


if __name__ == '__main__':
    unittest.main()