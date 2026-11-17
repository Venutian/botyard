"""botyard_home.py is the one place the crew's Python reads a folder, a tool's path or a run variable's
name from; botyard-home.sh is the same for the shell scripts. They must agree with each other and with
the server's home.mjs, and no script may write this computer's paths out by hand."""
import os
import re
import subprocess
import sys
import tempfile
import unittest

CREW = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
sys.path.insert(0, CREW)
import botyard_home  # noqa: E402


class Places(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()

    def test_a_new_computer_gets_the_botyard_home(self):
        env = {'HOME': self.home}
        places = botyard_home.places(env)
        self.assertEqual(places['home'], f'{self.home}/.botyard')
        self.assertEqual(places['crew'], f'{self.home}/.botyard/crew')
        self.assertEqual(places['keys'], f'{self.home}/.botyard/keys')
        self.assertEqual(places['run_logs'], os.path.join(places['data'], 'run-logs'))

    def test_botyard_home_set_by_hand_moves_everything(self):
        env = {'HOME': self.home, 'BOTYARD_HOME': f'{self.home}/mine'}
        places = botyard_home.places(env)
        self.assertEqual((places['crew'], places['keys'], places['data'], places['config']),
                         (f'{self.home}/mine/crew', f'{self.home}/mine/keys', f'{self.home}/mine', f'{self.home}/mine/config'))
        self.assertEqual(botyard_home.run_logs(env), [])
        os.makedirs(f'{self.home}/mine/run-logs')
        self.assertEqual(botyard_home.run_logs(env), [f'{self.home}/mine/run-logs'])

    def test_keys_folder_is_closed_to_others(self):
        folder = botyard_home.keys_dir({'HOME': self.home})
        self.assertEqual(os.stat(folder).st_mode & 0o777, 0o700)

    def test_the_shell_helper_agrees(self):
        for extra in ({}, {'BOTYARD_HOME': f'{self.home}/mine'}):
            env = {'HOME': self.home, 'PATH': '/usr/bin:/bin', **extra}
            out = subprocess.run(['sh', '-c', f'here={CREW}; . "$here/botyard-home.sh"; echo "$BOTYARD_CREW_DIR|$BOTYARD_KEYS_DIR|$BOTYARD_PROJECTS_DIR|$(run_var_name JOB_ID)|$(run_var_name ID)"'],
                                 capture_output=True, text=True, env=env).stdout.strip().split('|')
            places = botyard_home.places(env)
            self.assertEqual(out, [places['crew'], places['keys'], botyard_home.projects(env), botyard_home.var_name('JOB_ID'),
                                   botyard_home.var_name('ID')])

    def test_the_repository_is_found_from_the_script_itself(self):
        self.assertEqual(botyard_home.scripts(), CREW)
        self.assertEqual(botyard_home.repo(), os.path.dirname(CREW))
        self.assertEqual(botyard_home.projects({'BOTYARD_PROJECTS': '/srv/work'}), '/srv/work')


class Tools(unittest.TestCase):
    def test_a_tool_is_found_on_the_bots_path_and_missing_ones_say_what_to_install(self):
        home = tempfile.mkdtemp()
        os.makedirs(f'{home}/.npm-global/bin')
        tool = f'{home}/.npm-global/bin/opencode'
        open(tool, 'w').write('#!/bin/sh\n')
        os.chmod(tool, 0o755)
        self.assertEqual(botyard_home.tool('opencode', {'HOME': home, 'PATH': ''}), tool)
        self.assertIsNone(botyard_home.tool('no-such-tool-anywhere', {'HOME': home, 'PATH': ''}))
        with self.assertRaises(SystemExit) as stop:
            botyard_home.need('opencode', {'HOME': tempfile.mkdtemp(), 'PATH': ''})
        self.assertIn('npm install -g opencode-ai', str(stop.exception))


class Keys(unittest.TestCase):
    def test_a_key_is_read_from_the_keys_folder_then_from_opencodes_own_file(self):
        home = tempfile.mkdtemp()
        env = {'HOME': home}
        self.assertIsNone(botyard_home.key('openrouter', env))
        os.makedirs(f'{home}/.local/share/opencode')
        open(f'{home}/.local/share/opencode/auth.json', 'w').write('{"openrouter": {"type": "api", "key": "old-place"}}')
        self.assertEqual(botyard_home.key('openrouter', env), 'old-place')
        open(os.path.join(botyard_home.keys_dir(env), 'openrouter.key'), 'w').write('new-place\n')
        self.assertEqual(botyard_home.key('openrouter', env), 'new-place')
        self.assertIsNone(botyard_home.key('nvidia', env))


class Engine(unittest.TestCase):
    def test_the_address_is_what_was_told_or_this_computer_on_the_engines_port(self):
        self.assertEqual(botyard_home.api({'BOTYARD_API_URL': 'http://127.0.0.1:5274/api'}), 'http://127.0.0.1:5274/api')
        self.assertEqual(botyard_home.api({'BOTYARD_API_URL': 'http://127.0.0.1:5274'}), 'http://127.0.0.1:5274/api', 'a run is told it without /api')
        self.assertEqual(botyard_home.api({}), 'http://127.0.0.1:3210/api')
        self.assertEqual(botyard_home.api({'BOTYARD_ENGINE_PORT': '4000'}), 'http://127.0.0.1:4000/api')

    def test_run_variables_are_asked_by_what_they_are(self):
        env = {botyard_home.var_name('JOB_ID'): 'j1', botyard_home.var_name('API_KEY'): 'k', botyard_home.var_name('RUN_ID'): 'r'}
        self.assertEqual(botyard_home.run_var('JOB_ID', env=env), 'j1')
        self.assertEqual(botyard_home.run_var('BOT_ID', 'none', env=env), 'none')
        self.assertEqual(botyard_home.run_headers(env), {'Content-Type': 'application/json', 'Authorization': 'Bearer k'})
        self.assertEqual([botyard_home.var_name(w) for w in botyard_home.RUN_VARS],
                         ['BOTYARD_API_URL', 'BOTYARD_API_KEY', 'BOTYARD_RUN_ID', 'BOTYARD_JOB_ID', 'BOTYARD_BOT_ID', 'BOTYARD_ID'])

    def test_the_studios_id_is_what_the_run_was_told_or_the_file(self):
        home = tempfile.mkdtemp()
        self.assertEqual(botyard_home.studio_id({'HOME': home, botyard_home.var_name('ID'): 'told'}), 'told')
        os.makedirs(f'{home}/s/crew')
        open(f'{home}/s/crew/studio-id', 'w').write('kept\n')
        self.assertEqual(botyard_home.studio_id({'HOME': home, 'BOTYARD_HOME': f'{home}/s'}), 'kept')


class NoPathOfThisComputer(unittest.TestCase):
    """Nothing in crew/ names a person's home folder, an engine or a product this code grew from, and
    no script but the home helpers names a run variable or the engine's port."""
    def files(self):
        for root, dirs, names in os.walk(CREW):
            dirs[:] = [d for d in dirs if d not in ('__pycache__', 'node_modules')]
            for name in names:
                path = os.path.join(root, name)
                if not os.path.islink(path) and name.endswith(('.py', '.sh', '.json', '.md', '.mjs', '.service', '.timer', '.target', '.js')) or os.sep + 'agy-bin' + os.sep in path:
                    yield path

    def test_no_home_folder_is_written_out(self):
        found = []
        for path in self.files():
            if os.path.islink(path):
                continue
            try:
                text = open(path, encoding='utf8').read()
            except (OSError, UnicodeDecodeError):
                continue
            if re.search(r'/home/[a-z]+/|/Users/[A-Za-z]+/', text.replace('/home/owner/', '').replace('/home/you/', '')):
                found.append(os.path.relpath(path, CREW))
        self.assertEqual(found, [])

    def test_scripts_ask_botyard_home_for_folders_and_run_variables(self):
        code = re.compile(r"""(environ(\.get\(|\[)['"]BOTYARD_(API_URL|API_KEY|RUN_ID|JOB_ID|BOT_ID|ID)['"]|127\.0\.0\.1:3210)""")
        found = []
        for name in sorted(os.listdir(CREW)):
            if name.endswith('.py') and name not in ('botyard_home.py',):
                for n, line in enumerate(open(os.path.join(CREW, name), encoding='utf8'), 1):
                    if code.search(line):
                        found.append(f'{name}:{n}')
        self.assertEqual(found, [])


    def test_nothing_personal_or_of_the_first_studio_is_left(self):
        # The release test: no person, product or bot of the studio this code was first written for.
        words = ['ng' + 'en', 'ven' + 'us', 'venu' + 'tian', 'yo' + 'el', 'mebra' + 'htu', 'bal' + 'tis', 'ballo' + 'tta', 'al' + 'dis',
                 'night ' + 'rules', 'to' + 'ny ' + 'yayo', 'gid' + 'eon', 'karen ' + 'the', 'brick ' + 'the', 'bob the ' + 'builder', 'kwa' + 'ku',
                 'fred ' + 'the', 'fre' + 'ya', 'taf' + 'ari', 'hu' + 'go', 'flip' + 'pa', 'hus' + 'tl', 'jobs' + 'desk', 'kin' + 'dle',
                 'unti' + 'red', 'paper' + 'clip', 'at' + 'rium']
        old = re.compile('|'.join(words), re.I)
        found = []
        for path in list(self.files()) + [os.path.join(os.path.dirname(CREW), 'CREW.md')]:
            try:
                text = open(path, encoding='utf8').read()
            except (OSError, UnicodeDecodeError):
                continue
            hit = old.search(text) or old.search(os.path.relpath(path, CREW))
            if hit:
                found.append(f'{os.path.relpath(path, CREW)}: {hit.group(0)}')
        self.assertEqual(found, [])


if __name__ == '__main__':
    unittest.main()
