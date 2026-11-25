"""A bot's git refuses to move a repository's main checkout (19 Nov 2026), and still works in a worktree."""
import os
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
WRAP = os.path.join(HERE, '..', 'agy-bin', 'git')


def git(cwd, *args, wrap=False):
    cmd = ([WRAP] if wrap else ['git']) + list(args)
    env = {**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@example.invalid', 'GIT_COMMITTER_NAME': 't',
           'GIT_COMMITTER_EMAIL': 't@example.invalid'}
    env.pop('BOTYARD_MAIN_CHECKOUT_OK', None)
    env.update(EXTRA)
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, env=env)


EXTRA = {}


class Guard(unittest.TestCase):
    def setUp(self):
        self.projects = tempfile.mkdtemp()
        EXTRA['BOTYARD_PROJECTS'] = self.projects
        self.repo = os.path.join(self.projects, 'product')
        os.makedirs(self.repo)
        git(self.repo, 'init', '-q', '-b', 'main')
        open(os.path.join(self.repo, 'a'), 'w').write('a')
        git(self.repo, 'add', 'a')
        git(self.repo, 'commit', '-qm', 'a')
        self.wt = os.path.join(tempfile.mkdtemp(), 'wt')
        git(self.repo, 'worktree', 'add', '-q', '-b', 'job', self.wt)

    def test_the_main_checkout_cannot_be_moved(self):
        for args in (('checkout', '-b', 'job2'), ('switch', 'job'), ('reset', 'HEAD~0'), ('restore', 'a')):
            done = git(self.repo, *args, wrap=True)
            self.assertNotEqual(done.returncode, 0, args)
            self.assertIn('refused in a main checkout', done.stderr)
        done = git(tempfile.gettempdir(), '-C', self.repo, 'checkout', '-b', 'job3', wrap=True)
        self.assertIn('refused in a main checkout', done.stderr)
        self.assertEqual(git(self.repo, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.strip(), 'main')

    def test_claude_and_codex_bots_get_only_the_main_checkout_rule(self):
        env = {**os.environ, 'BOTYARD_GIT_MAIN_ONLY': '1', **EXTRA}
        done = subprocess.run([WRAP, 'checkout', '-b', 'x'], cwd=self.repo, capture_output=True, text=True, env=env)
        self.assertIn('refused in a main checkout', done.stderr)
        open(os.path.join(self.wt, 'b'), 'w').write('b')
        subprocess.run([WRAP, 'add', 'b'], cwd=self.wt, env=env)
        done = subprocess.run([WRAP, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'b'], cwd=self.wt,
                              capture_output=True, text=True, env=env)
        self.assertEqual(done.returncode, 0, done.stderr)

    def test_a_repository_outside_the_projects_folder_is_not_a_main_checkout(self):
        temp = tempfile.mkdtemp()
        git(temp, 'init', '-q', '-b', 'main')
        open(os.path.join(temp, 'a'), 'w').write('a')
        git(temp, 'add', 'a')
        git(temp, 'commit', '-qm', 'a')
        self.assertEqual(git(temp, 'checkout', '-qb', 'fix', wrap=True).returncode, 0)

    def test_a_worktree_still_moves_freely(self):
        self.assertEqual(git(self.wt, 'checkout', '-q', '-b', 'job-two', wrap=True).returncode, 0)
        self.assertEqual(git(self.wt, 'status', '--short', wrap=True).returncode, 0)


class Keeper(unittest.TestCase):
    def setUp(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('main_checkout', os.path.join(HERE, '..', 'main-checkout.py'))
        self.mc = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.mc)
        self.folder = tempfile.mkdtemp()
        self.repo = os.path.join(self.folder, 'r')
        os.makedirs(self.repo)
        git(self.repo, 'init', '-q', '-b', 'main')
        open(os.path.join(self.repo, 'a'), 'w').write('a')
        git(self.repo, 'add', 'a')
        git(self.repo, 'commit', '-qm', 'a')
        self.mc.botyard_home.state = lambda name, env=None: os.path.join(self.folder, name)

    def test_a_drifted_clean_checkout_goes_back_and_its_commits_stay_on_their_branch(self):
        git(self.repo, 'checkout', '-q', '-b', 'job')
        open(os.path.join(self.repo, 'b'), 'w').write('b')
        git(self.repo, 'add', 'b')
        git(self.repo, 'commit', '-qm', 'b')
        self.assertEqual(self.mc.faults(self.folder), [])
        self.assertEqual(git(self.repo, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.strip(), 'main')
        self.assertEqual(git(self.repo, 'log', '-1', '--format=%s', 'job').stdout.strip(), 'b')

    def test_uncommitted_code_on_main_is_said_and_state_files_are_not(self):
        open(os.path.join(self.repo, 'run.py'), 'w').write('x = 1\n')
        open(os.path.join(self.repo, 'ledger.json'), 'w').write('{}\n')
        git(self.repo, 'add', 'run.py', 'ledger.json')
        git(self.repo, 'commit', '-qm', 'files')
        open(os.path.join(self.repo, 'ledger.json'), 'w').write('{"a": 1}\n')
        self.assertEqual(self.mc.faults(self.folder), [])
        open(os.path.join(self.repo, 'run.py'), 'w').write('x = 2\n')
        got = self.mc.faults(self.folder)
        self.assertEqual(len(got), 1)
        self.assertIn('uncommitted code edits (run.py)', got[0])
        settings = os.path.join(self.folder, 'mc.json')
        open(settings, 'w').write('{"ignore": {"r": ["run.py"]}}')
        self.assertEqual(self.mc.uncommitted(self.repo, settings), '')

    def test_changed_files_are_left_and_said(self):
        git(self.repo, 'checkout', '-q', '-b', 'job')
        open(os.path.join(self.repo, 'a'), 'w').write('changed')
        got = self.mc.faults(self.folder)
        self.assertEqual(len(got), 1)
        self.assertIn('with changed files (a)', got[0])
        self.assertEqual(git(self.repo, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.strip(), 'job')


if __name__ == '__main__':
    unittest.main()
