#!/usr/bin/env python3
"""The owner's notes (Senth), read-only, for the bots: search them, read one. No AI.

    python3 brain.py search <words>     the notes whose title, area, tags or text hold every word
    python3 brain.py read <note>        one note's text (its file name without .md, or a path in the vault)
    python3 brain.py list [area]        every note you may read, newest first

A decision or preference in the notes beats a guess. Bots never write here: a bot that learns something worth
keeping says so in its report, and the lead proposes it to the owner.

Which folder: BOTYARD_BRAIN_DIR, else `config/brain.json` {"folder": ...} in Botyard's home (set in the Brain
view). Nothing set: there are no notes, and the script says so.

Privacy: work notes are for every bot. Personal notes (a folder named in PERSONAL, any folder other than
decisions/preferences/inbox, or `private: true` in the note) are served only to a run of Claude Code, and never
to a run under OpenCode or any other model's tool. That is decided from the processes that started this one,
which a model's own command cannot change; an environment variable is never trusted for it. Unsure means no.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import botyard_home  # noqa: E402

PERSONAL = {'life', 'career', 'money', 'investments', 'finance', 'health', 'family', 'personal', 'private'}
WORK_FOLDERS = {'', 'decisions', 'preferences', 'inbox', 'notes'}
SKIP = {'templates', 'node_modules'}
# The tools that run a Claude model. A run is Claude's only when one of these started it and no other model's
# tool stands between.
CLAUDE = {'claude'}
OTHER = {'opencode', 'codex', 'gemini', 'aider', 'goose', 'crush', 'qwen', 'agy', 'cursor-agent', 'droid', 'kilo', 'cline'}


def folder(env=None):
    env = os.environ if env is None else env
    if env.get('BOTYARD_BRAIN_DIR'):
        return os.path.abspath(os.path.expanduser(env['BOTYARD_BRAIN_DIR']))
    try:
        chosen = json.load(open(os.path.join(botyard_home.config_dir(env), 'brain.json'))).get('folder') or ''
        return os.path.abspath(os.path.expanduser(chosen)) if chosen else ''
    except (OSError, ValueError):
        return ''


def _proc(pid):
    """(parent pid, the program's name) of a process, from /proc; None when it cannot be read."""
    try:
        stat = open(f'/proc/{pid}/stat').read()
        ppid = int(stat.rsplit(')', 1)[1].split()[1])
        argv = open(f'/proc/{pid}/cmdline', 'rb').read().split(b'\0')
        names = {os.path.basename(open(f'/proc/{pid}/comm').read().strip()).lower()}
        # A node or bun program is named by its script: `node .../bin/opencode` is OpenCode.
        for arg in argv[:3]:
            if arg:
                names.add(os.path.basename(arg.decode(errors='replace')).lower())
        return ppid, names
    except (OSError, ValueError, IndexError):
        return None


def caller(pid=None, read=_proc):
    """'claude', 'other' or 'unknown': which model's tool this process runs under, from its ancestors."""
    pid = os.getpid() if pid is None else pid
    seen_claude = False
    for _ in range(64):
        got = read(pid)
        if not got:
            break
        ppid, names = got
        if names & OTHER or any(n.startswith(tuple(OTHER)) for n in names if n not in CLAUDE):
            if not names & CLAUDE:
                return 'other'
        if names & CLAUDE:
            seen_claude = True
        if ppid <= 1:
            break
        pid = ppid
    return 'claude' if seen_claude else 'unknown'


def front(text):
    m = re.match(r'^---\r?\n(.*?)\r?\n---\r?\n?', text, re.S)
    if not m:
        return {}, text
    data = {}
    for line in m.group(1).splitlines():
        kv = re.match(r'^([A-Za-z_][\w-]*):\s*(.*)$', line)
        if kv:
            data[kv.group(1).lower()] = kv.group(2).strip().strip('"\'')
    return data, text[m.end():]


def notes(root):
    """Every note: (id, path in the vault, frontmatter, body, personal)."""
    out = []
    for here, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if not d.startswith('.') and d not in SKIP)
        for name in sorted(files):
            if not name.endswith('.md') or name.lower() == 'readme.md' or (here == root and name.lower() == 'index.md'):
                continue
            path = os.path.join(here, name)
            rel = os.path.relpath(path, root)
            top = rel.split(os.sep)[0] if os.sep in rel else ''
            try:
                data, body = front(open(path, errors='replace').read())
            except OSError:
                continue
            personal = top.lower() in PERSONAL or top.lower() not in WORK_FOLDERS or str(data.get('private', '')).lower() == 'true'
            out.append((name[:-3], rel, data, body, personal))
    return out


def allowed(note, who):
    return not note[4] or who == 'claude'


def main(argv=None, env=None, who=None):
    argv = sys.argv[1:] if argv is None else argv
    root = folder(env)
    if not root or not os.path.isdir(root):
        print('No notes folder is set. The owner sets it in Botyard, in the Brain view.')
        return 1
    who = who or caller()
    every = notes(root)
    mine = [n for n in every if allowed(n, who)]
    hidden = len(every) - len(mine)
    cmd = argv[0] if argv else ''
    if cmd == 'read' and len(argv) > 1:
        want = argv[1].removesuffix('.md')
        hit = next((n for n in every if n[0] == want or n[1].removesuffix('.md') == want), None)
        if not hit:
            print(f'No note is called {want}. Try: brain.py search <words>')
            return 1
        if not allowed(hit, who):
            print(f'{want} is a personal note: only a Claude run may read it, and this run is not one.')
            return 3
        print(f'# {hit[1]}\n')
        print(hit[3].strip())
        return 0
    if cmd in ('search', 'list'):
        words = [w.lower() for w in argv[1:]] if cmd == 'search' else []
        area = argv[1].lower() if cmd == 'list' and len(argv) > 1 else ''
        rows = []
        for n in mine:
            title = (re.search(r'^#\s+(.+)$', n[3], re.M) or [None, n[0]])[1]
            hay = f'{title} {n[1]} {n[2].get("tags", "")} {n[2].get("area", "")} {n[3]}'.lower()
            if words and not all(w in hay for w in words):
                continue
            if area and area not in n[1].lower() and area not in str(n[2].get('area', '')).lower() and area not in str(n[2].get('tags', '')).lower():
                continue
            day = n[2].get('date') or n[2].get('updated') or (re.match(r'\d{4}-\d{2}-\d{2}', n[0]) or [''])[0]
            state = n[2].get('status', '')
            rows.append((day, n[0], title, state))
        rows.sort(reverse=True)
        for day, nid, title, state in rows[:60]:
            print(f'{day or "----------"}  {nid}  {title}{"  (" + state + ")" if state and state != "accepted" else ""}')
        print(f'{len(rows)} note(s)' + (f'; {hidden} personal note(s) are not shown to this run' if hidden and who != 'claude' else '') + '. Read one: brain.py read <name>')
        return 0
    print(__doc__.split('\n\n')[1])
    return 2


if __name__ == '__main__':
    sys.exit(main())
