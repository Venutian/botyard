#!/usr/bin/env python3
"""Pauses the Claude bots at the owner's token limit. No AI: it runs every few minutes and uses no tokens.

The engine's budgets count billed dollars, and subscription runs bill nothing, so they would never
stop anything here. This counts Claude tokens over 7 days instead, and also stops at a share of the
subscription's real weekly limit, which Claude reports in every run. That keeps room for the owner's
own Claude Code sessions, and keeps the bots out of paid extra usage. It only resumes bots it paused
itself, so a bot the owner paused by hand stays paused.

The engine's own 7-day total is too high: a run that resumes a session is logged with that session's
running total, and the total adds those up, so earlier runs count again. This takes from each run
only what it added.
"""
import importlib.util
import json
import os
import time
import urllib.error
import urllib.request
import sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import botyard_home  # noqa: E402

HOME = os.path.expanduser('~')
API = botyard_home.api()
COMPANY = botyard_home.studio_id()
FOLDER = botyard_home.config_dir()
SETTINGS = f'{FOLDER}/guard.json'
STATE = f'{FOLDER}/guard-state.json'
# The bots stop at this share of Claude's weekly limit; the rest is the owner's. The owner can move
# both ceilings from Botyard's control room (weekCeiling and leadCeiling in guard.json).
WEEK_CEILING = 0.90
# The lead keeps answering the owner past the ceiling, so the chat does not go dead until the week resets;
# he stops only here. His own runs are small next to the builds.
LEAD_CEILING = 0.97
USAGE = f'{os.path.dirname(os.path.realpath(__file__))}/usage.py'
# How many build sessions may run at once so Claude lasts until the week resets, as the owner asked on
# 2026-11-09 instead of pausing on Tuesday. start-session.py reads it.
PACE = botyard_home.state('pace.json')
MOST_SESSIONS = 5
# The share per hour is read over this window, and the cap moves by one session at most this often.
RATE_WINDOW = 3 * 3600
STEP_EVERY = 3600


def claude_reading():
    spec = importlib.util.spec_from_file_location('usage', USAGE)
    usage = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(usage)
    return usage.claude() or {}


def claude_week():
    return claude_reading().get('week', 0.0)


def cap_floor(settings):
    """The fewest sessions the owner lets the pace allow (capFloor in guard.json). Default 1, never above the maximum."""
    value = (settings or {}).get('capFloor')
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 1
    return min(MOST_SESSIONS, max(1, int(value)))


def pace(reading, now=None, ceiling=WEEK_CEILING, floor=1):
    """Moves the session cap one step an hour: down while the week is spent faster than the share per hour
    that lasts to the reset, up while it is spent much slower. The rate includes the owner's own Claude."""
    now = now or time.time()
    old = read(PACE)
    week, resets = reading.get('week'), reading.get('resets')
    if week is None or not resets:
        return old
    samples = [x for x in old.get('samples', []) if now - x[0] <= 2 * RATE_WINDOW and x[1] <= week + 1e-9]
    samples.append([now, week])
    target = max(0.0, ceiling - week) / max(1.0, (resets - now) / 3600)
    early = [x for x in samples if now - x[0] >= RATE_WINDOW * 0.66]
    rate = (week - early[-1][1]) / ((now - early[-1][0]) / 3600) if early else None
    floor = cap_floor({'capFloor': floor})
    cap, moved = max(floor, old.get('cap', 2)), old.get('moved', 0)
    if rate is not None and now - moved >= STEP_EVERY:
        if rate > target * 1.15 and cap > floor:
            cap, moved = cap - 1, now
        elif rate < target * 0.75 and cap < MOST_SESSIONS:
            cap, moved = cap + 1, now
    state = {'cap': cap, 'floor': floor, 'moved': moved, 'week': week, 'perHourAllowed': target, 'perHourNow': rate,
             'resets': resets, 'at': now, 'samples': samples}
    with open(PACE, 'w') as f:
        json.dump(state, f)
    return state


def call(method, path, body=None):
    req = urllib.request.Request(API + path, method=method,
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as res:
        raw = res.read()
    return json.loads(raw) if raw else {}


def claude_tokens():
    # The summary form of this list leaves out the session ids, so it is read in full, one bot at a time.
    runs = [run for agent in call('GET', f'/companies/{COMPANY}/agents') if agent.get('adapterType') == 'claude_local'
            for run in call('GET', f"/companies/{COMPANY}/heartbeat-runs?agentId={agent['id']}&limit=1000")]
    since = time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(time.time() - 7 * 86400))
    used, so_far = 0, {}
    for run in sorted(runs, key=lambda r: r['createdAt']):
        if run.get('inputTokens') is None:
            continue
        total = int(run['inputTokens']) + int(run.get('outputTokens') or 0)
        session = run.get('sessionIdAfter')
        before = so_far.get(session, 0) if session and run.get('sessionIdBefore') == session else 0
        if session:
            so_far[session] = total
        if run['createdAt'] >= since:
            used += max(0, total - before)
    return used


def read(path):
    try:
        return json.load(open(path))
    except (OSError, ValueError):
        return {}


FABLE_WEEK = botyard_home.state('fable-week.json')


def fable_week(now=None):
    """Whether the crew is on Fable for now. The owner has a separate Fable allowance some weeks: the file
    says until when, and which model each bot goes back to. Once that time has passed the bots are set
    back and the file is removed, so nobody has to remember to."""
    week = read(FABLE_WEEK)
    if not week:
        return False
    if (now or time.time()) < week.get('until', 0):
        return True
    for agent_id, was in (week.get('models') or {}).items():
        try:
            config = call('GET', f'/agents/{agent_id}')['adapterConfig']
            # The engine masks these on the way out and keeps its own copy when they come back masked.
            call('PATCH', f'/agents/{agent_id}', {'adapterConfig': {**config, 'model': was['model'], 'effort': was.get('effort') or config.get('effort')},
                                                  'replaceAdapterConfig': True})
            print('back on', was['model'], was.get('name'))
        except (urllib.error.HTTPError, KeyError) as err:
            print('could not set a bot back from Fable:', agent_id, err)
            return False
    os.remove(FABLE_WEEK)
    return False


def lead_and_rulers():
    """The bots that keep answering past the ceiling: the lead, and whoever rules in the owner's place."""
    spec = importlib.util.spec_from_file_location('setup_bots', os.path.join(os.path.dirname(os.path.realpath(__file__)), 'setup-bots.py'))
    bots = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bots)
    return set(bots.names_with_role('lead', 'ruler'))


def ceilings(settings):
    """Where the crew stops and where the lead does: the owner's settings, else the defaults."""
    def share(key, default):
        value = settings.get(key)
        return min(1.0, max(0.5, value)) if isinstance(value, (int, float)) and value > 0 else default
    week = share('weekCeiling', WEEK_CEILING)
    return week, max(week, share('leadCeiling', LEAD_CEILING))


def main():
    settings, state = read(SETTINGS), read(STATE)
    week_ceiling, lead_ceiling = ceilings(settings)
    used = claude_tokens()
    over_tokens = bool(settings.get('enabled')) and settings.get('limit', 0) > 0 and used >= settings['limit']
    reading = claude_reading()
    week = reading.get('week', 0.0)
    pace(reading, ceiling=week_ceiling, floor=cap_floor(settings))
    fable = fable_week()
    # While the crew runs on the owner's Fable allowance, Claude's week is not what limits it.
    over = over_tokens or (week >= week_ceiling and not fable)
    why = (f'{used / 1e6:.1f}M of your {settings.get("limit", 0) / 1e6:.0f}M tokens' if over_tokens
           else f'{week:.0%} of the weekly Claude limit' if over else '')
    paused = state.get('paused', [])
    if over:
        keep_answering = lead_and_rulers()
        for agent in call('GET', f'/companies/{COMPANY}/agents'):
            if agent['name'] in keep_answering and week < lead_ceiling and not over_tokens:
                continue
            if agent.get('adapterType') == 'claude_local' and agent['status'] != 'paused' and agent['id'] not in paused:
                call('POST', f"/agents/{agent['id']}/pause", {})
                paused.append(agent['id'])
                print('paused', agent['name'])
    elif paused:
        for agent_id in paused:
            call('POST', f'/agents/{agent_id}/resume', {})
        print('resumed', len(paused), 'bots')
        paused = []
    with open(STATE, 'w') as f:
        json.dump({'tripped': bool(paused), 'used': used, 'paused': paused, 'claudeWeek': week, 'why': why}, f)


if __name__ == '__main__':
    try:
        main()
    except (urllib.error.URLError, OSError) as err:
        print('The engine is not reachable:', err)
