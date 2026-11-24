#!/usr/bin/env python3
"""A free run whose session passes CONTEXT_HANDOVER tokens hands over, once, to a fresh session that starts from the
state the old one wrote (also posted on the job); a context overflow of a session with history goes on in a fresh
session too, never the same one. Below the point nothing changes. No test here can post to a real job."""
import importlib.util
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.realpath(__file__))
spec = importlib.util.spec_from_file_location('free_runner_handover', os.path.join(HERE, '..', 'free-runner.py'))
fred = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fred)

OVERFLOW = "Requested token count exceeds the model's maximum context length of 262144"
# The run's job and pace: cleared, so a run here has no job to post to (the earlier build's tests posted a fake
# handover comment to the real job, NGE-3411) and no pace or checker setting from the shell.
RUN_ENV = ('BOTYARD_API_URL', 'BOTYARD_API_KEY', 'BOTYARD_JOB_ID', 'BOTYARD_CHECKER', 'BOTYARD_FREE_PACE',
           'BOTYARD_FREE_TIER', 'BOTYARD_RUN_MINUTES')
TASK = 'Build the thing in crew/x.py and test it.'


def tool(session='ses_1'):
    """One finished tool call, so a start is never taken for a run that did no work."""
    return {'type': 'tool_use', 'sessionID': session,
            'part': {'tool': 'read', 'state': {'status': 'completed', 'input': {'filePath': 'crew/x.py'}}}}


def step(size, session='ses_1'):
    """A step_finish as OpenCode writes it (shape read from opencode.db, 24 Nov 2026)."""
    return {'type': 'step_finish', 'sessionID': session,
            'part': {'type': 'step-finish', 'reason': 'tool-calls',
                     'tokens': {'total': size, 'input': 1000, 'output': 50, 'reasoning': 20,
                                'cache': {'read': size - 1070, 'write': 0}}}}


class FakeWorld:
    def __init__(self, opencode):
        self.OPENCODE, self.FREE_LISTED = opencode, 'listed'

    def free_list(self): return [('x/m', 'f', 'strong')]
    def free_aside(self): return {}
    def free_family(self, m): return m.split('/')[0]
    def read_json(self, *a): return {'at': 9e12}
    def setup(self): return self
    def outage(self, *a): return False
    def limits(self): return type('L', (), {'answered': lambda s, m: None})()
    def set_free_aside(self, *a, **k): pass


def run_main(starts, argv=('run', '-m', 'x/m'), prompt=TASK, files=('crew/x.py',)):
    """Runs main() against a fake OpenCode. starts[n] is what start n does: a list of events to print (a number is a
    step_finish of that size, 'sleep' waits so the runner can stop it there, ('error', msg) fails the start)."""
    with tempfile.TemporaryDirectory() as d:
        fake, counter = os.path.join(d, 'opencode'), os.path.join(d, 'count')
        with open(fake, 'w') as f:
            f.write(f'''#!{sys.executable}
import json, os, sys, time
n = int(open({counter!r}).read() or 0) if os.path.exists({counter!r}) else 0
open({counter!r}, "w").write(str(n + 1))
open({counter!r} + ".args", "a").write(json.dumps(sys.argv[1:]) + "\\n")
open({counter!r} + ".prompts", "a").write(json.dumps(sys.stdin.read()) + "\\n")
starts = json.loads({json.dumps(json.dumps(starts))})
plan = starts[n] if n < len(starts) else [{{"type": "text", "sessionID": "ses_z", "part": {{"text": "done"}}}}]
for e in plan:
    if e == "sleep":
        time.sleep(5)
    elif isinstance(e, list) and e[0] == "error":
        print(json.dumps({{"type": "error", "error": {{"data": {{"message": e[1]}}}}}}), flush=True)
        sys.exit(1)
    else:
        print(json.dumps(e), flush=True)
''')
        os.chmod(fake, 0o755)
        world, posted = FakeWorld(fake), []
        names = ('load', 'pause', 'probe', 'BUSY', 'note', 'post_comment', 'changed_files')
        saved = {k: getattr(fred, k) for k in names}
        saved_io, env = (sys.argv, sys.stdin), dict(os.environ)
        fred.load = lambda *a: world
        fred.pause = lambda *a: None
        fred.probe = lambda *a: 'ok'
        fred.BUSY = os.path.join(d, 'busy.json')
        fred.note = lambda line: None
        fred.post_comment = posted.append
        fred.changed_files = lambda *a: list(files)
        for k in RUN_ENV:
            os.environ.pop(k, None)
        sys.argv = ['free-runner.py', *argv]
        sys.stdin = open(os.devnull)
        try:
            with open(os.devnull, 'w') as sink:
                out, err, sys.stdout, sys.stderr = sys.stdout, sys.stderr, sink, sink
                try:
                    code = main_with_prompt(prompt)
                finally:
                    sys.stdout, sys.stderr = out, err
        finally:
            for k, v in saved.items():
                setattr(fred, k, v)
            sys.stdin.close()
            sys.argv, sys.stdin = saved_io
            os.environ.clear()
            os.environ.update(env)
        calls = [json.loads(line) for line in open(counter + '.args')]
        prompts = [json.loads(line) for line in open(counter + '.prompts')]
        return code, calls, prompts, posted


def main_with_prompt(prompt):
    """main() reads its prompt from stdin; the fake world hands it the task."""
    with tempfile.TemporaryFile('w+') as f:
        f.write(prompt)
        f.seek(0)
        sys.stdin = f
        return fred.main()


def session_of(call):
    return call[call.index('--session') + 1] if '--session' in call else None


STATE = {'type': 'text', 'sessionID': 'ses_1', 'part': {'text': 'DONE: x.py written. LEFT: the test. FILES: crew/x.py'}}
DONE2 = {'type': 'text', 'sessionID': 'ses_2', 'part': {'text': 'done'}}
WORK = tool('ses_2')


class Size(unittest.TestCase):
    def test_the_size_is_the_last_steps_total_not_a_sum(self):
        self.assertEqual(fred.context_size(step(308649)), 308649)
        no_total = {'type': 'step_finish', 'part': {'tokens': {'input': 1469, 'output': 173, 'reasoning': 127,
                                                                'cache': {'read': 306880, 'write': 0}}}}
        self.assertEqual(fred.context_size(no_total), 308649)
        for other in ({'type': 'text', 'part': {'text': 'x'}}, {'type': 'step_finish', 'part': {}}, None, 'x'):
            self.assertIsNone(fred.context_size(other), other)

    def test_the_point_is_200k_with_a_per_model_override(self):
        self.assertEqual(fred.CONTEXT_HANDOVER, 200000)
        self.assertEqual(fred.handover_at('x/m'), 200000)
        saved = dict(fred.CONTEXT_HANDOVER_FOR)
        try:
            fred.CONTEXT_HANDOVER_FOR['small/m'] = 90000
            self.assertEqual(fred.handover_at('small/m'), 90000)
            self.assertEqual(fred.handover_at('x/m'), 200000)
        finally:
            fred.CONTEXT_HANDOVER_FOR.clear()
            fred.CONTEXT_HANDOVER_FOR.update(saved)

    def test_with_no_job_nothing_is_posted(self):
        env = dict(os.environ)
        try:
            for k in RUN_ENV:
                os.environ.pop(k, None)
            self.assertFalse(fred.post_comment('x'))
        finally:
            os.environ.clear()
            os.environ.update(env)


class Handover(unittest.TestCase):
    def test_below_200k_nothing_changes(self):
        code, calls, prompts, posted = run_main([[step(120000), step(199999), WORK, DONE2]])
        self.assertEqual((code, len(calls), posted), (0, 1, []))
        self.assertTrue(prompts[0].startswith(TASK))

    def test_passing_200k_hands_over_once_to_a_fresh_session_that_starts_from_the_state(self):
        code, calls, prompts, posted = run_main([
            [step(120000), step(210000), 'sleep', step(230000)],   # stopped at the 210k step end
            [STATE],                                                # asked once for its state
            [step(40000, 'ses_2'), step(60000, 'ses_2'), WORK, DONE2],    # the fresh session
        ])
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 3)
        self.assertEqual(session_of(calls[1]), 'ses_1', 'the state is asked of the full session')
        self.assertTrue(prompts[1].startswith('This session is near the end of its context window (210,000'))
        self.assertIsNone(session_of(calls[2]), 'the work goes on in a new session')
        self.assertEqual(len(posted), 1, 'the handover happens exactly once')
        self.assertTrue(posted[0].startswith('Context handover at 210,000 tokens on x/m'))
        self.assertIn('DONE: x.py written. LEFT: the test.', posted[0])
        self.assertTrue(prompts[2].startswith(posted[0]), 'the fresh prompt begins with the state comment')
        self.assertIn(TASK, prompts[2])

    def test_a_session_that_writes_no_state_hands_over_with_the_changed_files(self):
        code, calls, prompts, posted = run_main([[step(210000), 'sleep'], [], [WORK, DONE2]])
        self.assertEqual((code, len(calls), len(posted)), (0, 3, 1))
        self.assertIn('did not write its state', posted[0])
        self.assertIn('crew/x.py', posted[0])
        self.assertIsNone(session_of(calls[2]))

    def test_a_resumed_session_already_past_200k_hands_over_at_its_first_step(self):
        code, calls, prompts, posted = run_main([[step(240000, 'ses_old'), 'sleep'], [STATE], [WORK, DONE2]],
                                                argv=('run', '-m', 'x/m', '--session', 'ses_old'))
        self.assertEqual((code, len(calls), len(posted)), (0, 3, 1))
        self.assertEqual(session_of(calls[1]), 'ses_old')
        self.assertIsNone(session_of(calls[2]))


if __name__ == '__main__':
    unittest.main()
