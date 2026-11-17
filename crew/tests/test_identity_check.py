"""Every runner path commits as the bot's first name with the studio no-reply; identity-check.py fails on anything else."""
import importlib.util
import os
import subprocess
import tempfile
import unittest

from test_git_identity import CREW, NO_REPLY, commit_as, ident, load  # also sets BOTYARD_GIT_NOREPLY

check = load('identity_check', 'identity-check.py')
setup = load('setup_bots', 'setup-bots.py')
crew_set = load('crew_set', 'crew_set.py')
BAD = 'test@example.com'


def gitconfig_file(d, mail):
    path = os.path.join(d, 'gitconfig')
    with open(path, 'w') as f:
        f.write(f'[user]\n\tname = Test User\n\temail = {mail}\n' if mail else '[core]\n')
    return path


class IdentityCheck(unittest.TestCase):
    def test_passes_on_a_no_reply_and_fails_on_the_old_test_address(self):
        with tempfile.TemporaryDirectory() as d:
            env = {'BOTYARD_GIT_NOREPLY': NO_REPLY}
            self.assertEqual(check.faults(env=env, gitconfig=gitconfig_file(d, NO_REPLY)), [])
            found = check.faults(env=env, gitconfig=gitconfig_file(d, BAD))
            self.assertEqual(len(found), 1)
            self.assertIn(BAD, found[0])
            self.assertTrue(check.faults(env=env, gitconfig=gitconfig_file(d, None)))

    def test_fails_on_a_bad_runner_environment_and_a_bad_worktree(self):
        with tempfile.TemporaryDirectory() as d:
            good = gitconfig_file(d, NO_REPLY)
            self.assertTrue(any('GIT_AUTHOR_EMAIL' in x for x in check.faults(env={'BOTYARD_GIT_NOREPLY': NO_REPLY, 'GIT_AUTHOR_EMAIL': BAD}, gitconfig=good)))
            repo = os.path.join(d, 'r')
            subprocess.run(['git', 'init', '-q', repo], check=True)
            subprocess.run(['git', '-C', repo, 'config', '--local', 'user.email', BAD], check=True)
            found = check.faults(env={'BOTYARD_GIT_NOREPLY': NO_REPLY}, gitconfig=good, repos=[repo])
            self.assertEqual(len(found), 1)
            self.assertIn(BAD, found[0])

    def test_no_no_reply_anywhere_is_a_fault(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertTrue(any('no no-reply' in x for x in check.faults(env={'HOME': d, 'GIT_CONFIG_GLOBAL': '/dev/null'}, gitconfig=gitconfig_file(d, NO_REPLY))))


class RunnerPaths(unittest.TestCase):
    def test_generated_sandbox_config_authors_as_the_no_reply(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, 'gitconfig')
            with open(path, 'w') as f:
                f.write(setup.gitconfig(NO_REPLY))
            self.assertEqual(check.faults(env={'BOTYARD_GIT_NOREPLY': NO_REPLY}, gitconfig=path), [])
            repo = os.path.join(d, 'repo')
            self.assertEqual(commit_as({'GIT_CONFIG_GLOBAL': path}, repo), f'Botyard bot <{NO_REPLY}>|Botyard bot <{NO_REPLY}>')

    def test_an_old_test_address_is_replaced_on_setup_and_a_reseed_never_writes_one(self):
        self.assertNotIn(BAD, setup.gitconfig(NO_REPLY))
        self.assertNotIn('[user]', setup.gitconfig(''))
        with tempfile.TemporaryDirectory() as d:
            path = gitconfig_file(d, BAD)
            self.assertFalse(setup.gitconfig_ok(path))
            self.assertTrue(setup.gitconfig_ok(gitconfig_file(d, NO_REPLY)))

    def test_claude_and_free_runners_commit_as_the_bots_first_name(self):
        with tempfile.TemporaryDirectory() as d:
            bad = gitconfig_file(d, BAD)
            env = {'GIT_CONFIG_GLOBAL': bad, **ident.identity_env('ben-the-mason')}  # what claude-bot.sh exports
            self.assertEqual(commit_as(env, os.path.join(d, 'a')), f'Ben <{NO_REPLY}>|Ben <{NO_REPLY}>')
            target = {'BOTYARD_BOT_NAME': 'fred', 'BOTYARD_GIT_NOREPLY': NO_REPLY}
            ident.apply(target)  # what free-runner.py does to its own environment
            env = {'GIT_CONFIG_GLOBAL': bad, **{k: v for k, v in target.items() if k.startswith('GIT_')}}
            self.assertEqual(commit_as(env, os.path.join(d, 'b')), f'Fred <{NO_REPLY}>|Fred <{NO_REPLY}>')

    def test_codex_and_antigravity_configs_carry_the_identity(self):
        crew = crew_set.CrewSet()
        for slug in crew.slugs():
            spec = crew.spec(slug)
            if spec['ai'] in ('codex', 'gemini'):
                env = crew.config(spec)['env']
                self.assertEqual(env['GIT_AUTHOR_EMAIL'], NO_REPLY, slug)
                self.assertEqual(env['GIT_COMMITTER_NAME'], ident.first_name(slug), slug)
                with tempfile.TemporaryDirectory() as d:
                    plain = {k: (v['value'] if isinstance(v, dict) else v) for k, v in env.items() if k.startswith('GIT_') and k != 'GIT_CONFIG_GLOBAL'}
                    self.assertEqual(commit_as(plain, d), f'{ident.first_name(slug)} <{NO_REPLY}>|{ident.first_name(slug)} <{NO_REPLY}>')


if __name__ == '__main__':
    unittest.main()
