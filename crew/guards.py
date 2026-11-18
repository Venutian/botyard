#!/usr/bin/env python3
"""Three shapes of wasted run, caught the same way for every bot. No AI.

STANDARDS.md rules 14 to 16. loop-guard.py (every Claude bot, before the call runs) and free-runner.py
(every OpenCode bot) both use these, and agy-bin's stand-ins use `unreadable` before the command runs.

14. Payload: the engine refuses a request past 26,214,400 bytes, and a run that read a binary, an image, a zip or a huge
    log into its session can never send another request ("Please make sure your payload is below 26214400
    bytes"). A binary file, or a text file over READ_MAX, is never read whole: it is checked by name and
    size, or by a script. No tool output goes past OUTPUT_MAX.
15. Transient errors: a 429, a TLS handshake that failed, a reset connection are retried by the runner on
    the same model, in the same session, after 20, 60 and 180 seconds. Only after those does the run count as failed.
    A daily limit is not transient: that model is set aside and the run hands over.
16. Long foreground commands: a command expected to run over LONG_START seconds is started detached through
    the studio's heavy-job launcher (BOTYARD_HEAVY, if it has one), with botyard-wait, and the run ends. A foreground command past FOREGROUND_MAX seconds is killed.
"""
import os
import re
import shlex

READ_MAX = 1_000_000
OUTPUT_MAX = 200_000
LONG_START = 120
FOREGROUND_MAX = 300
RETRY_WAITS = (20, 60, 180)

# A provider message that is the network or the provider's burst limit, gone in a minute or two.
TRANSIENT = ('too many requests', '429', 'tls handshake', 'eproto', 'econnreset', 'etimedout', 'econnrefused',
             'socket hang up', 'network error', 'fetch failed', 'overloaded', 'temporarily unavailable', 'rate limit')
# ...unless it is a daily cap or a model that is gone: those never clear by waiting.
NOT_TRANSIENT = ('per-day', 'per day', 'daily limit', 'not available in your region', 'model is unavailable',
                 'model not found', 'unknown model', 'no endpoints found', 'not a valid model', 'model does not exist')

BINARY_EXT = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tif', '.tiff', '.psd', '.zip', '.gz', '.tgz',
              '.bz2', '.xz', '.7z', '.rar', '.tar', '.pdf', '.mp3', '.wav', '.ogg', '.flac', '.mp4', '.mov', '.webm',
              '.mkv', '.glb', '.gltf', '.bin', '.fbx', '.blend', '.exe', '.dll', '.so', '.dylib', '.a', '.o', '.wasm',
              '.ttf', '.otf', '.woff', '.woff2', '.apk', '.aab', '.ipa', '.jar', '.class', '.pyc', '.sqlite', '.db',
              '.npy', '.npz', '.onnx', '.safetensors', '.ckpt', '.pt', '.pth', '.iso', '.dmg'}
# Commands that put a whole file into the session. head and tail with a count are bounded, so they pass.
WHOLE_FILE = {'cat', 'less', 'more', 'base64', 'xxd', 'od', 'hexdump', 'strings', 'bat', 'tac', 'nl'}

READ_TOLD = ('Refused: {path} is {why}. Reading it whole would put it into your session, and a request past 26 MB '
             'can never be sent again. Check it by name and size (ls -l, file, du -sh), or run a script that '
             'prints only what you need. Never open binaries.')
SLOW_TOLD = ('Refused: {why}. A command expected to run over 2 minutes is not run inside your run. Start it'
             '{via} in the background with its output in a file, register botyard-wait on its done file, write its state in one '
             'comment and end your run; a script wakes this same session when it is done. A foreground command past '
             '5 minutes is killed.')
KILLED = ('A command you ran in the foreground, `{call}`, was still running after {seconds} seconds, so it was '
          'killed. Do not run anything that long inside your run. Start it{via} in the background '
          '(setsid nohup {heavy}bash -c \'CMD > tmp/job.log 2>&1; touch tmp/job.done\' > /dev/null 2>&1 &), run '
          'botyard-wait tmp/job.done, write what runs and what to do when it is done in one comment, and end your run.')
RETRY = ('The call before this one failed with a temporary error from the provider ({why}). It was not your fault and '
         'nothing was lost. Carry on from exactly where you stopped: repeat the call that failed.')


# The Read tool is how a model looks at a screenshot, which a check needs: a picture under READ_MAX is allowed
# through it (and never through cat). Anything bigger, and every other binary, is not.
PICTURES = {'.png', '.jpg', '.jpeg', '.gif', '.webp'}


def launcher():
    """The studio's heavy-job launcher (BOTYARD_HEAVY), or '' when it has none."""
    return os.environ.get('BOTYARD_HEAVY', '').strip()


def how():
    name = launcher()
    return {'heavy': name + ' ' if name else '', 'via': f' through {name}' if name else ' detached'}


def killed(call, seconds):
    return KILLED.format(call=call, seconds=seconds, **how())


def why_unreadable(path, whole=True, picture_ok=False):
    """Why this file must not be read whole, or None. whole=False means a bounded read (an offset and a limit),
    which is fine for any text file but never for a binary. picture_ok lets a small picture through."""
    path = str(path or '')
    if not path or not os.path.isfile(path):
        return None
    ext = os.path.splitext(path)[1].lower()
    size = os.path.getsize(path)
    if picture_ok and ext in PICTURES and size <= READ_MAX:
        return None
    if ext in BINARY_EXT:
        return f'a binary file ({ext}, {size:,} bytes)'
    try:
        with open(path, 'rb') as f:
            if b'\0' in f.read(8192):
                return f'a binary file ({size:,} bytes)'
    except OSError:
        return None
    if whole and size > READ_MAX:
        return f'{size:,} bytes, over the {READ_MAX:,} a read may take'
    return None


# The engine's owner key answers the owner's cards (studio/server/engine/caller.mjs). Only Botyard's own
# server reads it; no run ever does, by any tool.
OWNER_KEY_FILE = 'engine-owner.key'
OWNER_KEY_TOLD = ('Refused: {file} is the owner\'s key to the engine, and a run never reads, copies or sends it. Call the engine '
                  'with your run\'s pass, as your rules say; what only the owner decides goes to the owner on a card.')


def touches_owner_key(given):
    """True when a tool call's arguments name the owner's key file, in any field."""
    try:
        import json
        text = json.dumps(given, ensure_ascii=False) if not isinstance(given, str) else given
    except (TypeError, ValueError):
        text = str(given)
    return OWNER_KEY_FILE in text or 'engine-owner' in text


def unreadable(tool, given, cwd=None):
    """The refusal text for a tool call that would read a binary or a huge file whole, or None.
    Covers the Read tools of Claude Code and OpenCode and the shell commands that cat a file into the session.
    A call that names the owner's key to the engine is refused, whatever the tool."""
    if given is not None and touches_owner_key(given):
        return OWNER_KEY_TOLD.format(file=OWNER_KEY_FILE)
    if not isinstance(given, dict):
        return None
    name = (tool or '').lower()
    if name == 'read':
        path = given.get('file_path') or given.get('filePath') or given.get('path')
        bounded = bool(given.get('offset') or given.get('limit'))
        why = why_unreadable(_abs(path, cwd), whole=not bounded, picture_ok=True)
        return READ_TOLD.format(path=path, why=why) if why else None
    if name in ('bash', 'shell'):
        return unreadable_command(given.get('command'), cwd)
    return None


def _abs(path, cwd):
    path = os.path.expanduser(str(path or ''))
    return path if os.path.isabs(path) or not cwd else os.path.join(cwd, path)


def unreadable_command(command, cwd=None):
    """The refusal text when a shell command cats a binary or a huge file whole, or None."""
    for part in re.split(r'[;&|\n]+', str(command or '')):
        try:
            words = shlex.split(part)
        except ValueError:
            continue
        while words and ('=' in words[0] and not words[0].startswith('-')):
            words = words[1:]
        if not words or os.path.basename(words[0]) not in WHOLE_FILE:
            continue
        for word in words[1:]:
            if word.startswith('-'):
                continue
            why = why_unreadable(_abs(word, cwd))
            if why:
                return READ_TOLD.format(path=word, why=why)
    return None


def cap(text, limit=OUTPUT_MAX):
    """A tool output cut to the limit, saying so; shorter text comes back as it is."""
    text = str(text or '')
    if len(text) <= limit:
        return text
    return text[:limit] + f'\n[cut: {len(text) - limit:,} more characters. Print only what you need.]'


def transient(message):
    """True when a provider's error is one to retry in place: a burst limit or a network error, not a daily cap."""
    text = (message or '').lower()
    if not text or any(w in text for w in NOT_TRANSIENT):
        return False
    return any(w in text for w in TRANSIENT)


def retry_wait(tries):
    """Seconds to wait before retry number tries (0 based), or None when the retries are used up."""
    return RETRY_WAITS[tries] if tries < len(RETRY_WAITS) else None


def too_slow(given):
    """The refusal text for a Bash call that plainly runs over the foreground limit, or None: a timeout over 5
    minutes asked for in the foreground, a `timeout N` wrapper past it, or the heavy-job launcher run in the foreground."""
    if not isinstance(given, dict):
        return None
    command = str(given.get('command') or '')
    if given.get('run_in_background'):
        return None
    if re.search(r'\b(setsid|nohup)\b.*&\s*$', command.strip(), re.S):
        return None
    asked = given.get('timeout')
    if isinstance(asked, (int, float)) and asked / 1000 > FOREGROUND_MAX:
        return SLOW_TOLD.format(**how(), why=f'you asked to wait {round(asked / 60000)} minutes for it in the foreground')
    for n, unit in re.findall(r'(?:^|[;&|(\'"]\s*)timeout\s+(?:-\S+\s+)*(\d+(?:\.\d+)?)([smh]?)\b', command):
        if float(n) * {'': 1, 's': 1, 'm': 60, 'h': 3600}[unit] > FOREGROUND_MAX:
            return SLOW_TOLD.format(**how(), why=f'`timeout {n}{unit}` is more than {FOREGROUND_MAX // 60} minutes in the foreground')
    if launcher() and re.search(r'(^|[;&|]\s*)' + re.escape(launcher()) + r'\b', command):
        return SLOW_TOLD.format(why=f'{launcher()} is for jobs run detached in the background', **how())
    return None


SHELLS = {'bash', 'sh', 'zsh', 'dash'}


def overlong(procs, root, seconds=FOREGROUND_MAX):
    """The foreground shell command under pid root that has run longer than seconds, from a list of
    (pid, ppid, age in seconds, command line) rows; None when none has. Only a shell started with -c counts:
    the engine's own helper servers live as long as the run and are never a command of the model's."""
    kids = {}
    for pid, ppid, age, cmd in procs:
        kids.setdefault(ppid, []).append((pid, age, cmd))
    seen, todo, found = set(), [root], None
    while todo:
        for pid, age, cmd in kids.get(todo.pop(), []):
            if pid in seen:
                continue
            seen.add(pid)
            todo.append(pid)
            words = cmd.split()
            if age > seconds and words and os.path.basename(words[0]) in SHELLS and '-c' in words[1:3]:
                if found is None or age > found[1]:
                    found = (pid, age, cmd)
    return found


def tree(procs, root):
    """Every pid at or below root."""
    kids = {}
    for pid, ppid, _, _ in procs:
        kids.setdefault(ppid, []).append(pid)
    out, todo = [], [root]
    while todo:
        pid = todo.pop()
        out.append(pid)
        todo += kids.get(pid, [])
    return out


def processes():
    """(pid, ppid, age in seconds, command line) for every process, from /proc."""
    rows = []
    try:
        hertz = os.sysconf('SC_CLK_TCK')
        with open('/proc/uptime') as f:
            up = float(f.read().split()[0])
        for name in os.listdir('/proc'):
            if not name.isdigit():
                continue
            try:
                with open(f'/proc/{name}/stat') as f:
                    stat = f.read()
                with open(f'/proc/{name}/cmdline', 'rb') as f:
                    cmd = f.read().replace(b'\0', b' ').decode('utf-8', 'replace').strip()
            except OSError:
                continue
            fields = stat[stat.rindex(')') + 2:].split()
            rows.append((int(name), int(fields[1]), up - int(fields[19]) / hertz, cmd))
    except (OSError, ValueError, IndexError):
        pass
    return rows
