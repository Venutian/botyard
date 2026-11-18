"""Jobs marked done whose code never reached main are listed; notes, open jobs and fresh ones are not."""
import datetime as dt
import importlib.util
import os
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
spec = importlib.util.spec_from_file_location('not_in_main', os.path.join(HERE, 'not-in-main.py'))
nim = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nim)


def git(repo, *args):
    subprocess.run(['git', '-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', *args],
                   check=True, capture_output=True)


class NotInMain(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp()
        git(self.repo, 'init', '-q', '-b', 'main')
        self.write('app.js', 'one\n')
        git(self.repo, 'add', '-A')
        git(self.repo, 'commit', '-q', '-m', 'start')

    def write(self, name, text):
        path = os.path.join(self.repo, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w') as f:
            f.write(text)

    def branch(self, name, files, merge=False):
        git(self.repo, 'checkout', '-q', '-b', name, 'main')
        for f, text in files.items():
            self.write(f, text)
        git(self.repo, 'add', '-A')
        git(self.repo, 'commit', '-q', '-m', name)
        git(self.repo, 'checkout', '-q', 'main')
        if merge:
            git(self.repo, 'merge', '-q', '--no-ff', '-m', 'merge', name)

    def test_only_job_branches_with_code_not_in_main_are_found(self):
        self.branch('LH-1-left-behind', {'app.js': 'two\n'})
        self.branch('LH-2-landed', {'b.js': 'x\n'}, merge=True)
        self.branch('LH-3-notes-only', {'notes/plan.md': 'a\n', 'shot.png': 'p'})
        self.branch('feature-x', {'c.js': 'y\n'})
        found = nim.left_behind(self.repo)
        self.assertEqual([(c, b, n) for c, b, n, _ in found], [('LH-1', 'LH-1-left-behind', 1)])
        self.assertEqual(found[0][3], ['app.js'])

    def test_only_done_jobs_done_long_enough_ago_are_listed(self):
        now = dt.datetime(2026, 11, 18, 12, tzinfo=dt.timezone.utc)
        projects = [{'workspaces': [{'cwd': self.repo}]}, {'archivedAt': '2026-11-01', 'workspaces': [{'cwd': '/nowhere'}]}]
        jobs = [{'identifier': 'LH-1', 'id': 'a', 'status': 'done', 'completedAt': '2026-11-18T01:00:00Z', 'title': 'Old', 'assigneeAgentId': 'b1'},
                {'identifier': 'LH-2', 'id': 'b', 'status': 'done', 'completedAt': '2026-11-18T10:00:00Z', 'title': 'Fresh'},
                {'identifier': 'LH-3', 'id': 'c', 'status': 'in_progress', 'title': 'Open'},
                {'identifier': 'LH-4', 'id': 'd', 'status': 'cancelled', 'title': 'Dropped'}]
        scan = lambda repo: [(code, f'{code}-x', 1, ['a.js']) for code in ('LH-1', 'LH-2', 'LH-3', 'LH-4', 'LH-9')]
        rows = nim.measure(projects, jobs, hours=6, now=now, scan=scan, bots={'b1': 'Builder'})
        self.assertEqual([r['job'] for r in rows], ['LH-1'])
        self.assertEqual(rows[0]['repo'], os.path.realpath(self.repo))
        self.assertEqual(rows[0]['bot'], 'Builder')

    def test_what_counts_as_code(self):
        for path in ('src/a.ts', 'crew/x.py', 'data/goods.json', 'notes.mdx'):
            self.assertTrue(nim.is_code(path), path)
        for path in ('notes/a.md', 'README.md', 'reports/LH-1/x.json', 'art/shot.PNG', 'docs/notes/x.txt'):
            self.assertFalse(nim.is_code(path), path)


if __name__ == '__main__':
    unittest.main()
