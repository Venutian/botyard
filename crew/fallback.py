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
