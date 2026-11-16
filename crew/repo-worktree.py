#!/usr/bin/env python3
"""Makes a job worktree of a repo in the one place worktrees belong: <projects folder>/<repo>/.botyard/worktrees/<name>.
No AI. A job's own worktree is made by the engine; this is for the second repo a job needs (a job that also
changes a second repo, an audit), so nobody makes `tools-1029` or `wt-x` beside the projects.

    repo-worktree.py REPO NAME [--branch BRANCH] [--base REF]    prints the path of the new worktree
    repo-worktree.py REPO NAME --path                            prints the path it would use, creates nothing

REPO is a folder name under the projects folder. BRANCH defaults to NAME, BASE to main. When the branch exists it is
checked out as it is; a worktree already there is reused. Nothing is ever removed.
"""
import argparse
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import botyard_home  # noqa: E402

SAFE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]*$')


def target(repo, name, root=None):
    root = root or botyard_home.projects()
    for part in (repo, name):
        if not SAFE.match(part or '') or '..' in part:
            raise ValueError(f'"{part}" is not a plain folder name')
    return os.path.join(root, repo, '.botyard', 'worktrees', name)


def make(repo, name, branch=None, base='main', root=None, dry=False):
    path = target(repo, name, root)
    folder = os.path.dirname(os.path.dirname(os.path.dirname(path)))
    if dry or os.path.isdir(path):
        return path
    if not os.path.isdir(os.path.join(folder, '.git')) and not os.path.isfile(os.path.join(folder, '.git')):
        raise ValueError(f'{folder} is not a git repo')
    branch = branch or name
    exists = subprocess.run(['git', '-C', folder, 'rev-parse', '--verify', '--quiet', f'refs/heads/{branch}'], capture_output=True).returncode == 0
    args = ['worktree', 'add', path, branch] if exists else ['worktree', 'add', '-b', branch, path, base]
    done = subprocess.run(['git', '-C', folder, *args], capture_output=True, text=True)
    if done.returncode:
        raise RuntimeError(done.stderr.strip() or 'git worktree add failed')
    return path


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('repo')
    ap.add_argument('name')
    ap.add_argument('--branch')
    ap.add_argument('--base', default='main')
    ap.add_argument('--path', action='store_true', help='print the path only, create nothing')
    a = ap.parse_args(argv)
    try:
        print(make(a.repo, a.name, a.branch, a.base, dry=a.path))
    except (ValueError, RuntimeError) as e:
        print(f'repo-worktree: {e}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
