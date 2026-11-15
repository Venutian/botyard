#!/usr/bin/env python3
"""Stops a Claude bot going round in circles, and stops it waiting inside its own run. No AI.
claude-bot.sh gives every Claude bot this as a PreToolUse hook.

Circles: the same tool call, with the same input, again and again with nothing changed between. An edit
or a write counts as a change and starts the count again, so re-running a test after a fix is never a
loop. At REPEATS identical calls the call is refused, and the bot is told why, so it changes its
approach or ends the step and reports.

Payload and long commands (guards.py): a read of a binary or of a file over 1 MB is refused, and so is a
foreground command that asks for more than 5 minutes or runs the heavy-job launcher in the foreground.

Waits: a wait is judged by what the command says (waits.py), not by its text repeating, so a poll whose
number changes each time is seen like any other. A loop with no end, one long wait, or more waiting than
a run's budget is refused, and the bot is told how to wait without spending its run: start the job
detached, register its done file with botyard-wait, end the run. The free crew is held to the same rule
by free-runner.py.
"""
import hashlib
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import botyard_home  # noqa: E402
import guards  # noqa: E402
import waits  # noqa: E402

REPEATS = 5
# A run's waiting is counted for this long: a later run of the same session starts with a new budget.
RUN_SPAN = 3 * 3600
CHANGES = {'Edit', 'Write', 'MultiEdit', 'NotebookEdit'}
# Words a bot writes fresh each time about the same call: they do not make it a new call.
NOT_THE_CALL = {'description', 'timeout', 'run_in_background'}
STATE = botyard_home.state('loop-guard')
TOLD = ('You have made this exact call {n} times with nothing changed between: it will not give a new '
        'answer. Stop repeating it. Change your approach, read what the last result told you, or end the '
        'step and say in your report what is stuck.')


def check(event, state):
    """The refusal text for this call, or None; state is updated in place."""
    tool = event.get('tool_name') or ''
    calls = state.setdefault('calls', {})
    if tool in CHANGES:
        # A change starts the count of identical calls again; what the run has waited stays counted.
        calls.clear()
        return None
    given = event.get('tool_input') or {}
    # STANDARDS.md rules 14 and 16: nothing binary or huge is read whole, and nothing long runs in the foreground.
    told = guards.unreadable(tool, given, event.get('cwd'))
    if not told and tool == 'Bash':
        told = guards.too_slow(given)
    if told:
        return told
    if tool == 'Bash' and isinstance(given, dict):
        why, added = waits.judge(given.get('command'), state.get('waited', 0), given.get('run_in_background'))
        if why:
            return 'Refused: ' + why
        state['waited'] = state.get('waited', 0) + added
    given = {k: v for k, v in given.items() if k not in NOT_THE_CALL} if isinstance(given, dict) else given
    call = json.dumps({'tool': tool, 'input': given}, sort_keys=True)
    key = hashlib.sha1(call.encode()).hexdigest()
    calls[key] = calls.get(key, 0) + 1
    return TOLD.format(n=calls[key]) if calls[key] >= REPEATS else None


def main():
    try:
        event = json.load(sys.stdin)
    except ValueError:
        return 0
    session = re.sub(r'[^\w-]', '', str(event.get('session_id') or 'none'))[:80]
    os.makedirs(STATE, exist_ok=True)
    path = f'{STATE}/{session}.json'
    try:
        state = json.load(open(path))
    except (OSError, ValueError):
        state = {}
    if not isinstance(state.get('calls'), dict):
        state = {}
    if time.time() - state.get('at', 0) > RUN_SPAN:
        state['waited'], state['at'] = 0, time.time()
    told = check(event, state)
    with open(path, 'w') as f:
        json.dump(state, f)
    # Old sessions' counts are of no use after a day.
    for name in os.listdir(STATE):
        full = f'{STATE}/{name}'
        if time.time() - os.path.getmtime(full) > 86400:
            os.remove(full)
    if told:
        sys.stderr.write(told + '\n')
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
