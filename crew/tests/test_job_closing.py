"""The job-closing script comes from the repository (crew/skills) and reads what the run was told
through run-vars.sh, the one place the shell has the variables' names."""
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest

CREW = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
sys.path.insert(0, CREW)
import botyard_home  # noqa: E402

SCRIPTS = os.path.join(CREW, 'skills', 'botyard', 'scripts')
UPDATE = os.path.join(SCRIPTS, 'job-update.sh')


class Engine(http.server.BaseHTTPRequestHandler):
    seen, answer = [], None

    def do_PATCH(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        Engine.seen.append((self.path, dict(self.headers), body))
        status, out = Engine.answer(body) if Engine.answer else (200, {'id': 'j1', **body})
        self.send_response(status)
        self.end_headers()
        self.wfile.write(json.dumps(out).encode() if out is not None else b'')

    def log_message(self, *args):
        pass


class Closing(unittest.TestCase):
    def setUp(self):
        Engine.seen, Engine.answer = [], None
        self.server = http.server.HTTPServer(('127.0.0.1', 0), Engine)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.env = {'PATH': '/usr/bin:/bin', botyard_home.var_name('API_URL'): f'http://127.0.0.1:{self.server.server_address[1]}',
                    botyard_home.var_name('API_KEY'): 'pass-1', botyard_home.var_name('RUN_ID'): 'run-1',
                    botyard_home.var_name('JOB_ID'): 'j1'}

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def run_it(self, *args, text='Done.\n\n- proof: tests pass\n', env=None):
        return subprocess.run(['bash', UPDATE, *args], input=text, capture_output=True, text=True, env=self.env if env is None else env)

    def test_it_closes_the_job_the_run_was_woken_for_with_the_report_as_it_was_written(self):
        out = self.run_it('--status', 'done')
        self.assertEqual(out.returncode, 0, out.stderr)
        path, headers, body = Engine.seen[0]
        self.assertEqual(path, '/api/issues/j1')
        self.assertEqual(body, {'status': 'done', 'comment': 'Done.\n\n- proof: tests pass'})
        self.assertEqual(headers['Authorization'], 'Bearer pass-1')
        self.assertEqual(json.loads(out.stdout)['status'], 'done')

    def test_it_says_plainly_when_the_update_did_not_land(self):
        Engine.answer = lambda body: (200, {'id': 'j1', 'status': 'in_progress'})
        out = self.run_it('--status', 'done')
        self.assertEqual(out.returncode, 1)
        self.assertIn('NOT saved', out.stderr)
        Engine.answer = lambda body: (409, {'error': 'This job is closed.'})
        out = self.run_it('--status', 'done')
        self.assertEqual(out.returncode, 1)
        self.assertIn('refused', out.stderr)
        self.assertEqual(len(Engine.seen), 2, 'a refusal is not tried again')

    def test_outside_a_run_it_names_the_variables_by_their_real_names(self):
        out = self.run_it('--status', 'done', env={'PATH': '/usr/bin:/bin'})
        self.assertEqual(out.returncode, 1)
        self.assertIn(botyard_home.var_name('JOB_ID'), out.stderr)
        out = self.run_it('--issue-id', 'j9', '--status', 'blocked', '--dry-run', env={'PATH': '/usr/bin:/bin'})
        self.assertEqual(json.loads(out.stdout), {'status': 'blocked', 'comment': 'Done.\n\n- proof: tests pass'})

    def commit_repo(self):
        """A projects folder holding one repo with branch LH-1-fix two commits long: (env, first, tip)."""
        projects = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, projects, True)
        repo = os.path.join(projects, 'app')
        g = lambda *a: subprocess.run(['git', '-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', *a],
                                      check=True, capture_output=True, text=True).stdout.strip()
        os.makedirs(repo)
        g('init', '-q', '-b', 'LH-1-fix')
        g('commit', '-q', '--allow-empty', '-m', 'one')
        first = g('rev-parse', 'HEAD')
        g('commit', '-q', '--allow-empty', '-m', 'two')
        return {**self.env, 'BOTYARD_PROJECTS_DIR': projects}, first, g('rev-parse', 'HEAD')

    def report(self, line):
        return f'Done.\n\nOUTCOME: MET\nCHANGE: SMALL\nCOMMIT: {line}\n'

    def test_a_done_report_whose_commit_line_names_no_real_tip_is_refused_and_nothing_is_sent(self):
        # Real reports (Nov 2026) closed done on lines like these, so their work got no check and no landing.
        env, first, tip = self.commit_repo()
        for line in ('$(git rev-parse HEAD) LH-1-fix', tip[:7] + ' LH-1-fix', tip + 'a LH-1-fix',
                     tip[:8] + 'b4fc3fd1d5e1d3c1f3c0f5a8e0e6a1b2 LH-1-fix', f'{first} LH-1-fix', f'{first} (branch LH-1-fix)'):
            out = self.run_it('--status', 'done', text=self.report(line), env=env)
            self.assertEqual(out.returncode, 1, line)
            self.assertIn('Not closed:', out.stderr, line)
        self.assertEqual(Engine.seen, [])

    def test_a_done_report_naming_its_branch_tip_or_no_hash_is_closed(self):
        env, first, tip = self.commit_repo()
        for line in (f'{tip} LH-1-fix', f'{tip} on LH-1-fix (app repo)', f'{first} an-old-branch-that-is-gone', 'none (report only)'):
            out = self.run_it('--status', 'done', text=self.report(line), env=env)
            self.assertEqual(out.returncode, 0, f'{line}: {out.stderr}')
        self.assertEqual(len(Engine.seen), 4)

    def test_only_a_done_report_is_held_to_its_commit_line(self):
        env, _, _ = self.commit_repo()
        out = self.run_it('--status', 'blocked', text=self.report('$(git rev-parse HEAD)'), env=env)
        self.assertEqual(out.returncode, 0, out.stderr)

    def test_shell_and_python_name_every_run_variable_the_same(self):
        for what in botyard_home.RUN_VARS:
            out = subprocess.run(['sh', '-c', f'. "{SCRIPTS}/run-vars.sh"; run_var_name {what}'], capture_output=True, text=True)
            self.assertEqual(out.stdout, botyard_home.var_name(what))

    def test_no_script_a_bot_calls_names_a_run_variable_itself(self):
        for root, _, names in os.walk(os.path.join(CREW, 'skills')):
            for name in names:
                if name.endswith(('.sh', '.py', '.mjs')) and name != 'run-vars.sh':
                    text = open(os.path.join(root, name), encoding='utf8').read()
                    self.assertNotRegex(text, r'BOTYARD_(API_URL|API_KEY|RUN_ID|JOB_ID|BOT_ID|ID)\b', name)
        for name in ('claude-bot.sh', 'botyard-home.sh', 'install.sh'):
            self.assertNotRegex(open(os.path.join(CREW, name), encoding='utf8').read(), r'BOTYARD_(API_KEY|RUN_ID|JOB_ID|BOT_ID)\b', name)


if __name__ == '__main__':
    unittest.main()
