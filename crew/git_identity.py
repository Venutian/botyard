"""Who a bot's commits are signed as. Every bot, Claude or free, commits under its own first name
(Fred, Bob, Chip and the rest) with a GitHub no-reply address (BOTYARD_GIT_NOREPLY, else the global git user.email when it is one; with neither, nothing is set) as both author and
committer, and no other address: the push check refuses anything else, and a personal address stays
off GitHub. Git reads these four variables before any config, a `-c user.email=` or a `git config` the
bot ran itself, so setting them once in the launcher decides it.

    python3 git_identity.py --export [BOT_SLUG]   prints the export lines, for a shell launcher to eval
"""
import os
import re
import shlex
import subprocess
import sys

SAFE = re.compile(r'@users\.noreply\.github\.com$')


def no_reply(env=None):
    """The one address commits may carry: BOTYARD_GIT_NOREPLY, else the global git user.email when it is a
    GitHub no-reply address, else '' (nothing is set and git keeps whatever it has)."""
    env = os.environ if env is None else env
    given = (env.get('BOTYARD_GIT_NOREPLY') or '').strip()
    if given:
        return given if SAFE.search(given) else ''
    try:
        out = subprocess.run(['git', 'config', '--global', 'user.email'], capture_output=True, text=True, timeout=10, env={**os.environ, **env}).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ''
    return out if SAFE.search(out) else ''


def first_name(slug):
    """'ada-the-builder' or 'Ada The Builder' becomes 'Ada'; nothing usable becomes 'bot'."""
    word = re.split(r'[^A-Za-z0-9]+', (slug or '').strip())[0]
    return word.capitalize() if word else 'bot'


def bot_slug(env=None):
    """The bot of this run: its settings file (Claude bots) or the free runner's role."""
    env = os.environ if env is None else env
    if env.get('BOTYARD_BOT_NAME'):
        return env['BOTYARD_BOT_NAME']
    settings = env.get('BOTYARD_BOT_SETTINGS')
    if settings:
        return os.path.basename(settings).split('.')[0]
    if env.get('BOTYARD_CHECKER'):
        return 'checker'
    return ''


def identity_env(slug=None, env=None):
    mail = no_reply(env)
    if not mail:
        return {}
    name = first_name(slug if slug is not None else bot_slug(env))
    return {'GIT_AUTHOR_NAME': name, 'GIT_AUTHOR_EMAIL': mail,
            'GIT_COMMITTER_NAME': name, 'GIT_COMMITTER_EMAIL': mail}


def apply(target=None, default='fred'):
    """Set the identity in a process environment (the free runner's own, which OpenCode and its git inherit)."""
    target = os.environ if target is None else target
    target.update(identity_env(bot_slug(target) or default, target))
    return target


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    pairs = identity_env(args[0] if args else None)
    if '--export' in sys.argv:
        print('\n'.join(f'export {k}={shlex.quote(v)}' for k, v in pairs.items()))
    else:
        print('\n'.join(f'{k}={v}' for k, v in pairs.items()))
