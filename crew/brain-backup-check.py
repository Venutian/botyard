#!/usr/bin/env python3
"""The notes backup's health: a line when its last run failed or it has stopped running. No AI.

A notes folder's backup script (any that keeps this shape) writes `brain-backup.json` in Botyard's home:
{"ok": bool, "at": ISO time of the last run, "error": why it failed, "last_push": ISO time}. No file: no backup
is set up, and nothing is said.
"""
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import botyard_home  # noqa: E402

STALE_HOURS = 3


def faults(env=None, now=None):
    path = os.path.join(botyard_home.home(env), 'brain-backup.json')
    try:
        state = json.load(open(path))
    except (OSError, ValueError):
        return []
    now = now or datetime.datetime.now(datetime.timezone.utc)
    out = []
    if state.get('ok') is False:
        out.append(f'the notes backup failed: {str(state.get("error") or "no reason given")[:200]}')
    try:
        at = datetime.datetime.fromisoformat(state.get('at', ''))
        if (now - at).total_seconds() > STALE_HOURS * 3600:
            out.append(f'the notes backup has not run since {at.isoformat(timespec="minutes")}')
    except (TypeError, ValueError):
        out.append('the notes backup left no time of its last run')
    return out


if __name__ == '__main__':
    found = faults()
    print('\n'.join(found) or 'notes backup: ok')
    sys.exit(1 if found else 0)
