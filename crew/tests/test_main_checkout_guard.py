"""A bot's git refuses to move a repository's main checkout (19 Nov 2026), and still works in a worktree."""
import os
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
WRAP = os.path.join(HERE, '..', 'agy-bin', 'git')


def git(cwd, *args, wrap=False):
    cmd = ([WRAP] if wrap else ['git']) + list(args)
    env = {**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@example.com', 'GIT_COMMITTER_NAME': 't',
           'GIT_COMMITTER_EMAIL': 't@example.com'}
    env.pop('BOTYARD_MAIN_CHECKOUT_OK', None)
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, env=env)


class Guard(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp()
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

    def test_changed_files_are_left_and_said(self):
        git(self.repo, 'checkout', '-q', '-b', 'job')
        open(os.path.join(self.repo, 'a'), 'w').write('changed')
        got = self.mc.faults(self.folder)
        self.assertEqual(len(got), 1)
        self.assertIn('with changed files (a)', got[0])
        self.assertEqual(git(self.repo, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.strip(), 'job')


if __name__ == '__main__':
    unittest.main()
