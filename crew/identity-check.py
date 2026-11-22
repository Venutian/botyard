#!/usr/bin/env python3
"""Fails when a commit made on this PC could be authored under an address that is not the studio's own GitHub
no-reply (git_identity.no_reply(): BOTYARD_GIT_NOREPLY, else the owner's own global user.email). Another no-reply,
such as t@users.noreply.github.com, is a fault: on GitHub it is a stranger's account.
No AI. One line per fault on stdout, exit 1 when there is any, 0 when there is none. Botyard runs it on its
timetable, and every Claude bot's launcher runs `--sandbox` before the bot starts.

It looks at three things:
  the sandbox gitconfig every bot runs under (GIT_CONFIG_GLOBAL, else <crew folder>/codex-safe/gitconfig);
  the local config of every worktree of the repos given (default: the repo this file is in);
  the runner environment: GIT_AUTHOR_EMAIL / GIT_COMMITTER_EMAIL as set, and the identity git_identity.py would give.

    python3 identity-check.py [--gitconfig FILE] [--repo DIR ...]
    python3 identity-check.py --sandbox [--gitconfig FILE]   only the sandbox gitconfig (fast, for a launcher)
"""
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import git_identity  # noqa: E402


def good(mail, env=None):
    return git_identity.is_studio(mail, env)


def config_value(args, key, cwd=None):
    done = subprocess.run(['git', *(['-C', cwd] if cwd else []), 'config', *args, key], capture_output=True, text=True)
    return done.stdout.strip()


def sandbox_path(env):
    if env.get('GIT_CONFIG_GLOBAL') and env['GIT_CONFIG_GLOBAL'] != os.devnull:
        return env['GIT_CONFIG_GLOBAL']
    import botyard_home
    return os.path.join(botyard_home.places(env)['crew'], 'codex-safe', 'gitconfig')


def worktrees(repo):
    done = subprocess.run(['git', '-C', repo, 'worktree', 'list', '--porcelain'], capture_output=True, text=True)
    paths = [line[9:] for line in done.stdout.splitlines() if line.startswith('worktree ')]
    return paths or [repo]


def sandbox_faults(env, path, wrong_only=False):
    """The sandbox file's faults. wrong_only (a launcher's check): only an address that is there and is not the
    studio's, so a fresh clone with no address yet still runs; the timetable's full check reports the rest."""
    if not os.path.isfile(path):
        return [] if wrong_only else [f'sandbox gitconfig {path}: missing']
    mail = config_value(['-f', path], 'user.email')
    if wrong_only and not mail:
        return []
    if not good(mail, env):
        studio = git_identity.no_reply(env) or 'none set'
        return [f'sandbox gitconfig {path}: user.email is {mail or "not set"}, not the studio address ({studio}); '
                f'run crew/setup-bots.py to write it again']
    return []


def faults(env=None, gitconfig=None, repos=None, sandbox_only=False):
    env = dict(os.environ if env is None else env)
    out = sandbox_faults(env, gitconfig or sandbox_path(env), wrong_only=sandbox_only)
    if sandbox_only:
        return out
    for key in ('GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL', 'EMAIL'):
        if env.get(key) and not good(env[key], env):
            out.append(f'environment: {key} is {env[key]}, not the studio address')
    if not git_identity.identity_env('bot', env):
        out.append('environment: no studio no-reply address to sign commits with (set BOTYARD_GIT_NOREPLY)')
    for repo in repos or []:
        for tree in worktrees(repo):
            for mail in sorted({config_value([scope], 'user.email', cwd=tree) for scope in ('--local', '--worktree')} - {''}):
                if not good(mail, env):
                    out.append(f'worktree {tree}: local user.email is {mail}, not the studio address')
    return out


def main(argv):
    gitconfig, repos, sandbox_only = None, [], '--sandbox' in argv
    it = iter(argv)
    for arg in it:
        if arg == '--gitconfig':
            gitconfig = next(it, None)
        elif arg == '--repo':
            repos.append(next(it, ''))
    found = faults(gitconfig=gitconfig, sandbox_only=sandbox_only,
                   repos=repos or [os.path.dirname(os.path.dirname(os.path.realpath(__file__)))])
    print('\n'.join(found) if found else 'identity-check: ok')
    return 1 if found else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
