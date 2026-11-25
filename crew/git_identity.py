"""Who a bot's commits are signed as. Every bot, Claude or free, commits under its own first name
(Fred, Bob, Chip and the rest) with the studio's one GitHub no-reply address as both author and committer,
and no other address: the push check refuses anything else, and a personal address stays off GitHub. Git reads
these four variables before any config, a `-c user.email=` or a `git config` the bot ran itself, so setting them
once in the launcher decides it.

The studio address is BOTYARD_GIT_NOREPLY, else the owner's own global user.email (their ~/.gitconfig, never the
sandbox gitconfig a bot runs under through GIT_CONFIG_GLOBAL: a bot or a test can write that file). Either must have
GitHub's account form, <id>+<login>@users.noreply.github.com. With neither, nothing is set. An address that only ends
in @users.noreply.github.com is not the studio's: `t@users.noreply.github.com` is the GitHub account `t`, a stranger.

    python3 git_identity.py --export [BOT_SLUG]   prints the export lines, for a shell launcher to eval
    python3 git_identity.py --studio              prints the studio address (empty, exit 1, when there is none)
"""
import os
import re
import shlex
import subprocess
import sys

# GitHub's account-bound no-reply form. The shape alone never passes a check: use is_studio().
FORM = re.compile(r'^[0-9]+\+[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})@users\.noreply\.github\.com$')
SAFE = FORM  # old name, kept for callers that only ask about the shape
# Variables that point git at a config other than the owner's own.
NOT_OWNER = ('GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG', 'GIT_DIR',
             'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS')


def owner_global_email(env=None):
    """user.email of the owner's own global git config, read with GIT_CONFIG_GLOBAL and the like left out."""
    env = os.environ if env is None else env
    clean = {k: v for k, v in {**os.environ, **env}.items() if k not in NOT_OWNER and not k.startswith('GIT_CONFIG_KEY_')
             and not k.startswith('GIT_CONFIG_VALUE_')}
    try:
        return subprocess.run(['git', 'config', '--global', 'user.email'], capture_output=True, text=True, timeout=10,
                              env=clean, cwd=clean.get('HOME') or None).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ''


def no_reply(env=None):
    """The one address commits may carry: BOTYARD_GIT_NOREPLY, else the owner's own global git user.email, when it
    has GitHub's <id>+<login> no-reply form; else '' (nothing is set and git keeps whatever it has)."""
    env = os.environ if env is None else env
    given = (env.get('BOTYARD_GIT_NOREPLY') or '').strip()
    if given:
        return given if FORM.match(given) else ''
    out = owner_global_email(env)
    return out if FORM.match(out) else ''


def is_studio(mail, env=None):
    """True only for the studio's own address. Any other no-reply, a test one included, is False."""
    studio = no_reply(env)
    return bool(studio) and (mail or '').strip().lower() == studio.lower()


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
    if '--studio' in sys.argv:
        print(no_reply())
        sys.exit(0 if no_reply() else 1)
    if '--export' in sys.argv:
        print('\n'.join(f'export {k}={shlex.quote(v)}' for k, v in pairs.items()))
    else:
        print('\n'.join(f'{k}={v}' for k, v in pairs.items()))
