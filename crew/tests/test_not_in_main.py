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

    def test_a_branch_whose_work_reached_main_under_other_commits_is_not_listed(self):
        # Four jobs of 21 Nov 2026: their fixes were re-applied on main by later jobs, so git cherry still saw their
        # own commits as missing, but merging them would change nothing.
        self.branch('LH-5-reapplied', {'app.js': 'five\n'})
        self.write('app.js', 'five\n')
        self.write('other.js', 'also\n')
        git(self.repo, 'add', '-A')
        git(self.repo, 'commit', '-q', '-m', 'the same fix, applied again on main inside a bigger commit')
        self.branch('LH-6-conflicts', {'six.js': 'six\n'})
        self.write('six.js', 'seven\n')
        git(self.repo, 'add', '-A')
        git(self.repo, 'commit', '-q', '-am', 'main moved on')
        found = [c for c, _, _, _ in nim.left_behind(self.repo)]
        self.assertNotIn('LH-5', found)
        self.assertIn('LH-6', found)

    def test_only_code_the_branch_itself_changes_counts(self):
        # A ruling branch whose one commit out of main is a notes entry, cut before main's history was rewritten: the
        # diff from its merge base shows old code, but none of it is the branch's own (two rulings of 16 Nov 2026).
        git(self.repo, 'checkout', '-q', '-b', 'LH-7-ruling', 'main')
        self.write('app.js', 'old history\n')
        git(self.repo, 'commit', '-q', '-am', 'a commit main later holds under another hash')
        self.write('docs/DECISIONS.md', 'ruled\n')
        git(self.repo, 'add', '-A')
        git(self.repo, 'commit', '-q', '-m', 'ruling entry')
        git(self.repo, 'checkout', '-q', 'main')
        self.write('app.js', 'old history\n')
        git(self.repo, 'commit', '-q', '-am', 'the same change under a new hash (a rewrite)')
        self.write('more.js', 'later\n')
        git(self.repo, 'add', '-A')
        git(self.repo, 'commit', '-q', '-m', 'main moves on')
        self.assertNotIn('LH-7', [c for c, _, _, _ in nim.left_behind(self.repo)])
        # A branch with code of its own out of main is still listed, with only that code.
        self.branch('LH-8-own', {'eight.js': '8\n'})
        found = {c: files for c, _, _, files in nim.left_behind(self.repo)}
        self.assertEqual(found.get('LH-8'), ['eight.js'])

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

    def test_an_older_try_whose_goal_landed_later_is_superseded_not_lost(self):
        now = dt.datetime(2026, 11, 24, 12, tzinfo=dt.timezone.utc)
        projects = [{'workspaces': [{'cwd': self.repo}]}]
        jobs = [{'identifier': 'LH-1', 'id': 'a', 'status': 'done', 'completedAt': '2026-11-20T01:00:00Z', 'title': 'Fix 1 of Crew: lamp lands'},
                {'identifier': 'LH-2', 'id': 'b', 'status': 'done', 'completedAt': '2026-11-21T01:00:00Z', 'title': 'Crew: lamp lands · Build (round 2)'},
                {'identifier': 'LH-3', 'id': 'c', 'status': 'done', 'completedAt': '2026-11-20T01:00:00Z', 'title': 'Crew: door opens'},
                {'identifier': 'LH-4', 'id': 'd', 'status': 'done', 'completedAt': '2026-11-22T01:00:00Z', 'title': 'Fix 1 of Crew: door opens'}]
        # LH-2 landed (nothing left of it): LH-1, an earlier try of the same goal, is superseded. LH-3's goal has a
        # later done job too, but that one (LH-4) is not in main either: both stay lost work.
        scan = lambda repo: [(code, f'{code}-x', 1, ['a.js']) for code in ('LH-1', 'LH-3', 'LH-4')]
        rows = {r['job']: r for r in nim.measure(projects, jobs, hours=6, now=now, scan=scan)}
        self.assertEqual(rows['LH-1'].get('superseded'), 'LH-2')
        self.assertNotIn('superseded', rows['LH-3'])
        self.assertNotIn('superseded', rows['LH-4'])

    def test_what_counts_as_code(self):
        for path in ('src/a.ts', 'crew/x.py', 'data/goods.json', 'notes.mdx'):
            self.assertTrue(nim.is_code(path), path)
        for path in ('notes/a.md', 'README.md', 'reports/LH-1/x.json', 'art/shot.PNG', 'docs/notes/x.txt'):
            self.assertFalse(nim.is_code(path), path)


if __name__ == '__main__':
    unittest.main()
