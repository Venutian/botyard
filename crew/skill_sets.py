"""Which of the PC's skills each bot is given, and the files that give them.

Every skill on this PC is found here: the owner's ~/.claude/skills,
the Claude plugins switched on, and the skills of the studio's projects. Claude Code and
OpenCode both read ~/.claude/skills by themselves, so without this every bot sees all of them (often hundreds)
on every run: each one's line costs tokens, and past Claude's listing budget the descriptions are cut short,
so the skills a bot does need were the hardest to pick out. A bot whose settings file lists its skills sees only those:

- a Claude bot gets its own settings file (claude-bot.sh reads BOTYARD_BOT_SETTINGS): the crew's hooks,
  skillOverrides "off" for every skill not in its set, and enabledPlugins false for plugins it does not use;
- an OpenCode bot gets its own OpenCode config (OPENCODE_CONFIG): skill permission deny for everything but
  its set, and the folders of the plugin skills it needs, which OpenCode does not find on its own.

The skills are not imported into the engine's skill library: the engine writes one line per library skill into
every Claude bot's prompt (its "Company skill library" list), thousands of tokens a run.
Botyard's Library reads skills-index.json instead, written here, which also says who has each skill.

A skill added to the PC later is seen by every bot until setup-bots.py runs again.
"""
import json
import os
import re
import uuid
import sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import botyard_home  # noqa: E402

HOME = os.path.expanduser('~')
DIR = botyard_home.crew_dir()
OUT = f'{DIR}/bot-skills'
INDEX = f'{DIR}/skills-index.json'
USER_SKILLS = f'{HOME}/.claude/skills'
PROJECTS = botyard_home.projects()
# Test fixtures of code we did not write are not the studio's skills.
NOT_PROJECTS = ('untrusted',)

# What no bot is given, and why, as a studio's own list: [["^regex", "why"], ...] in its own folder.
# Shown in Botyard next to each skill, so the owner can see it was a choice.
LEFT_OUT_FILE = f'{DIR}/own/skills-left-out.json'
LEFT_OUT_OTHER = 'No bot of this studio is given it. Add it to a bot\'s "skills" to give it.'


def sets():
    """Each bot's own skills, by the bot's name: the "skills" list in its settings file. A bot whose
    file says "all" is not here and sees every skill."""
    import crew_set
    files = crew_set.CrewSet()
    out = {}
    for slug in files.slugs():
        spec = files.spec(slug)
        if isinstance(spec.get('skills'), list):
            out[spec['name']] = set(spec['skills'])
    return out


def left_out():
    try:
        with open(LEFT_OUT_FILE, encoding='utf8') as f:
            return [(re.compile(pattern), why) for pattern, why in json.load(f)]
    except (OSError, ValueError, re.error):
        return []


def _description(text):
    m = re.search(r'^description:\s*(.*?)(?=^[\w-]+:|^---)', text, re.S | re.M)
    return re.sub(r'\s+', ' ', m.group(1) if m else '').strip(' |>"\'')


def _skill(path, kind, source, plugin=None):
    try:
        text = open(f'{path}/SKILL.md', encoding='utf8', errors='replace').read()
    except OSError:
        return None
    files = []
    for root, dirs, names in os.walk(path):
        dirs[:] = sorted(d for d in dirs if not d.startswith('.') and d != 'node_modules')
        for n in sorted(names):
            if not n.startswith('.'):
                files.append(os.path.relpath(f'{root}/{n}', path))
        if len(files) >= 100:
            break
    files.sort(key=lambda f: (f != 'SKILL.md', f))
    return {'name': os.path.basename(path.rstrip('/')), 'kind': kind, 'source': source, 'plugin': plugin,
            'dir': os.path.realpath(path), 'description': _description(text), 'files': files[:100]}


def _plugins():
    """The Claude plugins the owner has switched on, with their install folders."""
    try:
        on = json.load(open(f'{HOME}/.claude/settings.json')).get('enabledPlugins') or {}
        installed = json.load(open(f'{HOME}/.claude/plugins/installed_plugins.json')).get('plugins') or {}
    except (OSError, ValueError):
        return {}
    return {key: entries[0]['installPath'] for key, entries in installed.items()
            if on.get(key) and entries and entries[0].get('installPath')}


def inventory():
    """Every skill on the PC, user skills first; a project copy of a user skill is not listed twice."""
    seen, out = set(), []
    if os.path.isdir(USER_SKILLS):
        for name in sorted(os.listdir(USER_SKILLS)):
            s = _skill(f'{USER_SKILLS}/{name}', 'user', '~/.claude/skills')
            if s:
                out.append(s)
                seen.add(s['name'])
    for key, path in sorted(_plugins().items()):
        # A plugin's skills are in skills/<name>/, or the plugin is one skill at its root folder.
        dirs = [f'{path}/skills/{n}' for n in sorted(os.listdir(f'{path}/skills'))] if os.path.isdir(f'{path}/skills') else \
            [f'{path}/{n}' for n in sorted(os.listdir(path)) if os.path.isfile(f'{path}/{n}/SKILL.md')]
        for d in dirs:
            s = _skill(d, 'plugin', f'plugin {key.split("@")[0]}', plugin=key)
            if s:
                out.append(s)
    if os.path.isdir(PROJECTS):
        for project in sorted(os.listdir(PROJECTS)):
            base = f'{PROJECTS}/{project}/.claude/skills'
            if project in NOT_PROJECTS or not os.path.isdir(base):
                continue
            for name in sorted(os.listdir(base)):
                if name in seen:
                    continue
                s = _skill(f'{base}/{name}', 'project', f'project {project}')
                if s:
                    out.append(s)
                    seen.add(s['name'])
    return out


def why_left_out(name, rules=None):
    for pattern, why in (left_out() if rules is None else rules):
        if pattern.search(name):
            return why
    return LEFT_OUT_OTHER


def _slug(bot):
    return bot.lower().replace(' ', '-')


def brain_denials(env=None):
    """OpenCode permission rules that keep the owner's personal notes (crew/brain.py says which) from a model
    run under OpenCode, whose words may go to a third party: no read, search, list or edit of a personal folder
    or a private note, no shell command that names one, and no edit anywhere in the notes. {} with no notes."""
    import brain
    root = brain.folder(env)
    if not root or not os.path.isdir(root):
        return {}
    every = brain.notes(root)
    tops = sorted({n[1].split(os.sep)[0] for n in every if n[4] and os.sep in n[1] and n[1].split(os.sep)[0].lower() not in brain.WORK_FOLDERS})
    tops += sorted(d for d in os.listdir(root) if d.lower() in brain.PERSONAL and os.path.isdir(os.path.join(root, d)) and d not in tops)
    files = sorted(os.path.join(root, n[1]) for n in every if n[4] and n[1].split(os.sep)[0] not in tops)
    # OpenCode matches a read or a search against the path from the run's worktree (`../../notes/life/x.md`),
    # so each rule is written to match from anywhere: the vault's own folder name, then the personal part.
    name = os.path.basename(root.rstrip('/'))
    paths = [p for t in tops for p in (f'{root}/{t}/*', f'*{name}/{t}/*', f'*{name}/{t}')] + [p for f in files for p in (f, '*' + name + '/' + os.path.relpath(f, root))]
    if not paths:
        return {'edit': {'*': 'allow', f'{root}/*': 'deny', f'*{name}/*': 'deny'}}
    deny = {'*': 'allow', **{p: 'deny' for p in paths}}
    # Named by the vault's own path only: a bare `*money/*` refused every command on a folder that merely has the
    # same name (pages/money, a lifecycle/ folder), 19 Nov 2026.
    shell = {'*': 'allow', **{f'*{os.path.join(root, t)}*': 'deny' for t in tops}, **{f'*{name}/{t}*': 'deny' for t in tops},
             **{f'*{os.path.basename(f)}*': 'deny' for f in files}}
    # A search names a pattern, not a folder, so the whole vault is kept outside the run (OpenCode's
    # external_directory, where anything else outside the worktree is asked, which an unattended run refuses),
    # and a shell command that names the vault is refused: the bots read work notes through brain.py.
    shell.update({f'*{root}*': 'deny', f'*{name}/*': 'deny'})
    outside = {'*': 'deny', root: 'deny', f'{root}/*': 'deny'}
    return {'read': deny, 'glob': deny, 'grep': deny, 'list': deny, 'edit': {**deny, f'{root}/*': 'deny', f'*{name}/*': 'deny'}, 'bash': shell, 'external_directory': outside}


def read_only(perm, reads, own=None):
    """The OpenCode permissions with the bot's `reads` folders opened for reading: outside its own folder OpenCode asks,
    and an unattended run refuses, so a bot that judges a product could not open the product (18 Nov: the scout's
    judge job read nothing and ended, every 30 minutes). Its edit tool stays refused there, and the owner's notes stay
    closed whatever `reads` says."""
    folders = [os.path.realpath(os.path.expanduser(f)).rstrip('/') for f in (reads or []) if isinstance(f, str) and f.strip()]
    if not folders:
        return perm
    perm = {k: (dict(v) if isinstance(v, dict) else v) for k, v in perm.items()}
    closed = {k: v for k, v in (perm.get('external_directory') or {}).items() if v == 'deny'}
    outside = {'*': 'deny', **{p: 'allow' for f in folders for p in (f, f'{f}/*')}, **closed}
    edit = perm.get('edit') if isinstance(perm.get('edit'), dict) else {'*': 'allow'}
    mine = os.path.realpath(os.path.expanduser(own)).rstrip('/') if own else ''
    # The bot's own folder stays its to edit, even inside a folder it only reads.
    # A job is worked in its own worktree (<repo>/.botyard/worktrees/<job>), which lies inside the folder a bot only reads when that is a
    # projects folder: those stay editable, or a job given to the bot would find every edit refused.
    trees = {p: 'allow' for f in folders for p in (f'{f}/.botyard/worktrees/*', f'{f}/*/.botyard/worktrees/*')}
    closed = {k: v for k, v in edit.items() if v == 'deny'}
    edit = {**{k: v for k, v in edit.items() if k not in closed}, **{f'{f}/*': 'deny' for f in folders}, **trees,
            **({mine: 'allow', f'{mine}/*': 'allow'} if mine else {}), **closed}
    return {**perm, 'external_directory': outside, 'edit': edit}


def job_skill_folder():
    """The folder of the job-closing skill, which every bot's rules send it to (crew/codex-safe/skills/botyard): read, never edited."""
    folder = os.path.join(botyard_home.places()['crew'], 'codex-safe', 'skills', 'botyard')
    return [folder] if os.path.isdir(folder) else []


def protected_denials(env=None):
    """OpenCode permission rules for what no bot may have (folders.protected: the keys, the owner's token, the guards' own files, the studio's
    "never" list): no edit of any of them, no read, search or list of those nobody may read. The owner's notes are brain_denials'."""
    import folders
    items = [i for i in folders.protected(env) if i['kind'] != 'notes' and os.path.exists(i['path'])]
    if not items:
        return {}
    edit = {p: 'deny' for i in items for p in (i['path'], f"{i['path']}/*")}
    read = {p: 'deny' for i in items if i['read'] is False for p in (i['path'], f"{i['path']}/*")}
    out = {'edit': {'*': 'allow', **edit}}
    if read:
        out.update({tool: {'*': 'allow', **read} for tool in ('read', 'glob', 'grep', 'list')})
        out['external_directory'] = {'*': 'deny', **read}
    return out


def merged(*perms):
    """OpenCode permission sets laid one over the next: each tool's rules keep their order, and a later set's rules come after, so they win."""
    out = {}
    for perm in perms:
        for tool, rules in perm.items():
            if isinstance(out.get(tool), dict) and isinstance(rules, dict):
                out[tool] = {**out[tool], **{k: v for k, v in rules.items() if k != '*'}}
            else:
                out[tool] = dict(rules) if isinstance(rules, dict) else rules
    return out


def scratch_open(perm):
    """The run's own scratch folder (the engine's botyard-run-* folder under the temporary folder, where TMPDIR points and OpenCode keeps its
    settings) opened outside the run's folder: a refusal there stopped runs (18 Nov: 68 free-model runs were refused in it or in /tmp)."""
    import tempfile
    mine = perm.get('external_directory') if isinstance(perm.get('external_directory'), dict) else {'*': 'deny'}
    scratch = {p: 'allow' for t in sorted({'/tmp', tempfile.gettempdir()}) for p in (f'{t}/botyard-run-*', f'{t}/botyard-run-*/*')}
    closed = {k: v for k, v in mine.items() if v == 'deny'}
    opened = {k: v for k, v in mine.items() if v == 'allow'}
    return {**perm, 'external_directory': {'*': mine.get('*', 'deny'), **opened, **scratch, **closed}}


def claude_denials(env=None):
    """permissions.deny rules for a Claude bot's settings file: no edit of what no bot may have (as protected_denials), no read of
    what nobody may read, and no edit of the owner's notes (a Claude run may read them, never write)."""
    import folders
    deny = []
    for item in folders.protected(env):
        if not os.path.exists(item['path']):
            continue
        spec = '/' + item['path'] + ('/**' if os.path.isdir(item['path']) else '')
        deny.append(f'Edit({spec})')
        if item['read'] is False:
            deny.append(f'Read({spec})')
    return sorted(set(deny))


def folder_aliases(folder=None):
    """[(alias, target)]: the folders in the crew's own folder that are links to another folder (a link named own may point at the
    studio's own scripts folder). OpenCode matches its rules on the path a bot names, so a rule on the target does not cover the link."""
    folder = folder or botyard_home.places()['crew']
    out = []
    for name in sorted(os.listdir(folder)) if os.path.isdir(folder) else []:
        alias = os.path.join(folder, name)
        if os.path.islink(alias) and os.path.isdir(alias):
            out.append((alias, os.path.realpath(alias)))
    return out


def with_aliases(perm, aliases):
    """The permissions with every path rule that covers a linked folder's target said again for the link, right after it, so the
    order (the last match wins) holds for both: an allowed folder is allowed through its link, and a refused file inside it stays refused.
    21 Nov 2026: one bot's brief named its skills through such a link, which only the target was allowed under, and every run for a
    day was refused them and ended without a word."""
    if not aliases:
        return perm
    out = {}
    for tool, rules in perm.items():
        if tool == 'bash' or not isinstance(rules, dict):
            out[tool] = rules
            continue
        said = {}
        for key, value in rules.items():
            said[key] = value
            if not key.startswith('/'):
                continue
            for alias, target in aliases:
                if key == target or key.startswith(target + '/'):
                    said.setdefault(alias + key[len(target):], value)
                elif key.endswith('/*') and (target + '/').startswith(key[:-1]):
                    # A parent folder's rule covers the whole link.
                    said.setdefault(alias, value)
                    said.setdefault(f'{alias}/*', value)
        out[tool] = said
    return out


def write_for(bot, adapter, skills=None, want=None, reads=None, own=None):
    """Writes the bot's settings file and returns the env entries that point its runs at it: the skills it sees (`want` is the bot's own
    list of names, from its settings file; with none it is asked from the files, and a bot whose file says "all" sees every skill) and what
    it may not touch (the keys, the guards' files, the owner's notes), which every Claude and OpenCode bot gets whatever its skills are.
    {} for an AI that reads neither."""
    if adapter not in ('claude_local', 'opencode_local'):
        return {}
    if want is None:
        want = sets().get(bot)
    every = want is None
    skills = skills if skills is not None else (inventory() if not every else [])
    want = set(want or ())
    os.makedirs(OUT, exist_ok=True)
    plain = lambda value: {'type': 'plain', 'value': value}
    if adapter == 'claude_local':
        with open(f'{os.path.dirname(os.path.realpath(__file__))}/bot-settings.json') as f:
            base = json.load(f)
        off = {} if every else {s['name']: 'off' for s in skills if s['kind'] != 'plugin' and s['name'] not in want}
        plugins = {}
        for s in ([] if every else skills):
            if s['kind'] == 'plugin':
                plugins[s['plugin']] = plugins.get(s['plugin'], False) or s['name'] in want
        path = f'{OUT}/{_slug(bot)}.claude.json'
        deny = sorted(set((base.get('permissions') or {}).get('deny', []) + claude_denials()))
        out = {**base, **({'permissions': {**(base.get('permissions') or {}), 'deny': deny}} if deny else {})}
        if not every:
            out.update({'skillOverrides': dict(sorted(off.items())), 'enabledPlugins': plugins})
        with open(path, 'w') as f:
            json.dump(out, f, indent=1)
        return {'BOTYARD_BOT_SETTINGS': plain(path)}
    # OpenCode: hide every skill but the set; add the folders of the plugin skills it needs.
    folders = sorted({os.path.dirname(s['dir']) for s in skills if s['kind'] == 'plugin' and s['name'] in want})
    config = {'$schema': 'https://opencode.ai/config.json',
              'permission': {**({} if every else {'skill': {'*': 'deny', **{n: 'allow' for n in sorted(want)}}}),
                             **with_aliases(scratch_open(read_only(merged(brain_denials(), protected_denials()), [*(reads or []), *job_skill_folder()], own)),
                                            folder_aliases())}}
    if folders:
        config['skills'] = {'paths': folders}
    # The free providers OpenCode does not know itself (free-providers.json), so the bot can be started on their models.
    if botyard_home.opencode_providers():
        config['provider'] = botyard_home.opencode_providers()
    path = f'{OUT}/{_slug(bot)}.opencode.json'
    with open(path, 'w') as f:
        json.dump(config, f, indent=1)
    return {'OPENCODE_CONFIG': plain(path)}


def check(skills=None, given=None):
    """Names in a bot's list that are not on the PC: a renamed or removed skill. The crew's own skills
    are put in place by the seed, so they are never missing."""
    names = {s['name'] for s in (skills if skills is not None else inventory())}
    for own in (botyard_home.source('skills'), f'{DIR}/own/skills'):
        names |= {name for name in (os.listdir(own) if os.path.isdir(own) else []) if os.path.isfile(f'{own}/{name}/SKILL.md')}
    given = sets() if given is None else given
    return {bot: sorted(want - names) for bot, want in given.items() if want - names}


def write_index(skills=None, given=None):
    """skills-index.json for Botyard's Library: every skill, who has it, or why nobody does."""
    skills = skills if skills is not None else inventory()
    given = sets() if given is None else given
    rules = left_out()
    rows = []
    for s in skills:
        bots = sorted(bot for bot, want in given.items() if s['name'] in want)
        rows.append({**s, 'id': str(uuid.uuid5(uuid.NAMESPACE_URL, f'botyard-skill:{s["dir"]}')), 'bots': bots,
                     'everyBot': bool(given) and len(bots) == len(given),
                     'leftOut': '' if bots or not given else why_left_out(s['name'], rules)})
    tmp = f'{INDEX}.tmp'
    with open(tmp, 'w') as f:
        json.dump({'skills': rows}, f, indent=1)
    os.replace(tmp, INDEX)
    return rows


if __name__ == '__main__':
    skills = inventory()
    given = sets()
    rows = write_index(skills, given)
    print(f'{len(rows)} skills on this PC')
    for bot, want in given.items():
        print(f'{bot:20} {len(want & {s["name"] for s in skills})}')
    for bot, gone in check(skills, given).items():
        print(f'{bot}: not on this PC: {", ".join(gone)}')
