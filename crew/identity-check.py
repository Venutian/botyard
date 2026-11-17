#!/usr/bin/env python3
"""Fails when a commit made on this PC could be authored under an address that is not a GitHub no-reply.
No AI. One line per fault on stdout, exit 1 when there is any, 0 when there is none.

It looks at three things:
  the sandbox gitconfig every bot runs under (GIT_CONFIG_GLOBAL, else <crew folder>/codex-safe/gitconfig);
  the local config of every worktree of the repos given (default: the repo this file is in);
  the runner environment: GIT_AUTHOR_EMAIL / GIT_COMMITTER_EMAIL as set, and the identity git_identity.py would give.

    python3 identity-check.py [--gitconfig FILE] [--repo DIR ...]
"""
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import git_identity  # noqa: E402


def good(mail):
    return bool(git_identity.SAFE.search((mail or '').strip()))


def config_value(args, key, cwd=None):
    done = subprocess.run(['git', *(['-C', cwd] if cwd else []), 'config', *args, key], capture_output=True, text=True)
    return done.stdout.strip()


def sandbox_path(env):
    if env.get('GIT_CONFIG_GLOBAL'):
        return env['GIT_CONFIG_GLOBAL']
    import botyard_home
    return os.path.join(botyard_home.places(env)['crew'], 'codex-safe', 'gitconfig')


def worktrees(repo):
    done = subprocess.run(['git', '-C', repo, 'worktree', 'list', '--porcelain'], capture_output=True, text=True)
    paths = [line[9:] for line in done.stdout.splitlines() if line.startswith('worktree ')]
    return paths or [repo]


def faults(env=None, gitconfig=None, repos=None):
    env = dict(os.environ if env is None else env)
    out = []
    path = gitconfig or sandbox_path(env)
    if not os.path.isfile(path):
        out.append(f'sandbox gitconfig {path}: missing')
    else:
        mail = config_value(['-f', path], 'user.email')
        if not good(mail):
            out.append(f'sandbox gitconfig {path}: user.email is {mail or "not set"}, not a GitHub no-reply address')
    for key in ('GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL', 'EMAIL'):
        if env.get(key) and not good(env[key]):
            out.append(f'environment: {key} is {env[key]}, not a GitHub no-reply address')
    if not git_identity.identity_env('bot', env):
        out.append('environment: no no-reply address to sign commits with (set BOTYARD_GIT_NOREPLY)')
    for repo in repos or []:
        for tree in worktrees(repo):
            for mail in sorted({config_value([scope], 'user.email', cwd=tree) for scope in ('--local', '--worktree')} - {''}):
                if not good(mail):
                    out.append(f'worktree {tree}: local user.email is {mail}, not a GitHub no-reply address')
    return out


def main(argv):
    gitconfig, repos = None, []
    it = iter(argv)
    for arg in it:
        if arg == '--gitconfig':
            gitconfig = next(it, None)
        elif arg == '--repo':
            repos.append(next(it, ''))
    found = faults(gitconfig=gitconfig, repos=repos or [os.path.dirname(os.path.dirname(os.path.realpath(__file__)))])
    print('\n'.join(found) if found else 'identity-check: ok')
    return 1 if found else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
