#!/usr/bin/env python3
"""How much of each subscription the studio has used this week. No AI.

Claude reports its weekly use in every run's log, and Codex writes its own in its session files. This
reads the newest of each, so the lead can plan Claude work around the limit and the token guard can stop
the Claude bots before they eat the owner's own Claude Code time or paid extra usage.

    python3 ~/.botyard/crew/usage.py          a short table
    python3 ~/.botyard/crew/usage.py --json   the same, for scripts
"""
import glob
import gzip
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import botyard_home  # noqa: E402

HOME = os.path.expanduser('~')
RUN_LOGS = botyard_home.places()['run_logs']
CODEX_SESSIONS = (botyard_home.state('codex-safe/sessions'), f'{HOME}/.codex/sessions')
GUARD = botyard_home.config_dir()
THINKER = botyard_home.state('thinker.json')
NEWEST_FILES = 40
WEEK_MINUTES = 7 * 24 * 60
# Claude's logs keep the reading inside an escaped JSON string, so quotes may carry backslashes.
CLAUDE_WEEK = re.compile(r'seven_day\\*"\s*:\s*\{\\*"utilization\\*"\s*:\s*([0-9.]+)\s*,\s*\\*"resetsAt\\*"\s*:\s*(\d+)')
CODEX_WINDOW = re.compile(r'"used_percent":([0-9.]+),"window_minutes":(\d+),"resets_at":(\d+)')


def newest(folders, pattern):
    files = [f for folder in folders for f in glob.glob(f'{folder}/**/{pattern}', recursive=True) if os.path.isfile(f)]
    return sorted(files, key=os.path.getmtime, reverse=True)[:NEWEST_FILES]


def text(path):
    try:
        with (gzip.open(path) if path.endswith('.gz') else open(path, 'rb')) as f:
            return f.read().decode('utf8', 'replace')
    except OSError:
        return ''


def claude():
    """The latest weekly share a Claude run logged. Once its week has reset, the share is back to zero."""
    for path in newest([RUN_LOGS], '*'):
        found = CLAUDE_WEEK.findall(text(path))
        if found:
            share, resets = float(found[-1][0]), int(found[-1][1])
            fresh = resets > time.time()
            return {'week': share if fresh else 0.0, 'resets': resets if fresh else None, 'seen': os.path.getmtime(path)}
    return None


def codex():
    """The latest weekly and five-hour shares from Codex's own session files."""
    for path in newest(CODEX_SESSIONS, '*.jsonl'):
        windows = CODEX_WINDOW.findall(text(path))
        if not windows:
            continue
        latest = {}
        for used, minutes, resets in windows:
            latest[int(minutes)] = (float(used) / 100, int(resets))
        week = latest.get(WEEK_MINUTES)
        short = latest.get(min((m for m in latest if m < WEEK_MINUTES), default=None))
        now = time.time()
        share = lambda w: (w[0] if w[1] > now else 0.0) if w else None
        return {'week': share(week), 'resets': week[1] if week and week[1] > now else None,
                'shortWindow': share(short), 'shortResets': short[1] if short and short[1] > now else None,
                'seen': os.path.getmtime(path)}
    return None


def guard():
    def read(name):
        try:
            return json.load(open(f'{GUARD}/{name}'))
        except (OSError, ValueError):
            return {}
    settings, state = read('guard.json'), read('guard-state.json')
    return {'enabled': bool(settings.get('enabled')), 'limit': settings.get('limit', 0),
            'used': state.get('used', 0), 'tripped': bool(state.get('tripped')), 'why': state.get('why', '')}


def thinking():
    """Where the Codex bots think now. fallback.py moves them to Gemini while Codex is out."""
    try:
        state = json.load(open(THINKER))
    except (OSError, ValueError):
        state = {}
    return {'on': state.get('on', 'codex'), 'back': state.get('back')}


def when(stamp):
    return time.strftime('%a %H:%M', time.localtime(stamp)) if stamp else 'unknown'


def age(stamp):
    hours = (time.time() - stamp) / 3600
    return f'{hours:.0f} h ago' if hours >= 1 else 'just now'


def main():
    report = {'claude': claude(), 'codex': codex(), 'guard': guard(), 'thinking': thinking()}
    if '--json' in sys.argv:
        print(json.dumps(report))
        return
    c, x, g, t = report['claude'], report['codex'], report['guard'], report['thinking']
    print(f"Claude  this week {c['week']:.0%} used, resets {when(c['resets'])} (read {age(c['seen'])})" if c else 'Claude  no reading yet')
    print(f"Codex   this week {x['week']:.0%} used, five-hour window {x['shortWindow']:.0%}, resets {when(x['resets'])} (read {age(x['seen'])})"
          if x and x['week'] is not None else 'Codex   no reading yet')
    if t['on'] == 'gemini':
        print(f"Backup  the Codex bots think in Antigravity while Codex is out, until about {when(t['back'])}")
    state = 'Claude bots paused' if g['tripped'] else 'Claude bots running'
    print(f"Guard   {'on' if g['enabled'] else 'off'}, {g['used'] / 1e6:.1f}M of {g['limit'] / 1e6:.0f}M Claude tokens this week, {state}"
          + (f" ({g['why']})" if g['tripped'] and g['why'] else ''))


if __name__ == '__main__':
    main()
