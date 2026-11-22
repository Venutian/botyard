#!/usr/bin/env python3
"""Keeps each repository's main checkout on its main branch. No AI.

The service and the scripts run from the main checkouts in the projects folder; bots work in worktrees. A main checkout
found on another branch (19 Nov 2026: a build's `git checkout -b` left one on its job branch for seven hours) is put
back on main when nothing would be lost: no tracked file changed, and the commits it holds stay on their branch. Anything
else is a fault line for the health check, saying what is there.

    main-checkout.py           put drifted main checkouts back, print what could not be (exit 1 when any)
    main-checkout.py --dry     only say what it would do
"""
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import botyard_home  # noqa: E402


def git(repo, *args):
    done = subprocess.run(['git', '-C', repo, *args], capture_output=True, text=True, timeout=60)
    return done.returncode, done.stdout.strip()


def main_checkouts(folder=None):
    folder = folder or botyard_home.projects()
    try:
        names = sorted(os.listdir(folder))
    except OSError:
        return []
    return [os.path.join(folder, n) for n in names if os.path.isdir(os.path.join(folder, n, '.git'))]


HOMES = ('main', 'master')


def home_branch(repo):
    """main where it exists, else master, else what the remote calls its default."""
    for name in HOMES:
        if git(repo, 'rev-parse', '--verify', '-q', f'refs/heads/{name}')[0] == 0:
            return name
    code, out = git(repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
    return out.split('/', 1)[1] if code == 0 and '/' in out else ''


CODE = ('.py', '.mjs', '.js', '.cjs', '.ts', '.tsx', '.sh', '.css', '.html')


def ignored(repo, settings=None):
    """Paths a studio keeps live state in (a bot's ledger, say), from config/main-checkout.json {"ignore": {repo: [prefix]}}."""
    try:
        with open(settings or os.path.join(botyard_home.config_dir(), 'main-checkout.json')) as f:
            return tuple((json.load(f).get('ignore') or {}).get(os.path.basename(repo), []))
    except (OSError, ValueError, AttributeError):
        return ()


def uncommitted(repo, settings=None):
    """'' unless code files in the main checkout differ from its commit: the service runs them, and nothing tested them
    (20 Nov 2026: six engine and runner files edited in place ran live through every restart)."""
    skip = ignored(repo, settings)
    files = [line.split(None, 1)[-1] for line in git(repo, 'status', '--porcelain', '--untracked-files=no')[1].splitlines() if line.strip()]
    code = [f for f in files if f.endswith(CODE) and not f.startswith(skip)]
    if not code:
        return ''
    return (f'{os.path.basename(repo)}: main checkout has uncommitted code edits ({", ".join(code[:6])}'
            f'{" and more" if len(code) > 6 else ""}); they run live untested. Move them to a branch with tests and land them')


def check(repo, dry=False):
    """'' when the checkout is on its main branch (or was put back), else the fault."""
    home = home_branch(repo)
    if not home:
        return ''
    code, now = git(repo, 'symbolic-ref', '-q', '--short', 'HEAD')
    if code == 0 and (now == home or now in HOMES):
        return uncommitted(repo)
    name = os.path.basename(repo)
    if git(repo, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')[0] == 0 or os.path.exists(os.path.join(repo, '.git', 'rebase-merge')):
        return f'{name}: main checkout is mid-merge or rebase on {now or "a detached commit"}; finish or abort it by hand'
    changed = git(repo, 'status', '--porcelain', '--untracked-files=no')[1]
    if changed:
        files = ', '.join(line.split(None, 1)[-1] for line in changed.splitlines()[:5])
        return f'{name}: main checkout is on {now or "a detached commit"}, not {home}, with changed files ({files}); left as it is'
    if code != 0 and not git(repo, 'branch', '--contains', 'HEAD', '--format=%(refname:short)')[1]:
        return f'{name}: main checkout is on a detached commit no branch holds; left as it is so nothing is lost'
    if dry:
        return f'{name}: would put the main checkout back on {home} (was on {now or "a detached commit"})'
    if git(repo, 'switch', '-q', home)[0] != 0:
        return f'{name}: main checkout is on {now}, and switching back to {home} failed'
    with open(botyard_home.state('main-checkout.log'), 'a') as f:
        f.write(f"{time.strftime('%Y-%m-%d %H:%M')} {name}: put back on {home} (was on {now or 'a detached commit'})\n")
    return ''


def faults(folder=None, dry=False):
    return [f for f in (check(r, dry) for r in main_checkouts(folder)) if f]


def main(argv):
    out = faults(dry='--dry' in argv)
    for line in out:
        print(line)
    return 1 if out else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
