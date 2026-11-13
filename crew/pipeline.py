#!/usr/bin/env python3
"""Moves the crew's work along by itself. No AI.

Botyard's timetable runs it every minute (as `review-guard`). Each pass reads the jobs and does four
plain things, each at most once per job:

1. A builder's finished job goes to its check. The builder's report ends with OUTCOME, CHANGE and
   COMMIT lines; a build that kept something in the project gets a job "Check LH-12: <title>": for the
   checker when a free model built it, for the reviewer when another AI did and the reviewer is on.
   A build that kept nothing (CHANGE: NONE) gets no check: its report goes to the lead.
2. A finished check is acted on. VERDICT: PASS goes to the lead, who tells the owner what is ready.
   VERDICT: FAIL goes back to the same builder once, as "Fix 1 of <title>", from its own commit with
   the check's blocking items; a second FAIL goes to the lead, who gives it to a stronger builder or
   puts it to the owner.
3. A job left in progress with no run for half an hour is woken again (at most three times, an hour
   apart), then the lead is told. A job the engine gave up on is told to the lead at once.
4. A finished ruling goes to the lead, with its RULING line.

"Telling the lead" is a comment on the job the work belongs to when that job is the lead's, else in
the lead's chat: either wakes the lead once. Bots are found by role (crew/bots, or the studio's own),
never by name. What was done is kept in <crew folder>/pipeline.json, so nothing is done twice.

    python3 pipeline.py          one pass
    python3 pipeline.py --dry    say what a pass would do, change nothing
"""
import argparse
import importlib.util
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import uuid

HERE = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, HERE)
import botyard_home  # noqa: E402

API = botyard_home.api()
STATE = botyard_home.state('pipeline.json')
CHECK = 'Check '
RULING = 'Ruling: '
FIX = re.compile(r'^Fix (\d+) of ')
# How many times a failed build goes back to its builder before the lead decides.
FIX_ROUNDS = 1
OUTCOME = re.compile(r'^\W*OUTCOME:\W*(MET|NOT MET|REPORT ONLY)\b', re.I | re.M)
CHANGE = re.compile(r'^\W*CHANGE:\W*(NONE|SMALL|LARGE)\b', re.I | re.M)
# What free-runner.py writes on a check that had only the build's own model family to run on.
SAME_FAMILY = 'SAME-FAMILY CHECK:'
COMMIT = re.compile(r'^\W*COMMIT:\W*([0-9a-f]{7,40})', re.I | re.M)
VERDICT = re.compile(r'^\W*VERDICT:\W*(PASS|FAIL)\b', re.I | re.M)
RULED = re.compile(r'^\W*RULING:\s*(.+)$', re.I | re.M)
# A job with no run this long is woken; then again after this long; then the lead is told.
QUIET = 30 * 60
WAKE_EVERY = 60 * 60
WAKES = 3
NAMESPACE = uuid.UUID('2d0c1f0e-7b1a-4c58-9a3e-5f6b7c8d9e10')
SIGN = '\n\n<!-- botyard-script: pipeline -->'
DRY = False


def call(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as res:
        raw = res.read()
    return json.loads(raw) if raw else {}


def write(method, path, body):
    """A call that changes something: only said, on a dry pass."""
    if DRY:
        return {}
    return call(method, path, body)


def crew_files():
    spec = importlib.util.spec_from_file_location('setup_bots', os.path.join(HERE, 'setup-bots.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_state():
    try:
        with open(STATE, encoding='utf8') as f:
            state = json.load(f)
        return state if isinstance(state, dict) else {}
    except (OSError, ValueError):
        return {}


def report_of(job_id):
    """A bot's report on its job: its newest comment that carries the closing lines, else its newest."""
    written = sorted((c for c in call('GET', f'/issues/{job_id}/comments') if c.get('authorAgentId')),
                     key=lambda c: c.get('createdAt') or '', reverse=True)
    for comment in written:
        if OUTCOME.search(comment.get('body') or '') or VERDICT.search(comment.get('body') or ''):
            return comment['body']
    return (written[0].get('body') or '') if written else ''


def same_family(job_id):
    """True when the check said it ran on the model family that made the build."""
    return any(SAME_FAMILY in (c.get('body') or '') for c in call('GET', f'/issues/{job_id}/comments'))


def last(pattern, text):
    found = pattern.findall(text or '')
    return found[-1] if found else None


def kept(report):
    """(outcome, change, commit) from a build's closing lines, each None when it does not say."""
    outcome, change = last(OUTCOME, report), last(CHANGE, report)
    return outcome and outcome.upper(), change and change.upper(), last(COMMIT, report)


def built_on(build, company, agent=None):
    """The model that ran the build, so a free check avoids its family: what its newest run reported, else
    what that run started on (a run can still be closing when its job is done), else the bot's own model."""
    try:
        runs = call('GET', f"/companies/{company}/heartbeat-runs?agentId={build['assigneeAgentId']}&limit=50")
    except urllib.error.HTTPError:
        runs = []
    mine = sorted((r for r in runs if (r.get('issueId') or (r.get('contextSnapshot') or {}).get('issueId')) == build['id']),
                  key=lambda r: r.get('createdAt') or r.get('startedAt') or '', reverse=True)
    for run in mine:
        model = (run.get('usageJson') or {}).get('model') or run.get('model') or (run.get('contextSnapshot') or {}).get('model')
        if model:
            return model
    return ((agent or {}).get('adapterConfig') or {}).get('model')


class Crew:
    """Who is who right now: the bots by role, from the files, joined with the engine's list."""

    def __init__(self, bots, agents):
        self.by_id = {a['id']: a for a in agents}
        by_name = {a['name']: a for a in agents}
        ids = lambda names: [by_name[n]['id'] for n in names if n in by_name]
        self.builders = set(ids(bots.names_with_role('builder')))
        self.checker = next(iter(ids(bots.names_with_role('checker'))), None)
        self.reviewer = next(iter(ids(bots.names_with_role('reviewer'))), None)
        self.rulers = set(ids(bots.names_with_role('ruler')))
        self.lead = (by_name.get(bots.LEAD or '') or {}).get('id')

    def on(self, agent_id):
        return bool(agent_id) and (self.by_id.get(agent_id) or {}).get('status') not in ('paused', 'terminated', None)

    def name(self, agent_id):
        return (self.by_id.get(agent_id) or {}).get('name') or 'nobody'

    def free(self, agent_id):
        return (self.by_id.get(agent_id) or {}).get('adapterType') == 'opencode_local'

    def checker_for(self, build):
        """Who checks this build: the checker for a free build; the reviewer for another AI's when it is
        on; whichever of the two is on otherwise. None when neither is."""
        first, second = (self.checker, self.reviewer) if self.free(build.get('assigneeAgentId')) else (self.reviewer, self.checker)
        return first if self.on(first) else second if self.on(second) else None


def tell_lead(crew, company, job, by_id, text, key):
    """One message that wakes the lead: on the job this work belongs to when that is the lead's and open,
    else in the lead's chat."""
    if not crew.lead:
        print(f"nobody to tell: this crew has no lead ({job.get('identifier')})")
        return
    parent = by_id.get(job.get('parentId') or '')
    body = {'body': text + SIGN, 'clientRequestId': str(uuid.uuid5(NAMESPACE, key))}
    if parent and parent.get('assigneeAgentId') == crew.lead and parent.get('status') not in ('done', 'cancelled'):
        write('POST', f"/issues/{parent['id']}/comments", body)
    else:
        chat = call('POST', f'/companies/{company}/chats/{crew.lead}', {}) if not DRY else {'id': 'chat'}
        write('POST', f"/issues/{chat['id']}/comments", body)
    print(f"told the lead: {text.splitlines()[0][:110]}")


def open_check(crew, company, build, report, commit):
    who = crew.checker_for(build)
    if not who:
        return False
    model = built_on(build, company, crew.by_id.get(build.get('assigneeAgentId'))) if crew.free(build.get('assigneeAgentId')) else None
    write('POST', f'/companies/{company}/issues', {
        'title': f"{CHECK}{build['identifier']}: {build['title']}"[:190], 'status': 'todo', 'priority': build.get('priority') or 'medium',
        'projectId': build.get('projectId'), 'parentId': build['id'], 'assigneeAgentId': who,
        'description': (
            f"Check {build['identifier']}, made by {crew.name(build.get('assigneeAgentId'))}. Its last commit is {commit}.\n\n"
            f"THE BUILDER'S REPORT\n{report[:2500]}\n\nTHE BRIEF\n{(build.get('description') or '')[:6000]}\n\n"
            "List BLOCKING and NOTES, and end with one line: VERDICT: PASS or VERDICT: FAIL."
            + (f"\n\n<!-- built-on: {model} -->" if model else '')),
    })
    print(f"opened the check of {build['identifier']} for {crew.name(who)}")
    return True


def open_fix(crew, company, build, check, verdict, commit, rounds):
    brief = (build.get('description') or '').split('\n\nFIX ROUND ')[0]
    title = FIX.sub('', build['title'])
    write('POST', f'/companies/{company}/issues', {
        'title': f"Fix {rounds + 1} of {title}"[:190], 'status': 'todo', 'priority': build.get('priority') or 'medium',
        'projectId': build.get('projectId'), 'assigneeAgentId': build['assigneeAgentId'],
        **({'parentId': build['parentId']} if build.get('parentId') else {}),
        'executionWorkspacePreference': 'isolated_workspace',
        'executionWorkspaceSettings': {'mode': 'isolated_workspace', 'workspaceStrategy': {'type': 'git_worktree', 'baseRef': commit}},
        'description': (f"{brief}\n\nFIX ROUND {rounds + 1}\nThis continues {build['identifier']}, whose last commit is {commit}: "
                        f"start from it (if git log does not show it, run: git checkout -B \"$(git branch --show-current)\" {commit}). "
                        f"A check failed it. Fix every BLOCKING item below and prove each one fixed; keep what already works. "
                        f"The check's verdict ({check['identifier']}):\n\n{verdict[:3500]}"),
    })
    print(f"sent {build['identifier']} back to {crew.name(build['assigneeAgentId'])}, fix round {rounds + 1}")


def builds(crew, company, jobs, by_id, state):
    """Step 1: each finished build goes to its check, or its report to the lead."""
    checked = {j.get('parentId') for j in jobs if (j.get('title') or '').startswith(CHECK)}
    for job in jobs:
        title = job.get('title') or ''
        if (job['status'] != 'done' or job.get('assigneeAgentId') not in crew.builders or title.startswith((CHECK, RULING))
                or job['id'] in state['builds'] or job['id'] in checked):
            continue
        report = report_of(job['id'])
        outcome, change, commit = kept(report)
        if not outcome:
            tell_lead(crew, company, job, by_id, f"{job['identifier']} ({title}) was closed by {crew.name(job['assigneeAgentId'])} without its "
                      "closing lines (OUTCOME, CHANGE, COMMIT), so it got no check. Read its report and decide: check it yourself, "
                      f"or brief what is left.\n\n{report[:1500]}", f"no-lines-{job['id']}")
        elif change == 'NONE' or not commit:
            tell_lead(crew, company, job, by_id, f"{job['identifier']} ({title}) finished with nothing kept in the project "
                      f"(OUTCOME: {outcome}), so it needs no check. Its report:\n\n{report[:2500]}", f"report-{job['id']}")
        elif not open_check(crew, company, job, report, commit):
            tell_lead(crew, company, job, by_id, f"{job['identifier']} ({title}) is built (commit {commit}) but no bot that checks "
                      "is on, so it is unchecked. Tell the owner what is ready and that nobody checked it.", f"unchecked-{job['id']}")
        state['builds'][job['id']] = int(time.time())


def checks(crew, company, jobs, by_id, state):
    """Step 2: each finished check is acted on."""
    for check in jobs:
        if not (check.get('title') or '').startswith(CHECK) or check['status'] != 'done' or check['id'] in state['checks']:
            continue
        build = by_id.get(check.get('parentId') or '')
        if not build:
            state['checks'][check['id']] = int(time.time())
            continue
        verdict_text = report_of(check['id'])
        verdict = (last(VERDICT, verdict_text) or '').upper()
        commit = kept(report_of(build['id']))[2]
        rounds = int((FIX.findall(build.get('title') or '') or ['0'])[0])
        if verdict == 'PASS':
            tell_lead(crew, company, build, by_id, f"{build['identifier']} ({build['title']}) passed its check ({check['identifier']}, by "
                      f"{crew.name(check.get('assigneeAgentId'))}). Its commit is {commit}. Tell the owner what is ready and on which "
                      f"branch, and ask on a card whether to merge it."
                      + (" The check ran on the same model family as the build, because no other answered: it is a second look, not an "
                         "independent check. Say that to the owner with the result, or have it checked again by another bot." if same_family(check['id']) else '')
                      + f" The check's notes, for the next brief on this code:\n\n{verdict_text[:1500]}",
                      f"pass-{check['id']}")
        elif verdict == 'FAIL' and rounds < FIX_ROUNDS and commit and crew.on(build.get('assigneeAgentId')):
            open_fix(crew, company, build, check, verdict_text, commit, rounds)
        elif verdict == 'FAIL':
            tell_lead(crew, company, build, by_id, f"{build['identifier']} ({build['title']}) failed its check"
                      f"{' after ' + str(rounds) + ' fix round' + ('s' if rounds > 1 else '') if rounds else ''}. Do not send it back to "
                      f"{crew.name(build.get('assigneeAgentId'))}: give it to a stronger builder from commit {commit or 'its branch'}, "
                      f"or put the options to the owner. The verdict:\n\n{verdict_text[:3000]}", f"fail-{check['id']}")
        else:
            tell_lead(crew, company, build, by_id, f"The check of {build['identifier']} ({check['identifier']}) was closed without a "
                      f"VERDICT line. Read it and decide.\n\n{verdict_text[:1500]}", f"no-verdict-{check['id']}")
        state['checks'][check['id']] = int(time.time())


def rulings(crew, company, jobs, by_id, state):
    """Step 4: a finished ruling goes to the lead."""
    for job in jobs:
        if (not (job.get('title') or '').startswith(RULING) or job['status'] != 'done' or job.get('assigneeAgentId') not in crew.rulers
                or job['id'] in state['rulings']):
            continue
        report = report_of(job['id']) or ''
        ruled = last(RULED, report)
        tell_lead(crew, company, job, by_id, f"{job['identifier']} is ruled: {ruled or 'see its report'}. Brief its NEXT job now.\n\n{report[:2000]}",
                  f"ruling-{job['id']}")
        state['rulings'][job['id']] = int(time.time())


def seconds_since(stamp):
    try:
        return time.time() - time.mktime(time.strptime(stamp[:19], '%Y-%m-%dT%H:%M:%S')) + time.timezone
    except (TypeError, ValueError):
        return 0


def stuck(crew, company, jobs, by_id, state):
    """Step 3: wake a job that is in progress with no run; tell the lead of one that cannot move."""
    busy = {}
    for job in jobs:
        who = job.get('assigneeAgentId')
        attention = job.get('blockerAttention') or {}
        if job['status'] == 'blocked' and attention.get('state') == 'needs_attention' and not attention.get('unresolvedBlockerCount'):
            key = f"{job['id']}-{job.get('updatedAt')}"
            if state['stuck'].get(job['id']) != key and who != crew.lead:
                tell_lead(crew, company, job, by_id, f"{job['identifier']} ({job['title']}) is stuck on {crew.name(who)}: it is blocked and "
                          "nothing it waits for is open. Read its last comment and act: close it with its outcome, brief what it "
                          "still needs, or give it to another bot.", f"stuck-{key}")
                state['stuck'][job['id']] = key
            continue
        if job['status'] != 'in_progress' or job.get('executionRunId') or not crew.on(who) or seconds_since(job.get('updatedAt')) < QUIET:
            continue
        woken = state['woken'].get(job['id']) or {'times': 0, 'at': 0}
        if time.time() - woken['at'] < WAKE_EVERY:
            continue
        if who not in busy:
            try:
                runs = call('GET', f"/companies/{company}/heartbeat-runs?agentId={who}&limit=10")
            except urllib.error.HTTPError:
                runs = []
            busy[who] = any(r.get('status') in ('queued', 'running') for r in runs)
        if busy[who]:
            continue
        if woken['times'] >= WAKES:
            if not woken.get('told') and who != crew.lead:
                tell_lead(crew, company, job, by_id, f"{job['identifier']} ({job['title']}) has been in progress on {crew.name(who)} with no "
                          f"run, and waking it {WAKES} times did not move it. Read its thread and act: brief what is left as a new, "
                          "smaller job, or give it to another bot.", f"quiet-{job['id']}")
                woken['told'] = True
                state['woken'][job['id']] = woken
            continue
        write('POST', f'/agents/{who}/wakeup', {'source': 'automation', 'reason': 'issue_assigned', 'payload': {'issueId': job['id']}})
        busy[who] = True
        state['woken'][job['id']] = {'times': woken['times'] + 1, 'at': int(time.time())}
        print(f"woke {crew.name(who)} for {job['identifier']}, left in progress with no run")


def one_pass(bots=None):
    company = botyard_home.studio_id()
    if not company:
        raise urllib.error.URLError('no studio')
    bots = bots or crew_files()
    crew = Crew(bots, call('GET', f'/companies/{company}/agents'))
    jobs = call('GET', f'/companies/{company}/issues?limit=100000')
    by_id = {j['id']: j for j in jobs}
    state = {'builds': {}, 'checks': {}, 'rulings': {}, 'stuck': {}, 'woken': {}, **read_state()}
    first = not os.path.exists(STATE)
    if first:
        # A studio that had work before this script: what finished over an hour ago is not sent to a check now.
        for job in jobs:
            if job['status'] in ('done', 'cancelled') and seconds_since(job.get('completedAt') or job.get('updatedAt')) > 3600:
                kind = 'checks' if (job.get('title') or '').startswith(CHECK) else 'rulings' if (job.get('title') or '').startswith(RULING) else 'builds'
                state[kind][job['id']] = 0
    builds(crew, company, jobs, by_id, state)
    checks(crew, company, jobs, by_id, state)
    rulings(crew, company, jobs, by_id, state)
    stuck(crew, company, jobs, by_id, state)
    # Only jobs the engine still lists are remembered.
    for kind in ('builds', 'checks', 'rulings', 'stuck', 'woken'):
        state[kind] = {k: v for k, v in state[kind].items() if k in by_id}
    if not DRY:
        with open(STATE + '.tmp', 'w', encoding='utf8') as f:
            json.dump(state, f)
        os.replace(STATE + '.tmp', STATE)
    return state


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Moves finished builds to their check, acts on verdicts, wakes stuck jobs. No AI.')
    parser.add_argument('--dry', action='store_true', help='say what a pass would do, change nothing')
    DRY = parser.parse_args().dry
    try:
        one_pass()
    except (urllib.error.URLError, OSError) as err:
        print('Botyard is not reachable:', getattr(err, 'reason', err))
