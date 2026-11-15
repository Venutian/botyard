"""A Claude bot that builds may git merge, fetch and merge --abort in its worktree; every other deny stays."""
import os, subprocess, sys, tempfile, unittest

CREW = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, CREW)
import crew_set  # noqa: E402

KEPT = ['git push', 'git rebase', 'git reset --hard', 'git clean', 'git worktree remove', 'rm -rf', 'sudo', 'gh']


def settings(role, may_not):
    files = crew_set.CrewSet(own='', places=crew_set.Places(env={'HOME': '/h', 'PATH': ''}, crew='/h/.botyard/crew', projects='/h/w'))
    spec = {**crew_set.DEFAULTS, 'name': 'T', 'role': role, 'ai': 'claude', 'model': 'claude-sonnet-5-5', 'effort': 'medium', 'turns': 150,
            'folder': None, 'mayNot': may_not}
    args = files.config(spec)['extraArgs']
    return {args[i]: args[i + 1] for i in range(0, len(args), 2)}


class BuilderMerge(unittest.TestCase):
    def test_builder_allows_merge_fetch_abort_and_keeps_every_other_deny(self):
        s = settings('builder', ['push'])
        allow, deny = s['--allowedTools'].split(','), s['--disallowedTools'].split(',')
        for rule in ('Bash(git merge:*)', 'Bash(git fetch:*)', 'Bash(git merge --abort)'):
            self.assertIn(rule, allow)
        self.assertNotIn('Bash(git merge:*)', deny)
        for cmd in KEPT:
            self.assertIn(f'Bash({cmd}:*)', deny)
        self.assertEqual(set(deny) | {'Bash(git merge:*)'}, set(crew_set.DENY_ALWAYS.split(',')))

    def test_reviewers_and_other_roles_still_may_not_merge(self):
        for role, may in (('builder', ['push', 'edit']), ('lead', ['push']), ('reviewer', ['push'])):
            s = settings(role, may)
            self.assertIn('Bash(git merge:*)', s['--disallowedTools'].split(','))
            self.assertNotIn('--allowedTools', s)

    def test_a_merge_runs_in_a_scratch_repo_and_aborts(self):
        with tempfile.TemporaryDirectory() as d:
            env = {**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@x', 'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@x'}

            def g(*a):
                return subprocess.run(['git', *a], cwd=d, env=env, capture_output=True, text=True)
            g('init', '-q', '-b', 'main')
            open(f'{d}/a', 'w').write('1'); g('add', 'a'); g('commit', '-qm', 'a')
            g('checkout', '-qb', 'side')
            open(f'{d}/b', 'w').write('2'); g('add', 'b'); g('commit', '-qm', 'b')
            g('checkout', '-q', 'main')
            self.assertEqual(g('merge', '--no-commit', '--no-ff', 'side').returncode, 0)
            g('merge', '--abort')
            self.assertFalse(os.path.exists(f'{d}/b'))


if __name__ == '__main__':
    unittest.main()
