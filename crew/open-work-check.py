#!/usr/bin/env python3
"""Open work that is not moving, found and settled. No AI.

On 24 Nov 2026 only 7 of 78 open jobs had a run going: 36 were older tries of a goal that had a newer job, and many
more sat "in progress" or "blocked" for days with nobody on them. A job says "in progress" only while work moves.

    python3 open-work-check.py            measure, settle what is safe, write crew/open-work.json, one line per action
    python3 open-work-check.py --dry      say what it would settle, change nothing
    python3 open-work-check.py --check    exit 1 when open work is still not moving after settling (for health.py)

What it settles, never touching a job with a run going on it, or one with open jobs under it (a request whose
steps are still at work), or one changed in the last `--idle` hours (12 by default):

    an older open try of a goal that has a newer job   closed (cancelled), with which job carries the goal now
    a job "in progress" with nothing done for a day     blocked, with why, so it is seen instead of looking busy

What it only measures: jobs blocked for more than three days (each is someone's decision to make).
"""
import argparse
import datetime as dt
import json
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, HERE)
import botyard_home  # noqa: E402

OUT = 'open-work.json'
OPEN = ('todo', 'in_progress', 'blocked')
# What a job's title says beyond its goal: a fix round, a check, a track's step or round.
GOAL_NOISE = re.compile(r'^(?:fix \d+ of |check [a-z]+-\d+(?: \([^)]*\))?: |review [a-z]+-\d+: )|\s*·.*$|\s*\(round \d+\)$', re.I)
STALL_HOURS = 24
BLOCKED_DAYS = 3


def goal_of(title):
    """The goal a job works on: "Fix 2 of Crew: X", "Crew: X · Build (round 3)" and "Crew: X" share one."""
    text = (title or '').strip()
    for _ in range(3):
        text = GOAL_NOISE.sub('', text).strip()
    return text.lower()


def when(job, *keys):
    for key in keys:
        text = job.get(key)
        if text:
            try:
                return dt.datetime.fromisoformat(str(text).replace('Z', '+00:00'))
            except ValueError:
                continue
    return None


def plan(jobs, live, now, idle_hours=12, requests=()):
    """What to do: [{'job', 'id', 'to', 'why'}] and what to say: {'stalled', 'blocked_long', 'duplicates'}.
    `live` holds the ids of jobs with a run going; `requests` the jobs of track requests still moving, which their
    track closes itself (a track runs on without its request's job, so a script never closes one). Pure, so it can be tested."""
    parents = {j.get('parentId') for j in jobs if j.get('status') in OPEN and j.get('parentId')} | set(requests)
    touched = lambda j: when(j, 'lastActivityAt', 'updatedAt', 'createdAt')
    resting = lambda j: j['id'] not in live and j['id'] not in parents and touched(j) and now - touched(j) >= dt.timedelta(hours=idle_hours)
    goals = {}
    for j in jobs:
        g = goal_of(j.get('title'))
        if g and j.get('status') in OPEN + ('done',):
            goals.setdefault(g, []).append(j)
    actions, closed = [], set()
    for g, family in goals.items():
        family.sort(key=lambda j: when(j, 'createdAt') or now)
        for older in family[:-1]:
            if older.get('status') not in OPEN or not resting(older):
                continue
            newer = [j for j in family if (when(j, 'createdAt') or now) > (when(older, 'createdAt') or now) and j['id'] != older['id']]
            if not newer:
                continue
            carrier = newer[-1]
            actions.append({'job': older.get('identifier'), 'id': older['id'], 'to': 'cancelled',
                            'why': f"Closed: an older try of this goal. {carrier.get('identifier')} ({carrier.get('status')}) carries it now."})
            closed.add(older['id'])
    for j in jobs:
        if j['id'] in closed or j.get('status') != 'in_progress' or not resting(j):
            continue
        idle = now - touched(j)
        if idle >= dt.timedelta(hours=STALL_HOURS):
            actions.append({'job': j.get('identifier'), 'id': j['id'], 'to': 'blocked',
                            'why': f"Blocked: nothing was done on it for {int(idle.total_seconds() // 3600)} hours and no run is on it. "
                                   "Whoever owns it picks it up again or closes it."})
    left_open = [j for j in jobs if j.get('status') in OPEN and j['id'] not in closed]
    say = {
        'stalled': sorted(j.get('identifier') for j in left_open if j.get('status') == 'in_progress' and resting(j)
                          and now - touched(j) >= dt.timedelta(hours=STALL_HOURS)),
        'blocked_long': sorted(j.get('identifier') for j in left_open if j.get('status') == 'blocked' and touched(j)
                               and now - touched(j) >= dt.timedelta(days=BLOCKED_DAYS)),
        'duplicates': sorted(g for g, family in goals.items() if sum(1 for j in family if j.get('status') in OPEN and j['id'] not in closed) > 1),
    }
    return actions, say


def call(method, path, body=None):
    req = urllib.request.Request(botyard_home.api() + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as res:
        raw = res.read()
    return json.loads(raw) if raw else {}


def main(argv=None):
    parser = argparse.ArgumentParser(description='Open work that is not moving, found and settled.')
    parser.add_argument('--dry', action='store_true')
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--idle', type=float, default=12, help='hours a job must be untouched before it is settled')
    args = parser.parse_args(argv)
    studio = botyard_home.studio_id()
    if not studio:
        print('Botyard is not running: nothing measured')
        return 0
    jobs = []
    for status in OPEN + ('done',):
        got = call('GET', f'/companies/{studio}/issues?status={status}&limit=100000')
        jobs += got if isinstance(got, list) else got.get('issues', [])
    live = {r.get('issueId') for r in call('GET', f'/companies/{studio}/live-runs') if r.get('issueId')}
    moving = set()
    for status in ('working', 'not-in-main'):
        try:
            moving |= {r.get('jobId') for r in call('GET', f'/companies/{studio}/requests?status={status}&limit=500') if r.get('jobId')}
        except Exception:  # noqa: BLE001 - an engine with no tracks has no requests
            pass
    now = dt.datetime.now(dt.timezone.utc)
    actions, say = plan(jobs, live, now, args.idle, moving)
    done = []
    for a in actions:
        if args.dry:
            print(f"would set {a['job']} {a['to']}: {a['why']}")
            continue
        try:
            call('POST', f"/issues/{a['id']}/comments", {'body': a['why']})
            call('PATCH', f"/issues/{a['id']}", {'status': a['to']})
            done.append(a)
            print(f"{a['job']} {a['to']}: {a['why']}")
        except Exception as err:  # noqa: BLE001 - one refused job never stops the rest
            print(f"{a['job']}: could not be set {a['to']}: {err}")
    out = {'at': now.isoformat(), 'settled': done, **say}
    if not args.dry:
        path = botyard_home.state(OUT)
        with open(path + '.tmp', 'w', encoding='utf8') as f:
            json.dump(out, f, indent=1)
        os.replace(path + '.tmp', path)
    print(f"open work: {len(done) if not args.dry else len(actions)} settled; {len(say['stalled'])} stalled, "
          f"{len(say['blocked_long'])} blocked over {BLOCKED_DAYS} days, {len(say['duplicates'])} goals with more than one open job")
    return 1 if args.check and (say['stalled'] or say['duplicates']) else 0


def faults():
    """For health.py: open work still not moving after the last settling (measured again when older than a day)."""
    try:
        with open(botyard_home.state(OUT), encoding='utf8') as f:
            data = json.load(f)
    except (OSError, ValueError):
        return []
    out = [f'{n} jobs are in progress with nothing done for a day: {", ".join(data["stalled"][:6])}' for n in [len(data.get('stalled') or [])] if n]
    out += [f'{n} goals have more than one open job: {", ".join(data["duplicates"][:4])}' for n in [len(data.get('duplicates') or [])] if n]
    return out


if __name__ == '__main__':
    sys.exit(main())
