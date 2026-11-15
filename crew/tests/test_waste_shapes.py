#!/usr/bin/env python3
"""STANDARDS.md rules 14 to 16: a payload past the engine's limit, a 429 or a network error, and a command that
waits in the foreground until the run's time limit are each caught the same way for every bot."""
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
guard = load('loop_guard', 'loop-guard.py')
fred = load('free_runner', 'free-runner.py')


def sparse(path, size):
    with open(path, 'wb') as f:
        f.seek(size - 1)
        f.write(b'x')


class Payload(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.big = os.path.join(self.dir.name, 'dump.log')
        with open(self.big, 'w') as f:
            f.write('line of a huge log\n' * 1_580_000)
        self.png = os.path.join(self.dir.name, 'shot.png')
        with open(self.png, 'wb') as f:
            f.write(b'\x89PNG\r\n\x1a\n' + b'\0' * 5000)
        self.text = os.path.join(self.dir.name, 'notes.txt')
        with open(self.text, 'w') as f:
            f.write('hello\n' * 100)

    def tearDown(self):
        self.dir.cleanup()

    def test_a_30_mb_file_read_is_refused_with_the_message_for_claude_bots(self):
        for tool, given in (('Read', {'file_path': self.big}), ('Bash', {'command': f'cat {self.big}'}),
                            ('Bash', {'command': f'cd /tmp && base64 {self.big} | head -c 10'})):
            told = guard.check({'tool_name': tool, 'tool_input': given}, {})
            self.assertIsNotNone(told, (tool, given))
            self.assertIn('check it by name and size', told.lower())
            self.assertIn('run a script', told)

    def test_a_30_mb_file_read_is_refused_for_free_bots_before_the_command_runs(self):
        stand_in = os.path.join(CREW, 'agy-bin', 'cat')
        out = subprocess.run([stand_in, self.big], capture_output=True, text=True)
        self.assertNotEqual(out.returncode, 0)
        self.assertEqual(out.stdout, '')
        self.assertIn('check it by name and size', out.stderr.lower())
        ok = subprocess.run([stand_in, self.text], capture_output=True, text=True)
        self.assertEqual((ok.returncode, ok.stdout.count('hello')), (0, 100))

    def test_binaries_are_refused_but_a_small_screenshot_can_be_looked_at_and_ordinary_reads_pass(self):
        self.assertIsNotNone(guards.unreadable('Read', {'file_path': self.png.replace('.png', '.zip')}) or guards.why_unreadable(self.png))
        self.assertIn('binary', guards.unreadable('Bash', {'command': f'cat {self.png}'}))
        self.assertIsNone(guards.unreadable('Read', {'file_path': self.png}), 'a screenshot is how a check looks at a screen')
        self.assertIsNone(guards.unreadable('Read', {'file_path': self.text}))
        self.assertIsNone(guards.unreadable('Bash', {'command': f'head -c 2000 {self.big}'}), 'a bounded read is fine')
        self.assertIsNone(guards.unreadable('Read', {'file_path': self.big, 'offset': 10, 'limit': 50}))
        self.assertIsNone(guards.unreadable('Bash', {'command': 'git log | cat'}))
        self.assertIsNotNone(guards.unreadable('Read', {'file_path': self.big}))

    def test_a_free_run_that_read_one_is_stopped_and_told_and_a_huge_output_is_too(self):
        loops = fred.Loops()
        read = {'type': 'tool_use', 'part': {'tool': 'read', 'state': {'status': 'completed', 'input': {'filePath': self.big}, 'output': ''}}}
        what, why = loops.feed(read)
        self.assertIn('read', what)
        self.assertIn('check it by name and size', loops.prompt.lower())
        loud = {'type': 'tool_use', 'part': {'tool': 'bash', 'state': {'status': 'completed', 'input': {'command': 'make 2>&1'}, 'output': 'x' * 300_000}}}
        got = fred.Loops().feed(loud)
        self.assertIn('200,000', got[1])
        quiet = {'type': 'tool_use', 'part': {'tool': 'bash', 'state': {'status': 'completed', 'input': {'command': 'ls'}, 'output': 'x' * 1000}}}
        self.assertIsNone(fred.Loops().feed(quiet))

    def test_cap_cuts_output_to_the_limit(self):
        self.assertEqual(guards.cap('a' * 10), 'a' * 10)
        self.assertLess(len(guards.cap('a' * 500_000)), 200_200)


class Transient(unittest.TestCase):
    def test_which_errors_are_waited_out(self):
        for text in ('Too Many Requests: {"status":429}', 'EPROTO: The TLS handshake failed', 'socket hang up', 'overloaded'):
            self.assertTrue(guards.transient(text), text)
        for text in ('Rate limit exceeded: free-models-per-day-high-balance.', 'model not found', '403 not available in your region', ''):
            self.assertFalse(guards.transient(text), text)
        self.assertEqual([guards.retry_wait(n) for n in range(4)], [20, 60, 180, None])

    def run_main(self, errors, script_dir):
        """Runs free-runner's main() against a fake OpenCode that fails with `errors` first, then works."""
        fake = os.path.join(script_dir, 'opencode')
        counter = os.path.join(script_dir, 'count')
        with open(fake, 'w') as f:
            f.write(f'''#!{sys.executable}
import json, sys
n = int(open({counter!r}).read() or 0) if __import__("os").path.exists({counter!r}) else 0
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
        fred.BUSY = os.path.join(script_dir, 'busy.json')
        fred.note = lambda line: None
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
            fred.load, fred.pause, fred.probe, fred.BUSY, fred.note, sys.argv, sys.stdin = saved
        with open(counter + '.args') as f:
            calls = [json.loads(line) for line in f]
        return code, waits, calls, fb

    def test_a_429_is_retried_in_the_same_run_and_session_and_then_succeeds(self):
        with tempfile.TemporaryDirectory() as d:
            code, waits, calls, fb = self.run_main(['Too Many Requests: {"status":429}'], d)
        self.assertEqual(code, 0)
        self.assertEqual(waits, [20])
        self.assertEqual(len(calls), 2)
        self.assertIn('--session', calls[1])
        self.assertEqual(calls[1][calls[1].index('--session') + 1], 'ses_1')
        self.assertFalse(hasattr(fb, 'aside'), 'a 429 never sets the model aside on its first occurrence')

    def test_backoff_is_20_60_180_and_a_fourth_failure_hands_over(self):
        with tempfile.TemporaryDirectory() as d:
            code, waits, calls, fb = self.run_main(['TLS handshake failed'] * 4, d)
        self.assertEqual(waits[:3], [20, 60, 180])
        self.assertEqual(len(calls) >= 4, True)

    def test_a_daily_limit_is_not_waited_out(self):
        with tempfile.TemporaryDirectory() as d:
            code, waits, calls, fb = self.run_main(['Rate limit exceeded: free-models-per-day-high-balance.'], d)
        self.assertEqual(waits, [])
        self.assertTrue(hasattr(fb, 'aside'), 'the model is set aside, rule 4')


class LongCommands(unittest.TestCase):
    def test_a_foreground_command_that_asks_for_more_than_five_minutes_is_refused_with_the_message(self):
        for given in ({'command': 'npm run sim', 'timeout': 600000}, {'command': 'timeout 900 npm test'},
                      {'command': 'heavy-launcher bash -c "npm run sim"'}):
            told = guard.check({'tool_name': 'Bash', 'tool_input': given}, {})
            self.assertIsNotNone(told, given)
            self.assertIn('heavy-launcher', told)
            self.assertIn('botyard-wait', told)
        for given in ({'command': 'npm test', 'timeout': 120000}, {'command': 'npm run sim', 'timeout': 600000, 'run_in_background': True},
                      {'command': "setsid nohup heavy-launcher bash -c 'npm run sim > tmp/job.log 2>&1' > /dev/null 2>&1 &"},
                      {'command': 'npm test -- --timeout 900'}):
            self.assertIsNone(guard.check({'tool_name': 'Bash', 'tool_input': given}, {}), given)

    def test_a_shell_command_over_five_minutes_in_the_foreground_is_found_and_the_engines_helpers_are_not(self):
        rows = [(10, 1, 900, 'opencode run'), (11, 10, 900, 'node mcp-server.js'), (12, 10, 400, 'bash -c npm run sim'),
                (13, 12, 399, 'node sim.js'), (14, 10, 100, 'bash -c sleep 5'), (15, 1, 9000, 'bash -c setsid sleep 9000')]
        self.assertEqual(guards.overlong(rows, 10)[0], 12)
        self.assertIsNone(guards.overlong([r for r in rows if r[0] != 12], 10))
        self.assertEqual(sorted(guards.tree(rows, 12)), [12, 13])

    def test_a_real_overlong_command_is_killed_by_the_runner_loop_and_told(self):
        # What the runner does with the finding: kill the command's tree and hand the model KILLED.
        proc = subprocess.Popen(['bash', '-c', 'sleep 60; true'], start_new_session=True)
        try:
            rows = guards.processes()
            mine = [r for r in rows if r[0] == proc.pid]
            self.assertTrue(mine, 'the process is listed')
            found = guards.overlong([(pid, ppid, 301 if pid == proc.pid else age, cmd) for pid, ppid, age, cmd in rows], os.getpid())
            self.assertEqual(found[0], proc.pid)
            for pid in guards.tree(rows, found[0]):
                os.kill(pid, 9)
            proc.wait(timeout=5)
            self.assertEqual(proc.returncode, -9)
        finally:
            if proc.poll() is None:
                proc.kill()
        said = guards.killed('bash -c npm run sim', 400)
        self.assertIn('heavy-launcher', said)
        self.assertIn('botyard-wait', said)


if __name__ == '__main__':
    unittest.main()
