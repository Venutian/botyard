"""botyard-wait: a session registers a heavy job, ends its run, and is woken in the same session once, when the done
file appears."""
import importlib.util
import json
import os
import tempfile
import time
import unittest

CREW = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(CREW, file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


wait = load('botyard_wait', 'botyard-wait.py')
ENV = {'BOTYARD_JOB_ID': 'j1', 'BOTYARD_BOT_ID': 'a1'}


class Wake(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        wait.FILE = os.path.join(self.dir, 'waits.json')
        self.done = os.path.join(self.dir, 'job.done')
        self.status, self.runs, self.posts = 'in_progress', [{'id': 'r1', 'createdAt': '1', 'status': 'succeeded'}], []

        def api(method, path, body=None):
            if method == 'POST':
                self.posts.append((path, body))
                return {}
            if path.endswith('/runs'):
                return self.runs
            return {'identifier': 'LH-1', 'status': self.status}
        self.api = api

    def test_registration_is_written(self):
        w = wait.register(self.done, 'sim', env=ENV)
        self.assertEqual(json.load(open(wait.FILE)), [w])
        self.assertEqual((w['issueId'], w['agentId'], w['doneFile']), ('j1', 'a1', self.done))
        wait.register(self.done, 'again', env=ENV)
        self.assertEqual(len(wait.load()), 1)

    def test_no_wake_while_the_file_is_absent(self):
        wait.register(self.done, env=ENV)
        wait.wake_pass(api=self.api)
        self.assertEqual(self.posts, [])
        self.assertEqual(len(wait.load()), 1)

    def test_wakes_once_when_the_file_appears(self):
        wait.register(self.done, env=ENV)
        open(self.done, 'w').close()
        wait.wake_pass(api=self.api)
        wait.wake_pass(api=self.api)
        self.assertEqual(self.posts, [('/agents/a1/wakeup', {'source': 'automation', 'reason': 'heavy_job_done',
                                                            'payload': {'issueId': 'j1'}})])
        self.assertEqual(wait.load(), [])

    def test_wake_after_a_cut_off_is_the_request_resume_phased_builds(self):
        self.runs = [{'runId': 'r9', 'createdAt': '1', 'status': 'timed_out'}]
        wait.register(self.done, env=ENV)
        open(self.done, 'w').close()
        wait.wake_pass(api=self.api)
        self.assertEqual(self.posts[0][1], {'source': 'automation', 'reason': 'retry_failed_run', 'failedRunId': 'r9'})

    def test_old_id_shape_still_works(self):
        self.runs = [{'id': 'r8', 'createdAt': '1', 'status': 'failed'}]
        wait.register(self.done, env=ENV)
        open(self.done, 'w').close()
        wait.wake_pass(api=self.api)
        self.assertEqual(self.posts[0][1]['failedRunId'], 'r8')

    def test_dry_run_prints_the_live_shape_request(self):
        import contextlib, io
        self.runs = [{'runId': 'R1', 'createdAt': '2026-11-12T10:00:00Z', 'status': 'timed_out'}]
        wait.register(self.done, env=ENV)
        open(self.done, 'w').close()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            wait.wake_pass(dry=True, api=self.api)
        self.assertIn('{"source": "automation", "reason": "retry_failed_run", "failedRunId": "R1"}', out.getvalue())
        print(out.getvalue().strip())

    def test_a_bad_registration_does_not_stop_a_good_one(self):
        import contextlib, io
        other = os.path.join(self.dir, 'other.done')
        wait.register(self.done, env=ENV)
        wait.register(other, env={'BOTYARD_JOB_ID': 'j2', 'BOTYARD_BOT_ID': 'a2'})
        open(self.done, 'w').close()
        open(other, 'w').close()

        def api(method, path, body=None):
            if path == '/issues/j1':
                raise KeyError('id')
            return self.api(method, path, body)
        with contextlib.redirect_stdout(io.StringIO()):
            kept = wait.wake_pass(api=api)
        self.assertEqual([p for p, _ in self.posts], ['/agents/a2/wakeup'])
        self.assertEqual([w['issueId'] for w in kept], ['j1'])
        self.assertEqual([w['issueId'] for w in wait.load()], ['j1'])

    def test_refused_wake_falls_back_and_says_fresh_session(self):
        import contextlib, io, urllib.error
        wait.register(self.done, env=ENV)
        open(self.done, 'w').close()

        def api(method, path, body=None):
            if method == 'POST' and body['reason'] == 'heavy_job_done':
                raise urllib.error.HTTPError(path, 422, 'no', {}, None)
            return self.api(method, path, body)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            wait.wake_pass(api=api)
        self.assertEqual(self.posts[0][1]['reason'], 'issue_assigned')
        self.assertIn('FRESH session (heavy_job_done was refused)', out.getvalue())
        self.assertEqual(wait.load(), [])

    def test_waits_while_the_run_is_still_ending(self):
        self.runs = [{'id': 'r1', 'createdAt': '1', 'status': 'running'}]
        wait.register(self.done, env=ENV)
        open(self.done, 'w').close()
        wait.wake_pass(api=self.api)
        self.assertEqual(self.posts, [])
        self.assertEqual(len(wait.load()), 1)

    def test_dry_run_prints_and_changes_nothing(self):
        wait.register(self.done, env=ENV)
        open(self.done, 'w').close()
        wait.wake_pass(dry=True, api=self.api)
        self.assertEqual(self.posts, [])
        self.assertEqual(len(wait.load()), 1)

    def test_closed_and_stale_registrations_are_dropped(self):
        wait.register(self.done, env=ENV)
        self.status = 'done'
        wait.wake_pass(api=self.api)
        self.assertEqual(wait.load(), [])
        self.status = 'in_progress'
        wait.register(self.done, env=ENV, now=time.time() - 25 * 3600)
        wait.wake_pass(api=self.api)
        self.assertEqual(wait.load(), [])
        self.assertEqual(self.posts, [])


def log(path, commands):
    """A run log: each (command, seconds it ran) as a tool call and its result."""
    t, lines = 1_800_000_000.0, []
    for n, (cmd, secs) in enumerate(commands):
        for kind, at, block in (('assistant', t, {'type': 'tool_use', 'id': f't{n}', 'name': 'Bash', 'input': {'command': cmd}}),
                                ('user', t + secs, {'type': 'tool_result', 'tool_use_id': f't{n}'})):
            chunk = json.dumps({'type': kind, 'message': {'content': [block]}})
            stamp_ = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime(at))
            lines.append(json.dumps({'ts': stamp_, 'stream': 'stdout', 'chunk': chunk}))
        t += secs + 1
    open(path, 'w').write('\n'.join(lines) + '\n')


if __name__ == '__main__':
    unittest.main()
