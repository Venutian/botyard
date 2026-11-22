#!/usr/bin/env python3
"""Keeps the crew on an AI that answers. No AI of its own.

Free bots: a free model that stops answering (its daily limit, or the offer ended) is set aside until it
is worth asking again, and the free builder and the checker are moved to one that answers; a job left
with no run is woken again.

Codex bots: when Codex refuses a run because its limit is used up, they would sit idle until it resets,
and the owner's message would wait with them. This moves them to Gemini (or, where a bot's file says so,
to Claude) until then, retries each bot's refused run there so nothing is left unanswered, and moves
them back when Codex resets. The Claude bots and their sessions are not touched. Botyard's timetable
runs it every two minutes.

Gemini runs in Google's Antigravity CLI, which the owner signs in once by running: agy
"""
import calendar
import importlib.util
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import botyard_home  # noqa: E402

HOME = os.path.expanduser('~')
API = botyard_home.api()
COMPANY = botyard_home.studio_id()
HERE = os.path.dirname(os.path.realpath(__file__))
THINKER = botyard_home.state('thinker.json')
AGY = botyard_home.tool('agy') or f'{HOME}/.local/bin/agy'
THINKERS = ('codex_local', 'gemini_local')
SWITCHES = botyard_home.state('fallback.log')
# agy-acp.py notes here each Antigravity model that is used up, and when it resets.
USED_UP = botyard_home.state('agy-used-up.json')
ANTIGRAVITY = ['gemini-3.8-flash-high', 'claude-opus-4-6-thinking', 'claude-sonnet-4-6', 'gemini-3.8-flash-medium',
               'gemini-3.8-flash-low', 'gpt-oss-120b-medium']
# A Codex window this full counts as out, so the bots come back when that window resets.
FULL = 0.95
# When Codex refuses but its readings show no full window, try it again after this long.
RETRY_AFTER = 30 * 60
# An older refusal belongs to a limit that has reset since.
RECENT = 2 * 3600


def call(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as res:
        raw = res.read()
    return json.loads(raw) if raw else {}


def setup():
    spec = importlib.util.spec_from_file_location('setup_bots', f'{HERE}/setup-bots.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# A free model that stops answering is set aside this long, then tried again: offers have no published end.
FREE_PAUSE = 3600
FREE_OK = botyard_home.state('free-ok.json')


def limits():
    """free-limits.py: what each free model's limit looks like, learned from these reports."""
    spec = importlib.util.spec_from_file_location('free_limits', f'{HERE}/free-limits.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def free_works(bots, model):
    """Asks a free model for one word. Over its free limit OpenCode does not fail a run, it hangs until
    the run times out: the lead lost two hours to that on 9 November before anything noticed. A good answer
    is trusted for ten minutes, so the check itself spends little of the free allowance."""
    try:
        ok = json.load(open(FREE_OK))
    except (OSError, ValueError):
        ok = {}
    if time.time() - ok.get(model, 0) < 600:
        return True
    if not bots.OPENCODE:
        return False
    try:
        out = subprocess.run([bots.OPENCODE, 'run', '-m', model, 'Reply with exactly: pong'], capture_output=True,
                             text=True, timeout=30, stdin=subprocess.DEVNULL, cwd='/tmp',
                             env={**os.environ, 'PWD': '/tmp'})
    except (OSError, subprocess.TimeoutExpired):
        return False
    works = 'pong' in out.stdout.lower()
    if works:
        ok[model] = time.time()
        with open(FREE_OK, 'w') as f:
            json.dump(ok, f)
        limits().answered(model)
    return works


# Each provider's model list, which answers without a key: reachable means the line and the provider are up.
PROVIDER_UP = {'opencode/': 'https://opencode.ai/zen/v1/models', 'nvidia/': 'https://integrate.api.nvidia.com/v1/models',
               'openrouter/': 'https://openrouter.ai/api/v1/models'}


def outage(bots, model):
    """True when the model's provider cannot be reached at all: the line or the provider is down, not the
    offer. Around midnight on 10 November four free models were set aside one after another that way.
    Asking another model instead misled: on the morning of 10 November it was out of its limit too."""
    url = next((u for p, u in PROVIDER_UP.items() if model.startswith(p)), 'https://opencode.ai/zen/v1/models')
    try:
        with urllib.request.urlopen(url, timeout=10) as res:
            return res.status >= 500
    except urllib.error.HTTPError as err:
        return err.code >= 500
    except OSError:
        return True


def set_free_aside(bots, model, why, until=None):
    """Sets a model aside until it is worth asking again: the provider's own reset when it gives one,
    else what the model's history says (free-limits.py), in place of the flat hour used before."""
    aside = bots.free_aside()
    learn = limits()
    learn.stopped(model, why, fixed_until=until)
    aside[model] = {'until': until or int(time.time() + learn.retry_in(model)), 'error': why}
    with open(bots.FREE_OUT, 'w') as f:
        json.dump(aside, f, indent=1)


# Fewer free requests than this left today cannot carry one more run.
OPENROUTER_SPARE = 10


def openrouter_left():
    """How many free requests OpenRouter still allows the owner's key today, or None when it will not say."""
    try:
        key = botyard_home.key('openrouter')
        if not key:
            return None
        req = urllib.request.Request('https://openrouter.ai/api/v1/key', headers={'Authorization': f'Bearer {key}'})
        with urllib.request.urlopen(req, timeout=20) as res:
            return int(json.load(res)['data']['free_model_daily_requests']['remaining'])
    except (OSError, ValueError, KeyError, TypeError):
        return None


def openrouter_day_limit():
    """OpenRouter's free models share one count of requests a day on the owner's key: 1,000 since the
    key has credit on it, 50 without. A run over it fails with 'free-models-per-day', while
    the one-word ask only hangs, so each model looked like its own limit and was tried again an hour
    later: that day a check went round four of them for two hours while a model elsewhere
    answered. So OpenRouter is asked what is left, and when too little is, all its models are set aside
    until the day turns over, at 00:00 UTC. If it will not say, one such failure today does the same."""
    bots = setup()
    turns = (int(time.time()) // 86400 + 1) * 86400
    aside = bots.free_aside()
    ours = [m for m, _, _ in bots.free_list() if m.startswith('openrouter/') and aside.get(m, {}).get('until', 0) < turns]
    if not ours:
        return
    left = openrouter_left()
    if left is None:
        today = time.strftime('%Y-%m-%d', time.gmtime())
        left = OPENROUTER_SPARE + 1
        for agent in call('GET', f'/companies/{COMPANY}/agents'):
            if agent['name'] not in (bots.BUILDER, bots.CHECKER):
                continue
            runs = call('GET', f"/companies/{COMPANY}/heartbeat-runs?agentId={agent['id']}&limit=10")
            if any('free-models-per-day' in (r.get('error') or '') and (r.get('finishedAt') or '')[:10] == today for r in runs):
                left = 0
    if left <= OPENROUTER_SPARE:
        for model in ours:
            set_free_aside(bots, model, "OpenRouter's free requests for today are used up", turns)
        print("OpenRouter's free requests for today are used up: its models wait for tomorrow")


def count_free_work():
    """Adds each finished free run's tokens and minutes to its model's round, once per run."""
    bots, learn = setup(), limits()
    for agent in call('GET', f'/companies/{COMPANY}/agents'):
        if agent['name'] not in (bots.BUILDER, bots.CHECKER):
            continue
        for run in call('GET', f"/companies/{COMPANY}/heartbeat-runs?agentId={agent['id']}&limit=20"):
            usage = run.get('usageJson') or {}
            if not usage.get('model') or not run.get('finishedAt') or not run.get('startedAt'):
                continue
            seconds = calendar.timegm(time.strptime(run['finishedAt'][:19], '%Y-%m-%dT%H:%M:%S')) - calendar.timegm(
                time.strptime(run['startedAt'][:19], '%Y-%m-%dT%H:%M:%S'))
            ended = calendar.timegm(time.strptime(run['finishedAt'][:19], '%Y-%m-%dT%H:%M:%S'))
            learn.used(usage['model'], (usage.get('inputTokens') or 0) + (usage.get('outputTokens') or 0), seconds, run['id'], now=ended)


def try_resting():
    """Asks each set-aside model one word once its wait is over, whether or not the free builder has a run: that is
    how the time a model stays out is learned, and how one that is back is known before a job needs it."""
    bots = setup()
    out = read_json(bots.FREE_OUT)
    for model, _, _ in bots.free_list():
        when = out.get(model)
        if not isinstance(when, dict):
            continue
        known = limits().read().get('models', {}).get(model, {}).get('state')
        if known is None:  # set aside before the ledger existed
            limits().stopped(model, when.get('error') or '', fixed_until=when['until'] if 'today' in (when.get('error') or '') else None)
        if when.get('until', 0) > time.time() or known == 'up':
            continue
        if free_works(bots, model):
            print(model, 'answers again')
        elif not outage(bots, model):
            set_free_aside(bots, model, when.get('error') or 'did not answer')


def read_json(path):
    try:
        return json.load(open(path))
    except (OSError, ValueError):
        return {}


def live_runs(agent):
    return [r for r in call('GET', f"/companies/{COMPANY}/heartbeat-runs?agentId={agent['id']}&limit=10")
            if r['status'] in ('queued', 'running')]


def keep_free_builder_going():
    """The free builder starts each run on the best free model that answers. His model is asked only while
    he has a run, so an idle builder spends nothing; a set-aside model is tried again an hour later."""
    bots = setup()
    agent = next((a for a in call('GET', f'/companies/{COMPANY}/agents') if bots.BUILDER and a['name'] == bots.BUILDER), None)
    if not agent:
        return
    now = agent['adapterConfig'].get('model')
    runs = live_runs(agent)
    if runs and now and not free_works(bots, now):
        if outage(bots, now):
            print('No free model answers: the connection is down, so none is set aside')
            return
        set_free_aside(bots, now, 'did not answer: its free limit, or the offer ended')
    want = bots.free_model()
    if runs:
        while want and want != now and not free_works(bots, want):
            set_free_aside(bots, want, 'did not answer')
            want = bots.free_model()
    if not want or want == now:
        if not want and runs:
            print('Every free model is out: the free builder waits until one answers again')
        return
    # Read again: the bots' settings are worked out when setup-bots.py loads, after the set-asides above.
    bots = setup()
    existing = {a['name']: a for a in call('GET', f'/companies/{COMPANY}/agents')}
    bots.put(next(b for b in bots.BOTS if b['name'] == bots.BUILDER), existing, existing.get(bots.LEAD or '', {}).get('id'))
    with open(SWITCHES, 'a') as f:
        f.write(f"{time.strftime('%Y-%m-%d %H:%M')} the free builder moved from {now} to {want}\n")
    # Only his next runs: a live run moves itself in free-runner.py, keeping its session.
    print(f'The free builder moves from {now} to {want}')


def rerun(agent, run):
    """Starts a stopped run's job again where the bot runs now. The engine will not retry a run stopped
    partway (only one that failed), so a run that holds a job is woken for that job instead: on
    9 November that refusal left the free builder's two jobs waiting all night after a model change."""
    body = ({'reason': 'issue_assigned', 'payload': {'issueId': run['issueId']}} if run.get('issueId')
            else {'failedRunId': run['id'], 'reason': 'retry_failed_run'})
    call('POST', f"/agents/{agent['id']}/wakeup", body)


def checker_model(bots, job):
    """The best strong free model for a check: of another family than the build's where one answers."""
    built = (re.findall(r'built-on: (\S+) -->', job.get('description') or '') or [None])[0]
    family = bots.free_family(built) if built and built != 'None' else None
    # Not on NVIDIA while the free builder is, where another answers: its requests a minute are one shared count.
    try:
        fred_on = set(json.load(open(botyard_home.state('free-busy.json'))).values())
    except (OSError, ValueError):
        fred_on = set()
    if any(m.startswith('nvidia/') for m in fred_on):
        aside = bots.free_aside()
        other = [m for m, f, t in bots.free_list() if t == 'strong' and m not in aside and not m.startswith('nvidia/')]
        pick = next((m for m in other if bots.free_family(m) != family), None) or next(iter(other), None)
        if pick:
            return pick
    return bots.free_model('strong', not_family=family) or bots.free_model('strong')


# ── a check goes to the AI that answers now ─────────────────────────────────────────
# A checker whose file lists lanes ("fallbacks" marked "for": "checks") never lets a check wait on busy free models:
# free ones first, then each lane in the order the file gives, and the lane on Claude only when every other is out.
# The pick is made when the check is opened (check_engine) and again by route_checks for a check that waits.
CHECK_WAIT = int(os.environ.get('BOTYARD_CHECK_WAIT') or 4 * 60)
CHECK_REST = botyard_home.state('check-rest.json')
CHECK_REST_FOR = 30 * 60
READY_FOR = 5 * 60
READY_CACHE = botyard_home.state('check-ready.json')
ENGINE_FAMILY = {'codex': 'openai', 'gemini': 'google', 'claude': 'anthropic'}
MARK_ENGINES = re.compile(r'check-engines: ([a-z,]+)')
MARK_BUILT_BY = re.compile(r'built-by: ([a-z]+)')


def runner():
    spec = importlib.util.spec_from_file_location('free_runner', f'{HERE}/free-runner.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def pick_engine(order, ready, builder_family=None, waited=0, budget=CHECK_WAIT, never=(), free_family=None):
    """Which AI takes a check, from `order` (the checker's own AI first, then its lanes) and `ready` (the AIs that
    answer now: the free model to use for 'free', True for the others). Returns {'ai', 'model', 'sameFamily', 'why'},
    or None when nothing answers.
    - A free model that is not answering, or a check that has waited `budget` seconds for one, moves down the order.
    - A family other than the builder's is taken where one answers (a Codex build's check goes to Gemini).
    - Claude takes a check only when no other AI answers at all: it is the last resort.
    - Never an AI in `never` (a project that may not use Claude, say)."""
    family = lambda ai: (free_family(ready[ai]) if ai == 'free' and free_family and ready.get(ai) else ENGINE_FAMILY.get(ai, ai))
    chain = [ai for ai in order if ai not in never and ready.get(ai)]
    patient = [ai for ai in chain if not (ai == 'free' and waited >= budget)]
    pool = [ai for ai in patient if ai != 'claude'] or [ai for ai in patient if ai == 'claude']
    why = ''
    if not pool and chain:   # nothing else answers: a free model that was passed over is still better than none
        pool, why = chain, 'nothing else answers'
    if not pool:
        return None
    other = [ai for ai in pool if builder_family is None or family(ai) != builder_family]
    ai = (other or pool)[0]
    if not why and ai != order[0]:
        why = ('the free models are busy or resting' if not ready.get(order[0]) or waited >= budget else 'a different family than the build')
    return {'ai': ai, 'model': ready[ai] if ai == 'free' else None, 'sameFamily': builder_family is not None and family(ai) == builder_family,
            'why': why}


def _read(path):
    try:
        with open(path) as f:
            got = json.load(f)
        return got if isinstance(got, dict) else {}
    except (OSError, ValueError):
        return {}


def engines_resting(now=None):
    now = now or time.time()
    return {ai: t for ai, t in _read(CHECK_REST).items() if isinstance(t, (int, float)) and t > now}


def rest_engine(ai, seconds=CHECK_REST_FOR, now=None):
    """A lane whose check was refused for its limit rests, and checks go to the next one meanwhile."""
    now = now or time.time()
    got = engines_resting(now)
    got[ai] = now + seconds
    with open(CHECK_REST, 'w') as f:
        json.dump(got, f)


def _cached(key, fn, now=None, ttl=READY_FOR):
    now = now or time.time()
    kept = _read(READY_CACHE)
    row = kept.get(key)
    if isinstance(row, dict) and now - row.get('at', 0) < ttl:
        return bool(row.get('ok'))
    ok = bool(fn())
    kept[key] = {'at': now, 'ok': ok}
    try:
        with open(READY_CACHE, 'w') as f:
            json.dump(kept, f)
    except OSError:
        pass
    return ok


def engines_ready(bots, build_family=None, have=None, now=None):
    """{ai: model or True} for the AIs that answer now. `have` are the AIs whose lane agent exists. Free: the best
    strong model of another family than the build's whose provider is not resting after a 429 and that is not set
    aside; Codex: it has not moved the thinkers off itself and is signed in; Gemini: signed in and with room;
    Claude: signed in. Each lane also rests after a refusal (rest_engine)."""
    now = now or time.time()
    out = {}
    rested = runner().resting(now)
    aside = bots.free_aside()
    rows = [(m, f) for m, f, t in bots.free_list() if t == 'strong' and m not in aside and m.split('/')[0] not in rested]
    pick = next((m for m, f in rows if f != build_family), None) or next((m for m, _ in rows), None)
    if pick:
        out['free'] = pick
    off = engines_resting(now)
    for ai in ('codex', 'gemini', 'claude'):
        if have is not None and ai not in have or ai in off or not bots.signed_in(ai):
            continue
        if ai == 'codex' and _read(THINKER).get('on', 'codex') != 'codex':
            continue
        if ai == 'gemini' and not _cached('gemini', lambda: gemini_ready() and antigravity_has_room(), now):
            continue
        out[ai] = True
    return out


def check_engine(bots, order, build_family=None, builder_ai=None, waited=0, never=(), have=None):
    """The AI for a check right now: pick_engine over what answers. The builder's own AI counts as its family."""
    ready = engines_ready(bots, build_family, have)
    family = build_family or (ENGINE_FAMILY.get(builder_ai) if builder_ai and builder_ai != 'free' else None)
    return pick_engine(order, ready, family, waited, never=never, free_family=bots.free_family)


def checker_never(spec, project):
    """The AIs a project's checks may not use: a project in the checker's "freeOnly" list takes free models alone."""
    return () if project not in (spec.get('freeOnly') or []) else tuple(ai for ai in ('codex', 'gemini', 'claude'))


def lanes_of(agents, spec_name, lanes):
    """{ai: agent} for the checker's lane agents that exist."""
    import crew_set
    by_name = {a['name']: a for a in agents}
    return {ai: by_name[crew_set.lane_name(spec_name, ai)] for ai in lanes if crew_set.lane_name(spec_name, ai) in by_name}


def route_checks(call=call, now=None):
    """Checks that wait for the checker are moved down the order: a check on a free model that is busy or resting, or one
    that has waited CHECK_WAIT, goes to the first lane that answers, and a check that is waiting on a lane that is out
    moves on. Only a check with no live run is touched. Returns the moves, as text."""
    now = now or time.time()
    bots = setup()
    files = bots.crew()
    slug = next(iter(files.with_role('checker')), None)
    if not slug:
        return []
    spec = files.spec(slug)
    lanes = files.check_lanes(slug)
    if not lanes:
        return []
    agents = call('GET', f'/companies/{COMPANY}/agents')
    main_agent = next((a for a in agents if a['name'] == spec['name']), None)
    found = lanes_of(agents, spec['name'], lanes)
    if not main_agent:
        return []
    ours = {main_agent['id']: 'free', **{a['id']: ai for ai, a in found.items()}}
    for ai, agent in found.items():
        newest = call('GET', f"/companies/{COMPANY}/heartbeat-runs?agentId={agent['id']}&limit=1")
        run = newest[0] if newest else None
        error = (run.get('error') or '').lower() if run else ''
        if run and run.get('status') == 'failed' and (run.get('errorCode') == 'provider_quota' or re.search(r'quota|usage limit|rate limit|429', error)):
            started = datetime.fromisoformat(run['createdAt'].replace('Z', '+00:00')).timestamp()
            if now - started < CHECK_REST_FOR:
                rest_engine(ai, now=now)
    rows = call('GET', f'/companies/{COMPANY}/projects')
    project_names = {p['id']: p['name'] for p in rows if isinstance(p, dict)} if isinstance(rows, list) else {}
    moves = []
    for agent_id, now_on in ours.items():
        for job in call('GET', f"/companies/{COMPANY}/issues?assigneeAgentId={agent_id}&status=todo"):
            if job.get('executionRunId') or not (job.get('title') or '').startswith('Check '):
                continue
            made = datetime.fromisoformat((job.get('updatedAt') or job['createdAt']).replace('Z', '+00:00')).timestamp()
            waited = now - made
            text = job.get('description') or ''
            built_by = (MARK_BUILT_BY.findall(text) or [None])[0]
            built_on = (re.findall(r'built-on: (\S+) -->', text) or [None])[0]
            family = bots.free_family(built_on) if built_on and built_on != 'None' else None
            allowed = (MARK_ENGINES.findall(text) or [''])[0].split(',')
            never = {ai for ai in ('codex', 'gemini', 'claude') if allowed != [''] and ai not in allowed}
            never = tuple(never | set(checker_never(spec, project_names.get(job.get('projectId')))))
            pick = check_engine(bots, files.check_order(slug), family, built_by, waited, never, have=set(found))
            order = files.check_order(slug)
            # Only down the order, so a check never flips back and forth; up again only when its lane is resting.
            if not pick or pick['ai'] == now_on or (order.index(pick['ai']) < order.index(now_on) and now_on not in engines_resting(now)):
                continue
            target = main_agent if pick['ai'] == 'free' else found[pick['ai']]
            body = {'assigneeAgentId': target['id']}
            if pick['ai'] == 'free':
                body['assigneeAdapterOverrides'] = {'adapterConfig': {'model': pick['model']}}
            call('PATCH', f"/issues/{job['id']}", body)
            call('POST', f"/issues/{job['id']}/comments", {'body': f"CHECK ENGINE: {pick['ai']}" + (f", {pick['why']}" if pick['why'] else '')
                                                           + (' (the same family as the build: no other answers now)' if pick['sameFamily'] else '')
                                                           + '\n\n<!-- botyard-script: fallback -->', 'wake': False})
            try:
                call('POST', f"/agents/{target['id']}/wakeup", {'reason': 'issue_assigned', 'payload': {'issueId': job['id']}})
            except urllib.error.HTTPError as err:
                print(f"could not wake {target['name']} for {job.get('identifier')}: {err.read()[:200].decode()}")
            line = f"the check {job.get('identifier')} moved from {now_on} to {pick['ai']} after {int(waited)} s{(': ' + pick['why']) if pick['why'] else ''}"
            with open(SWITCHES, 'a') as f:
                f.write(f"{time.strftime('%Y-%m-%d %H:%M')} {line}\n")
            moves.append(line)
            print(line)
    return moves


def keep_checker_going():
    """Each of the checker's live checks runs on the model its job names. One whose model stopped answering
    moves to the next strong model of another family than the build's, and runs again."""
    bots = setup()
    agent = next((a for a in call('GET', f'/companies/{COMPANY}/agents') if a['name'] == bots.CHECKER), None)
    if not agent:
        return
    # The checker on the runner switches models inside her run; cancelling it would only start her over.
    if (agent.get('adapterConfig') or {}).get('command', '').endswith('free-runner.py'):
        return
    for run in live_runs(agent):
        job = call('GET', f"/issues/{run['issueId']}") if run.get('issueId') else {}
        model = ((job.get('assigneeAdapterOverrides') or {}).get('adapterConfig') or {}).get('model')
        if not model or free_works(bots, model):
            continue
        if outage(bots, model):
            print('No free model answers: the connection is down, so none is set aside')
            return
        set_free_aside(bots, model, 'did not answer: its free limit, or the offer ended')
        want = checker_model(bots, job)
        if not want:
            print(f"Every strong free model is out: the checker's check {job.get('identifier')} waits")
            continue
        call('PATCH', f"/issues/{job['id']}", {'assigneeAdapterOverrides': {'adapterConfig': {'model': want}}})
        call('POST', f"/heartbeat-runs/{run['id']}/cancel", {})
        try:
            rerun(agent, run)
        except urllib.error.HTTPError as err:
            print(f"could not rerun the checker's check {job.get('identifier')}: {err.read()[:200].decode()}")
        with open(SWITCHES, 'a') as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M')} the checker's check {job.get('identifier')} moved from {model} to {want}\n")
        print(f"the checker's check {job.get('identifier')} moves from {model} to {want}")


WOKEN = botyard_home.state('free-woken.json')


def pick_up_stranded():
    """A free bot's job left in progress with no run is woken again, at most every half hour per job, so
    one that ends at once does not loop. Nothing else wakes it."""
    bots = setup()
    if not bots.free_model('any'):
        return
    try:
        woken = json.load(open(WOKEN))
    except (OSError, ValueError):
        woken = {}
    for agent in call('GET', f'/companies/{COMPANY}/agents'):
        # Every free-model bot, not a list of names: a researcher's job would otherwise wait for ever.
        if agent.get('adapterType') != 'opencode_local' or agent.get('status') == 'paused' or live_runs(agent):
            continue
        jobs = call('GET', f"/companies/{COMPANY}/issues?assigneeAgentId={agent['id']}&status=in_progress")
        stranded = [j for j in jobs if not j.get('executionRunId') and time.time() - woken.get(j['id'], 0) > 1800]
        if stranded:
            job = min(stranded, key=lambda j: j['updatedAt'])
            # A check names its own model: one set aside since would fail the new run at once.
            model = ((job.get('assigneeAdapterOverrides') or {}).get('adapterConfig') or {}).get('model')
            if model and model in bots.free_aside():
                want = checker_model(bots, job)
                if not want:
                    continue
                call('PATCH', f"/issues/{job['id']}", {'assigneeAdapterOverrides': {'adapterConfig': {'model': want}}})
                with open(SWITCHES, 'a') as f:
                    f.write(f"{time.strftime('%Y-%m-%d %H:%M')} the checker's check {job.get('identifier')} moved from {model} to {want}\n")
            rerun(agent, {'issueId': job['id']})
            woken[job['id']] = time.time()
            print(f"woke {agent['name']} for {job['identifier']}")
    with open(WOKEN, 'w') as f:
        json.dump(woken, f)


def codex_back():
    """When Codex should have room again, from its own readings of its windows."""
    spec = importlib.util.spec_from_file_location('usage', f'{HERE}/usage.py')
    usage = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(usage)
    reading = usage.codex() or {}
    full = [reading.get(resets) for share, resets in (('shortWindow', 'shortResets'), ('week', 'resets'))
            if (reading.get(share) or 0) >= FULL and reading.get(resets)]
    return max(full) if full else int(time.time()) + RETRY_AFTER


def gemini_ready():
    """agy lists its models only when it is signed in, and the listing costs no requests."""
    try:
        listing = subprocess.run([AGY, 'models'], capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return 'sign in' not in (listing.stdout + listing.stderr).lower() and 'gemini' in listing.stdout.lower()


def antigravity_has_room():
    try:
        noted = json.load(open(USED_UP))
    except (OSError, ValueError):
        return True
    return any(noted.get(model, 0) <= time.time() for model in ANTIGRAVITY)


def refused(agents, since, on):
    """Each thinking bot's newest run, if the engine it is on now refused it for its limit after the last move."""
    runs = {}
    for agent in agents:
        if agent.get('adapterType') != on:
            continue
        newest = call('GET', f"/companies/{COMPANY}/heartbeat-runs?agentId={agent['id']}&limit=1")
        run = newest[0] if newest else None
        out = run and (run.get('errorCode') == 'provider_quota' if on == 'codex_local'
                       else 'quota reached' in (run.get('error') or '').lower())
        if (run and run.get('status') == 'failed' and out
                and datetime.fromisoformat(run['createdAt'].replace('Z', '+00:00')).timestamp() > since):
            runs[agent['name']] = (agent, run)
    return runs


def move(to, back=None, on_claude_now=()):
    args = ([sys.executable, '-I', f'{HERE}/setup-bots.py', '--think-on', to] + (['--back', str(back)] if back else [])
            + (['--on-claude', ','.join(sorted(on_claude_now))] if on_claude_now else []))
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL)
    # The weekly crew review counts these.
    with open(SWITCHES, 'a') as f:
        where = 'Codex' if to == 'codex' else 'Antigravity' + (f", on cheap Claude: {', '.join(sorted(on_claude_now))}" if on_claude_now else '')
        f.write(f"{time.strftime('%Y-%m-%d %H:%M')} moved to {where}\n")


def retry(runs):
    # The engine takes an exact retry of a failed run only with this reason and nothing else changed.
    for name, (agent, run) in runs.items():
        try:
            call('POST', f"/agents/{agent['id']}/wakeup", {'failedRunId': run['id'], 'reason': 'retry_failed_run'})
            print('retried', name)
        except urllib.error.HTTPError as err:
            print(f'could not retry {name}: {err.read()[:200].decode()}')


def main():
    try:
        state = json.load(open(THINKER))
    except (OSError, ValueError):
        state = {}
    on, moved = state.get('on', 'codex'), state.get('moved', 0)
    # Keys pasted in Botyard reach OpenCode as the variables it reads; with none, its own free models still work.
    os.environ.update(botyard_home.key_env())
    try:
        if not setup().OPENCODE:
            raise FileNotFoundError(botyard_home.INSTALL['opencode'])
        openrouter_day_limit()
        keep_free_builder_going()
        keep_checker_going()
        try:
            route_checks()
        except (urllib.error.URLError, ValueError, TypeError, OSError) as err:
            print('Could not route the checker\'s checks:', err)
        pick_up_stranded()
        count_free_work()
        try_resting()
    except (urllib.error.HTTPError, subprocess.SubprocessError, KeyError, StopIteration, FileNotFoundError) as err:
        print('Could not check the free bots:', err)
    agents = [a for a in call('GET', f'/companies/{COMPANY}/agents') if a.get('adapterType') in THINKERS]
    if on == 'codex':
        runs = refused(agents, max(moved, time.time() - RECENT), 'codex_local')
        if not runs:
            return
        if not gemini_ready() and not setup().ALWAYS_CLAUDE:
            print('Codex is out of its limit, but Gemini is not signed in, so the bots wait for Codex')
            return
        back = codex_back()
        move('gemini', back)
        print('Codex is out of its limit: the bots think on Gemini until', time.strftime('%a %H:%M', time.localtime(back)))
        retry(runs)
    elif time.time() < (state.get('back') or 0):
        # Every Antigravity model can run out too. Then that bot thinks on cheap Claude, as the owner
        # allowed, until Antigravity has room again or Codex resets.
        on_claude_now = set(state.get('claude') or [])
        runs = refused(agents, moved, 'gemini_local')
        if runs:
            move('gemini', state['back'], on_claude_now | set(runs))
            print('Every Antigravity model is out for', ', '.join(runs), '- they think on cheap Claude for now')
            retry(runs)
        elif on_claude_now and antigravity_has_room():
            move('gemini', state['back'])
            print('Antigravity has room again: the bots on Claude move back to it')
    else:
        # Runs Antigravity refused for its own limit get another go on Codex.
        runs = refused(agents, moved, 'gemini_local')
        move('codex')
        print('Codex has reset: the bots think on Codex again')
        retry(runs)


if __name__ == '__main__':
    try:
        main()
    except (urllib.error.URLError, OSError) as err:
        print('The engine is not reachable:', err)
