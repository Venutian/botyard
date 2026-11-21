#!/usr/bin/env python3
"""Jobs marked done whose code is still not in main. No AI.

A job's work is on a branch named after the job (`<CODE>-<title>`, the engine's own naming, also in any other
project repo the job touched). When the job is done but such a branch still holds commits that are not in main and
that change code (not only notes, reports or pictures), the work never landed: a merge that failed, a second repo
nobody merged, a hold that was never ruled on. This lists every one, so none stays "done" unseen.

    python3 not-in-main.py              measure, write crew/not-in-main.json, one line per job
    python3 not-in-main.py --hours 6    only jobs done at least this long ago (default 6: a landing in progress is not
                                        a fault)
    python3 not-in-main.py --check      exit 1 when any job is listed (for health.py)

The page reads crew/not-in-main.json: a listed job shows "Done, not in main" and the list says how many there are.
Branches of jobs that are not done (open, cancelled) are not listed: a cancelled job's branch is the owner's to keep
or drop. Read-only on every repo: it runs git cherry, git diff and git for-each-ref, nothing that writes.
"""
import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, HERE)
import botyard_home  # noqa: E402

JOB_BRANCH = re.compile(r'^([A-Z][A-Z0-9]*-\d+)(?:-|$)')
PICTURES = ('.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif')
NOTES = ('.md', '.txt')
NOTE_DIRS = ('notes/', 'reports/', 'docs/notes/')
OUT = 'not-in-main.json'


def git(repo, *args):
    done = subprocess.run(['git', '-C', repo, *args], capture_output=True, text=True, timeout=120)
    return done.stdout if done.returncode == 0 else ''


def is_code(path):
    low = path.lower()
    return not (low.endswith(PICTURES) or low.endswith(NOTES) or any(low.startswith(d) or f'/{d}' in low for d in NOTE_DIRS))


def main_of(repo):
    for name in ('main', 'master'):
        if git(repo, 'rev-parse', '--verify', '--quiet', f'refs/heads/{name}').strip():
            return name
    return ''


def lands_nothing(repo, base, branch):
    """True when merging the branch into main would leave main's tree as it is: its work reached main under other
    commits (a re-applied fix, a squash, a later job's merge), which git cherry cannot see. A merge with conflicts is
    never "nothing": that branch still holds work, and stays listed."""
    done = subprocess.run(['git', '-C', repo, 'merge-tree', '--write-tree', base, branch], capture_output=True, text=True, timeout=120)
    tree = done.stdout.split('\n', 1)[0].strip()
    return done.returncode == 0 and bool(tree) and tree == git(repo, 'rev-parse', f'{base}^{{tree}}').strip()


def left_behind(repo):
    """[(job code, branch, commits not in main, code files changed)] for every job-named branch of one repo."""
    base = main_of(repo)
    if not base:
        return []
    out = []
    for branch in git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split():
        match = JOB_BRANCH.match(branch)
        if not match or branch == base:
            continue
        ahead = [line for line in git(repo, 'cherry', base, branch).splitlines() if line.startswith('+')]
        if not ahead:
            continue
        if lands_nothing(repo, base, branch):
            continue
        files = [f for f in git(repo, 'diff', '--name-only', f'{base}...{branch}').split() if is_code(f)]
        if files:
            out.append((match.group(1), branch, len(ahead), files))
    return out


def project_repos(projects):
    """The git folder of every live project, once each."""
    seen = []
    for p in projects:
        if p.get('archivedAt'):
            continue
        for w in p.get('workspaces') or []:
            cwd = w.get('cwd')
            if cwd and os.path.exists(os.path.join(cwd, '.git')):
                real = os.path.realpath(cwd)
                if real not in seen:
                    seen.append(real)
    return seen


def done_at(job):
    text = job.get('completedAt') or job.get('updatedAt') or ''
    try:
        return dt.datetime.fromisoformat(text.replace('Z', '+00:00'))
    except ValueError:
        return None


def measure(projects, jobs, hours=6, now=None, scan=left_behind, bots=None):
    """The rows to list: done jobs, done at least `hours` ago, with a branch whose code is not in main."""
    now = now or dt.datetime.now(dt.timezone.utc)
    by_code = {j.get('identifier'): j for j in jobs}
    rows = []
    for repo in project_repos(projects):
        for code, branch, commits, files in scan(repo):
            job = by_code.get(code)
            if not job or job.get('status') != 'done':
                continue
            when = done_at(job)
            if when and now - when < dt.timedelta(hours=hours):
                continue
            rows.append({'job': code, 'id': job.get('id'), 'title': (job.get('title') or '')[:140], 'repo': repo,
                         'branch': branch, 'commits': commits, 'files': len(files), 'sample': files[:5],
                         'doneAt': when.isoformat() if when else None,
                         'bot': (bots or {}).get(job.get('assigneeAgentId'), '')})
    rows.sort(key=lambda r: (r['doneAt'] or '', r['job']))
    return rows


def call(path):
    with urllib.request.urlopen(botyard_home.api() + path, timeout=30) as res:
        return json.load(res)


def main(argv=None):
    parser = argparse.ArgumentParser(description='Jobs marked done whose code is still not in main.')
    parser.add_argument('--hours', type=float, default=6)
    parser.add_argument('--check', action='store_true', help='exit 1 when any job is listed')
    args = parser.parse_args(argv)
    studio = botyard_home.studio_id()
    if not studio:
        print('Botyard is not running: nothing measured')
        return 0
    bots = {a['id']: a.get('name', '') for a in call(f'/companies/{studio}/agents')}
    rows = measure(call(f'/companies/{studio}/projects'), call(f'/companies/{studio}/issues?limit=100000'), hours=args.hours, bots=bots)
    out = {'at': dt.datetime.now(dt.timezone.utc).isoformat(), 'hours': args.hours, 'jobs': rows}
    path = botyard_home.state(OUT)
    with open(path + '.tmp', 'w', encoding='utf8') as f:
        json.dump(out, f, indent=1)
    os.replace(path + '.tmp', path)
    for r in rows:
        print(f"{r['job']} done {(r['doneAt'] or '?')[:16]}: {r['commits']} commit(s), {r['files']} code file(s) not in main "
              f"on {r['branch']} in {botyard_home.short(r['repo'])}")
    print(f'not in main: {len(rows)} done job(s)' if rows else 'not in main: none')
    return 1 if args.check and rows else 0


def faults():
    """For health.py: one line per done job whose code is not in main, from the last measure (measured again when
    it is older than a day)."""
    path = botyard_home.state(OUT)
    try:
        with open(path, encoding='utf8') as f:
            data = json.load(f)
        fresh = dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(data['at']) < dt.timedelta(days=1)
    except (OSError, ValueError, KeyError):
        data, fresh = None, False
    if not fresh:
        try:
            main([])
            with open(path, encoding='utf8') as f:
                data = json.load(f)
        except (OSError, ValueError, urllib.error.URLError):
            return []
    return [f"{r['job']} is done but {r['commits']} commit(s) on {r['branch']} are not in main" for r in data.get('jobs', [])]


if __name__ == '__main__':
    sys.exit(main())
