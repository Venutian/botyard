#!/usr/bin/env python3
"""Checks a closing report's COMMIT line before the job is closed done. No AI.

    commit-line.py < report       exit 0 when the line is sound or there is none, 1 with the reason on stderr

The review script lands the commit a build names on its COMMIT line, and nothing else. A line that names no real
commit gets no check and no landing, and the job stays "done, not in main" (21 Nov 2026: of one builder's 40 such
jobs, one report gave `$(git rev-parse HEAD)` as written, one a full hash whose last 33 characters were made up,
three a short hash; another bot's report gave 41 characters). So a done report's COMMIT line, when it names a hash, must name the full
40-character hash of a commit in one of the projects' repos; and when it names a branch of that repo, the commit
must be that branch's tip, or the commits after it never land. A line with no hash ("COMMIT: none") is left to the
review script, which says the report has no commit.
"""
import os
import re
import subprocess
import sys

LINE = re.compile(r'^\W*COMMIT:[ \t]*(.*)$', re.I | re.M)
HEX = re.compile(r'^[0-9a-f]{7,}$', re.I)


def git(repo, *args):
    try:
        done = subprocess.run(['git', '-C', repo, *args], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return done.stdout.strip() if done.returncode == 0 else None


def repos(cwd=None, env=None):
    """The repo the run is in, then every repo in the projects folder, once each."""
    env = os.environ if env is None else env
    seen = []
    here = git(cwd or os.getcwd(), 'rev-parse', '--show-toplevel')
    if here:
        seen.append(os.path.realpath(here))
    for top in (env.get('BOTYARD_PROJECTS_DIR'), env.get('BOTYARD_PROJECTS')):
        if not top or not os.path.isdir(top):
            continue
        for name in sorted(os.listdir(top)):
            path = os.path.realpath(os.path.join(top, name))
            if os.path.exists(os.path.join(path, '.git')) and path not in seen:
                seen.append(path)
    return seen


def problem(report, cwd=None, env=None):
    """Why the report's last COMMIT line cannot be landed, or None when it can (or names no hash)."""
    found = LINE.findall(report or '')
    if not found:
        return None
    value = found[-1].strip()
    words = [w.strip('()[],;:.\'"') for w in value.split()]
    if not words or not HEX.match(words[0]):
        if value.startswith(('$(', '`', '${')):
            return (f'the COMMIT line is "{value[:80]}": a command, not its answer (a quoted heredoc runs nothing). '
                    'Run git rev-parse HEAD, then write the 40-character hash itself.')
        return None
    commit = words[0].lower()
    if len(commit) != 40:
        return (f'the COMMIT line names {commit} ({len(commit)} characters): write the full 40-character hash that '
                'git rev-parse HEAD prints, copied, never typed from memory.')
    for repo in repos(cwd, env):
        if git(repo, 'cat-file', '-e', f'{commit}^{{commit}}') is None:
            continue
        for word in words[1:]:
            tip = git(repo, 'rev-parse', '--verify', '--quiet', f'refs/heads/{word}') if word else None
            if tip and tip != commit:
                return (f'the COMMIT line names {commit[:10]}, but branch {word} in {repo} ends at {tip[:10]}: the commits '
                        'after it would never land. Name the tip (git rev-parse HEAD on that branch).')
        return None
    return (f'the COMMIT line names {commit[:10]}, which is no commit in any project repo. '
            'Copy the hash git rev-parse HEAD prints in the worktree you committed in.')


def main():
    why = problem(sys.stdin.read())
    if why:
        print(f'Not closed: {why}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
