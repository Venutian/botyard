#!/usr/bin/env python3
"""A build session that has started a heavy job registers it here, ends its run, and is woken in the SAME
session when the job's done file appears. No AI while it waits.

    botyard-wait.py DONEFILE [DONEFILE ...] [--note TEXT]
                                           register (run it right after starting the job, detached). Several
                                           done files are one wait: the session is woken once, when the LAST
                                           one appears. A second registration for the same job joins the
                                           wait already there, so one job's session is never woken per arm.
    botyard-wait.py --wake                    the pass that wakes sessions; Botyard's timetable runs it every
                                           minute and health.py runs it too. --dry prints the requests.

Sessions use it as `botyard-wait` (install.sh links it onto ~/.local/bin). A registration is {issueId, agentId,
doneFiles, doneFile (the first, for older readers), startedAt, note}. It is woken at most once, and dropped when its
job is closed or a day old, or when the session has already run since the last done file appeared (something else
woke it: a second wake would only re-read the whole session to find nothing new).
A deliberate end is an ordinary finished run with the job left in_progress: the engine counts only failed
or timed-out runs against a job's retries, so nothing is retried or blocked, and the session writes the
state of the wait in one comment so the wake finds it.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import botyard_home  # noqa: E402

HOME = os.path.expanduser('~')
API = os.environ.get('BOTYARD_API') or botyard_home.api()
FILE = botyard_home.state('waits.json')
MAX_AGE = 24 * 3600
CLOSED = ('done', 'cancelled')


def load():
    try:
        return json.load(open(FILE))
    except (OSError, ValueError):
        return []


def save(waits):
    tmp = FILE + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(waits, f, indent=1)
    os.replace(tmp, FILE)


def files_of(wait):
    """The done files a wait is for: doneFiles, or the one doneFile of a registration made before lists."""
    return list(wait.get('doneFiles') or ([wait['doneFile']] if wait.get('doneFile') else []))


def register(done_files, note='', env=None, now=None):
    """One wait per job: these done files join any the job's session registered before."""
    env = env or os.environ
    if isinstance(done_files, str):
        done_files = [done_files]
    issue, agent = botyard_home.run_var('JOB_ID', env=env), botyard_home.run_var('BOT_ID', env=env)
    if not issue or not agent:
        raise SystemExit(f"botyard-wait: run it inside a job ({botyard_home.var_name('JOB_ID')} and {botyard_home.var_name('BOT_ID')} are not set)")
    waits = load()
    before = [w for w in waits if w['issueId'] == issue]
    files = []
    for f in [x for w in before for x in files_of(w)] + [os.path.abspath(d) for d in done_files]:
        if f not in files:
            files.append(f)
    notes = [w.get('note') for w in before if w.get('note')] + ([note] if note else [])
    waits = [w for w in waits if w['issueId'] != issue]
    waits.append({'issueId': issue, 'agentId': agent, 'doneFiles': files, 'doneFile': files[0],
                  'startedAt': min([w['startedAt'] for w in before] + [now or time.time()]), 'note': ' | '.join(notes)})
    save(waits)
    return waits[-1]


def _when(value):
    """An engine time (ISO) as seconds, or None."""
    from datetime import datetime
    try:
        return datetime.fromisoformat(str(value).replace('Z', '+00:00')).timestamp()
    except (TypeError, ValueError):
        return None


def call(method, path, body=None):
    headers = {'Content-Type': 'application/json'}
    if botyard_home.run_var('API_KEY'):  # a session has a key; the timer runs as the local board
        headers['Authorization'] = 'Bearer ' + botyard_home.run_var('API_KEY')
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers=headers)
    with urllib.request.urlopen(req, timeout=60) as res:
        raw = res.read()
    return json.loads(raw) if raw else {}


def run_id(r):
    """The engine's run records carry runId (live server); older shapes carry id."""
    return r.get('runId') or r.get('id')


def wake_request(wait, last_run):
    """The wake for a finished job. A heavy_job_done wake keeps the session; the issue_assigned fallback
    starts a fresh one (the engine resets the task session for that reason). After a failed or timed-out run it is the exact retry resume_phased
    sends; after an ordinary finished run it is a wake on the job under its own reason."""
    if last_run and last_run['status'] in ('failed', 'timed_out'):
        return {'source': 'automation', 'reason': 'retry_failed_run', 'failedRunId': run_id(last_run)}
    return {'source': 'automation', 'reason': 'heavy_job_done', 'payload': {'issueId': wait['issueId']}}


def wake_pass(dry=False, now=None, api=None, exists=os.path.exists, mtime=os.path.getmtime):
    """Wakes each registered session whose done files all exist, once, and drops stale or closed ones."""
    api = api or call
    now = now or time.time()
    keep = []
    for wait in load():
        if now - wait['startedAt'] > MAX_AGE:
            continue
        try:
            job = api('GET', f"/issues/{wait['issueId']}")
            if job.get('status') in CLOSED:
                continue
            files = files_of(wait)
            if not files or not all(exists(f) for f in files):
                keep.append(wait)
                continue
            runs = sorted(api('GET', f"/issues/{wait['issueId']}/runs"), key=lambda r: r['createdAt'])
            if runs and runs[-1]['status'] in ('queued', 'running'):
                keep.append(wait)  # the session is still ending its run; wake it on the next pass
                continue
            try:
                last_done = max(mtime(f) for f in files)
            except OSError:
                last_done = None
            started = _when(runs[-1].get('startedAt') or runs[-1].get('createdAt')) if runs else None
            if last_done and started and started > last_done and runs[-1]['status'] not in ('failed', 'timed_out'):
                print('dropped', job.get('identifier', wait['issueId']), ': its session already ran after the work was done')
                continue
            body = wake_request(wait, runs[-1] if runs else None)
            if dry:
                print('would wake', wait['agentId'], json.dumps(body))
                keep.append(wait)
                continue
            try:
                api('POST', f"/agents/{wait['agentId']}/wakeup", body)
            except urllib.error.HTTPError as err:
                if err.code not in (400, 422) or body['reason'] != 'heavy_job_done':
                    raise
                api('POST', f"/agents/{wait['agentId']}/wakeup",
                    {'source': 'automation', 'reason': 'issue_assigned', 'payload': {'issueId': wait['issueId']}})
                print('woke', job.get('identifier', wait['issueId']), 'on a FRESH session (heavy_job_done was refused)')
                continue
            print('woke', job.get('identifier', wait['issueId']), 'on', ', '.join(files))
        except (urllib.error.URLError, OSError) as err:
            print('could not check a wait:', err)
            keep.append(wait)
        except Exception as err:  # one bad registration must not stop the others or the save
            print('could not handle wait', wait.get('issueId'), 'kept for the next pass:', repr(err))
            keep.append(wait)
    if not dry:
        save(keep)
    return keep


def main(argv):
    if '--wake' in argv:
        wake_pass(dry='--dry' in argv)
        return
    args = [a for a in argv if not a.startswith('--')]
    note = argv[argv.index('--note') + 1] if '--note' in argv else ''
    args = [a for a in args if a != note]
    if not args:
        raise SystemExit(__doc__)
    w = register(args, note)
    shown = w['doneFiles'][0] if len(w['doneFiles']) == 1 else f"all of {', '.join(w['doneFiles'])}"
    print(f"registered: this session is woken once, when {shown} exist{'s' if len(w['doneFiles']) == 1 else ''}. Now write your state in one comment and end your run; do not wait.")


if __name__ == '__main__':
    main(sys.argv[1:])
