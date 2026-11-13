#!/usr/bin/env python3
"""A build session that has started a heavy job registers it here, ends its run, and is woken in the SAME
session when the job's done file appears. No AI while it waits.

    botyard-wait.py DONEFILE [--note TEXT]    register (run it right after starting the job, detached)
    botyard-wait.py --wake                    the pass that wakes sessions; Botyard's timetable runs it every
                                           minute and health.py runs it too. --dry prints the requests.

Sessions use it as `botyard-wait` (install.sh links it onto ~/.local/bin). A registration is {issueId, agentId,
doneFile, startedAt, note}. It is woken at most once, and dropped when its job is closed or a day old.
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


def register(done_file, note='', env=None, now=None):
    env = env or os.environ
    issue, agent = botyard_home.run_var('JOB_ID', env=env), botyard_home.run_var('BOT_ID', env=env)
    if not issue or not agent:
        raise SystemExit(f"botyard-wait: run it inside a job ({botyard_home.var_name('JOB_ID')} and {botyard_home.var_name('BOT_ID')} are not set)")
    waits = [w for w in load() if not (w['issueId'] == issue and w['doneFile'] == os.path.abspath(done_file))]
    waits.append({'issueId': issue, 'agentId': agent, 'doneFile': os.path.abspath(done_file),
                  'startedAt': now or time.time(), 'note': note})
    save(waits)
    return waits[-1]


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


def wake_pass(dry=False, now=None, api=None, exists=os.path.exists):
    """Wakes each registered session whose done file now exists, once, and drops stale or closed ones."""
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
            if not exists(wait['doneFile']):
                keep.append(wait)
                continue
            runs = sorted(api('GET', f"/issues/{wait['issueId']}/runs"), key=lambda r: r['createdAt'])
            if runs and runs[-1]['status'] in ('queued', 'running'):
                keep.append(wait)  # the session is still ending its run; wake it on the next pass
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
            print('woke', job.get('identifier', wait['issueId']), 'on', wait['doneFile'])
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
    if len(args) != 1:
        raise SystemExit(__doc__)
    w = register(args[0], note)
    print(f"registered: this session is woken when {w['doneFile']} exists. Now write your state in one comment and end your run; do not wait.")


if __name__ == '__main__':
    main(sys.argv[1:])
