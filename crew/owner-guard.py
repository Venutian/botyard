#!/usr/bin/env python3
"""Refuses what only the owner may approve: sending mail or messages, and publishing anything online.
No AI. Every Claude bot has it as a PreToolUse hook (claude-bot.sh, bot-settings.json), and the free and
Gemini bots meet the same list through the stand-ins in agy-bin.

Bots never send mail or publish online without the owner's approval, which comes as a card. So store
submissions, app updates sent to users, package and release uploads, mail, and messaging or posting
tools are refused here. It also keeps bots out of the folders that hold keys.
"""
import json
import os
import re
import shlex
import sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import botyard_home  # noqa: E402

# Commands that send or publish, matched anywhere in a shell command (npx, a path, after && all count).
SENDS = re.compile(r'''(?x)
    \b(sendmail|mailx|msmtp|mutt|swaks|ssmtp)\b
  | (^|[;&|]\s*|\s)mail\s+-
  | \beas(-cli)?\s+(submit|update)\b
  | \bfastlane\s+\S*\s*(deliver|supply|pilot|upload_to|release)
  | \bnpm\s+publish\b | \bpnpm\s+publish\b | \byarn\s+(npm\s+)?publish\b
  | \bgh\s+release\s+(create|upload|edit)\b
  | \btwine\s+upload\b | \bcargo\s+publish\b | \bbutler\s+push\b
  | \bsteamcmd\b.*\+run_app_build
  | smtps?://
  | api\.(sendgrid|mailgun|postmarkapp|resend)\.
  | api\.telegram\.org/bot | hooks\.slack\.com | discord(app)?\.com/api/webhooks
''')
# Connector tools that send or post for the owner (mail, chat, social), whatever their server is called.
SEND_TOOLS = re.compile(r'^mcp__.*(send|reply|forward|draft|post|publish|tweet|share)', re.I)
# The keys of the services the owner connected in Botyard. Botyard's gateway adds a key to a bot's call; no
# bot reads, copies or uses the folder itself.
KEYS_TOLD = ('Refused: the folder with the keys is read by Botyard only. Use the service through its '
             'tools (mcp__<service>__...); if a tool you need is missing or refused, ask the owner on a card.')
CLOSED_TOLD = 'Refused: that folder is closed to bots. Ask the owner on a card if the job needs something from it.'
# The PC load setting names the program the owner's PC load button runs, so no bot may point it elsewhere.
PC_LOAD_TOLD = ('Refused: the PC load setting is the owner\'s. The level is set with the owner\'s button on the page '
                'or phone; a run never changes it or the tool it names.')


def closed_folders():
    """Folders no bot may touch, each with what a bot is told: Botyard's keys folder, and the ones a studio
    names itself in its crew/own/guard.json, {"closed": [{"folder": "name-or-path", "told": "why"}]}."""
    places = botyard_home.places()
    keys = places['keys']
    out = [(mark, KEYS_TOLD) for mark in {keys, botyard_home.short(keys), os.path.join(os.path.basename(places['home']), 'keys')}]
    load = os.path.join(places['config'], 'pc-load.json')
    out += [(mark, PC_LOAD_TOLD) for mark in {load, botyard_home.short(load), os.path.join(os.path.basename(places['home']), 'config', 'pc-load.json')}]
    try:
        with open(os.path.join(places['crew'], 'own', 'guard.json'), encoding='utf8') as f:
            for row in json.load(f).get('closed') or []:
                if row.get('folder'):
                    out.append((str(row['folder']), row.get('told') or CLOSED_TOLD))
    except (OSError, ValueError, AttributeError):
        pass
    return out


COMMAND_TOLD = 'Refused: that command is the owner\'s alone. Ask the owner on a card if the job needs it.'


def closed_commands():
    """Shell commands no bot runs, each with what it is told: the ones a studio names in its crew/own/guard.json,
    {"commands": [{"pattern": "a regular expression", "told": "why"}]} (a PC setting only the owner changes, say)."""
    out = []
    try:
        with open(os.path.join(botyard_home.places()['crew'], 'own', 'guard.json'), encoding='utf8') as f:
            for row in json.load(f).get('commands') or []:
                try:
                    out.append((re.compile(str(row['pattern'])), row.get('told') or COMMAND_TOLD))
                except (KeyError, re.error):
                    continue
    except (OSError, ValueError, AttributeError):
        pass
    return out


TOLD = ('Refused: the folder with the connectors\' keys is read by Botyard only. Use the service through its '
                    'tools (mcp__<service>__...); if a tool you need is missing or refused, ask the owner on a card.')
KEY_TOLD = ('Refused: the support inbox\'s key folder is read by support-mail.py only. To answer support mail '
            'run support-mail.py (fetch, list, show, reply); to change its settings, ask the owner.')
TOLD = ('Refused: {what} needs the owner\'s approval first (sending mail or messages, or publishing '
        'online). Put it to the owner on a choice card saying exactly what would go out and where, and '
        'carry on with the rest.')


WORKTREE_TOLD = ('Refused: a worktree goes under its repo, in <repo>/.botyard/worktrees/, never beside the projects. '
                 'Run repo-worktree.py REPO NAME (in the crew folder; it prints the path and makes the worktree there).')


def worktree_at_root(command, cwd=None, root=None, depth=0):
    """True when a `git worktree add` in this shell command makes its folder directly in the projects folder.
    Follows `cd` between the parts of the command and looks inside `bash -c "..."`."""
    root = os.path.realpath(root or botyard_home.projects())
    here = cwd or os.getcwd()
    for part in re.split(r'&&|\|\||;|\n|\|', command):
        try:
            words = shlex.split(part)
        except ValueError:
            words = part.split()
        if words[:1] == ['cd'] and len(words) > 1:
            here = os.path.join(here, os.path.expanduser(os.path.expandvars(words[1])))
            continue
        if depth < 3 and len(words) > 2 and os.path.basename(words[0]) in ('bash', 'sh', 'zsh') and '-c' in words[1:3]:
            if worktree_at_root(words[words.index('-c') + 1], here, root, depth + 1):
                return True
        if 'git' not in words or 'worktree' not in words:
            continue
        rest = words[words.index('worktree') + 1:]
        if rest[:1] != ['add']:
            continue
        where = here
        before = words[:words.index('worktree')]
        if '-C' in before and before.index('-C') + 1 < len(before):
            where = os.path.join(where, os.path.expanduser(before[before.index('-C') + 1]))
        paths, skip = [], False
        for w in rest[1:]:
            if skip:
                skip = False
            elif w in ('-b', '-B', '--reason'):
                skip = True
            elif not w.startswith('-'):
                paths.append(w)
        if paths:
            folder = os.path.realpath(os.path.join(where, os.path.expanduser(os.path.expandvars(paths[0]))))
            if os.path.dirname(folder) == root:
                return True
    return False


MAIN_TOLD = ('Refused: that file is in a repository\'s main checkout, which the service runs from. Work in your job\'s '
             'worktree (it is your working folder); the change reaches main through the landing, with its tests.')
# Shell writes the hook can see: a redirect, tee, sed -i.
WRITES = re.compile(r"""(?:>>?|\btee\s+(?:-a\s+)?)\s*(["']?)([^\s|;&<>"']+)\1""")


def main_checkout_of(path, root=None):
    """The main checkout a file is in (a repository directly in the projects folder whose .git is a folder), or ''.
    A job worktree (its .git is a file) and anything outside the projects folder are free."""
    root = os.path.realpath(root or botyard_home.projects())
    here = os.path.realpath(path)
    while True:
        dot = os.path.join(here, '.git')
        if os.path.exists(dot):
            return here if os.path.isdir(dot) and os.path.dirname(here) == root else ''
        up = os.path.dirname(here)
        if up == here:
            return ''
        here = up


def written_paths(command, cwd=None):
    """The files a shell command visibly writes (redirects, tee, sed -i), as absolute paths."""
    here = cwd or os.getcwd()
    out = []
    for part in re.split(r'&&|\|\||;|\n', command):
        words = part.split()
        if words[:1] == ['cd'] and len(words) > 1:
            here = os.path.join(here, os.path.expanduser(os.path.expandvars(words[1])))
            continue
        targets = []
        for piece in part.split('|'):
            try:
                w = shlex.split(piece)
            except ValueError:
                w = piece.split()
            if w[:1] == ['sed'] and any(x.startswith('-i') or x.startswith('--in-place') or (x.startswith('-') and not x.startswith('--') and 'i' in x[1:]) for x in w[1:]):
                targets.append(w[-1])
        for m in WRITES.finditer(part):
            targets.append(m.group(2))
        for target in targets:
            if target.startswith('&') or target in ('/dev/null', '/dev/stderr', '/dev/stdout') or target.isdigit():
                continue
            out.append(os.path.normpath(os.path.join(here, os.path.expanduser(os.path.expandvars(target)))))
    return out


def check(event):
    """The refusal text for this tool call, or None."""
    tool = event.get('tool_name') or ''
    given = event.get('tool_input') or {}
    # Where a tool points, not what it writes: the script's own source names the folder and may be edited.
    aimed = [given.get('command')] if tool == 'Bash' else [given.get(k) for k in ('file_path', 'path', 'pattern', 'notebook_path')]
    for folder, told in closed_folders():
        if any(folder in str(a) for a in aimed if a):
            return told
    if SEND_TOOLS.search(tool):
        return TOLD.format(what=tool)
    # A bot never edits a main checkout in place (20 Nov 2026): job worktrees only.
    if tool in ('Edit', 'Write', 'MultiEdit', 'NotebookEdit'):
        target = given.get('file_path') or given.get('notebook_path')
        if target and main_checkout_of(os.path.join(event.get('cwd') or os.getcwd(), os.path.expanduser(str(target)))):
            return MAIN_TOLD
    if tool == 'Bash':
        command = str((event.get('tool_input') or {}).get('command', ''))
        if 'worktree' in command and worktree_at_root(command, event.get('cwd')):
            return WORKTREE_TOLD
        if any(main_checkout_of(p) for p in written_paths(command, event.get('cwd'))):
            return MAIN_TOLD
        m = SENDS.search(command)
        if m:
            return TOLD.format(what=f'"{m.group(0).strip()}"')
        for pattern, told in closed_commands():
            if pattern.search(command):
                return told
    return None


def main():
    try:
        event = json.load(sys.stdin)
    except ValueError:
        return 0
    told = check(event)
    if told:
        sys.stderr.write(told + '\n')
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
