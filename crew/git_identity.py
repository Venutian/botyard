"""Who a bot's commits are signed as. Every bot, Claude or free, commits under its own first name
(Fred, Freya, Bob, Chip, Gideon, Tony, Dana) with the studio's GitHub no-reply address as both author and
committer, and no other address: the push check refuses anything else, and the owner's own address stays
off GitHub. Git reads these four variables before any config, a `-c user.email=` or a `git config` the
bot ran itself, so setting them once in the launcher decides it.

    python3 git_identity.py --export [BOT_SLUG]   prints the export lines, for a shell launcher to eval
"""
import os
import re
import shlex
import sys

NO_REPLY = os.environ.get('BOTYARD_GIT_NOREPLY') or '25855689+Venutian@users.noreply.github.com'
SAFE = re.compile(r'@users\.noreply\.github\.com$')


def first_name(slug):
    """'bob-the-builder' or 'Bob The Builder' becomes 'Bob'; nothing usable becomes 'nGen bot'."""
    word = re.split(r'[^A-Za-z0-9]+', (slug or '').strip())[0]
    return word.capitalize() if word else 'nGen bot'


def bot_slug(env=None):
    """The bot of this run: its settings file (Claude bots) or the free runner's role."""
    env = os.environ if env is None else env
    if env.get('BOTYARD_BOT_NAME'):
        return env['BOTYARD_BOT_NAME']
    settings = env.get('BOTYARD_BOT_SETTINGS')
    if settings:
        return os.path.basename(settings).split('.')[0]
    if env.get('BOTYARD_CHECKER'):
        return 'freya'
    return ''


def identity_env(slug=None, env=None):
    name = first_name(slug if slug is not None else bot_slug(env))
    return {'GIT_AUTHOR_NAME': name, 'GIT_AUTHOR_EMAIL': NO_REPLY,
            'GIT_COMMITTER_NAME': name, 'GIT_COMMITTER_EMAIL': NO_REPLY}


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
