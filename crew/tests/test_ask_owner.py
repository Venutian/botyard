"""ask-owner.sh puts one decision to the owner as a card, and never sends one with nothing to answer.
The card it sends is checked against the engine's own rule (studio/server/engine/write.mjs)."""
import http.server
import json
import os
import shutil
import subprocess
import sys
import threading
import unittest

CREW = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
sys.path.insert(0, CREW)
import botyard_home  # noqa: E402

ASK = os.path.join(CREW, 'skills', 'botyard', 'scripts', 'ask-owner.sh')
ENGINE_WRITE = os.path.join(os.path.dirname(CREW), 'studio', 'server', 'engine', 'write.mjs')


class Engine(http.server.BaseHTTPRequestHandler):
    seen = []

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        Engine.seen.append((self.path, dict(self.headers), body))
        self.send_response(201)
        self.end_headers()
        self.wfile.write(json.dumps({'id': 'card-1', 'status': 'pending', **body}).encode())

    def log_message(self, *args):
        pass


class AskOwner(unittest.TestCase):
    def setUp(self):
        Engine.seen = []
        self.server = http.server.HTTPServer(('127.0.0.1', 0), Engine)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.env = {'PATH': '/usr/bin:/bin', botyard_home.var_name('API_URL'): f'http://127.0.0.1:{self.server.server_address[1]}',
                    botyard_home.var_name('API_KEY'): 'pass-1', botyard_home.var_name('JOB_ID'): 'j1'}

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def ask(self, *args, env=None):
        return subprocess.run(['bash', ASK, *args], capture_output=True, text=True, env=self.env if env is None else env)

    def test_it_sends_one_card_with_the_question_and_its_choices_recommended_first(self):
        out = self.ask('--title', 'Which size ships first', '--question', 'Which size ships first?',
                       '--option', 'Small (recommended)|A day.', '--option', 'Large|A week.', '--key', 'Size first')
        self.assertEqual(out.returncode, 0, out.stderr)
        path, headers, card = Engine.seen[0]
        self.assertEqual(path, '/api/issues/j1/interactions')
        self.assertEqual(headers['Authorization'], 'Bearer pass-1')
        self.assertEqual(card['kind'], 'ask_user_questions')
        self.assertEqual(card['idempotencyKey'], 'question:j1:size-first')
        (question,) = card['payload']['questions']
        self.assertEqual((question['prompt'], question['selectionMode']), ('Which size ships first?', 'single'))
        self.assertEqual([(o['label'], o.get('description')) for o in question['options']], [('Small (recommended)', 'A day.'), ('Large', 'A week.')])
        self.assertNotIn('questionSet', card['payload'])

    def test_it_never_sends_a_card_with_nothing_to_answer(self):
        for args, words in ((['--option', 'A', '--option', 'B'], 'give the question'),
                            (['--question', '   ', '--option', 'A', '--option', 'B'], 'give the question'),
                            (['--question', 'Which?'], 'at least two choices'),
                            (['--question', 'Which?', '--option', 'Only one'], 'at least two choices'),
                            (['--question', 'Which?', '--option', '|no label', '--option', 'B'], 'no label')):
            out = self.ask(*args)
            self.assertEqual(out.returncode, 1, args)
            self.assertIn(words, out.stderr)
        self.assertEqual(Engine.seen, [], 'nothing reached the engine')

    def test_more_than_one_answer_and_a_dry_run(self):
        out = self.ask('--question', 'Which platforms?', '--option', 'Web', '--option', 'Phone', '--multi', '--dry-run', env={'PATH': '/usr/bin:/bin'})
        self.assertEqual(out.returncode, 1, 'no job named outside a run, even for a dry run')
        out = self.ask('--issue-id', 'j7', '--question', 'Which platforms?', '--option', 'Web', '--option', 'Phone', '--multi', '--dry-run',
                       env={'PATH': '/usr/bin:/bin'})
        card = json.loads(out.stdout)
        self.assertEqual(card['payload']['questions'][0]['selectionMode'], 'multi')
        self.assertEqual(card['title'], 'Which platforms?', 'the question is the title when none is given')
        self.assertEqual(Engine.seen, [])

    @unittest.skipUnless(shutil.which('node'), 'node is needed to ask the engine')
    def test_the_card_it_sends_is_one_the_engine_takes(self):
        out = self.ask('--issue-id', 'j7', '--question', 'Which size?', '--option', 'Small', '--option', 'Large', '--dry-run')
        card = json.loads(out.stdout)
        script = (f"import({json.dumps(ENGINE_WRITE)}).then(({{ questionsOf }}) => "
                  f"process.stdout.write(JSON.stringify(questionsOf({json.dumps(card['payload'])}))))")
        kept = json.loads(subprocess.run(['node', '-e', script], capture_output=True, text=True, check=True).stdout)
        self.assertEqual([o['label'] for o in kept[0]['options']], ['Small', 'Large'])


if __name__ == '__main__':
    unittest.main()
