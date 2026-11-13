#!/usr/bin/env python3
"""How long a shell command waits by design, and the rule every bot's run is held to. No AI.

A run that sits in `until [ -f job.done ]; do sleep 30; done` spends its whole time limit doing nothing,
holds a place another job could have, and is then cut and started again with its whole session re-read.
Waiting is done outside the run: the job is started detached, the session registers its done file with
botyard-wait and ends its run, and Botyard wakes the same session when the file appears.

The rule, used by loop-guard.py (which refuses the call before it runs) and by free-runner.py (which
sees a free model's calls after they ran, and stops the run):

  refused   a loop of until/while with sleep that no `timeout N` bounds to WAIT_MAX seconds,
            one command that sleeps more than WAIT_MAX seconds in all,
            any further wait once a run has slept BUDGET seconds in all.
  allowed   a job started detached (setsid/nohup ... &, or in the background), and everything that
            is not a wait.

A wait is measured by what the command says, not by its text being the same as the last one, so a wait
whose number changes each time is counted like any other.
"""
import re

WAIT_MAX = 120
BUDGET = 600
LOOP = re.compile(r'\b(until|while)\b.*?\bdo\b.*?\bsleep\s+\d', re.S)
# sleep as a command (after ; && | do then ( or at the start of a -c script), not as a word in a pattern.
SLEEP = re.compile(r'(?:^|[;&|({]|\bdo\b|\bthen\b|-c\s+[\'"])\s*sleep\s+(\d+(?:\.\d+)?)([smh]?)\b', re.M)
TIMEOUT = re.compile(r'\btimeout\s+(?:-\S+\s+)*(\d+(?:\.\d+)?)([smh]?)\b')
DETACHED = re.compile(r'\b(setsid|nohup)\b.*&\s*$', re.S)
UNIT = {'': 1, 's': 1, 'm': 60, 'h': 3600}
HOW = ('Do not wait inside your run. If the job is not already detached, start it detached with its output in a '
       'file (setsid nohup bash -c \'CMD > job.log 2>&1; touch job.done\' > /dev/null 2>&1 &). Then run: '
       'botyard-wait job.done   (the done file of the last job you wait for). Write its state in one comment on '
       'your job (what runs, which file, what to do when it is done) and end your run. Botyard wakes this same '
       'session when the file appears, and nothing is spent while it waits. Do not look for another way to wait.')


def seconds(command):
    """How long this command waits by design, in seconds, and whether that is a loop with no bound."""
    command = str(command or '')
    sleeps = [float(n) * UNIT[u] for n, u in SLEEP.findall(command)]
    if not sleeps:
        return 0, False
    if LOOP.search(command):
        bounds = [float(n) * UNIT[u] for n, u in TIMEOUT.findall(command)]
        return (max(bounds), False) if bounds else (0, True)
    return sum(sleeps), False


def detached(command, background=False):
    """True when the command starts something and lets go of it: that is how to wait, not a wait."""
    return bool(background) or bool(DETACHED.search(str(command or '').strip()))


def judge(command, waited=0, background=False):
    """(why this wait is refused or None, the seconds it adds to what the run has waited)."""
    if detached(command, background):
        return None, 0
    wait, unbounded = seconds(command)
    if unbounded:
        return 'this command waits in a loop with no end. ' + HOW, 0
    if wait > WAIT_MAX:
        return f'this command waits up to {round(wait / 60)} minutes inside your run. ' + HOW, 0
    if wait and waited + wait > BUDGET:
        return f'this run has already spent {round(waited / 60)} minutes waiting. ' + HOW, 0
    return None, wait
