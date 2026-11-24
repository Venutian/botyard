#!/usr/bin/python3 -I
"""Runs Antigravity CLI's ACP server for the engine's Gemini adapter, on the bot's model, within the bots' rules. No AI.

The engine's Gemini adapter can talk to an agent over ACP, which sends the prompt through a pipe,
so a long job thread fits; on the command line, Linux refuses any argument over 128 KB. This sits
between the two and relays every message unchanged, except for two things:

- The engine offers its tool servers to every session. One is named "The engine projects", and the
  space in its tool names makes Claude models refuse the whole turn. The bots manage tasks through
  the engine's API instead, so the servers are left out.
- The engine names the model in GEMINI_MODEL, which agy does not read. Whenever a session opens,
  this sets its model before the engine sees the answer. AGY_MODELS lists the others to fall back on,
  in order: one that is gone, or out of its allowance, is skipped, so every Antigravity model is
  used up before fallback.py moves the bot to Claude. Used-up models are noted, with when they
  reset, in agy-used-up.json, so the next run does not try them again.
- Over ACP, agy leaves every tool permission to the client and ignores its own deny rules, and
  the engine approves everything. So this answers the permission requests itself: it refuses what
  the owner does by hand and file writes outside the bot's folder, as Codex's rules and sandbox do,
  and allows the rest. agy ends its turn when a tool is refused, so this then tells the bot what
  was refused and lets it carry on, and the engine sees one turn.
- When a model is out of its allowance, agy says so as if it were the bot's reply and ends the turn
  normally. This moves the session to the next model and asks again. When none is left, the engine
  gets a failed run with the reason, so fallback.py can act on it.
"""
import json
import os
import re
import shlex
import signal
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import botyard_home  # noqa: E402

AGY = botyard_home.tool('agy') or os.path.expanduser('~/.local/bin/agy')
USED_UP = botyard_home.state('agy-used-up.json')
# When agy does not say when a model resets, try it again after this long.
RETRY_AFTER = 3600
OPENS = {'session/new', 'session/load', 'session/resume'}
# Commands are judged one piece at a time, split on shell operators, subshells and substitutions.
PIECES = re.compile(r'&&|\|\||\$\(|[;&|\n()`]')
WRAPPERS = {'env', 'command', 'exec', 'nohup', 'setsid', 'time', 'nice', 'ionice', 'timeout', 'stdbuf', 'xargs'}
SHELLS = {'bash', 'sh', 'zsh', 'dash'}
NEVER = {'sudo', 'su', 'doas', 'gh'}
NEVER_GIT = {'push', 'merge', 'rebase', 'commit', 'clean'}
GIT_TAKES_VALUE = {'-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--super-prefix'}
# File tools that change something. Their names when asking differ from their listed names (write_file, write_to_file).
WRITES = re.compile(r'write|replace|edit|sed|delete|remove|move|rename|create|notebook', re.I)
# The bots have no messages, schedules, connected accounts or tool servers, as on Codex.
REFUSED_TOOLS = {'send_message', 'manage_inbox', 'schedule', 'list_plugin_accounts', 'call_mcp_tool',
                 'search_marketplace', 'run_workflow'}

child = None
lock = threading.Lock()
opening, folders, waiting = {}, {}, {}
# Per session: the engine's prompt in progress and what it asked, the refusals in it, the follow-ups
# sent for it, and the model it runs on.
prompts, asked, refusals, follow_ups, current = {}, {}, {}, {}, {}
serial = iter(range(1, 1 << 62))
MOST_FOLLOW_UPS = 3
OUT_OF_ALLOWANCE = re.compile(r'quota reached|RESOURCE_EXHAUSTED|rate limit|upgrade your subscription', re.I)
out_of_allowance = {}
CARRY_ON = ('Not allowed: {}. The owner does these by hand, so do not try again or any other way around '
            'it. Carry on with the rest of your task without it, and finish it as your instructions say.')


def words(piece):
    try:
        return shlex.split(piece)
    except ValueError:
        return piece.split()


def forbidden(command, depth=0):
    """What in this shell command needs the owner, or None."""
    for piece in PIECES.split(command):
        w = words(piece)
        while w and (re.match(r'^[A-Za-z_]\w*=', w[0]) or os.path.basename(w[0]) in WRAPPERS):
            w.pop(0)
            while w and (w[0].startswith('-') or re.fullmatch(r'[\d.]+[smhd]?', w[0])):
                w.pop(0)
        if not w:
            continue
        name, rest = os.path.basename(w[0]), w[1:]
        if name in SHELLS and '-c' in rest and rest.index('-c') + 1 < len(rest) and depth < 3:
            found = forbidden(rest[rest.index('-c') + 1], depth + 1)
            if found:
                return found
        if name in NEVER:
            return name
        if name == 'rm':
            flags = ''.join(a for a in rest if a.startswith('-') and not a.startswith('--'))
            if ('r' in flags.lower() or '--recursive' in rest) and ('f' in flags or '--force' in rest):
                return 'rm -rf'
        if (name, rest[:1]) in (('npm', ['publish']), ('eas', ['submit'])):
            return f'{name} {rest[0]}'
        if name == 'git':
            i = 0
            while i < len(rest) and rest[i].startswith('-'):
                i += 2 if rest[i] in GIT_TAKES_VALUE else 1
            sub, after = (rest[i], rest[i + 1:]) if i < len(rest) else ('', [])
            if sub in NEVER_GIT or (sub == 'reset' and '--hard' in after) or (sub == 'worktree' and after[:1] == ['remove']):
                return f'git {sub}'
    return None


def paths(value):
    if isinstance(value, dict):
        for key, item in value.items():
            if isinstance(item, str) and ('file' in key.lower() or 'path' in key.lower()):
                yield item
            else:
                yield from paths(item)
    elif isinstance(value, list):
        for item in value:
            yield from paths(item)


def closed_folders():
    """The folders no bot may touch (owner-guard.py's list). A run here is never on Claude, so no folder's readers count."""
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location('owner_guard', os.path.join(os.path.dirname(os.path.realpath(__file__)), 'owner-guard.py'))
        guard = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(guard)
        return [row[0] for row in guard.closed_folders()]
    except Exception:
        return []


def verdict(session, call):
    """Why this tool call is refused, or None to allow it."""
    name, args = call.get('name') or '', call.get('args') or call.get('rawInput') or {}
    if name in REFUSED_TOOLS:
        return f'{name} is not for the bots'
    said = json.dumps(args, ensure_ascii=False)
    for folder in closed_folders():
        if folder in said:
            return f'{folder} is closed to the bots'
    if name in ('run_command', 'send_command_input'):
        text = ' '.join(str(v) for k, v in args.items() if k.lower() in ('commandline', 'command', 'input'))
        found = forbidden(text)
        return f'{found} needs the owner\'s approval' if found else None
    if WRITES.search(name) and name not in ('run_command', 'send_command_input'):
        roots = [os.path.realpath(folders.get(session) or os.getcwd()), '/tmp']
        for path in paths(args):
            real = os.path.realpath(os.path.join(folders.get(session) or os.getcwd(), os.path.expanduser(path)))
            if not any(real == root or real.startswith(root + os.sep) for root in roots):
                return f'writing {path} is outside your folder'
    return None


def answer_permission(message):
    params = message.get('params') or {}
    options = params.get('options') or []
    refused = verdict(params.get('sessionId'), params.get('toolCall') or {})
    kind = 'reject' if refused else 'allow'
    choice = next((o['optionId'] for o in options if o.get('kind') == f'{kind}_once'), None) or \
        next((o['optionId'] for o in options if str(o.get('kind', '')).startswith(kind)), None)
    if refused:
        sys.stderr.write(f'[agy-acp] refused: {refused}\n')
        refusals.setdefault(params.get('sessionId'), []).append(refused)
    outcome = {'outcome': 'selected', 'optionId': choice} if choice else {'outcome': 'cancelled'}
    to_agy({'jsonrpc': '2.0', 'id': message['id'], 'result': {'outcome': outcome}})


def to_agy(message):
    with lock:
        child.stdin.write(json.dumps(message) + '\n')
        child.stdin.flush()


def to_engine(message):
    sys.stdout.write((message if isinstance(message, str) else json.dumps(message)).rstrip('\n') + '\n')
    sys.stdout.flush()


def ask_agy(method, params, then):
    """A request of this relay's own; its answer goes to then() instead of the engine."""
    key = f'agy-acp-{next(serial)}'
    waiting[key] = then
    to_agy({'jsonrpc': '2.0', 'id': key, 'method': method, 'params': params})


def used_up():
    try:
        noted = json.load(open(USED_UP))
    except (OSError, ValueError):
        return {}
    return {model: until for model, until in noted.items() if until > time.time()}


def note_used_up(model, reason):
    found = re.search(r'(\d+)h(?:(\d+)m)?', reason)
    wait = int(found.group(1)) * 3600 + int(found.group(2) or 0) * 60 if found else RETRY_AFTER
    noted = used_up()
    noted[model] = time.time() + wait
    with open(USED_UP, 'w') as f:
        json.dump(noted, f)


def chain():
    """The bot's model, then the others it may fall back on, minus those used up."""
    models = [os.environ.get('GEMINI_MODEL')] + os.environ.get('AGY_MODELS', '').split(',')
    gone = used_up()
    return [m for i, m in enumerate(models) if m and m not in models[:i] and m not in gone]


def shown_model(answer, model):
    """The session's answer, naming the model it now runs on."""
    models = (answer.get('result') or {}).get('models')
    if isinstance(models, dict):
        models['currentModelId'] = model
    return answer


def put_on_model(session, models, done):
    """Moves the session to the first of these models agy takes, then calls done(model or None)."""
    if not models:
        done(None)
        return

    def answered(reply):
        if 'error' in reply:
            sys.stderr.write(f'[agy-acp] {models[0]} is not offered, trying the next\n')
            put_on_model(session, models[1:], done)
        else:
            current[session] = models[0]
            done(models[0])
    ask_agy('session/set_model', {'sessionId': session, 'modelId': models[0]}, answered)


def from_engine():
    for line in sys.stdin:
        try:
            message = json.loads(line)
        except ValueError:
            continue
        params = message.get('params') or {}
        if message.get('method') in OPENS and 'id' in message:
            opening[message['id']] = (params.get('sessionId'), params.get('cwd'))
            params['mcpServers'] = []
        if message.get('method') == 'session/prompt' and 'id' in message:
            session = params.get('sessionId')
            prompts[session], asked[session] = message['id'], json.loads(json.dumps(params))
            refusals.pop(session, None)
            follow_ups[session] = 0
        to_agy(message)
    child.stdin.close()


def turn_over(session, reply):
    """agy finished a turn of the engine's prompt. Try the next model, let the bot carry on after a
    refusal, or give the engine the answer."""
    if session in out_of_allowance and 'result' in reply:
        reason = out_of_allowance.pop(session)
        if current.get(session):
            note_used_up(current[session], reason)
        sys.stderr.write(f'[agy-acp] {current.get(session)} is used up: {reason[:120]}\n')

        def moved(model):
            if model:
                ask_agy('session/prompt', asked[session], lambda again: turn_over(session, again))
            else:
                to_engine({'jsonrpc': '2.0', 'id': prompts[session],
                              'error': {'code': -32000, 'message': f'Antigravity quota reached on every model: {reason}'}})
        put_on_model(session, [m for m in chain() if m != current.get(session)], moved)
        return
    if 'result' in reply and refusals.get(session) and follow_ups.get(session, 0) < MOST_FOLLOW_UPS:
        follow_ups[session] = follow_ups.get(session, 0) + 1
        note = CARRY_ON.format('; '.join(refusals.pop(session)))
        ask_agy('session/prompt', {'sessionId': session, 'prompt': [{'type': 'text', 'text': note}]},
                lambda again: turn_over(session, again))
        return
    to_engine({**reply, 'id': prompts[session]})


def from_agy():
    for line in child.stdout:
        try:
            message = json.loads(line)
        except ValueError:
            sys.stderr.write(line)
            continue
        key = message.get('id')
        if message.get('method') == 'session/request_permission':
            answer_permission(message)
            continue
        if message.get('method') == 'session/update':
            params = message.get('params') or {}
            update = params.get('update') or {}
            text = (update.get('content') or {}).get('text') or '' if update.get('sessionUpdate') == 'agent_message_chunk' else ''
            if text.lstrip().startswith('\u26a0') and OUT_OF_ALLOWANCE.search(text):
                out_of_allowance[params.get('sessionId')] = text.strip().lstrip('\u26a0').strip()[:300]
                continue
        if key in waiting and 'method' not in message:
            waiting.pop(key)(message)
            continue
        session = next((s for s, prompt in prompts.items() if prompt == key), None) if 'method' not in message else None
        if session is not None:
            turn_over(session, message)
            continue
        if key in opening and 'result' in message:
            session, cwd = opening.pop(key)
            session = session or (message['result'] or {}).get('sessionId')
            if session and cwd:
                folders[session] = cwd
            if session and chain():
                put_on_model(session, chain(), lambda model, answer=message: to_engine(shown_model(answer, model) if model else answer))
                continue
        to_engine(line)


if __name__ == '__main__':
    child = subprocess.Popen([AGY, 'acp', '--disable-telemetry'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
    for name in ('SIGTERM', 'SIGINT', 'SIGHUP'):
        signal.signal(getattr(signal, name), lambda sig, _frame: child.send_signal(sig))
    threading.Thread(target=from_engine, daemon=True).start()
    from_agy()
    sys.exit(child.wait())
