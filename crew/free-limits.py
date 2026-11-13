#!/usr/bin/env python3
"""What each free model's limit looks like, learned from watching it. No AI of its own.

Free offers publish almost nothing: a model just stops answering, and until 11 November it was then set
aside for a flat hour, whether its limit was a minute's rate (NVIDIA) or a day's count. Nobody could say
when a model would stop or when it would be back, so the owner woke to a night where the free builder mostly waited.

So every model's life is kept here as rounds. A round starts when the model answers, counts the work it
does (tokens, minutes of runs), and ends when it stops answering; the time until it answers again is the
round's rest. From the rounds seen so far come two numbers per model: how much work it usually gives
before it stops, and how long it usually stays out. The first says when it will stop, the second when to
try it again, in place of the flat hour. Both are typical values with a spread, never promises: an offer
can change or end any day, and a model seen fewer than MIN_SEEN times says so instead of guessing.

fallback.py and free-runner.py report what they see (stopped, answered, a finished run's usage);
health.py and Botyard read the forecast. Run it by hand for the table.
"""
import fcntl
import json
import os
import statistics
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import botyard_home  # noqa: E402

STATE = botyard_home.state('free-limits.json')
# A model with no history is tried again after these waits, one after another: short first, because a
# per-minute limit is back in a minute and only trying shows which kind it is.
STEPS = (120, 300, 900, 1800, 3600)
MIN_SEEN = 2
KEEP = 30
# Tried again a little before the usual rest is over: waiting the whole of it could never learn a shorter one.
EARLY = 0.7
RUNS_KEPT = 400
# What the providers themselves publish, read on 11 November 2026. Almost nothing: OpenCode gives no
# numbers for its free models but one, NVIDIA's figure comes from its forum and not its docs, and only
# OpenRouter can be asked what is left (fallback.py does). First match on the model's name wins.
PUBLISHED = (('opencode/longcat', '100 requests a day, which one long build can use up'),
             ('opencode/', 'no limit published; free for a limited time with no end date given'),
             ('zai/', 'no limit published; said to allow one request at a time'),
             ('cloudflare-workers-ai/', '10,000 neurons a day shared by all its models (about 1.2M tokens on GLM 4.7 Flash), new day at 01:00'),
             ('nvidia/', 'about 40 requests a minute shared by every NVIDIA model on the key, no daily cap published'),
             ('openrouter/', '20 requests a minute and 1,000 a day shared by all its free models, new day at 01:00'))


def published(model):
    return next((text for start, text in PUBLISHED if model.startswith(start)), '')


def _change(fn, path=None):
    """Reads the state, lets fn change it, and writes it back, one writer at a time."""
    path = path or STATE
    with open(path, 'a+') as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        f.seek(0)
        try:
            state = json.loads(f.read() or '{}')
        except ValueError:
            state = {}
        before = json.dumps(state, sort_keys=True)
        result = fn(state)
        if json.dumps(state, sort_keys=True) != before:
            f.seek(0)
            f.truncate()
            json.dump(state, f, indent=1)
    return result


def read(path=None):
    try:
        return json.load(open(path or STATE))
    except (OSError, ValueError):
        return {}


def _model(state, model, now):
    return state.setdefault('models', {}).setdefault(
        model, {'state': 'up', 'since': now, 'tries': 0, 'tokens': 0, 'seconds': 0, 'runs': 0, 'rounds': []})


def stopped(model, why='', now=None, fixed_until=None, path=None):
    """The model stopped answering. Closes its round the first time; later calls count failed tries.
    fixed_until is a return time the provider itself gives (OpenRouter's day), which is not learned from."""
    now = time.time() if now is None else now

    def fn(state):
        m = _model(state, model, now)
        if m['state'] == 'out':
            m['tries'] += 1
            return
        m['rounds'] = (m['rounds'] + [{'up': m['since'], 'out': now, 'back': None, 'tokens': m['tokens'],
                                       'seconds': m['seconds'], 'runs': m['runs'], 'why': why[:120],
                                       'fixed': bool(fixed_until)}])[-KEEP:]
        m.update(state='out', since=now, tries=0, tokens=0, seconds=0, runs=0, fixed_until=fixed_until)
    _change(fn, path)


def answered(model, now=None, path=None):
    """The model answered. Ends its rest if it was out; otherwise changes nothing."""
    now = time.time() if now is None else now

    def fn(state):
        m = _model(state, model, now)
        if m['state'] != 'out':
            return
        if m['rounds']:
            m['rounds'][-1]['back'] = now
        m.update(state='up', since=now, tries=0, tokens=0, seconds=0, runs=0, fixed_until=None)
    _change(fn, path)


def used(model, tokens, seconds, run=None, now=None, path=None):
    """A finished run's work on the model, counted once per run. `now` is when the run ended: work from
    before the model's round began, or on a model never seen answering, belongs to no round."""
    now = time.time() if now is None else now

    def fn(state):
        seen = state.setdefault('runs', [])
        if run and run in seen:
            return
        if run:
            seen.append(run)
            del seen[:-RUNS_KEPT]
        m = state.get('models', {}).get(model)
        if m and m['state'] == 'up' and now >= m['since']:
            m['tokens'] += int(tokens or 0)
            m['seconds'] += int(seconds or 0)
            m['runs'] += 1
    _change(fn, path)


def _typical(values):
    values = [v for v in values if v and v > 0]
    if len(values) < MIN_SEEN:
        return None
    return {'usual': statistics.median(values), 'low': min(values), 'high': max(values), 'seen': len(values)}


def learned(m):
    """What the model's finished rounds say: the work it gives before stopping, and how long it rests."""
    rounds = [r for r in m.get('rounds', []) if not r.get('fixed')]
    return {'tokens': _typical([r['tokens'] for r in rounds]),
            'seconds': _typical([r['seconds'] for r in rounds]),
            'rest': _typical([r['back'] - r['out'] for r in rounds if r.get('back')])}


def retry_in(model, now=None, path=None):
    """Seconds until the model is worth asking again, counted from now."""
    now = time.time() if now is None else now
    m = read(path).get('models', {}).get(model)
    if not m or m['state'] != 'out':
        return STEPS[0]
    if m.get('fixed_until'):
        return max(60, m['fixed_until'] - now)
    rest = learned(m)['rest']
    out_for = now - m['since']
    if rest and out_for < rest['usual'] * EARLY:
        return max(60, rest['usual'] * EARLY - out_for)
    return STEPS[min(m.get('tries', 0), len(STEPS) - 1)]


def forecast(now=None, path=None):
    """One row per model: its state, what it has done this round, and what its history says comes next."""
    now = time.time() if now is None else now
    rows = []
    for model, m in sorted(read(path).get('models', {}).items()):
        know = learned(m)
        row = {'model': model, 'state': m['state'], 'since': m['since'], 'tokens': m['tokens'],
               'seconds': m['seconds'], 'runs': m['runs'], 'learned': know, 'left': None, 'back': None}
        if m['state'] == 'up' and know['seconds']:
            row['left'] = max(0, know['seconds']['usual'] - m['seconds'])
        if m['state'] == 'up' and know['tokens']:
            row['tokens_left'] = max(0, know['tokens']['usual'] - m['tokens'])
        if m['state'] == 'out':
            row['back'] = m.get('fixed_until') or (m['since'] + know['rest']['usual'] if know['rest'] else None)
        rows.append(row)
    return rows


def _minutes(seconds):
    minutes = round(seconds / 60)
    return f'{minutes} min' if minutes < 90 else f'{minutes / 60:.1f} h'


def _short(model):
    return model.split('/')[-1].replace(':free', '').replace('-free', '') + {'nvidia': ' (NVIDIA)', 'openrouter': ' (OpenRouter)'}.get(model.split('/')[0], '')


def line(row, now=None):
    """One plain sentence for a model, for the lead and the owner."""
    now = time.time() if now is None else now
    name, know = _short(row['model']), row['learned']
    if row['state'] == 'up':
        done = f"{_minutes(row['seconds'])} of work since {time.strftime('%H:%M', time.localtime(row['since']))}"
        if know['seconds']:
            s = know['seconds']
            return (f"{name}: answering, {done}; it usually stops after about {_minutes(s['usual'])} "
                    f"({_minutes(s['low'])} to {_minutes(s['high'])}, seen {s['seen']} times), so about {_minutes(row['left'])} left")
        return f"{name}: answering, {done}; its limit is not known yet"
    out = f"out since {time.strftime('%H:%M', time.localtime(row['since']))}"
    if row['back'] and know['rest'] is None:
        return f"{name}: {out}, back at {time.strftime('%a %H:%M', time.localtime(row['back']))} (the provider's own reset)"
    if know['rest']:
        r = know['rest']
        when = time.strftime('%H:%M', time.localtime(row['back']))
        late = ' (overdue, being tried)' if row['back'] < now else ''
        return (f"{name}: {out}; it is usually back after about {_minutes(r['usual'])} "
                f"({_minutes(r['low'])} to {_minutes(r['high'])}, seen {r['seen']} times), so about {when}{late}")
    return f"{name}: {out}; how long it stays out is not known yet, it is being tried at growing gaps"


def report(now=None, path=None, only=None, facts=False):
    rows = [r for r in forecast(now, path) if only is None or r['model'] in only]
    return [line(r, now) + (f". Published: {published(r['model'])}" if facts and published(r['model']) else '') for r in rows]


if __name__ == '__main__':
    lines = report(facts=True)
    print('\n'.join(lines) if lines else 'Nothing seen yet: the table fills as the free models are used.')
    if '--json' in sys.argv:
        print(json.dumps(forecast(), indent=1))
