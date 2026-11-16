"""Every bot commits as its own first name with the studio's GitHub no-reply address and no other address."""
import importlib.util
import os
import re
import subprocess
import tempfile
import unittest

CREW = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
NO_REPLY = '25855689+Venutian@users.noreply.github.com'
SAFE_MAIL = re.compile(r'@users\.noreply\.github\.com$')  # the same pattern as own/review-guard.py
BOTS = {'bob-the-builder': 'Bob', 'chip-the-ripper': 'Chip', 'gideon-the-wise': 'Gideon', 'tony-yayo': 'Tony',
        'karen-the-kritik': 'Karen', 'dana-the-scout': 'Dana'}


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(CREW, file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ident = load('git_identity', 'git_identity.py')
runner = load('free_runner', 'free-runner.py')


def commit_as(env, cwd, extra=()):
    """Makes one commit the way a bot would, with whatever the bot tried to set, and returns author and committer."""
    base = {'PATH': '/usr/bin:/bin', 'HOME': cwd, 'GIT_CONFIG_NOSYSTEM': '1', **env}
    subprocess.run(['git', 'init', '-q', cwd], check=True, env=base)
    subprocess.run(['git', '-C', cwd, *extra, 'commit', '-q', '--allow-empty', '-m', 'x'], check=True, env=base)
    return subprocess.run(['git', '-C', cwd, 'log', '-1', '--format=%an <%ae>|%cn <%ce>'], capture_output=True, text=True, env=base).stdout.strip()


class GitIdentity(unittest.TestCase):
    def test_each_bots_environment_holds_only_the_no_reply_address(self):
        for slug, name in BOTS.items():
            env = ident.identity_env(slug)
            self.assertEqual(env['GIT_AUTHOR_NAME'], name)
            self.assertEqual(env['GIT_COMMITTER_NAME'], name)
            mails = {v for k, v in env.items() if k.endswith('EMAIL')}
            self.assertEqual(mails, {NO_REPLY})
            self.assertTrue(all(SAFE_MAIL.search(m) for m in mails))
        self.assertEqual(ident.identity_env('fred')['GIT_AUTHOR_NAME'], 'Fred')
        self.assertEqual(ident.identity_env('Freya The Checker')['GIT_AUTHOR_NAME'], 'Freya')

    def test_the_claude_launcher_exports_the_identity_from_the_bots_settings_file(self):
        with tempfile.TemporaryDirectory() as d:
            fake = os.path.join(d, 'claude')
            with open(fake, 'w') as f:
                f.write('#!/bin/sh\nenv | grep "^GIT_" | sort\n')
            os.chmod(fake, 0o755)
            out = subprocess.run(['sh', os.path.join(CREW, 'claude-bot.sh'), '--print', 'hi'], capture_output=True, text=True, cwd=d,
                                 env={'PATH': '/usr/bin:/bin', 'HOME': d, 'BOTYARD_CLAUDE': fake, 'BOTYARD_CONNECTORS': 'off',
                                      'BOTYARD_BOT_SETTINGS': '/x/bob-the-builder.claude.json',
                                      'GIT_AUTHOR_EMAIL': 'me@example.local'}).stdout
            self.assertIn('GIT_AUTHOR_NAME=Bob', out)
            self.assertIn(f'GIT_COMMITTER_EMAIL={NO_REPLY}', out)
            self.assertNotIn('example.local', out)

    def test_a_commit_in_a_fresh_worktree_through_the_free_runner_carries_the_no_reply_address(self):
        env = {'BOTYARD_CHECKER': ''}
        ident.apply(env)
        self.assertEqual(env['GIT_AUTHOR_NAME'], 'Fred')
        with tempfile.TemporaryDirectory() as d:
            # the model tries to sign as itself with -c and a git config: the environment still wins
            subprocess.run(['git', 'init', '-q', d], check=True)
            subprocess.run(['git', '-C', d, 'config', 'user.email', 'fred@example.local'], check=True)
            got = commit_as(env, d, extra=('-c', 'user.email=fred@example.local', '-c', 'user.name=Fred'))
        self.assertEqual(got, f'Fred <{NO_REPLY}>|Fred <{NO_REPLY}>')
        checker = {'BOTYARD_CHECKER': '1'}
        ident.apply(checker)
        self.assertEqual(checker['GIT_COMMITTER_NAME'], 'Freya')

    def test_main_of_the_free_runner_applies_the_identity(self):
        self.assertIn("git_identity.py').apply()", open(os.path.join(CREW, 'free-runner.py')).read())

    def test_the_push_check_refuses_a_local_address(self):
        self.assertFalse(SAFE_MAIL.search('fred@example.local'))
        self.assertFalse(SAFE_MAIL.search('someone@gmail.com'))
        self.assertTrue(SAFE_MAIL.search(NO_REPLY))
        guard = os.path.expanduser('~/studio/studio-own/own/review-guard.py')
        if os.path.exists(guard):  # the pattern here must be the guard's own
            self.assertIn(r"SAFE_MAIL = re.compile(r'@users\.noreply\.github\.com$')", open(guard).read())


if __name__ == '__main__':
    unittest.main()
