"""Which folders each bot may use, read from the bot's own adapter rules, and what a refused call looks like in a run's log. No AI.

crew/folder-check.py is the command; this is what it and the seeder share. A bot that cannot use a folder its jobs need does not say so:
it ends with no report, and the run counts as a success. The rules of each adapter are read where they are written:

    Codex      <CODEX_HOME>/config.toml: sandbox_mode and sandbox_workspace_write.writable_roots (a run writes its own folder, the roots, /tmp)
    OpenCode   $OPENCODE_CONFIG: permission.external_directory (asked outside the run's folder, and an unattended run refuses what is asked)
               and permission.edit; the last rule that matches wins
    Claude     $BOTYARD_BOT_SETTINGS: permissions.deny (Edit, Write, Read rules); everything else is allowed
    Gemini     agy-acp.py: a write is refused outside the bot's folder and /tmp

What a bot needs: its own folder (adapterConfig.cwd), the folders its bot file lists in `reads`, the job-closing skill's folder, its run's scratch
folder, the project folders and worktrees of the jobs given to it, and the folders a studio says its scripts write ("writes" in
crew/own/folder-check.json). What no bot may have: the keys folder, the owner's notes (never written, personal areas read by Claude bots only),
the guards' own files, and the studio's "never" list in the same file:

    {"writes": [{"path": "{crew}/bot-writes", "bots": ["Name"], "why": "..."}],
     "never":  [{"path": "~/.config/x", "read": false, "why": "..."}]}

`bots` is a list of bot names (default: every bot whose adapter has a file sandbox); `read: false` means no bot may read it either.
Nothing here changes a config: it reports, and the fix stays in the bot's file or the adapter's own config.
"""
import json
import os
import re
import sqlite3
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import botyard_home  # noqa: E402

OPEN_JOB = ('todo', 'in_progress', 'in_review', 'blocked')
SANDBOXED = ('codex_local',)
LANES = re.compile(r' on (?:Claude|Codex|Gemini)$')
EDITS = ('Edit', 'Write', 'MultiEdit', 'NotebookEdit')


# ── paths and rules ─────────────────────────────────────────────────────────────────

def expand(path, marks=None):
    """A path as the studio's files write it: {crew} {home} {botyard} marks and ~."""
    for name, value in (marks or {}).items():
        path = path.replace('{' + name + '}', value)
    return os.path.expanduser(path)


def inside(path, root):
    path, root = os.path.normpath(path), os.path.normpath(root)
    return path == root or path.startswith(root.rstrip('/') + '/')


def both(path):
    """The path as named and where it really is (a symlink in the crew folder points into a repository)."""
    real = os.path.realpath(path)
    return [path] if real == path else [path, real]


def glob_re(pattern):
    """An OpenCode permission pattern: * is any run of characters (a slash too), ? one character."""
    return re.compile('^' + re.escape(os.path.expanduser(pattern)).replace(r'\*', '.*').replace(r'\?', '.') + '$', re.S)


def decide(rules, path, default='ask'):
    """The verdict of an OpenCode permission for a path: the last rule that matches wins."""
    if isinstance(rules, str):
        return rules
    verdict = default
    for pattern, action in (rules or {}).items():
        if isinstance(action, str) and glob_re(pattern).match(path):
            verdict = action
    return verdict


def claude_denies(permissions, tools, path, cwd=''):
    """True when a Claude settings file's permissions.deny holds a rule for one of these tools that covers the path."""
    for rule in (permissions or {}).get('deny') or []:
        m = re.match(r'^(\w+)(?:\((.*)\))?$', str(rule).strip())
        if not m or m.group(1) not in tools:
            continue
        spec = m.group(2)
        if spec in (None, '', '*', '**'):
            return True
        if spec.startswith('//'):
            spec = spec[1:]
        elif spec.startswith('~'):
            spec = os.path.expanduser(spec)
        elif spec.startswith('/') and cwd:
            spec = os.path.join(cwd, spec[1:])
        regex = re.escape(spec).replace(r'\*\*', '\0').replace(r'\*', '[^/]*').replace('\0', '.*')
        if re.match('^' + regex + '$', path) or (not re.search(r'[*?]', spec) and inside(path, spec)):
            return True
        if spec.endswith('/**') and inside(path, spec[:-3]):
            return True
    return False


# ── the engine's store, read-only ───────────────────────────────────────────────────

def open_store(env=None, db=None):
    path = db or os.path.join(botyard_home.places(env)['data'], 'studio.db')
    if not os.path.isfile(path):
        return None
    return sqlite3.connect(f'file:{path}?mode=ro', uri=True)


def _load(path):
    with open(path, encoding='utf8') as f:
        return json.load(f)


def _json(text):
    try:
        return json.loads(text) if text else {}
    except (TypeError, ValueError):
        return {}


def bots(db):
    """The bots that can run: id, name, adapter type, adapterConfig. A removed bot is left out."""
    out = []
    for aid, name, adapter, status, raw in db.execute('SELECT id, name, adapter_type, status, raw FROM agents ORDER BY name'):
        if status != 'terminated':
            out.append({'id': aid, 'name': name, 'adapter': adapter, 'config': _json(raw).get('adapterConfig') or {}})
    return out


def plain_env(config):
    return {key: (value.get('value') if isinstance(value, dict) else value) for key, value in (config.get('env') or {}).items()}


def project_folders(db, project_id):
    """Where a project is worked: the folder its settings name, else its workspaces' (the engine's own order)."""
    out = []
    row = db.execute('SELECT raw FROM projects WHERE id = ?', (project_id,)).fetchone()
    primary = ((_json(row[0]).get('primaryWorkspace') or {}).get('cwd')) if row else None
    if primary:
        out.append(primary)
    for (cwd,) in db.execute('SELECT cwd FROM project_workspaces WHERE project_id = ? ORDER BY is_primary DESC', (project_id,)):
        if cwd and cwd not in out:
            out.append(cwd)
    return out


def jobs_of(db, agent_id):
    """The open jobs given to a bot: (identifier, project id, its worktree when it has one)."""
    out = []
    for ident, project, execution in db.execute(
            'SELECT identifier, project_id, execution_workspace_id FROM jobs WHERE assignee_agent_id = ? AND status IN (%s)' % ','.join('?' * len(OPEN_JOB)),
            (agent_id, *OPEN_JOB)).fetchall():
        row = db.execute('SELECT cwd FROM workspaces WHERE id = ?', (execution,)).fetchone() if execution else None
        out.append((ident, project, row[0] if row else None))
    return out


# ── what each adapter lets a bot do ─────────────────────────────────────────────────

def codex_config(path):
    """(sandbox_mode, writable_roots) of a Codex home's config.toml; (None, None) when the file is not there."""
    try:
        with open(path, encoding='utf8') as f:
            text = f.read()
    except OSError:
        return None, None
    mode = re.search(r'^\s*sandbox_mode\s*=\s*"([^"]*)"', text, re.M)
    roots = re.search(r'^\s*writable_roots\s*=\s*\[(.*?)\]\s*$', text, re.M | re.S)
    return (mode.group(1) if mode else None), (re.findall(r'"([^"]+)"', roots.group(1)) if roots else [])


def tmp_roots():
    """The folders every sandbox lets a run write: the temporary folders."""
    return sorted({p for p in ('/tmp', tempfile.gettempdir(), os.environ.get('TMPDIR') or '') if p})


class Policy:
    """What one bot's adapter lets it do. write(path) and read(path) say True or False; read says None where the adapter has no rule to read."""

    def __init__(self, adapter, config):
        self.adapter = adapter
        self.cwd = config.get('cwd') or ''
        self.env = plain_env(config)
        self.problems = []
        self.tmp = tmp_roots()
        self.run_folders = [self.cwd] if self.cwd else []
        self.roots, self.mode, self.rules, self.permissions, self.file = [], None, {}, {}, ''
        if adapter == 'codex_local':
            self.file = os.path.join(self.env.get('CODEX_HOME') or os.path.join(os.path.expanduser('~'), '.codex'), 'config.toml')
            self.mode, roots = codex_config(self.file)
            if roots is None:
                self.problems.append(f'its Codex config {self.file} is missing, so it has no sandbox rules')
            elif self.mode == 'read-only':
                self.problems.append('its Codex config sets sandbox_mode "read-only": it can write nowhere')
            elif not self.mode:
                self.problems.append('its Codex config sets no sandbox_mode, so a run is read-only')
            self.roots = roots or []
        elif adapter == 'opencode_local':
            self.file = self.env.get('OPENCODE_CONFIG') or ''
            if not self.file or not os.path.isfile(self.file):
                self.problems.append(f'its OpenCode config {self.file or "(none named: OPENCODE_CONFIG)"} is missing')
            else:
                try:
                    self.rules = _load(self.file).get('permission') or {}
                except ValueError as err:
                    self.problems.append(f'its OpenCode config {self.file} is not valid JSON ({err})')
        elif adapter == 'claude_local':
            self.file = self.env.get('BOTYARD_BOT_SETTINGS') or ''
            if self.file:
                try:
                    self.permissions = _load(self.file).get('permissions') or {}
                except OSError:
                    self.problems.append(f'its settings file {self.file} is missing')
                except ValueError as err:
                    self.problems.append(f'its settings file {self.file} is not valid JSON ({err})')

    def in_run(self, path):
        return any(inside(path, f) for f in self.run_folders)

    def write(self, path):
        if self.adapter == 'codex_local':
            if self.mode == 'danger-full-access':
                return True
            return self.mode == 'workspace-write' and (self.in_run(path) or any(inside(path, r) for r in self.roots + self.tmp))
        if self.adapter == 'opencode_local':
            if not self.rules:
                return None
            if decide(self.rules.get('edit', 'allow'), path, 'allow') != 'allow':
                return False
            return self.in_run(path) or decide(self.rules.get('external_directory', 'ask'), path, 'ask') == 'allow'
        if self.adapter == 'claude_local':
            return not claude_denies(self.permissions, EDITS, path, self.cwd)
        if self.adapter == 'gemini_local':
            return self.in_run(path) or any(inside(path, t) for t in self.tmp)
        return None

    def read(self, path):
        if self.adapter == 'opencode_local':
            if not self.rules:
                return None
            if decide(self.rules.get('read', 'allow'), path, 'allow') == 'deny':
                return False
            return self.in_run(path) or decide(self.rules.get('external_directory', 'ask'), path, 'ask') == 'allow'
        if self.adapter == 'claude_local':
            return not claude_denies(self.permissions, ('Read',), path, self.cwd)
        return None   # Codex and Antigravity have no rule for reading: a read is never refused, and never kept closed either


def base_name(name):
    return LANES.sub('', name)


# ── what a studio's data says ───────────────────────────────────────────────────────

def marks(env=None):
    p = botyard_home.places(env)
    return {'crew': p['crew'], 'home': botyard_home.user_home(env), 'botyard': p['home']}


def studio_file(env=None):
    """The studio's own rules (crew/own/folder-check.json); BOTYARD_FOLDER_RULES names another file, for a look at rules not yet in place."""
    told = (os.environ if env is None else env).get('BOTYARD_FOLDER_RULES')
    if told:
        try:
            return _load(told)
        except (OSError, ValueError):
            return {}
    try:
        return _load(os.path.join(botyard_home.places(env)['crew'], 'own', 'folder-check.json'))
    except (OSError, ValueError):
        return {}


def writes(env=None):
    """The folders a studio's scripts write for a bot: [(path, bot names or None, why)]."""
    m = marks(env)
    return [(expand(row['path'], m), row.get('bots'), row.get('why') or '') for row in studio_file(env).get('writes') or [] if row.get('path')]


def protected(env=None):
    """What no bot may have: [{path, kind, why, read}]. `read` is True (anyone may read), 'claude' (a Claude run only) or False (nobody).
    A path is listed as named and where it really is, so a symlink into a repository is not a way round."""
    p = botyard_home.places(env)
    out = []

    def add(path, kind, why, read=True):
        out.extend({'path': each, 'kind': kind, 'why': why, 'read': read} for each in both(path))

    add(p['keys'], 'keys', 'the keys the owner pasted', False)
    add(os.path.join(p['crew'], 'claude-token'), 'keys', "the owner's long-lived Claude token", False)
    add(os.path.join(p['config'], 'pc-load.json'), 'guard', "the PC load setting, which is the owner's")
    for name in ('guards.py', 'owner-guard.py', 'loop-guard.py'):
        add(os.path.join(p['crew'], name), 'guard', "a guard's own file")
    add(os.path.join(p['crew'], 'own', 'guard.json'), 'guard', "the owner guard's rules")
    vault = notes_folder(env)
    if vault:
        add(vault, 'notes', "the owner's notes", 'claude')
    for row in studio_file(env).get('never') or []:
        if row.get('path'):
            add(expand(row['path'], marks(env)), 'never', row.get('why') or "on the studio's never list", row.get('read', True))
    return out


def notes_folder(env=None):
    try:
        import brain
        root = brain.folder(env)
        return root if root and os.path.isdir(root) else ''
    except Exception:
        return ''


def personal_notes(env=None, limit=6):
    """A few of the owner's personal notes (a path each), to test that a read of one is refused."""
    root = notes_folder(env)
    if not root:
        return []
    import brain
    return [os.path.join(root, n[1]) for n in brain.notes(root) if n[4]][:limit]


# ── the check ───────────────────────────────────────────────────────────────────────

def needs(bot, db, policy, env=None):
    """What this bot needs, as dicts: kind 'exists' (the folder is there), 'write' or 'read' (the adapter lets it), 'none';
    `path` is shown, `probe` is a file inside it that the adapter's rules are asked about, `virtual` is a folder that is made when a run starts."""
    out = []
    own = 'its own folder'
    if not policy.cwd:
        return [{'kind': 'none', 'path': '', 'why': 'it has no working folder (adapterConfig.cwd)'}]
    out += [{'kind': 'exists', 'path': policy.cwd, 'why': own}, {'kind': 'write', 'path': policy.cwd, 'probe': os.path.join(policy.cwd, 'x'), 'why': own}]
    for folder in bot.get('reads') or []:
        folder = os.path.realpath(os.path.expanduser(folder))
        why = 'a folder its bot file says it reads ("reads")'
        out += [{'kind': 'exists', 'path': folder, 'why': why}, {'kind': 'read', 'path': folder, 'probe': os.path.join(folder, 'x'), 'why': why}]
    skill = os.path.join(botyard_home.places(env)['crew'], 'codex-safe', 'skills', 'botyard')
    if bot['adapter'] == 'opencode_local':
        if os.path.isdir(skill):
            out.append({'kind': 'read', 'path': skill, 'probe': os.path.join(skill, 'scripts', 'x'), 'why': "the job-closing skill's folder", 'fix': 'setup-bots.py (it opens this folder to every OpenCode bot)'})
        scratch = os.path.join(tempfile.gettempdir(), 'botyard-run-x')
        out.append({'kind': 'write', 'path': scratch, 'probe': os.path.join(scratch, 'tmp', 'x'), 'why': "the run's own scratch folder, where its temporary files go", 'virtual': True, 'fix': "setup-bots.py (it opens the run's scratch folder to every OpenCode bot)"})
        out.append({'kind': 'read', 'path': scratch, 'probe': os.path.join(scratch, 'opencode', 'x'), 'why': "the run's own scratch folder, where OpenCode keeps its settings", 'virtual': True, 'fix': "setup-bots.py (it opens the run's scratch folder to every OpenCode bot)"})
    for path, who, why in writes(env):
        names = [base_name(n) for n in who] if who else None
        # Only a bot whose shell is sandboxed is refused a write its script makes: the other adapters rule on their own file tools, not on a script.
        if bot['adapter'] in SANDBOXED and (not names or base_name(bot['name']) in names):
            why = why or 'a folder its scripts write'
            out += [{'kind': 'exists', 'path': path, 'why': why}, {'kind': 'write', 'path': path, 'probe': os.path.join(path, 'x'), 'why': why}]
    seen = set()
    for ident, project, work in jobs_of(db, bot['id']):
        root = (project_folders(db, project) or [None])[0] if project else None
        if root and root not in seen:
            seen.add(root)
            out.append({'kind': 'exists', 'path': root, 'why': f'the project folder of {ident}'})
            if bot['adapter'] in SANDBOXED and os.path.isdir(os.path.join(root, '.git')):
                git = os.path.join(root, '.git')
                out.append({'kind': 'write', 'path': git, 'probe': os.path.join(git, 'objects', 'x'),
                            'why': f"the repository's own git data, where a worktree of {ident} commits"})
            elif bot['adapter'] == 'opencode_local' and os.path.isdir(root):
                trees = os.path.join(root, '.botyard', 'worktrees')
                out.append({'kind': 'write', 'path': trees, 'probe': os.path.join(trees, 'x', 'y'), 'why': f'the worktrees of its jobs (as {ident}) in the project folder', 'virtual': True})
        if work and os.path.isdir(work):
            out.append({'kind': 'write', 'path': work, 'probe': os.path.join(work, 'x'), 'why': f'the worktree of {ident}'})
    return out


def reads_of(name, env=None):
    """The folders a bot file lists in `reads`, by bot name (a lane's, by its bot's); [] when the crew's files cannot be read."""
    try:
        import crew_set
        files = crew_set.CrewSet(env)
        out = {}
        for slug in files.slugs():
            spec = files.spec(slug)
            out[spec['name']] = [f for f in spec.get('reads') or [] if isinstance(f, str)]
        return out.get(name, out.get(base_name(name), []))
    except (SystemExit, Exception):
        return []


def fix_for(bot, kind):
    """Where the fix goes: a bot's file or its adapter's own config, never this script."""
    adapter = bot['adapter']
    if adapter == 'codex_local':
        return "the sandbox config's writable_roots (or move the write into a folder that is one)"
    if adapter == 'opencode_local':
        return 'its bot file\'s "reads" list for a read, its edit rule for a write, then setup-bots.py'
    if adapter == 'claude_local':
        return "its settings file's permissions"
    return "the bot's own folder"


def faults(env=None, db=None, hours=6, logs=True):
    """The check. Returns a Result: .faults one line each, .gaps what no config can close, .refusals what the logs show."""
    result = Result()
    store = open_store(env, db)
    if store is None:
        result.faults.append(f"the engine's store is not at {db or os.path.join(botyard_home.places(env)['data'], 'studio.db')}: no bot's folders can be checked")
        return result
    secrets, personal = protected(env), personal_notes(env)
    for bot in bots(store):
        bot['reads'] = reads_of(bot['name'], env)
        policy = Policy(bot['adapter'], bot['config'])
        name = bot['name']
        # A run works in its job's own worktree, in the project folder: that folder is the run's, whatever the bot's own folder is.
        for ident, project, work in jobs_of(store, bot['id']):
            root = (project_folders(store, project) or [None])[0] if project else None
            policy.run_folders += [f for f in (os.path.join(root, '.botyard', 'worktrees') if root else None, work) if f]
        result.faults += [f'{name}: {problem}' for problem in policy.problems]
        cmd = bot['config'].get('command') or bot['config'].get('agentCommand')
        if cmd and os.path.isabs(cmd) and not os.path.exists(cmd):
            result.faults.append(f'{name}: its launcher {cmd} does not exist')
        for need in needs(bot, store, policy, env):
            kind, path, why = need['kind'], need['path'], need['why']
            if kind == 'none':
                result.faults.append(f'{name}: {why}')
            elif kind == 'exists':
                if not os.path.exists(path):
                    result.faults.append(f'{name}: {path} does not exist ({why})')
            elif need.get('virtual') or os.path.exists(path):
                ok = policy.write(need['probe']) if kind == 'write' else policy.read(need['probe'])
                if ok is False:
                    result.faults.append(f"{name}: cannot {kind} {path} ({why}); fix: {need.get('fix') or fix_for(bot, kind)}")
        for root in policy.roots:
            if not os.path.exists(root):
                result.faults.append(f'{name}: its sandbox names {root}, which does not exist: every shell command of the bot fails (sandbox-roots.py --fix takes it out)')
        wide(bot, policy, secrets, personal, result)
    if logs:
        result.refusals = refusals(store, env, hours)
        result.faults += summary(result.refusals)
    store.close()
    result.faults = list(dict.fromkeys(result.faults))
    result.gaps = list(dict.fromkeys(result.gaps))
    return result


def wide(bot, policy, secrets, personal, result):
    """Nothing is wider than it should be: protected paths the adapter lets the bot write, or read when nobody may. One line a bot and a verb."""
    name = bot['name']
    can_write, can_read = [], []
    for item in secrets:
        if not os.path.exists(item['path']):
            continue
        probe = os.path.join(item['path'], 'x') if os.path.isdir(item['path']) else item['path']
        if policy.write(probe) is True:
            can_write.append(item)
        if item['read'] is False:
            seen = policy.read(probe)
            if seen is True:
                can_read.append(item)
            elif seen is None:
                result.gaps.append(f"{name}: {bot['adapter']} has no rule for reading, so {item['path']} ({item['why']}) is closed to it by the guards' hooks only")
    for verb, items in (('write', can_write), ('read', can_read)):
        if items:
            groups = {}
            for i in items:
                groups.setdefault(i['why'], []).append(i['path'])
            held = [i['path'] for i in items if policy.cwd and inside(i['path'], policy.cwd)]
            result.faults.append(f"{name}: can {verb} what it must not: "
                                 + '; '.join(f"{why} ({paths[0]}{f' and {len(paths) - 1} more' if len(paths) > 1 else ''})" for why, paths in groups.items())
                                 + (f". {len(held)} of them lie inside its own folder {policy.cwd}, which a run with no project works in" if held else '')
                                 + f'; fix: {fix_wide(bot)}')
    if bot['adapter'] == 'claude_local':
        return
    for note in personal[:1]:
        seen = policy.read(note)
        if seen is True:
            result.faults.append(f"{name}: can read the owner's personal notes (e.g. {note}), which only a Claude run may; fix: {fix_wide(bot)}")
        elif seen is None:
            result.gaps.append(f"{name}: {bot['adapter']} has no rule for reading, so the owner's personal notes are closed to it by brain.py's process check only")


def fix_wide(bot):
    if bot['adapter'] == 'opencode_local':
        return 'setup-bots.py writes the denials into its OpenCode config (skill_sets.protected_denials)'
    if bot['adapter'] == 'claude_local':
        return "setup-bots.py writes the denials into its settings file (skill_sets.claude_denials)"
    if bot['adapter'] == 'codex_local':
        return 'a working folder that does not hold it, and none of it in writable_roots'
    return "keep it out of the bot's folder"


class Result:
    def __init__(self):
        self.faults, self.gaps, self.refusals = [], [], []


# ── refused calls, in a run's log ───────────────────────────────────────────────────

PATH = r"(/[^\s'\"`:()<>|]+)"
PATTERNS = [
    ('external_directory', re.compile(r'permission requested: external_directory \(([^)]+)\)[^\n]*auto-rejecting', re.I)),
    ('read-only', re.compile(r"Read-only file system:?\s*['\"]?" + PATH, re.I)),
    ('read-only', re.compile(PATH + r"['\"]?:?\s+(?:[A-Za-z ]{0,40})?Read-only file system", re.I)),
    ('writable-roots', re.compile(r'outside (?:the )?(?:sandbox(?:\'s)? )?writable roots[^\n]{0,80}?' + PATH, re.I)),
    ('writable-roots', re.compile(PATH + r'[^\n]{0,80}?(?:not (?:in|within)|outside) (?:the )?(?:sandbox(?:\'s)? )?writable roots', re.I)),
    ('mount', re.compile(r"(?:cannot|can't|unable to) mount[ `'\"]*" + PATH, re.I)),
    ('not-permitted', re.compile(r"Operation not permitted[^\n]{0,40}?" + PATH, re.I)),
    ('not-permitted', re.compile(PATH + r"['\"]?:?\s+(?:\[Errno 1\]\s*)?Operation not permitted", re.I)),
    ('denied', re.compile(r"Permission denied:?\s*['\"]?" + PATH, re.I)),
    ('denied', re.compile(PATH + r"['\"]?:?\s+(?:\[Errno 13\]\s*)?Permission denied", re.I)),
]
# The model's own words are not the tool's: a report that quotes "Read-only file system" is no refusal.
PROSE_EVENTS = ('assistant', 'agent_message', 'reasoning', 'thinking')
SKIP_KEYS = ('command', 'input', 'cmd', 'message', 'thinking')
TOOL_EVENTS = ('tool_result', 'tool_use', 'command_execution', 'tool')
WORDS = re.compile(r'auto-rejecting|Read-only file system|writable roots|mount|Operation not permitted|Permission denied', re.I)
# A path no bot's job has a say in: the package manager's lock, devices.
NOISE = re.compile(r'^/(?:var/lib/dpkg|var/cache|proc|sys|dev)(?:/|$)')


def tool_texts(event, under=False):
    """The strings of one log event that a tool made: its output and errors, not the model's words nor the command it ran."""
    if isinstance(event, str):
        yield event
    elif isinstance(event, list):
        for item in event:
            yield from tool_texts(item, under)
    elif isinstance(event, dict):
        kind = str(event.get('type') or '')
        if kind in PROSE_EVENTS or (kind == 'text' and not under):
            return
        under = under or kind in TOOL_EVENTS
        for key, value in event.items():
            if key not in SKIP_KEYS and (key != 'text' or under):
                yield from tool_texts(value, under)


def log_texts(path, limit=20_000_000):
    """Every tool-made line of a run's ndjson log, in order. A stream line that is JSON (a tool's event) is read into its strings."""
    try:
        size = os.path.getsize(path)
        with open(path, encoding='utf8', errors='replace') as f:
            if size > limit:
                f.seek(size - limit)
                f.readline()
            for row in f:
                try:
                    text = json.loads(row).get('chunk') or ''
                except (ValueError, AttributeError):
                    continue
                for line in text.split('\n'):
                    line = line.strip()
                    if line.startswith('{'):
                        try:
                            yield from (s for s in tool_texts(json.loads(line)) if s)
                            continue
                        except ValueError:
                            pass
                    if line:
                        yield line
    except OSError:
        return


def refused_in(text):
    """[(kind, path)] a tool's output says it was refused."""
    out = []
    for line in str(text).split('\n'):
        # Only the stretch around a word that says "refused" is read: a log line can be a megabyte of minified code.
        spans = [line[max(0, m.start() - 300):m.end() + 300] for m in WORDS.finditer(line)] if len(line) > 600 else [line]
        for blob in spans if WORDS.search(line) else []:
            for kind, rx in PATTERNS:
                for m in rx.finditer(blob):
                    path = re.sub(r'/\*$', '', m.group(1)) if kind == 'external_directory' else m.group(1).rstrip('.,;)*').rstrip('/')
                    if path.startswith('/') and not NOISE.match(path):
                        out.append((kind, path))
    return out


def scan_log(path):
    """What one run's log holds: ([(kind, path)], whether the last tool output of the run was a refusal)."""
    found, last = [], False
    try:   # most logs hold none of the words: they are not parsed
        with open(path, encoding='utf8', errors='replace') as f:
            if not WORDS.search(f.read(40_000_000)):
                return found, last
    except OSError:
        return found, last
    for text in log_texts(path):
        hit = refused_in(text)
        found += hit
        last = bool(hit)
    return found, last


def refusals(db, env=None, hours=6, now=None):
    """Every refusal in the runs of the last `hours`: [{agent, adapter, run, job, kind, path, silent, started}]. A run that ended with exit 0, no report
    and no comment of its own, whose last tool call was refused, is `silent`: a success that did nothing."""
    now = now or time.time()
    cutoff = time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(now - hours * 3600))
    logs = botyard_home.places(env)['run_logs']
    names = dict(db.execute('SELECT id, name FROM agents'))
    adapters = dict(db.execute('SELECT id, adapter_type FROM agents'))
    out = []
    for rid, agent, job, status, started, ref, result, code in db.execute(
            'SELECT id, agent_id, job_id, status, started_at, log_ref, result_json, exit_code FROM runs WHERE started_at >= ? AND log_ref IS NOT NULL ORDER BY started_at', (cutoff,)).fetchall():
        found, last = scan_log(os.path.join(logs, ref))
        if not found:
            continue
        said = (_json(result).get('summary') or '').strip()
        spoke = db.execute('SELECT 1 FROM comments WHERE created_by_run_id = ? AND deleted_at IS NULL LIMIT 1', (rid,)).fetchone()
        silent = status == 'succeeded' and code in (0, None) and not said and not spoke and last
        for kind, path in sorted(set(found)):
            out.append({'agent': names.get(agent, agent), 'adapter': adapters.get(agent, ''), 'run': rid, 'job': job, 'kind': kind, 'path': path, 'silent': silent, 'started': started})
    return out


def summary(found):
    """One line per bot: how many runs were refused, where, and how many ended with exit 0 and no report."""
    by = {}
    for row in found:
        by.setdefault(row['agent'], []).append(row)
    lines = []
    for agent, rows in sorted(by.items()):
        counts = {}
        for row in rows:
            counts[(row['path'], row['kind'])] = counts.get((row['path'], row['kind']), 0) + 1
        top = ', '.join(f'{p} ({k}, {n})' for (p, k), n in sorted(counts.items(), key=lambda x: -x[1])[:4])
        silent = len({r['run'] for r in rows if r['silent']})
        lines.append(f"{agent}: refused in {len({r['run'] for r in rows})} run(s), most at {top}"
                     + (f"; {silent} of them ended with exit 0 and no report" if silent else ''))
    return lines


def fixed_by(kind, adapter):
    """The phrase a job is told: what fixes this kind of refusal."""
    if kind == 'external_directory' or adapter == 'opencode_local':
        return 'the "reads" list of its bot file'
    if kind in ('read-only', 'writable-roots', 'mount'):
        return "the sandbox config's writable_roots, or moving the write into a folder that is one"
    return "the bot's folder rules"
