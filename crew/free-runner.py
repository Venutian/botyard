#!/usr/bin/env python3
"""The free builder's OpenCode: when his free model runs out mid-job, he carries on in the same session
on the next free model, inside the same run. No AI of its own.

Free models run out often and without an error: over its limit OpenCode just goes quiet. Before this,
fallback.py stopped the run and the engine started a new one, which began with no memory of the job and
spent 10 to 15 minutes reading it all again. Here, a run quiet
for QUIET seconds asks its model for one word. A model that answers is busy (a long build or test), so
the run goes on. One that does not is set aside for an hour, and OpenCode is started again with
--session on the best free model that answers, told to continue where it stopped. When a model of
another family does not answer either, the connection is down, and the run waits instead.

Free limits are counted per model, so the free builder's runs at once each take a different model, of another family
where one answers: two jobs on one model ran DeepSeek out in half an hour on 10 November. Each run
claims its model in free-busy.json, which every other run reads before it picks.

A model can also go round in circles: the same command with the same arguments, again and again, with
nothing changed in the worktree between. That is never a new question, only a run that burns its free
limit. Loops counts each tool call against the files as they stood (OpenCode's snapshot at each step):
the fifth identical call with nothing changed stops the run, which goes on once, in the same session, on
a model of another family told what it was repeating. A second loop ends the run. Re-running a test after
an edit is a new snapshot, so it never counts.

A model can also wait inside its run: a poll for a done file with a sleep in it. A wait is measured by
what the command says (waits.py), so one whose number changes each time is counted too. A wait with no
end, one long wait, or more waiting than a run's budget stops the run the same way, and it goes on once
told how to wait without spending a run (start the job detached, botyard-wait, end the run).

A checker runs here too. She does not judge a build on the model family that made it: every pick takes
another family first, a lighter model of another family before a strong one of the same. When no other
family answers at all, the check still runs, and says so on its own job (SAME-FAMILY CHECK), so the
pipeline tells the lead it was not an independent check.

The engine runs it as the free builder's command with OpenCode's own arguments and the prompt on stdin.
"""
import atexit
import collections
import fcntl
import importlib.util
import json
import os
import queue
import signal
import subprocess
import sys
import threading
import time
import re
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import botyard_home  # noqa: E402
import git_identity  # noqa: E402  (imported directly: tests stub load())
import guards  # noqa: E402
import waits  # noqa: E402

HERE = os.path.dirname(os.path.realpath(__file__))
QUIET = 240
MOST_SWITCHES = 8
BUSY = botyard_home.state('free-busy.json')
# A provider that answers 429 ("Too Many Requests", "usage limit reached") rests here for REST_FOR seconds: every run
# picks another provider's model meanwhile, instead of each run waiting out the same provider in turn.
RESTING = botyard_home.state('free-rest.json')
REST_FOR = 600
# The same call with nothing changed: this many is a loop.
REPEATS = 5
# How old the kept listing of the tool's models may be before a run asks the tool again.
LIST_AGAIN = 6 * 3600
WAITED = ('You were waiting inside your run ({call}): {why}')
PAYLOAD = ('You put something into your session that must not be there ({call}): {why} Carry on without it: check it '
           'by name and size, or run a script that prints only what you need.')
# How often the run looks for a foreground command that has gone past guards.FOREGROUND_MAX.
LOOK_EVERY = 15
SAME_FAMILY = 'SAME-FAMILY CHECK:'
# STANDARDS.md rule 22: a run whose limit is over LONG_RUN minutes is told at NOTICE_AT of it to write its state
# and finish its step, so a stop at the time limit loses nothing. The limit comes from the bot's own file
# (crew_set.py sets BOTYARD_RUN_MINUTES); the runner cannot see the engine's clock.
LONG_RUN = 45
NOTICE_AT = 0.8
# The notice waits for the end of a step (OpenCode's step_finish) but not longer than this many seconds.
NOTICE_WAIT = 120
NOTICE = ('You are at {used} of the {limit} minutes this run is allowed, and it is stopped at the limit. Write your '
          'state now: add your checkpoint to your ledger as your rules say (what is done, what is next, in one '
          'line), finish the step you are on, and do not start a new large one. The next run carries on from that '
          'checkpoint.')
LOOPED = ('You were going round in circles: you ran {call} {times} times with nothing in the worktree changing '
          'between. Stop repeating it. Read what it returned, decide what that means, and take a different next '
          'step; if you are blocked, say what blocks you and end the task with OUTCOME: NOT MET and why.')
CONTINUE = ('The free model you were running on ran out partway through this task, so you are now on another '
            'model in the same session. Carry on from exactly where you stopped: check what is already done in '
            'the worktree (git status, the last files you changed) instead of starting over.')
# A run that ends without one tool call did none of its work: every job is read, done and closed through tools. On
# 22 Nov four runs of one scout on one free model wrote only "grant me read access" (the files were readable): the
# resumed session kept repeating an old refusal. Such a model is set aside for NO_TOOLS_FOR and the job starts again
# once on another model in a new session, so nothing the old session believed comes with it.
NO_TOOLS_FOR = 86400


class Loops:
    """Counts identical tool calls against the worktree as it stood. feed() takes OpenCode's JSON events
    one at a time and returns a short description of the call once it has repeated too often."""

    def __init__(self):
        self.snapshot = ''
        self.seen = collections.Counter()
        self.waited = 0
        # What the model is told when feed() stops the run for something that is not a circle.
        self.prompt = None
        # Tool calls seen this start, whatever they returned.
        self.tools = 0

    def feed(self, event):
        part = event.get('part') or {}
        if event.get('type') == 'step_start':
            self.snapshot = part.get('snapshot') or self.snapshot
            return None
        if event.get('type') != 'tool_use':
            return None
        state = part.get('state') or {}
        if state.get('status') not in (None, 'completed', 'error'):
            return None
        self.tools += 1
        tool, given = part.get('tool') or '?', state.get('input') or {}
        key = (tool, json.dumps(given, sort_keys=True), self.snapshot)
        self.seen[key] += 1
        command = str(given.get('command') or '')
        shown = command or json.dumps(given)[:120]
        # STANDARDS.md rule 14: a binary or a huge file read whole, or an output past the cap. It has already
        # run (OpenCode reports a call when it ends), so the run stops here, in the same session, told why.
        big = guards.unreadable(tool, given, os.getcwd())
        if not big and len(str(state.get('output') or '')) > guards.OUTPUT_MAX:
            big = f'its output was {len(str(state["output"])):,} characters, over the {guards.OUTPUT_MAX:,} a tool result may have.'
        if big:
            self.prompt = PAYLOAD.format(call=f'{tool} `{shown[:120]}`', why=big)
            return f'{tool} `{shown[:160]}`', big
        # A wait is judged by what it says, so a poll with a new number each time is seen too. It has
        # already run by now: what it waited is counted, and the one past the rule stops the run.
        why, added = waits.judge(command, self.waited)
        if why:
            self.prompt = WAITED.format(call=f'{tool} `{shown[:160]}`', why=why)
            return f'{tool} `{shown[:160]}`', why
        self.waited += added
        if self.seen[key] < REPEATS:
            return None
        return f'{tool} `{shown[:160]}`', self.seen[key]


def pause(seconds):
    time.sleep(seconds)


def clock():
    return time.time()


def run_minutes(env=None):
    """The run's time limit in minutes from the bot's file, or 0 when it is not told."""
    try:
        return int((env if env is not None else os.environ).get('BOTYARD_RUN_MINUTES') or 0)
    except ValueError:
        return 0


def notice_due(started, minutes, now, noticed, step_ended, since=None):
    """True when a run that may last over LONG_RUN minutes has used NOTICE_AT of its limit and has not yet been
    told: at a step's end, or NOTICE_WAIT seconds after the point if no step ends by then."""
    if noticed or minutes <= LONG_RUN:
        return False
    point = started + minutes * 60 * NOTICE_AT
    return now >= point and (step_ended or now >= point + NOTICE_WAIT)


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, f'{HERE}/{file}')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# What a provider says when a model will never serve this PC: blocked in the owner's region, or gone from
# the offer. On 11 and 12 November runs kept switching to inkling-2-small (403, not in this region) and
# flint-v1.0 (no longer offered) because a model that failed was only set aside for an hour; each switch
# sent the whole session, 300,000 tokens and more, to a model that could only refuse it.
GONE = ('not available in your region', 'model is unavailable', 'model not found', 'unknown model',
        'no endpoints found', 'not a valid model', 'model does not exist')
GONE_FOR = 30 * 86400
# A provider's own daily cap on free use: every model of that provider is out until its day resets.
PER_DAY = ('free-models-per-day', 'per day', 'daily limit', 'daily')
# STANDARDS.md rule 22: "quota" alone may be one model's; with one of these it speaks for the whole provider.
WIDE = ('every model', 'all models', 'all free models', 'provider', 'account', 'free tier', 'free-tier')
BUSY_WORDS = ('too many requests', '429', 'rate limit', 'overloaded')
# A prompt that outgrew the model's context window: the model cannot take the work, so the run hands
# over to a model that can (same session), instead of failing the run.
CONTEXT = ('context length', 'context window', 'context limit', 'maximum context length', 'prompt is too long', 'token count exceeds', 'exceeds the context', 'too many tokens')


# Providers whose daily caps are one model's each (free-limits.py PUBLISHED: OpenCode's longcat has its own 100
# requests a day), so a bare "per day" there sets that model aside and no other.
PER_MODEL_DAY = ('opencode/',)


def provider_wide(text, model=None):
    """True when an error names a cap on the whole provider (a day's count, a quota for every model), not one
    model: STANDARDS.md rule 22. Such a cap sets every model of that provider aside."""
    text = (text or '').lower()
    if 'free-models-per-day' in text or any(w in text for w in WIDE) and any(w in text for w in ('quota',) + PER_DAY):
        return True
    if model and model.startswith(PER_MODEL_DAY):
        return False
    return any(w in text for w in PER_DAY)


# What each asked model last said, so a one-word ask refused for a provider's daily cap is understood as
# one and sets the whole provider aside, instead of every model of it being asked in turn.
SAID = {}


def said(model, got):
    """Why a model that was asked and did not answer is out: its words when they name a provider-wide cap."""
    if got == 'gone':
        return 'model is unavailable (asked before the switch)'
    text = SAID.get(model) or ''
    return text if provider_wide(text, model) else None


def probe(opencode, model):
    """One word from the model, never from a cache: 'ok' when it answers, 'gone' when the provider says it
    can never serve us, else 'out' (its limit, or busy)."""
    SAID.pop(model, None)
    try:
        out = subprocess.run([opencode, 'run', '-m', model, 'Reply with exactly: pong'], capture_output=True, text=True,
                             timeout=30, stdin=subprocess.DEVNULL, cwd='/tmp', env={**os.environ, 'PWD': '/tmp'})
    except (OSError, subprocess.TimeoutExpired):
        return 'out'
    if 'pong' in out.stdout.lower():
        return 'ok'
    SAID[model] = (out.stdout + ' ' + out.stderr)[-300:]
    return 'gone' if any(w in (out.stdout + out.stderr).lower() for w in GONE) else 'out'


def answers(opencode, model):
    return probe(opencode, model) == 'ok'


def next_utc_day(now=None):
    now = time.time() if now is None else now
    return int(now // 86400 + 1) * 86400 + 300


def provider_reset(fallback, model, now=None):
    """When the model's provider turns its day over: free-limits knows it for the providers that publish it,
    else the start of the next UTC day."""
    try:
        got = fallback.limits().reset_at(model, now)
    except (AttributeError, TypeError):
        got = None
    return got or next_utc_day(now)


def set_aside(fallback, bots, model, why):
    """Sets a model aside for as long as the reason lasts: a month when it can never serve us, the rest of
    the provider's day for its daily cap (every model of that provider), else what its history says."""
    text = (why or '').lower()
    if any(w in text for w in GONE):
        fallback.set_free_aside(bots, model, f'never serves this PC: {why}'[:200], until=int(time.time() + GONE_FOR))
    elif provider_wide(text, model):
        provider = model.split('/')[0] + '/'
        until = provider_reset(fallback, model)
        for m, _, _ in bots.free_list():
            if m.startswith(provider):
                fallback.set_free_aside(bots, m, f'its provider\'s daily free cap: {why}'[:200], until=until)
    else:
        fallback.set_free_aside(bots, model, (why or 'did not answer: its free limit, or the offer ended')[:200])
    return fallback.setup()


def next_working(fallback, bots, avoid_family=None, tries=4):
    """The next free model that answers now, asked before it is handed the session: a model that cannot
    answer one word would only take the whole session's tokens and fail. None when none answers."""
    for _ in range(tries):
        nxt = pick(bots, avoid_family=avoid_family)
        if not nxt:
            return None, bots
        claim(nxt)
        got = probe(bots.OPENCODE, nxt)
        if got == 'ok':
            fallback.limits().answered(nxt)
            return nxt, bots
        bots = set_aside(fallback, bots, nxt, said(nxt, got))
    return None, bots


def error_of(event):
    """The provider's message in one of OpenCode's error events, or None."""
    if not isinstance(event, dict) or event.get('type') != 'error':
        return None
    err = event.get('error') or {}
    data = err.get('data') if isinstance(err, dict) else None
    return str((data or {}).get('message') or (err.get('name') if isinstance(err, dict) else err) or 'error')[:300]


def context_error(text):
    """True when an error says the prompt outgrew the model's context window: the model cannot take the work, so
    the run goes on in the same session on a model that can, instead of failing the run."""
    text = (text or '').lower()
    return any(w in text for w in CONTEXT)


def alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError):
        return False


def stop_child(child, wait=30):
    """Waits for a stopped OpenCode to exit, and kills it if it has not after `wait` seconds: a slow exit crashed the
    whole run with TimeoutExpired (18 Nov, four scout runs failed that way)."""
    try:
        child.wait(timeout=wait)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except OSError:
            pass
        child.wait()


PACE_WAIT, PACE_MOST = 300, 45 * 60


def pace_kind(env=None):
    env = env or os.environ
    # The bot's role sets its pace (BOTYARD_PACE_KIND), apart from the models it takes: a scout may run on strong models.
    kind = env.get('BOTYARD_PACE_KIND', '').strip()
    if kind in ('build', 'check', 'scout'):
        return kind
    return 'check' if env.get('BOTYARD_CHECKER') else 'scout' if env.get('BOTYARD_FREE_TIER') == 'light' else 'build'


def paced(env=None, run=subprocess.run, sleep=time.sleep, clock=time.time):
    """Asks the studio's pace gate (BOTYARD_FREE_PACE, a command that exits 0 to go and 3 to hold) before the run's
    first model call, so no starter can drain a daily free allowance at once. Waits while it holds, up to PACE_MOST;
    '' when the run may go, else why it was held. No gate named: the run goes."""
    env = env or os.environ
    gate = env.get('BOTYARD_FREE_PACE', '').strip()
    if not gate or not os.path.isfile(gate):
        return ''
    begun, told, why = clock(), False, ''
    while True:
        try:
            done = run([sys.executable, gate, '--kind', pace_kind(env), '--grant'], capture_output=True, text=True, timeout=60)
        except (OSError, subprocess.SubprocessError):
            return ''
        if done.returncode != 3:
            return ''
        why = (done.stdout or '').strip()[:200]
        if clock() - begun >= PACE_MOST:
            return why
        if not told:
            note(f"A free run waits for the day's pace: {why}")
            told = True
        sleep(PACE_WAIT)


def provider_of(model):
    return (model or '').split('/')[0]


def resting(now=None):
    """The providers resting after a 429 now, with until when."""
    now = now or time.time()
    try:
        with open(RESTING) as f:
            got = json.load(f)
    except (OSError, ValueError):
        return {}
    return {p: t for p, t in got.items() if isinstance(t, (int, float)) and t > now} if isinstance(got, dict) else {}


def rest(model, seconds=REST_FOR, now=None):
    """Rests the model's provider for `seconds` after a 429. Returns the provider."""
    provider, now = provider_of(model), now or time.time()
    if not provider:
        return provider
    with open(RESTING, 'a+') as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        f.seek(0)
        try:
            got = json.loads(f.read() or '{}')
        except ValueError:
            got = {}
        got = {p: t for p, t in (got.items() if isinstance(got, dict) else []) if isinstance(t, (int, float)) and t > now}
        got[provider] = max(got.get(provider, 0), now + seconds)
        f.seek(0)
        f.truncate()
        json.dump(got, f)
    return provider


def light_first():
    """True for a run whose bot takes the light free models first (a scout), keeping the strong ones for builds and checks."""
    return os.environ.get('BOTYARD_FREE_TIER') == 'light'


def best_first():
    """True for a run whose bot takes the strongest free model answering, by measured pass rate, even one another run
    is on (a money scout: its work is worth more than the share of a model's requests it takes)."""
    return os.environ.get('BOTYARD_FREE_TIER') == 'best'


def claim(model):
    """Records this run's model, or none, and returns the models the free builder's other live runs are on."""
    with open(BUSY, 'a+') as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        f.seek(0)
        try:
            busy = json.loads(f.read() or '{}')
        except ValueError:
            busy = {}
        busy = {pid: m for pid, m in busy.items() if pid != str(os.getpid()) and alive(pid)}
        others = set(busy.values())
        if model:
            busy[str(os.getpid())] = model
        f.seek(0)
        f.truncate()
        json.dump(busy, f)
    return others


# A checker runs here too, with BOTYARD_CHECKER set: she must not judge a build on the family that made
# it, so that family is avoided at every pick, the way fallback.py chose for her before (11 November).
NEVER = set()


def build_family(bots):
    """The family of the model that made the build this check is for, from its job: None when unknown."""
    base, task = botyard_home.run_var('API_URL'), botyard_home.run_var('JOB_ID')
    if not (base and task):
        return None
    try:
        req = urllib.request.Request(f"{base.rstrip('/')}/api/issues/{task}",
                                     headers={'Authorization': f"Bearer {botyard_home.run_var('API_KEY', '')}"})
        with urllib.request.urlopen(req, timeout=20) as res:
            text = json.load(res).get('description') or ''
    except (OSError, ValueError):
        return None
    built = (re.findall(r'built-on: (\S+) -->', text) or [None])[0]
    return bots.free_family(built) if built and built != 'None' else None


def same_family(bots, model):
    """True when this run is a check and the model is of the family that made the build."""
    return bool(NEVER) and bool(model) and bots.free_family(model) in NEVER


def say_same_family(bots, model, post=None):
    """Says on the check's own job that it could not be run on another family than the build's. Once a
    run. The pipeline reads the line and tells the lead the check was not independent."""
    if getattr(say_same_family, 'said', False):
        return False
    say_same_family.said = True
    base, job = botyard_home.run_var('API_URL'), botyard_home.run_var('JOB_ID')
    text = (f"{SAME_FAMILY} no free model of another family than the build's ({', '.join(sorted(NEVER))}) answers now, so "
            f"this check runs on {model}, the family that made the build. It is a second look by the same kind of "
            "model, not an independent check.\n\n<!-- botyard-script: free-runner -->")
    note(f'The checker had only the build\'s own family left: {model}')
    sys.stderr.write(text.split('\n')[0] + '\n')
    if post:
        return post(text)
    if not (base and job):
        return False
    try:
        req = urllib.request.Request(f"{base.rstrip('/')}/api/issues/{job}/comments", method='POST', data=json.dumps({'body': text}).encode(),
                                     headers={'Content-Type': 'application/json', 'Authorization': f"Bearer {botyard_home.run_var('API_KEY', '')}"})
        urllib.request.urlopen(req, timeout=20).close()
        return True
    except (OSError, ValueError):
        return False


def list_again(bots, run=subprocess.run, now=None):
    """Asks the tool which models it has when the kept listing is older than LIST_AGAIN, so a name that
    left the offer is not handed a run. A tool that does not answer changes nothing."""
    now = time.time() if now is None else now
    kept = bots.read_json(bots.FREE_LISTED, {})
    if isinstance(kept, dict) and now - kept.get('at', 0) < LIST_AGAIN:
        return False
    try:
        extra = botyard_home.providers_config()
        out = run([bots.OPENCODE, 'models'], capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL,
                  env={**os.environ, **botyard_home.key_env(), **({'OPENCODE_CONFIG': extra} if extra else {})})
    except (OSError, subprocess.TimeoutExpired):
        return False
    return bots.keep_tool_models([line.strip() for line in out.stdout.splitlines() if '/' in line and ' ' not in line.strip()], now=now)


def pick(bots, avoid_family=None):
    """The best strong free model no other builder run is on, of a family none of them uses where one is
    left; then any strong one; then any that is not set aside. A check takes a model of another family
    than the build's before any of these, a light one if no strong one is left."""
    used = claim(None)
    families = {bots.free_family(m) for m in used} | {avoid_family} | NEVER
    aside = bots.free_aside()
    rows = [(m, f, t) for m, f, t in bots.free_list() if m not in aside]
    rested = resting()
    awake = [r for r in rows if provider_of(r[0]) not in rested]
    rows = awake or rows
    if best_first() and not NEVER:
        best = bots.free_best(rows, bots.read_json(bots.FREE_SCORES, {}))
        if best:
            return best[0]
    if light_first() and not NEVER:
        light = [m for m, f, t in rows if t != 'strong']
        for choice in ([m for m in light if m not in used], light):
            if choice:
                return choice[0]
    if NEVER:
        other = [(m, f, t) for m, f, t in rows if f not in NEVER]
        for choice in ([m for m, f, t in other if t == 'strong' and m not in used and f not in families],
                       [m for m, f, t in other if t == 'strong' and m not in used], [m for m, f, t in other if t == 'strong'],
                       [m for m, f, t in other if m not in used], [m for m, _, _ in other]):
            if choice:
                return choice[0]
    strong = [(m, f) for m, f, t in rows if t == 'strong']
    # NVIDIA's requests a minute are shared by every model on the key, so a second run there takes from
    # the first: on 11 November the free builder and the checker on two NVIDIA models got "Too Many Requests" all night.
    pools = {m.split('/')[0] for m in used if m.startswith('nvidia/')}
    for choice in ([m for m, f in strong if m not in used and f not in families and m.split('/')[0] not in pools],
                   [m for m, f in strong if m not in used and f not in families], [m for m, f in strong if m not in used],
                   [m for m, _ in strong], [m for m, _, _ in rows]):
        if choice:
            return choice[0]
    return None


def no_tools(code, tools, prompt):
    """True when a run ended as if done (code 0) with no tool call at all on a real task: it did none of the work."""
    return code == 0 and tools == 0 and len(prompt or '') >= 200


def without_session(args):
    """The run's arguments with no --session (or -s): the next start is a new session."""
    args, out, skip = list(args), [], False
    for i, a in enumerate(args):
        if skip:
            skip = False
            continue
        if a in ('--session', '-s'):
            skip = True
            continue
        if a.startswith('--session='):
            continue
        out.append(a)
    return out


def with_model(args, model, session):
    args = list(args)
    at = args.index('--model') if '--model' in args else args.index('-m') if '-m' in args else -1
    if at >= 0:
        args[at + 1] = model
    else:
        args += ['--model', model]
    if session and '--session' not in args:
        args += ['--session', session]
    return args


def say_model(model, out=None):
    """One line on the run's own output naming the model this start runs on: the engine books the run on the model
    that actually ran (every one, after a switch), not on the bot's set model (23 Nov 2026: a run on flint was booked
    on the set model, so the pass rates went to the wrong model)."""
    if not model:
        return
    out = out or sys.stdout
    # sessionID marks the line as OpenCode's for the engine's reader; it is filled in by the events that follow.
    out.write(json.dumps({'type': 'model', 'model': model, 'sessionID': '', 'timestamp': int(time.time() * 1000)}) + '\n')
    out.flush()


def note(line):
    try:
        with open(botyard_home.state('fallback.log'), 'a') as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M')} {line}\n")
    except OSError:
        pass


def with_connectors(env, folder=None):
    """The bot's OpenCode settings with the connectors the owner gave it in Botyard added.

    Botyard writes each bot's list next to the skills file's name (`<bot>.opencode.json`, under `mcp`); the bot
    reaches a service through Botyard's gateway and never holds a key. Returns the settings file to run with:
    the bot's own when it was given nothing, when BOTYARD_CONNECTORS is off, or when anything cannot be read.
    """
    own = env.get('OPENCODE_CONFIG') or ''
    if not own or env.get('BOTYARD_CONNECTORS') == 'off':
        return own
    folder = folder or env.get('BOTYARD_BOT_CONNECTORS') or botyard_home.state('connectors')
    given = os.path.join(folder, re.sub(r'(\.with-connectors)+\.opencode\.json$', '.opencode.json', os.path.basename(own)))
    try:
        with open(given) as f:
            mcp = json.load(f).get('mcp') or {}
        if not mcp:
            return own
        with open(own) as f:
            config = json.load(f)
        # One merged file per bot, whatever it is started from: a run started with the merged file already in
        # OPENCODE_CONFIG stacked ".with-connectors" on each start (19 Nov: eight files, six suffixes deep).
        base = re.sub(r'(\.with-connectors)+\.opencode\.json$', '.opencode.json', os.path.basename(own))
        merged = os.path.join(folder, base.replace('.opencode.json', '.with-connectors.opencode.json'))
        text = json.dumps({**config, 'mcp': {**(config.get('mcp') or {}), **mcp}}, indent=1)
        try:
            with open(merged) as f:
                same = f.read() == text
        except OSError:
            same = False
        if not same:
            fd = os.open(merged, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, 'w') as f:
                f.write(text)
        return merged
    except (OSError, ValueError):
        return own


def main():
    settings = with_connectors(os.environ)
    if settings:
        os.environ['OPENCODE_CONFIG'] = settings
    # Keys pasted in Botyard reach OpenCode as the variables it reads; with none, its own free models still work.
    os.environ.update(botyard_home.key_env())
    # Free bots commit as themselves with the no-reply address only (git_identity.py), whatever the model runs in git.
    git_identity.apply()
    fallback = load('fallback', 'fallback.py')
    spec = importlib.util.spec_from_file_location('identity_check', f'{HERE}/identity-check.py')
    check = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(check)
    wrong = check.faults(sandbox_only=True)
    if wrong and sys.argv[1:2] == ['run']:
        # The sandbox gitconfig names an address that is not the studio's: no run until it is written again.
        sys.exit('\n'.join(wrong))
    bots = fallback.setup()
    if not bots.OPENCODE:
        sys.exit(botyard_home.INSTALL['opencode'])
    args = sys.argv[1:]
    if args[:1] != ['run']:
        # The engine also lists models and checks the version through this command: those go straight through.
        os.execv(bots.OPENCODE, [bots.OPENCODE, *args])
    list_again(bots)
    held = paced()
    if held:
        sys.stderr.write(f'Held by the free pace for {PACE_MOST // 60} minutes ({held}); the job is woken again later.\n')
        return 1
    prompt = sys.stdin.read() if not sys.stdin.isatty() else ''
    scratch = os.environ.get('TMPDIR') or ''
    if prompt and 'botyard-run-' in scratch:
        # 19 Nov: runs wrote /tmp/report.md, outside every folder they may use, and ended on the refusal.
        prompt += (f"\n\nScratch files go in {scratch} (also in $TMPDIR), never in /tmp itself. Folders outside your job's "
                   "folders are closed to you: a refused path is closed, so do not try it again; use this folder instead.")
    model = next((args[i + 1] for i, a in enumerate(args[:-1]) if a in ('--model', '-m')), None)
    session = None
    child = None
    atexit.register(lambda: claim(None))
    if os.environ.get('BOTYARD_CHECKER'):
        NEVER.discard(None)
        NEVER.add(build_family(bots))
        NEVER.discard(None)
    for _ in range(MOST_SWITCHES):
        chosen = pick(bots) or model
        claim(chosen)  # before asking it, so a run starting at the same moment picks another
        if not chosen:
            break
        got = probe(bots.OPENCODE, chosen)
        if got == 'ok':
            fallback.limits().answered(chosen)
            break
        if got == 'out' and fallback.outage(bots, chosen):
            break
        bots = set_aside(fallback, bots, chosen, said(chosen, got))
    if chosen and chosen != model:
        args, model = with_model(args, chosen, None), chosen
    claim(model)
    if same_family(bots, model):
        say_same_family(bots, model)

    def stop(signum, _frame):
        if child and child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
        claim(None)
        os._exit(128 + signum)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    loops = Loops()
    looped = 0
    retried = 0
    # Tool calls over the whole run (every start of it), so a short last step after a notice does not count as none.
    first_prompt, fresh_start, ran_tools = prompt, False, 0
    started, minutes, noticed = clock(), run_minutes(), False
    looked = time.time()
    for switch in range(MOST_SWITCHES + 1 + len(guards.RETRY_WAITS)):
        say_model(model)
        child = subprocess.Popen([bots.OPENCODE, *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
                                 start_new_session=True)
        child.stdin.write(prompt)
        child.stdin.close()
        lines = queue.Queue()
        threading.Thread(target=lambda: [lines.put(line) for line in child.stdout] + [lines.put(None)], daemon=True).start()
        heard, ended, ran_out, circling, failed = time.time(), False, False, None, None
        told = False
        while not ended:
            try:
                line = lines.get(timeout=10)
            except queue.Empty:
                line = ''
            if line is None:
                ended = True
                break
            # STANDARDS.md rule 16: a foreground command past 5 minutes is killed, and the model is told how to
            # run it. Looking costs one pass over /proc every LOOK_EVERY seconds.
            if time.time() - looked >= LOOK_EVERY:
                looked = time.time()
                rows = guards.processes()
                long = guards.overlong(rows, child.pid)
                if long:
                    for pid in guards.tree(rows, long[0]):
                        try:
                            os.kill(pid, signal.SIGKILL)
                        except OSError:
                            pass
                    shown = long[2][:160]
                    loops.prompt = guards.killed(shown, int(long[1]))
                    circling = (f'bash `{shown}`', f'ran {int(long[1])} seconds in the foreground')
                    os.killpg(child.pid, signal.SIGTERM)
                    stop_child(child)
                    break
            if line:
                heard = time.time()
                sys.stdout.write(line)
                sys.stdout.flush()
                try:
                    event = json.loads(line)
                    session = event.get('sessionID') or session
                    circling = loops.feed(event) or circling
                    failed = error_of(event) or failed
                    step_ended = event.get('type') == 'step_finish'
                except ValueError:
                    step_ended = False
                if not circling and session and notice_due(started, minutes, clock(), noticed, step_ended):
                    # STANDARDS.md rule 22: the model is told once at 80% of the limit. OpenCode takes its prompt
                    # once per start, so the run is stopped at a step's end and goes on in the same session with the notice.
                    told = noticed = True
                    os.killpg(child.pid, signal.SIGTERM)
                    stop_child(child)
                    break
                if circling:
                    os.killpg(child.pid, signal.SIGTERM)
                    stop_child(child)
                    break
                continue
            if time.time() - heard < QUIET:
                continue
            if answers(bots.OPENCODE, model):
                heard = time.time()
                continue
            if fallback.outage(bots, model):
                heard = time.time()
                continue
            ran_out = True
            os.killpg(child.pid, signal.SIGTERM)
            stop_child(child)
            break
        code = child.wait()
        ran_tools += loops.tools
        if told:
            used = int((clock() - started) / 60)
            note(f'The free builder was told at {used} of {minutes} minutes to write its state ({model}, same session)')
            sys.stderr.write(f'{used} of {minutes} minutes used: the model is told to write its checkpoint.\n')
            args = with_model(args, model, session)
            prompt = NOTICE.format(used=f'{used} minutes', limit=minutes)
            loops = Loops()
            continue
        if circling:
            looped += 1
            what, times = circling
            task = botyard_home.run_var('JOB_ID', '?')[:8]
            if isinstance(times, str):
                # A wait, not a circle: the same model goes on, told how to wait without spending a run.
                if looped > 1 or not session:
                    note(f'The free builder stopped waiting inside its run on {task}: {what}')
                    sys.stderr.write(f'Stopped: the model kept waiting inside its run ({what}).\n')
                    return 1
                note(f'The free builder was waiting inside its run on {task} ({what}); told how to wait, same session')
                args = with_model(args, model, session)
                prompt = loops.prompt or WAITED.format(call=what, why=times)
                loops = Loops()
                continue
            if looped > 1 or not session:
                note(f'The free builder stopped looping on {task}: {model} ran {what} {times} times with nothing changed')
                sys.stderr.write(f'Stopped: the model ran {what} {times} times with nothing changed between, twice over.\n')
                return 1
            nxt = next_working(fallback, bots, avoid_family=bots.free_family(model))[0] or model
            note(f'The free builder looped on {task} ({what} {times} times on {model}); going on with {nxt}, same session')
            sys.stderr.write(f'{model} was repeating itself; continuing the same session on {nxt}.\n')
            args, model = with_model(args, nxt, session), nxt
            claim(model)
            prompt = LOOPED.format(call=what, times=times)
            loops = Loops()
            continue
        # A 429 rests the provider for REST_FOR and the run goes on at once, same session, on another provider's model
        # that answers (18 Nov: runs waited 20, 60 and 180 seconds on a provider that kept saying "usage limit
        # reached", 57 times in 6 hours). Only when no other provider answers is it waited out below.
        low = (failed or '').lower()
        if (code and failed and any(w in low for w in BUSY_WORDS + ('usage limit',))
                and not provider_wide(failed, model) and not any(w in low for w in guards.NOT_TRANSIENT)):
            tired = rest(model)
            nxt, bots = next_working(fallback, bots, avoid_family=None)
            if nxt and provider_of(nxt) != tired:
                note(f'The free builder met a 429 on {model} ({failed[:80]}); {tired} rests {REST_FOR // 60} minutes, going on with {nxt}, same session')
                sys.stderr.write(f'{tired} is busy (429); continuing the same session on {nxt}.\n')
                args, model = with_model(args, nxt, session), nxt
                claim(model)
                if session:
                    prompt = guards.RETRY.format(why=failed[:80])
                loops = Loops()
                retried = 0
                continue
        # STANDARDS.md rule 15: a burst limit or a network error is waited out and the same call tried again, on
        # this model in this session, 20, 60 and 180 seconds later. Only a fourth failure in a row counts.
        if code and failed and guards.transient(failed) and retried < len(guards.RETRY_WAITS):
            wait = guards.retry_wait(retried)
            retried += 1
            note(f'The free builder met a temporary error on {model} ({failed[:80]}); trying again in {wait}s, same session ({retried} of {len(guards.RETRY_WAITS)})')
            sys.stderr.write(f'Temporary error ({failed[:80]}); trying the same call again in {wait} seconds.\n')
            pause(wait)
            args = with_model(args, model, session)
            if session:
                prompt = guards.RETRY.format(why=failed[:80])
            loops = Loops()
            continue
        if not code:
            retried = 0
        # A run that ended on the provider's error (403 region, 429, a daily cap) is the model failing, not
        # the work: it goes on in the same session on a model that answers, instead of failing the run.
        wide = bool(code and failed and provider_wide(failed, model))
        if code and failed and (wide or any(w in failed.lower() for w in GONE + BUSY_WORDS) or context_error(failed)):
            ran_out = True
        if no_tools(code, ran_tools, first_prompt):
            task = botyard_home.run_var('JOB_ID', '?')[:8]
            fallback.set_free_aside(bots, model, 'made no tool calls on a real task', until=int(time.time() + NO_TOOLS_FOR))
            nxt, bots = next_working(fallback, bots, avoid_family=bots.free_family(model))
            if fresh_start or not nxt:
                note(f'The free builder made no tool calls on {task} ({model}); {"no other model answers" if not nxt else "twice over"}, the run fails')
                sys.stderr.write(f'{model} ended without one tool call: none of the work was done.\n')
                return 1
            note(f'The free builder made no tool calls on {task} ({model}); set aside a day, starting again on {nxt} in a new session')
            sys.stderr.write(f'{model} ended without one tool call; starting the task again on {nxt} in a new session.\n')
            args, model, session = with_model(without_session(args), nxt, None), nxt, None
            claim(model)
            prompt, fresh_start, ran_tools = first_prompt, True, 0
            loops = Loops()
            continue
        if not ran_out and (code == 0 or answers(bots.OPENCODE, model)):
            return code
        bots = set_aside(fallback, bots, model, failed)
        nxt, bots = next_working(fallback, bots, avoid_family=bots.free_family(model))
        if not nxt:
            note(f'The free builder ran out of free models mid-run on {botyard_home.run_var('JOB_ID', "?")[:8]}')
            if wide:
                # STANDARDS.md rule 22 (like rule 3): a provider's day is used up and no other provider answers. The
                # run rests, it does not fail; fallback.py wakes the job again once a model answers.
                sys.stderr.write(f'{model.split("/")[0]} has used up its free day and no other provider answers: resting, not failing.\n')
                return 0
            sys.stderr.write('Every free model is out now; this run stops and is woken again when one answers.\n')
            return 1
        note(f'The free builder switched mid-run from {model} to {nxt}, same session')
        sys.stderr.write(f'{model} ran out; continuing the same session on {nxt}.\n')
        args, model = with_model(args, nxt, session), nxt
        claim(model)
        if same_family(bots, model):
            say_same_family(bots, model)
        if session:
            prompt = CONTINUE
    return 1


if __name__ == '__main__':
    sys.exit(main())
