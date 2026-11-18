"""A job's own effort replaces the bot's default in claude-bot.sh; no ask keeps the default."""
import http.server
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import job_effort  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
BOT = os.path.join(HERE, '..', 'claude-bot.sh')
ARGS = ['--print', '--model', 'm', '--effort', 'medium', '--max-turns', '5', 'two words']


class Asked(unittest.TestCase):
    def test_no_ask_keeps_default(self):
        self.assertEqual(job_effort.asked({'labels': [], 'description': 'build it'}), '')

    def test_label_and_line(self):
        self.assertEqual(job_effort.asked({'labels': [{'name': 'effort:high'}]}), 'high')
        self.assertEqual(job_effort.asked({'description': 'x\nEFFORT: low\n'}), 'low')

    def test_bad_value_ignored(self):
        self.assertEqual(job_effort.asked({'description': 'EFFORT: turbo'}), '')

    def test_swap(self):
        self.assertEqual(job_effort.swap(ARGS, 'high')[4], 'high')
        self.assertEqual(job_effort.swap(ARGS, ''), ARGS)
        self.assertEqual(job_effort.swap(['--print'], 'high'), ['--print'])


class Wrapper(unittest.TestCase):
    def run_bot(self, issue):
        """Runs the real claude-bot.sh with a stub claude and a local engine that answers with `issue`."""
        class Engine(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                body = json.dumps(issue).encode()
                self.send_response(200)
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass
        server = http.server.HTTPServer(('127.0.0.1', 0), Engine)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        with tempfile.TemporaryDirectory() as d:
            stub = os.path.join(d, 'claude')
            open(stub, 'w').write('#!/bin/sh\nfor a in "$@"; do echo "[$a]"; done\n')
            os.chmod(stub, 0o755)
            env = {**os.environ, 'BOTYARD_CLAUDE': stub, 'BOTYARD_CONNECTORS': 'off', 'BOTYARD_JOB_ID': 'j1',
                   'BOTYARD_API_URL': f'http://127.0.0.1:{server.server_port}', 'BOTYARD_BOT_SETTINGS': ''}
            r = subprocess.run(['sh', BOT, *ARGS], env=env, capture_output=True, text=True)
        server.shutdown()
        self.assertIn('[--effort]', r.stdout.split('\n'), r.stderr)
        return r.stdout.split('\n')

    def effort_of(self, out):
        return out[out.index('[--effort]') + 1]

    def test_no_label_keeps_default(self):
        self.assertEqual(self.effort_of(self.run_bot({'labels': [], 'description': 'x'})), '[medium]')

    def test_label_high_overrides_medium(self):
        out = self.run_bot({'labels': [{'name': 'effort:high'}]})
        self.assertEqual(self.effort_of(out), '[high]')
        self.assertIn('[two words]', out)
        self.assertEqual(out.count('[--effort]'), 1)

    def test_line_overrides_to_low_and_resume_reads_same_job(self):
        issue = {'description': 'brief\nEFFORT: low'}
        self.assertEqual(self.effort_of(self.run_bot(issue)), '[low]')
        self.assertEqual(self.effort_of(self.run_bot(issue)), '[low]')


if __name__ == '__main__':
    unittest.main()
