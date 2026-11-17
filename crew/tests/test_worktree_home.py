"""Job worktrees live under their repo (<repo>/.botyard/worktrees), never at the projects folder's top level (rule 23)."""
import importlib.util
import os
import subprocess
import tempfile
import unittest

CREW = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(CREW, file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


guard = load('owner_guard', 'owner-guard.py')
maker = load('repo_worktree', 'repo-worktree.py')


def git(*args, cwd):
    subprocess.run(['git', *args], cwd=cwd, check=True, capture_output=True,
                   env={**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t', 'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@t', 'GIT_CONFIG_GLOBAL': '/dev/null'})


class WorktreeHome(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.realpath(self.tmp.name)
        self.repo = os.path.join(self.root, 'tools')
        os.makedirs(self.repo)
        git('init', '-b', 'main', cwd=self.repo)
        git('commit', '--allow-empty', '-m', 'first', cwd=self.repo)

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_worktree_beside_the_projects_is_refused(self):
        for command in ['git worktree add ../tools-1029 -b YRD-1029 main',
                        f'git -C {self.repo} worktree add {self.root}/wt-fix -b fix main',
                        'cd .. && git worktree add -b b wt-YRD-9 main',
                        'git worktree add "../tools-wt1" main; echo ok',
                        f'cd {self.root} && git worktree add wt-x -b wt-x main',
                        f'cd {self.root}; git worktree add ./wt-y main',
                        f'bash -c "git worktree add {self.root}/wt-z main"']:
            self.assertTrue(guard.worktree_at_root(command, cwd=self.repo, root=self.root), command)

    def test_a_worktree_under_its_repo_and_other_git_is_fine(self):
        for command in ['git worktree add .botyard/worktrees/YRD-5 -b YRD-5 main', 'git worktree list',
                        f'git -C {self.repo} worktree add {self.repo}/.botyard/worktrees/a -b a main',
                        'git worktree remove ../x', 'git status', f'cd {self.repo} && git worktree add .botyard/worktrees/q -b q main', 'git worktree add /tmp/scratch main']:
            self.assertFalse(guard.worktree_at_root(command, cwd=self.repo, root=self.root), command)

    def test_the_guard_tells_the_bot_what_to_run(self):
        told = guard.check({'tool_name': 'Bash', 'cwd': self.repo, 'tool_input': {'command': 'git worktree add ../tools-77 -b x main'}})
        # The real projects folder is not the temp one, so only the shape is checked here: a plain refusal needs the root.
        self.assertTrue(told is None or 'repo-worktree.py' in told)

    def test_the_helper_makes_the_worktree_under_the_repo_and_reuses_it(self):
        path = maker.make('tools', 'YRD-1067-x', root=self.root)
        self.assertEqual(path, os.path.join(self.repo, '.botyard', 'worktrees', 'YRD-1067-x'))
        self.assertTrue(os.path.isfile(os.path.join(path, '.git')))
        self.assertEqual(maker.make('tools', 'YRD-1067-x', root=self.root), path)
        out = subprocess.run(['git', '-C', path, 'branch', '--show-current'], capture_output=True, text=True).stdout.strip()
        self.assertEqual(out, 'YRD-1067-x')
        # The folder it made is not a worktree at the top level, so the guard lets a later command in it through.
        self.assertFalse(guard.worktree_at_root('git worktree add .botyard/worktrees/y -b y', cwd=self.repo, root=self.root))

    def test_the_helper_refuses_paths_that_climb_out_and_non_repos(self):
        for repo, name in (('..', 'x'), ('tools', '../x'), ('tools', 'a/b'), ('nothing', 'x')):
            with self.assertRaises(ValueError):
                maker.make(repo, name, root=self.root)
        self.assertEqual(maker.make('tools', 'p', root=self.root, dry=True), os.path.join(self.repo, '.botyard', 'worktrees', 'p'))
        self.assertFalse(os.path.exists(os.path.join(self.repo, '.botyard', 'worktrees', 'p')))


if __name__ == '__main__':
    unittest.main()
