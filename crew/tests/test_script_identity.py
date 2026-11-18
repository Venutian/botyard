"""A crew script is `script:<name>` to the engine: importing botyard_home adds the scripts key and the
script's name to every urllib call to the engine that carries no pass, and never the owner's key. A run
never reads the owner's key, by any tool (studio/server/engine/caller.mjs)."""
import http.server
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.request

CREW = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
sys.path.insert(0, CREW)
import botyard_home  # noqa: E402
import guards  # noqa: E402


class Seen(http.server.BaseHTTPRequestHandler):
    got = []

    def do_GET(self):
        Seen.got.append({k.lower(): v for k, v in self.headers.items()})
        body = b'{}'
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


class ScriptIdentity(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        keys = os.path.join(self.home, 'keys')
        os.makedirs(keys)
        with open(os.path.join(keys, 'engine-scripts.key'), 'w') as f:
            f.write('scripts-key\n')
        with open(os.path.join(keys, 'engine-owner.key'), 'w') as f:
            f.write('owner-key\n')
        self.server = http.server.HTTPServer(('127.0.0.1', 0), Seen)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.port = self.server.server_address[1]
        self.saved = {k: os.environ.get(k) for k in ('BOTYARD_HOME', 'BOTYARD_API_URL')}
        os.environ['BOTYARD_HOME'] = self.home
        os.environ['BOTYARD_API_URL'] = f'http://127.0.0.1:{self.port}'
        Seen.got.clear()

    def tearDown(self):
        self.server.shutdown()
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_a_call_with_no_pass_carries_the_scripts_key_and_the_name(self):
        urllib.request.urlopen(f'http://127.0.0.1:{self.port}/api/health', timeout=5).read()
        got = Seen.got[-1]
        self.assertEqual(got.get('x-botyard-key'), 'scripts-key')
        self.assertTrue(got.get('x-botyard-script'))
        self.assertNotIn('owner-key', json.dumps(got))

    def test_a_bot_pass_is_left_as_it_is(self):
        req = urllib.request.Request(f'http://127.0.0.1:{self.port}/api/agents/me', headers={'Authorization': 'Bearer run-pass'})
        urllib.request.urlopen(req, timeout=5).read()
        got = Seen.got[-1]
        self.assertEqual(got.get('authorization'), 'Bearer run-pass')
        self.assertNotIn('x-botyard-key', got)

    def test_other_addresses_get_nothing(self):
        self.assertFalse(botyard_home._to_engine('https://example.com/api/x'))
        self.assertTrue(botyard_home._to_engine(f'http://127.0.0.1:{self.port}/api/x'))

    def test_the_name_is_the_files_name(self):
        self.assertEqual(botyard_home.script_name('/x/own/Review-Guard.py'), 'review-guard')
        self.assertEqual(botyard_home.script_name('job update.sh'), 'job-update')


class OwnerKeyGuard(unittest.TestCase):
    def test_no_tool_reads_the_owner_key(self):
        for tool, given in [('Read', {'file_path': '/h/.botyard/keys/engine-owner.key'}),
                            ('Bash', {'command': 'cat ~/.botyard/keys/engine-owner.key'}),
                            ('Bash', {'command': 'python3 -c "print(open(\'keys/engine-owner.key\').read())"'}),
                            ('Grep', {'pattern': 'x', 'path': '/h/.botyard/keys/engine-owner.key'})]:
            told = guards.unreadable(tool, given)
            self.assertTrue(told and 'owner' in told, (tool, given))

    def test_the_scripts_key_and_other_reads_are_not_refused_for_it(self):
        self.assertIsNone(guards.unreadable('Bash', {'command': 'ls ~/.botyard/keys'}))


if __name__ == '__main__':
    unittest.main()
