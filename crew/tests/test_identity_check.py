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
STRANGER = 't@users.noreply.github.com'  # GitHub's account `t`: what the sandbox held from 19 to 22 Nov
OTHER = '9+someone@users.noreply.github.com'


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
            self.assertTrue(any('no studio no-reply' in x for x in check.faults(env={'HOME': d, 'GIT_CONFIG_GLOBAL': '/dev/null'}, gitconfig=gitconfig_file(d, NO_REPLY))))

    def test_another_no_reply_is_not_the_studio_address(self):
        with tempfile.TemporaryDirectory() as d:
            env = {'BOTYARD_GIT_NOREPLY': NO_REPLY}
            for mail in (STRANGER, OTHER):
                found = check.faults(env=env, gitconfig=gitconfig_file(d, mail))
                self.assertEqual(len(found), 1, mail)
                self.assertIn(mail, found[0])
                self.assertTrue(any('GIT_AUTHOR_EMAIL' in x for x in check.faults(env={**env, 'GIT_AUTHOR_EMAIL': mail}, gitconfig=gitconfig_file(d, NO_REPLY))))

    def test_the_launcher_check_fails_only_on_a_wrong_sandbox_address(self):
        with tempfile.TemporaryDirectory() as d:
            env = {'BOTYARD_GIT_NOREPLY': NO_REPLY}
            self.assertEqual(check.faults(env=env, gitconfig=gitconfig_file(d, NO_REPLY), sandbox_only=True), [])
            self.assertEqual(check.faults(env=env, gitconfig=gitconfig_file(d, None), sandbox_only=True), [])  # a fresh clone runs
            self.assertEqual(check.faults(env=env, gitconfig=os.path.join(d, 'none'), sandbox_only=True), [])
            self.assertTrue(check.faults(env=env, gitconfig=gitconfig_file(d, STRANGER), sandbox_only=True))
            run = lambda path: subprocess.run(['python3', os.path.join(CREW, 'identity-check.py'), '--sandbox', '--gitconfig', path],
                                              capture_output=True, text=True, env={**os.environ, **env})
            self.assertEqual(run(gitconfig_file(d, NO_REPLY)).returncode, 0)
            done = run(gitconfig_file(d, STRANGER))
            self.assertEqual(done.returncode, 1)
            self.assertIn(STRANGER, done.stdout)

    def test_the_claude_launcher_refuses_to_start_on_a_wrong_sandbox_address(self):
        with tempfile.TemporaryDirectory() as d:
            fake = os.path.join(d, 'claude')
            with open(fake, 'w') as f:
                f.write('#!/bin/sh\necho started\n')
            os.chmod(fake, 0o755)
            env = {**os.environ, 'BOTYARD_GIT_NOREPLY': NO_REPLY, 'BOTYARD_CLAUDE': fake, 'BOTYARD_CONNECTORS': 'off'}
            launch = lambda path: subprocess.run(['sh', os.path.join(CREW, 'claude-bot.sh')], capture_output=True, text=True,
                                                 env={**env, 'GIT_CONFIG_GLOBAL': path}, timeout=60)
            self.assertIn('started', launch(gitconfig_file(d, NO_REPLY)).stdout)
            done = launch(gitconfig_file(d, STRANGER))
            self.assertNotEqual(done.returncode, 0)
            self.assertNotIn('started', done.stdout)
            self.assertIn(STRANGER, done.stderr)

    def test_the_check_is_on_the_timetable(self):
        import json
        with open(os.path.join(CREW, 'timetable.json')) as f:
            jobs = {j['name']: j for j in json.load(f)['jobs']}
        self.assertIn('{scripts}/identity-check.py', jobs['identity']['command'])
        self.assertTrue(jobs['identity']['on'])


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
            for mail in (STRANGER, OTHER):  # a no-reply that is not the studio's is replaced too
                self.assertFalse(setup.gitconfig_ok(gitconfig_file(d, mail)), mail)
            self.assertTrue(setup.gitconfig_ok_text(setup.gitconfig(NO_REPLY)))
            self.assertFalse(setup.gitconfig_ok_text(setup.gitconfig(STRANGER)))
            self.assertFalse(setup.gitconfig_ok_text(setup.gitconfig('')))

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
                # The engine keeps each value as {'type': 'plain', 'value': ...}; older configs held the bare string.
                value = lambda key: env[key]['value'] if isinstance(env[key], dict) else env[key]
                self.assertEqual(value('GIT_AUTHOR_EMAIL'), NO_REPLY, slug)
                self.assertEqual(value('GIT_COMMITTER_NAME'), ident.first_name(slug), slug)
                with tempfile.TemporaryDirectory() as d:
                    plain = {k: (v['value'] if isinstance(v, dict) else v) for k, v in env.items() if k.startswith('GIT_') and k != 'GIT_CONFIG_GLOBAL'}
                    self.assertEqual(commit_as(plain, d), f'{ident.first_name(slug)} <{NO_REPLY}>|{ident.first_name(slug)} <{NO_REPLY}>')


if __name__ == '__main__':
    unittest.main()
