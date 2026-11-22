"""A Claude bot never edits a repository's main checkout in place; its job worktree is free (20 Nov 2026)."""
import importlib.util
import os
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('owner_guard_main', os.path.join(HERE, '..', 'owner-guard.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class NoEditMain(unittest.TestCase):
    def setUp(self):
        self.projects = tempfile.mkdtemp()
        self.repo = os.path.join(self.projects, 'product')
        os.makedirs(os.path.join(self.repo, 'src'))
        subprocess.run(['git', 'init', '-q', '-b', 'main', self.repo], check=True)
        self.wt = os.path.join(self.repo, '.botyard', 'worktrees', 'JOB-1-x')
        os.makedirs(self.wt)
        open(os.path.join(self.wt, '.git'), 'w').write('gitdir: ../../../.git/worktrees/x\n')
        self.saved = guard.botyard_home.projects
        guard.botyard_home.projects = lambda env=None: self.projects

    def tearDown(self):
        guard.botyard_home.projects = self.saved

    def ev(self, tool, cwd=None, **inp):
        return {'tool_name': tool, 'tool_input': inp, 'cwd': cwd or self.wt}

    def test_edit_write_and_notebook_in_a_main_checkout_are_refused(self):
        for tool, key in (('Edit', 'file_path'), ('Write', 'file_path'), ('NotebookEdit', 'notebook_path')):
            self.assertEqual(guard.check(self.ev(tool, **{key: os.path.join(self.repo, 'src', 'a.py')})), guard.MAIN_TOLD, tool)
        self.assertEqual(guard.check(self.ev('Edit', cwd=self.repo, file_path='src/a.py')), guard.MAIN_TOLD)

    def test_the_job_worktree_and_other_folders_are_free(self):
        self.assertIsNone(guard.check(self.ev('Edit', file_path=os.path.join(self.wt, 'src', 'a.py'))))
        self.assertIsNone(guard.check(self.ev('Write', file_path=os.path.join(tempfile.gettempdir(), 'x.txt'))))
        self.assertIsNone(guard.check(self.ev('Bash', command='echo hi > out.txt && sed -i s/a/b/ src/a.py')))

    def test_shell_writes_into_a_main_checkout_are_refused(self):
        for cmd in (f'echo x > {self.repo}/src/a.py', f'echo x >> {self.repo}/a.log', f'cat a | tee {self.repo}/b.txt',
                    f'sed -i "s/a/b/" {self.repo}/src/a.py', f'cd {self.repo} && echo x > src/a.py'):
            self.assertEqual(guard.check(self.ev('Bash', command=cmd)), guard.MAIN_TOLD, cmd)
        for cmd in (f'cat {self.repo}/src/a.py', f'grep x {self.repo}/src/a.py 2>/dev/null', f'ls {self.repo} > /dev/null'):
            self.assertIsNone(guard.check(self.ev('Bash', command=cmd)), cmd)


if __name__ == '__main__':
    unittest.main()
