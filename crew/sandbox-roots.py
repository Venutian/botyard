#!/usr/bin/env python3
"""Keeps the Codex bots' sandbox from naming folders that no longer exist. No AI.

The Codex bots run in a sandbox whose config (<crew folder>/codex-safe/config.toml) lists the folders they may
write besides their work folder (`sandbox_workspace_write.writable_roots`) and the folders they trust (`projects`).
When a repository is retired or moved, a root left in that list makes every shell command fail before it starts:
"the sandbox cannot mount ... (No such file or directory)", and the bot cannot answer even in its chat.

    sandbox-roots.py          say which roots and trusted folders are missing, exit 1 when any is
    sandbox-roots.py --fix    drop them from the config (the old file kept beside it as config.toml.bak), exit 0

Botyard's timetable runs it with --fix every 5 minutes, so a retired folder never stops a bot for longer.
"""
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import botyard_home  # noqa: E402

ROOTS = re.compile(r'^(\s*writable_roots\s*=\s*)\[(.*)\]\s*$', re.M)


def config_path(env=None):
    return os.path.join(botyard_home.places(env or os.environ)['crew'], 'codex-safe', 'config.toml')


def missing(text, exists=os.path.exists):
    """The writable roots and trusted folders the config names that do not exist."""
    out = []
    for m in ROOTS.finditer(text):
        out += [p for p in re.findall(r'"([^"]+)"', m.group(2)) if not exists(p)]
    out += [p for p in re.findall(r'^\[projects\."([^"]+)"\]\s*$', text, re.M) if not exists(p)]
    return out


def fixed(text, exists=os.path.exists):
    """The config with every missing root and trusted folder taken out, the rest as it was."""
    def roots(m):
        keep = [p for p in re.findall(r'"([^"]+)"', m.group(2)) if exists(p)]
        return m.group(1) + '[' + ', '.join(f'"{p}"' for p in keep) + ']'
    text = ROOTS.sub(roots, text)
    # A [projects."<path>"] table runs to the next table or the end.
    parts = re.split(r'(?m)^(?=\[)', text)
    return ''.join(p for p in parts if not (re.match(r'\[projects\."([^"]+)"\]', p) and not exists(re.match(r'\[projects\."([^"]+)"\]', p).group(1))))


def main(argv):
    path = next((a.split('=', 1)[1] for a in argv if a.startswith('--config=')), None) or config_path()
    try:
        text = open(path).read()
    except OSError:
        return 0
    gone = missing(text)
    if not gone:
        return 0
    if '--fix' not in argv:
        for p in gone:
            print(f'{path}: names {p}, which does not exist: every sandboxed shell command fails until it is taken out')
        return 1
    with open(path + '.bak', 'w') as f:
        f.write(text)
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        f.write(fixed(text))
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    with open(botyard_home.state('sandbox-roots.log'), 'a') as f:
        f.write(f"{time.strftime('%Y-%m-%d %H:%M')} took out of {path}: {', '.join(gone)}\n")
    print('took out:', ', '.join(gone))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
