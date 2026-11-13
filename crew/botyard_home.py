"""Where Botyard keeps things, and what a run is told: the one place the crew's Python reads a name from.

The same answers as the server's `studio/server/lib/home.mjs`, and as `botyard-home.sh` for the shell
scripts. A studio's home is `$BOTYARD_HOME`, by default `~/.botyard`:

    studio.db, runs/, files/   the store and what runs leave behind    data_dir()
    run-logs/                  every run's log                          run_logs()
    crew/                      bots, instructions, the crew's state     crew_dir()
    keys/                      pasted keys, readable by you alone       keys_dir()
    config/                    limits, paired phones, built previews    config_dir()

No script writes a folder of this computer, a variable's name or a tool's path out by hand:
    repo(), scripts()      the repository and its crew folder, from this file's own place
    projects()             the folder the studio's projects are in
    tool('opencode')       where a tool is, found on the bots' PATH
    studio_id()            this studio's id in the engine
    api(), base()          the engine's address
    run_var('JOB_ID')      what the run was told

    python3 botyard_home.py            prints every place
    python3 botyard_home.py crew_dir   prints one
"""
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.realpath(__file__))


def user_home(env=None):
    env = os.environ if env is None else env
    return env.get('HOME') or os.path.expanduser('~')


DEFAULT_PORT = 3210


def places(env=None):
    """Where each folder is, without making anything."""
    env = os.environ if env is None else env
    chosen = (env.get('BOTYARD_HOME') or '').strip()
    root = os.path.abspath(chosen or os.path.join(user_home(env), '.botyard'))
    return {'home': root, 'data': root, 'run_logs': os.path.join(root, 'run-logs'), 'crew': os.path.join(root, 'crew'),
            'keys': os.path.join(root, 'keys'), 'config': os.path.join(root, 'config')}


def _made(folder, mode=None):
    os.makedirs(folder, exist_ok=True)
    if mode:
        try:
            os.chmod(folder, mode)
        except OSError:
            pass
    return folder


def home(env=None):
    return _made(places(env)['home'])


def data_dir(env=None):
    return _made(places(env)['data'])


def crew_dir(env=None):
    return _made(places(env)['crew'])


def keys_dir(env=None):
    """Keys are for the owner's eyes only: the folder is closed to everyone else on the computer."""
    return _made(places(env)['keys'], 0o700)


def config_dir(env=None):
    """Settings the owner and the service keep: the token limits, paired phones, built previews."""
    return _made(places(env)['config'])


def run_logs(env=None):
    """The folder every run's log is in, as a list, so a script can loop over it: [] before a first run."""
    mine = places(env)['run_logs']
    return [mine] if os.path.isdir(mine) else []


def state(name, env=None):
    """A state file of the crew's, by its file name: state('pace.json')."""
    return os.path.join(crew_dir(env), name)


def repo():
    """The repository this script is in, wherever it was cloned. A copy of the crew (install.sh --copy)
    is not in it, and names it in a one-line .repo file beside itself."""
    try:
        with open(os.path.join(HERE, '.repo'), encoding='utf8') as f:
            told = f.read().strip()
        if told:
            return told
    except OSError:
        pass
    return os.path.dirname(HERE)


def scripts():
    """The crew's scripts: the repository's, or a copy of them (install.sh --copy)."""
    return HERE


def source(name=''):
    """The crew's data in the repository, which is never copied: source('bots'), source('skills')."""
    return os.path.join(repo(), 'crew', name) if name else os.path.join(repo(), 'crew')


def projects(env=None):
    """The folder the studio's projects are in: `$BOTYARD_PROJECTS`, else the folder the repository was
    cloned into, so projects sit beside Botyard."""
    env = os.environ if env is None else env
    return os.path.abspath(env.get('BOTYARD_PROJECTS') or os.path.dirname(repo()))


def short(path, env=None):
    """A path as a person writes it: the home folder as ~."""
    home_dir = user_home(env)
    return '~' + path[len(home_dir):] if path == home_dir or path.startswith(home_dir + os.sep) else path


# ── tools ────────────────────────────────────────────────────────────────────────────

def bot_path(env=None):
    """The PATH a bot's run gets. The service starts at login without the shell's PATH, so the places
    a person's tools are installed in are named here."""
    home_dir = user_home(env)
    return f'{home_dir}/.local/bin:{home_dir}/.npm-global/bin:/usr/local/bin:/usr/bin:/bin'


# Where a tool may be when it is on no PATH (the desktop apps bring their own copy).
ELSEWHERE = {
    'codex': ['/usr/lib/chatgpt/resources/codex', '/opt/chatgpt/resources/codex',
              '/Applications/ChatGPT.app/Contents/Resources/codex'],
    'opencode': ['~/.opencode/bin/opencode'],
    'claude': ['~/.claude/local/claude'],
}
INSTALL = {
    'opencode': 'OpenCode is not installed, and it is what runs the free models. Install it with: '
                'npm install -g opencode-ai   (or: curl -fsSL https://opencode.ai/install | bash), then run this again.',
    'claude': 'Claude Code is not installed. Install it with: npm install -g @anthropic-ai/claude-code, then sign in with: claude',
    'codex': 'Codex is not installed. Install it with: npm install -g @openai/codex, then sign in with: codex login',
    'agy': "Google's Antigravity CLI (agy) is not installed, so no bot can run on Gemini.",
}


def tool(name, env=None):
    """Where a tool is: on the bots' PATH first (so a timer and a person at a shell get the same answer),
    then on this shell's PATH, then where its desktop app keeps it. None when it is not installed."""
    env = os.environ if env is None else env
    found = shutil.which(name, path=bot_path(env)) or shutil.which(name, path=env.get('PATH', ''))
    if found:
        return found
    home_dir = user_home(env)
    for place in ELSEWHERE.get(name, []):
        place = place.replace('~', home_dir, 1)
        if os.access(place, os.X_OK):
            return place
    return None


def need(name, env=None):
    """The tool's path, or stop saying in plain words what to install."""
    found = tool(name, env)
    if not found:
        sys.exit(INSTALL.get(name, f'{name} is not installed on this computer.'))
    return found


# ── keys ─────────────────────────────────────────────────────────────────────────────

def key(name, env=None):
    """A pasted key by its name ('openrouter', 'nvidia'), or None. Read from Botyard's keys folder
    (`<name>.key`, one line), else from OpenCode's own file for a provider signed in to
    with `opencode auth login`. Never print what this returns."""
    env = os.environ if env is None else env
    try:
        with open(os.path.join(places(env)['keys'], f'{name}.key'), encoding='utf8') as f:
            value = f.read().strip()
        if value:
            return value
    except OSError:
        pass
    try:
        with open(os.path.join(user_home(env), '.local', 'share', 'opencode', 'auth.json'), encoding='utf8') as f:
            value = (json.load(f).get(name) or {}).get('key')
        return value or None
    except (OSError, ValueError, AttributeError):
        return None


def has_key(name, env=None):
    """True when the provider can be asked: its key was pasted in Botyard, or it was signed in to with
    `opencode auth login` (which may hold a sign-in that is not a key)."""
    env = os.environ if env is None else env
    if key(name, env):
        return True
    try:
        with open(os.path.join(user_home(env), '.local', 'share', 'opencode', 'auth.json'), encoding='utf8') as f:
            return bool(json.load(f).get(name))
    except (OSError, ValueError, AttributeError):
        return False


# The variable each provider's own tools read its key from.
KEY_VARS = {'openrouter': 'OPENROUTER_API_KEY', 'nvidia': 'NVIDIA_API_KEY'}


def key_env(env=None):
    """The keys pasted in Botyard, as the variables OpenCode reads them from: {} when there are none.
    A variable already set is left alone. Merge this into the environment of anything that runs OpenCode."""
    env = os.environ if env is None else env
    out = {}
    for name, var in KEY_VARS.items():
        if env.get(var):
            continue
        try:
            with open(os.path.join(places(env)['keys'], f'{name}.key'), encoding='utf8') as f:
                value = f.read().strip()
        except OSError:
            continue
        if value:
            out[var] = value
    return out


# ── the engine ───────────────────────────────────────────────────────────────────────

def base(env=None):
    """The engine's address without a trailing slash: `BOTYARD_API_URL` when the service or the run was
    told it, else this computer on the engine's port (`BOTYARD_ENGINE_PORT`, 3210)."""
    env = os.environ if env is None else env
    told = (env.get('BOTYARD_API_URL') or '').strip().rstrip('/')
    if told:
        return told[:-4] if told.endswith('/api') else told
    return f"http://127.0.0.1:{(env.get('BOTYARD_ENGINE_PORT') or '').strip() or DEFAULT_PORT}"


def api(env=None):
    return base(env) + '/api'


def studio_id(env=None):
    """This studio's id in the engine: what the run was told, else the id kept in the crew's folder,
    else the engine's one studio (kept from then on). '' while Botyard is not running."""
    env = os.environ if env is None else env
    told = run_var('ID', env=env)
    if told:
        return told
    file = os.path.join(places(env)['crew'], 'studio-id')
    try:
        with open(file, encoding='utf8') as f:
            found = f.read().strip()
        if found:
            return found
    except OSError:
        pass
    import urllib.request
    try:
        with urllib.request.urlopen(api(env) + '/companies', timeout=10) as res:
            found = json.load(res)[0]['id']
    except Exception:  # noqa: BLE001
        # Not running: the caller's own first call says so in its own words. Nothing is kept.
        return ''
    with open(os.path.join(crew_dir(env), 'studio-id'), 'w', encoding='utf8') as f:
        f.write(found)
    return found


# ── what a run is told ───────────────────────────────────────────────────────────────

# The variables a run is told, by what each one is.
RUN_VARS = ('API_URL', 'API_KEY', 'RUN_ID', 'JOB_ID', 'BOT_ID', 'ID')


def var_name(what):
    """The variable's own name: var_name('JOB_ID') is what a bot's rules write after a $."""
    if what not in RUN_VARS:
        raise KeyError(what)
    return 'BOTYARD_' + what


def run_var(what, default=None, env=None):
    """What the run was told: run_var('JOB_ID'), run_var('API_KEY'). `default` when it was not."""
    env = os.environ if env is None else env
    return env.get(var_name(what)) or default


def run_headers(env=None, json_body=True):
    """The headers a bot's own call to the engine carries: its pass, which also says which run it is."""
    out = {'Content-Type': 'application/json'} if json_body else {}
    if run_var('API_KEY', env=env):
        out['Authorization'] = f"Bearer {run_var('API_KEY', env=env)}"
    return out


if __name__ == '__main__':
    answers = {**places(), 'repo': repo(), 'scripts': scripts(), 'projects': projects(), 'crew_dir': places()['crew'],
               'keys_dir': places()['keys'], 'data_dir': places()['data'], 'config_dir': places()['config'], 'bot_path': bot_path()}
    if len(sys.argv) > 1:
        if sys.argv[1] == 'var' and len(sys.argv) > 2:
            print(var_name(sys.argv[2]))
        elif sys.argv[1] == 'tool' and len(sys.argv) > 2:
            print(need(sys.argv[2]))
        elif sys.argv[1] in answers:
            print(answers[sys.argv[1]])
        else:
            sys.exit(f'botyard_home.py knows: {", ".join(sorted(answers))}, var NAME, tool NAME')
    else:
        for name in sorted(answers):
            print(f'{name:10} {answers[name]}')
