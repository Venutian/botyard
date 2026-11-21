"""In a repository that publishes, a bot whose name its push check refuses commits under a public name, and a commit
message the push would refuse is refused when it is written (20 Nov 2026: one such commit held back every push)."""
import os
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
WRAP = os.path.join(ROOT, 'crew', 'agy-bin', 'git')
MAIL = 'bot@users.noreply.github.com'
LEAD = ''.join(reversed('ynoT'))  # a first studio's lead, refused by the push check (spelled backwards, as it does)


def git(cwd, *args, name='Fred', wrap=True):
    env = {**os.environ, 'GIT_AUTHOR_NAME': name, 'GIT_AUTHOR_EMAIL': MAIL, 'GIT_COMMITTER_NAME': name,
           'GIT_COMMITTER_EMAIL': MAIL, 'BOTYARD_PROJECTS': tempfile.gettempdir(), 'BOTYARD_GIT_MAIN_ONLY': '1'}
    return subprocess.run(([WRAP] if wrap else ['git']) + list(args), cwd=cwd, capture_output=True, text=True, env=env)


class PublicName(unittest.TestCase):
    def repo(self, publishes):
        dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, dir, True)
        git(dir, 'init', '-q', '-b', 'main', wrap=False)
        if publishes:
            os.makedirs(os.path.join(dir, 'tools', 'hooks'))
            shutil.copy(os.path.join(ROOT, 'tools', 'release-check.mjs'), os.path.join(dir, 'tools'))
            shutil.copy(os.path.join(ROOT, 'tools', 'hooks', 'commit-msg'), os.path.join(dir, 'tools', 'hooks'))
            git(dir, 'config', 'core.hooksPath', 'tools/hooks', wrap=False)
        open(os.path.join(dir, 'a'), 'w').write('a')
        git(dir, 'add', '-A', wrap=False)
        return dir

    def author(self, dir):
        return git(dir, 'log', '-1', '--format=%an|%cn', wrap=False).stdout.strip()

    def test_a_refused_name_commits_as_the_crew_in_a_repo_that_publishes(self):
        dir = self.repo(True)
        done = git(dir, 'commit', '-qm', 'one change', name=LEAD)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.author(dir), 'Botyard crew|Botyard crew')

    def test_a_name_that_passes_is_kept(self):
        dir = self.repo(True)
        self.assertEqual(git(dir, 'commit', '-qm', 'one change', name='Fred').returncode, 0)
        self.assertEqual(self.author(dir), 'Fred|Fred')

    def test_a_repo_that_does_not_publish_keeps_every_name(self):
        dir = self.repo(False)
        self.assertEqual(git(dir, 'commit', '-qm', 'one change', name=LEAD).returncode, 0)
        self.assertEqual(self.author(dir), f'{LEAD}|{LEAD}')

    def test_a_message_the_push_would_refuse_is_refused_when_written(self):
        dir = self.repo(True)
        code = ''.join(reversed('EGN')) + '-2070'
        done = git(dir, 'commit', '-qm', f'a fix ({code})', name='Fred', wrap=False)
        self.assertNotEqual(done.returncode, 0)
        self.assertIn('commit refused', done.stderr)
        self.assertEqual(git(dir, 'commit', '-qm', 'a fix', name='Fred', wrap=False).returncode, 0)

    def test_a_refused_author_without_the_bots_git_is_refused_too(self):
        dir = self.repo(True)
        done = git(dir, 'commit', '-qm', 'one change', name=LEAD, wrap=False)
        self.assertNotEqual(done.returncode, 0)
        self.assertIn('belongs to one person', done.stderr)


if __name__ == '__main__':
    unittest.main()
