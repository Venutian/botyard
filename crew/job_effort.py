#!/usr/bin/env python3
"""The Claude effort a job asks for. No AI.

A bot's configured effort is its default. A job can ask for another with one line in its description,
`EFFORT: high` (written by start-session.py --effort), or a label `effort:high` when the job has labels.
claude-bot.sh calls this with the running job's id (the run's BOTYARD_JOB_ID) and swaps the engine's
`--effort` argument for the answer. Prints nothing when the job asks for nothing, so the default stays.

    python3 job_effort.py            the running job's effort, or nothing
"""
import json
import os
import re
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import botyard_home  # noqa: E402

LEVELS = ('low', 'medium', 'high', 'xhigh')
LINE = re.compile(r'^\s*EFFORT:\s*(\w+)\s*$', re.M | re.I)


def asked(issue):
    """The effort a job row asks for, or '' (none, or a value that is not a level: the default stays)."""
    found = []
    for label in issue.get('labels') or []:
        name = (label.get('name') if isinstance(label, dict) else str(label)) or ''
        if name.lower().startswith('effort:'):
            found.append(name.split(':', 1)[1].strip().lower())
    found += [m.lower() for m in LINE.findall(issue.get('description') or '')]
    good = [f for f in found if f in LEVELS]
    return good[-1] if good else ''


def swap(args, effort):
    """The claude arguments with the value after --effort replaced; unchanged when effort is empty."""
    out, i = [], 0
    while i < len(args):
        if args[i] == '--effort' and effort and i + 1 < len(args):
            out += ['--effort', effort]
            i += 2
        else:
            out.append(args[i])
            i += 1
    return out


def running(env=None):
    env = os.environ if env is None else env
    job = botyard_home.run_var('JOB_ID', env=env)
    key = botyard_home.run_var('API_KEY', env=env)
    if not job:
        return ''
    req = urllib.request.Request(f'{botyard_home.api(env)}/issues/{job}',
                                 headers={'Authorization': f'Bearer {key}'} if key else {})
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            return asked(json.load(res))
    except (OSError, ValueError):
        return ''


if __name__ == '__main__':
    print(running())
