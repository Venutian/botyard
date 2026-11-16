"""A crew as files: reads the studio's bots and works out what each bot is given, its settings for
the engine and its instructions as text.

    crew/bots/crew.json          the crew: the studio's name, the lead, the order, places
    crew/bots/<slug>.json        one bot's settings
    crew/bots/<slug>.md          its instructions, a template
    crew/bots/shared/<name>.md   paragraphs several bots share

The repository ships one crew, in crew/bots. A studio's own is in `$BOTYARD_HOME/crew/bots/` and wins:
an `.md` there replaces the repository's whole, a `.json` is laid over it and need hold only what
differs, a bot that is only there is the studio's own, and a `crew.json` there that lists `bots` makes
exactly those the studio's crew.

In a template, and nothing else is special:
    {{shared: long-jobs}}   the text of shared/long-jobs.md, without its last newline
    {{note}}                the shared note for the AI the bot runs on now (the bot's "notes")
    {{name}} {{title}} {{studio}}
    {{home}} {{crew}} {{crew~}} {{own}} {{own~}} {{projects}} {{projects~}}   folders (~ is the home folder written short)
    {{finish}}              the command that closes a job; {{skill}} is the folder of the skill it comes from
    {{$JOB_ID}}             a run variable, as the bot's shell knows it
    {{crew-ids}}            the line listing every bot's id
and any name under "places" in crew.json.

What depends on the moment stays code and reads this data: which free model a bot starts on, and
where a bot thinks while its own AI is out of its limit (setup-bots.py).
"""
import json
import os
import re

import botyard_home

AIS = {'claude': 'claude_local', 'codex': 'codex_local', 'gemini': 'gemini_local', 'free': 'opencode_local'}
AI_OF = {adapter: ai for ai, adapter in AIS.items()}

DENY_ALWAYS = ','.join([
    'Bash(git push:*)', 'Bash(git merge:*)', 'Bash(git rebase:*)', 'Bash(git reset --hard:*)',
    'Bash(git clean:*)', 'Bash(git worktree remove:*)', 'Bash(rm -rf:*)', 'Bash(sudo:*)',
    'Bash(npm publish:*)', 'Bash(eas submit:*)', 'Bash(gh:*)',
])
# A Claude bot that builds (role builder, free to edit) works in its job's own worktree and branch, and
# must be able to bring another branch into it (a merge job, or catching up with main). It may merge,
# fetch and abort a merge there; every other deny stays, and push is still blocked for good by no_push().
MERGE = 'Bash(git merge:*)'
ALLOW_MERGE = ','.join([MERGE, 'Bash(git fetch:*)', 'Bash(git merge --abort)'])
DENY_REVIEW = DENY_ALWAYS + ',Edit,Write,NotebookEdit,Bash(git commit:*)'

# Every Antigravity model the plan offers, in the order a bot falls back on them after its own: all
# of them are used up before a bot moves to Claude. Gemini has one allowance, and the Claude and GPT
# models share another; agy-acp.py skips a model that is used up or gone (Opus 4.6, Sonnet 4.6 and
# GPT-OSS retire on 2026-11-18).
ANTIGRAVITY = ['gemini-3.8-flash-high', 'claude-opus-4-6-thinking', 'claude-sonnet-4-6', 'gemini-3.8-flash-medium',
               'gemini-3.8-flash-low', 'gpt-oss-120b-medium']
# A Codex bot with no "fallbacks" of its own, by the Codex model it runs on.
GEMINI_MODELS = {'gpt-6.1-sol': 'gemini-3.8-flash-high', 'gpt-6-luna': 'gemini-3.8-flash-medium'}
# Where a bot thinks when its file does not say, while its own AI is out. On Claude it is a reviewer:
# it cannot edit files or commit.
FALLBACK = {'gemini': {}, 'claude': {'model': 'claude-haiku-5-5', 'effort': 'medium', 'turns': 80, 'minutes': 45,
                                     'mayNot': ['push', 'edit']}}

# A job's folder is a worktree, which Codex does not take for a repository of its own.
CODEX_ARGS = ['--skip-git-repo-check']

HEARTBEAT = {'enabled': False, 'wakeOnDemand': True, 'maxConcurrentRuns': 1, 'cooldownSec': 10}
SLUG = re.compile(r'^[a-z0-9][a-z0-9-]*$')
# What a bot is in the crew, and the engine's own word for it.
ROLES = {'lead': 'ceo', 'builder': 'engineer', 'checker': 'qa', 'reviewer': 'qa', 'ruler': 'qa', 'researcher': 'researcher',
         'general': 'general'}
INCLUDE = re.compile(r'\{\{shared: ([a-z0-9-]+)\}\}')
DEFAULTS = {'role': 'general', 'tier': 'strong', 'look': {}, 'title': '', 'does': '', 'reportsTo': None, 'model': 'auto', 'effort': 'medium', 'minutes': 60,
            'turns': None, 'mayNot': ['push'], 'atOnce': 1, 'freshChat': None, 'folder': None, 'skills': 'all',
            'variables': [], 'on': True}


def slug_of(name):
    return re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')


def plain(value):
    return {'type': 'plain', 'value': value}


def read_json(path, empty=None):
    try:
        with open(path, encoding='utf8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return empty


def read_text(path):
    try:
        with open(path, encoding='utf8') as f:
            return f.read()
    except OSError:
        return None


def own_dir(env=None):
    """A studio's own copies of its bots."""
    return os.path.join(botyard_home.places(env)['crew'], 'bots')


class Places:
    """The folders and commands a bot's settings and instructions name. A test gives its own."""

    def __init__(self, env=None, **given):
        env = os.environ if env is None else env
        self.home = given.get('home') or botyard_home.user_home(env)
        self.crew = given.get('crew') or botyard_home.places(env)['crew']
        self.projects = given.get('projects') or botyard_home.projects(env)
        self.path = given.get('path') or botyard_home.bot_path(env)
        self.codex = given.get('codex') or botyard_home.tool('codex', env) or 'codex'
        self.own = f'{self.crew}/own'
        self.safe = f'{self.crew}/codex-safe'
        # The job-closing skill and its script, as crew/skills has them.
        self.skill = f'{self.safe}/skills/botyard'
        self.finish = f'bash {self.skill}/scripts/job-update.sh'

    def short(self, path):
        return '~' + path[len(self.home):] if path == self.home or path.startswith(self.home + '/') else path


class PaidEngine(ValueError):
    """A script tried to put a free-model bot on a paid engine."""


class CrewSet:
    def __init__(self, env=None, places=None, own=None, repo_dir=None):
        self.dir = repo_dir or botyard_home.source('bots')
        # A test, or a look at the repository's crew alone, passes own='' for "no copies of the studio's own".
        self.own = own_dir(env) if own is None else own
        self.places = places or Places(env)
        mine = (read_json(os.path.join(self.own, 'crew.json')) or {}) if self.own else {}
        self.crew = {**(read_json(os.path.join(self.dir, 'crew.json')) or {}), **mine}
        # A studio that lists its own bots has exactly those; else the repository's, and any it added.
        self.listed_by_studio = bool(mine.get('bots'))
        if not self.slugs():
            raise SystemExit(f'No crew found in {self.dir}: it needs a crew.json and one .json and .md a bot.')

    # ── reading ──────────────────────────────────────────────────────────────────────
    def _files(self, name):
        """The studio's own copy and the repository's, each None when there is none."""
        return (os.path.join(self.own, name) if self.own else None), os.path.join(self.dir, name)

    def slugs(self):
        """Every bot of the set in seeding order, then the bots only this studio has."""
        listed = list(self.crew.get('bots') or [])
        extra = []
        for folder in ((self.own,) if self.listed_by_studio else (self.dir, self.own)):
            if folder and os.path.isdir(folder):
                for file in sorted(os.listdir(folder)):
                    slug = file[:-5]
                    if file.endswith('.json') and file != 'crew.json' and SLUG.match(slug) and slug not in listed + extra:
                        extra.append(slug)
        return listed + extra

    def overlay(self, slug):
        """What the studio's own <slug>.json holds: only what differs from the repository's."""
        own, _ = self._files(f'{slug}.json')
        return (read_json(own) or {}) if own else {}

    def spec(self, slug):
        """A bot's settings: the repository's, with the studio's own laid over them."""
        _, repo = self._files(f'{slug}.json')
        base, over = read_json(repo) or {}, self.overlay(slug)
        if not base and not over:
            raise SystemExit(f'There is no bot "{slug}" in {self.dir} or {self.own}.')
        spec = {**DEFAULTS, **base, **over}
        spec['fallbacks'] = {ai: {**(base.get('fallbacks') or {}).get(ai, {}), **(over.get('fallbacks') or {}).get(ai, {})}
                             for ai in {*(base.get('fallbacks') or {}), *(over.get('fallbacks') or {})}}
        spec['slug'] = slug
        if not spec.get('name') or spec.get('ai') not in AIS:
            raise SystemExit(f'{slug}.json needs a "name" and an "ai" that is one of: {", ".join(AIS)}.')
        if spec['role'] not in ROLES:
            raise SystemExit(f'{slug}.json: "role" is one of: {", ".join(ROLES)}.')
        return spec

    def sources(self, slug):
        """Where each of the bot's files came from, for Botyard's editor."""
        out = {}
        for kind in ('json', 'md'):
            own, repo = self._files(f'{slug}.{kind}')
            out[kind] = {'own': own if own and os.path.isfile(own) else None, 'default': repo if os.path.isfile(repo) else None}
        return out

    def template(self, slug):
        own, repo = self._files(f'{slug}.md')
        text = (read_text(own) if own else None)
        return text if text is not None else (read_text(repo) or '')

    def shared(self, name):
        own, repo = self._files(os.path.join('shared', f'{name}.md'))
        text = (read_text(own) if own else None)
        text = text if text is not None else read_text(repo)
        if text is None:
            raise SystemExit(f'shared/{name}.md is named in a bot\'s instructions but is not in {self.dir}/shared.')
        return text[:-1] if text.endswith('\n') else text

    def shared_names(self):
        names = set()
        for folder in (self.dir, self.own):
            if folder and os.path.isdir(os.path.join(folder, 'shared')):
                names |= {f[:-3] for f in os.listdir(os.path.join(folder, 'shared')) if f.endswith('.md')}
        return sorted(names)

    def by_name(self, name):
        return next((slug for slug in self.slugs() if self.spec(slug)['name'] == name), None)

    def with_role(self, *roles, ai=None, tier=None):
        """The bots that are this in the crew, in seeding order: with_role('builder', ai='free')."""
        out = []
        for slug in self.slugs():
            spec = self.spec(slug)
            if spec['role'] in roles and (ai is None or spec['ai'] == ai) and (tier is None or spec['tier'] == tier):
                out.append(slug)
        return out

    # ── a bot on an AI ───────────────────────────────────────────────────────────────
    # STANDARDS.md rule 22: a bot whose file says "ai": "free" never falls back to a paid engine (Antigravity,
    # Codex, Claude) for its work: its "fallbacks" are for a person to ask for on purpose, never for a script.
    paid_by_hand = False

    def on(self, slug, ai=None):
        """The bot's settings as they hold on `ai`: its own AI when none is given, else its "fallbacks"."""
        spec = self.spec(slug)
        ai = ai or spec['ai']
        if ai == spec['ai']:
            return spec
        if spec['ai'] == 'free' and not self.paid_by_hand:
            raise PaidEngine(f"{spec['name']} runs on free models only: it is never moved to {ai} by a script (STANDARDS.md rule 22).")
        over = {**FALLBACK.get(ai, {}), **spec['fallbacks'].get(ai, {})}
        if ai == 'gemini' and 'model' not in over:
            over['model'] = GEMINI_MODELS.get(spec['model'], ANTIGRAVITY[0])
        return {**spec, **over, 'ai': ai}

    # ── instructions ─────────────────────────────────────────────────────────────────
    def marks(self, spec, crew_ids=''):
        p = self.places
        marks = {'name': spec['name'], 'title': spec['title'], 'studio': self.crew.get('studio', 'this studio'),
                 'finish': p.finish, 'skill': p.skill, 'crew-ids': crew_ids}
        folders = {'home': p.home, 'crew': p.crew, 'own': p.own, 'projects': p.projects}
        for name, value in (self.crew.get('places') or {}).items():
            folders[name] = self._fill(value, {**folders, 'crew~': p.short(p.crew), 'own~': p.short(p.own), 'projects~': p.short(p.projects)})
        for name, value in list(folders.items()):
            if name != 'home':
                folders[name + '~'] = p.short(value)
        return {**marks, **folders, **{'$' + what: '$' + botyard_home.var_name(what) for what in botyard_home.RUN_VARS}}

    @staticmethod
    def _fill(text, marks):
        return re.sub(r'\{\{([^{}\n]+)\}\}', lambda m: marks[m[1]] if m[1] in marks else m[0], text)

    def note(self, spec):
        name = (spec.get('notes') or {}).get(spec['ai'])
        return self.shared(name) if name else ''

    def render(self, slug, ai=None, crew_ids=''):
        """The bot's instructions as text, exactly as the bot is given them."""
        spec = self.on(slug, ai)
        text = INCLUDE.sub(lambda m: self.shared(m[1]), self.template(slug))
        text = text.replace('{{note}}', self.note(spec))
        return self._fill(text, self.marks(spec, crew_ids))

    def unrender(self, slug, text, ai=None, crew_ids=''):
        """A bot's instructions as text, back into a template: what the owner changed in Botyard stays as
        they wrote it, and every shared paragraph still whole goes back in as its {{shared: ...}} line."""
        spec = self.on(slug, ai)
        marks = self.marks(spec, crew_ids)
        note_name = (spec.get('notes') or {}).get(spec['ai'])
        if note_name:
            text = text.replace(self._fill(self.shared(note_name), marks), '{{note}}', 1)
        notes = set((spec.get('notes') or {}).values())
        whole = sorted(((self._fill(self.shared(name), marks), name) for name in self.shared_names() if name not in notes),
                       key=lambda pair: -len(pair[0]))
        for rendered, name in whole:
            if len(rendered) > 40:
                text = text.replace(rendered, '{{shared: %s}}' % name)
        if crew_ids:
            text = text.replace(crew_ids, '{{crew-ids}}')
        head = f"You are {spec['name']}, {spec['title']} at {marks['studio']}."
        if text.startswith(head):
            text = 'You are {{name}}, {{title}} at {{studio}}.' + text[len(head):]
        text = text.replace(marks['finish'], '{{finish}}').replace(marks['skill'], '{{skill}}')
        # Folders, longest first, so a folder inside another is named by its own mark.
        folders = sorted(((value, name) for name, value in marks.items()
                          if name in ('home', 'crew', 'crew~', 'own', 'own~', 'projects', 'projects~') or name.rstrip('~') in (self.crew.get('places') or {})),
                         key=lambda pair: (-len(pair[0]), pair[1]))
        for value, name in folders:
            if len(value) > 3:
                text = re.sub(re.escape(value) + r'(?![\w.-])', '{{%s}}' % name, text)
        for what in botyard_home.RUN_VARS:
            text = re.sub(re.escape('$' + botyard_home.var_name(what)) + r'\b', '{{$%s}}' % what, text)
        return text

    # ── settings ─────────────────────────────────────────────────────────────────────
    def no_push(self):
        """The real block: every bot runs with no way to authenticate to GitHub. The deny lists only
        catch honest mistakes."""
        safe = self.places.safe
        return {'GIT_CONFIG_GLOBAL': plain(f'{safe}/gitconfig'), 'GH_CONFIG_DIR': plain(f'{safe}/gh-empty'),
                'GIT_TERMINAL_PROMPT': plain('0')}

    def claude_tools(self, spec, may_not):
        """The tool rules of a Claude bot: --disallowedTools, and for a builder that may edit, the merge allow too."""
        if 'edit' in may_not:
            return ['--disallowedTools', DENY_REVIEW]
        if spec.get('role') == 'builder':
            deny = ','.join(d for d in DENY_ALWAYS.split(',') if d != MERGE)
            return ['--disallowedTools', deny, '--allowedTools', ALLOW_MERGE]
        return ['--disallowedTools', DENY_ALWAYS]

    def config(self, spec, free_model=None):
        """The engine's settings for a bot on its AI."""
        p = self.places
        marks = self.marks(spec)
        cwd = self._fill(spec['folder'], marks) if spec.get('folder') else p.projects
        seconds = int(spec['minutes']) * 60
        path_env = {'PATH': plain(p.path)}
        guarded = {'PATH': plain(f"{p.crew}/agy-bin:{p.path}")}
        may_not = spec.get('mayNot') or []
        ai = spec['ai']
        if ai == 'claude':
            # claude-bot.sh gives Claude Code the owner's long-lived token, so the bots outlast the desktop sign-in.
            config = {'engine': 'cli', 'command': f'{p.crew}/claude-bot.sh', 'cwd': cwd, 'model': spec['model'], 'effort': spec['effort'],
                      'maxTurnsPerRun': spec['turns'] or 150, 'timeoutSec': seconds, 'graceSec': 15,
                      'dangerouslySkipPermissions': True,
                      'extraArgs': self.claude_tools(spec, may_not),
                      'env': {**self.no_push(), **path_env}}
        elif ai == 'codex':
            # CODEX_HOME is the bots' own: connected apps (mail, GitHub, calendar) are off in its config.toml.
            config = {'engine': 'cli', 'cwd': cwd, 'model': spec['model'], 'modelReasoningEffort': spec['effort'],
                      'command': p.codex, 'timeoutSec': seconds, 'graceSec': 15,
                      'dangerouslyBypassApprovalsAndSandbox': False, 'extraArgs': CODEX_ARGS,
                      'env': {**self.no_push(), **path_env, 'CODEX_HOME': plain(p.safe)}}
        elif ai == 'gemini':
            # Over ACP the prompt goes through a pipe: on the command line a long job thread is too big for Linux.
            # agy-acp.py sets the model and answers agy's permission requests within the bots' rules; agy-bin
            # comes first on PATH so its git refuses those commands too.
            config = {'engine': 'acp', 'agentCommand': f'{p.crew}/agy-acp.py', 'cwd': cwd, 'model': spec['model'],
                      'timeoutSec': seconds, 'graceSec': 15,
                      'env': {**self.no_push(), **guarded,
                              'AGY_MODELS': plain(','.join(m for m in ANTIGRAVITY if m != spec['model']))}}
        else:
            # OpenCode allows every tool to a bot, so the git on its PATH refuses what the owner does by hand
            # (commit too, unless it builds), and no_push leaves it nothing to push with. Every OpenCode bot
            # runs through free-runner.py: a free model that runs out hands over mid-run.
            builds = 'commit' not in may_not and 'edit' not in may_not
            model = spec['model'] if spec['model'] not in ('auto', None, '') else (free_model() if free_model else None)
            config = {'command': f'{p.crew}/free-runner.py', 'cwd': cwd, 'model': model, 'variant': spec['effort'],
                      'timeoutSec': seconds, 'graceSec': 15, 'dangerouslySkipPermissions': True,
                      'env': {**self.no_push(), **guarded, **({'BOTYARD_GIT_ALLOW': plain('commit')} if builds else {})}}
            if spec.get('checker') or spec['role'] == 'checker':
                # A checker never judges a build on the model family that made it.
                config['env']['BOTYARD_CHECKER'] = plain('1')
        for name in spec.get('variables') or []:
            value = (self.crew.get('variables') or {}).get(name)
            if value is not None:
                config['env'][name] = plain(str(value))
        return config

    @staticmethod
    def heartbeat(spec):
        """How the bot's conversations and runs are kept: a fresh conversation after so many runs or hours,
        or several runs side by side."""
        fresh = spec.get('freshChat')
        if fresh:
            return {**HEARTBEAT, 'sessionCompaction': {'enabled': True, 'maxSessionRuns': fresh['runs'], 'maxSessionAgeHours': fresh['hours']}}
        if (spec.get('atOnce') or 1) > 1:
            return {**HEARTBEAT, 'maxConcurrentRuns': spec['atOnce']}
        return dict(HEARTBEAT)

    def build(self, slug, ai=None, free_model=None):
        """Everything the seeder needs for one bot on an AI."""
        spec = self.on(slug, ai)
        return {'slug': slug, 'name': spec['name'], 'role': ROLES[spec['role']], 'title': spec['title'], 'caps': spec['does'],
                'ai': spec['ai'], 'adapter': AIS[spec['ai']], 'config': self.config(spec, free_model),
                'heartbeat': self.heartbeat(spec), 'reportsTo': spec.get('reportsTo'),
                'rulesFile': spec.get('rulesFile') or slug, 'spec': spec}

    def listing(self):
        """The set as data, for Botyard's editor: every bot with its settings and where its files are."""
        return {'folder': self.dir, 'own': self.own, 'studio': self.crew.get('studio'),
                'lead': self.crew.get('lead'), 'shared': self.shared_names(),
                'bots': [{**{k: v for k, v in self.spec(slug).items()}, 'files': self.sources(slug)} for slug in self.slugs()]}


# ── the engine's copy of a bot, as the same simple fields ────────────────────────────

def view(agent, slug_by_id=None):
    """A bot as the engine holds it (or as it is about to be sent), in the words of <slug>.json. Only
    what can be read back with certainty is here; the rest is the seeder's to set."""
    config = agent.get('adapterConfig') or {}
    ai = AI_OF.get(agent.get('adapterType'))
    # A list entry that leaves a field out says nothing about it.
    out = {field: agent.get(key) or '' for field, key in (('name', 'name'), ('title', 'title'), ('does', 'capabilities'))
           if key in agent}
    if not ai:
        return out
    out['ai'] = ai
    if ai != 'free':
        out['model'] = config.get('model')
    effort = config.get({'claude': 'effort', 'codex': 'modelReasoningEffort', 'free': 'variant'}.get(ai, ''))
    if effort:
        out['effort'] = effort
    if config.get('timeoutSec'):
        out['minutes'] = int(config['timeoutSec']) // 60
    if ai == 'claude' and config.get('maxTurnsPerRun'):
        out['turns'] = config['maxTurnsPerRun']
    out['atOnce'] = ((agent.get('runtimeConfig') or {}).get('heartbeat') or {}).get('maxConcurrentRuns') or 1
    # Botyard's editor writes the owner's choice under mayNot. Otherwise it is read from what enforces it,
    # and only from what is there: a setting that is missing says nothing (an older seed, or an editor
    # that sent a clean config), and "nothing" must never read as a choice of the owner's.
    if isinstance(config.get('mayNot'), list):
        out['mayNot'] = sorted(config['mayNot'])
    elif ai == 'claude':
        args = config.get('extraArgs') or []
        if '--disallowedTools' in args:
            out['mayNot'] = ['edit', 'push'] if ',Edit,' in ' '.join(args) else ['push']
    elif ai == 'free':
        allow = ((config.get('env') or {}).get('BOTYARD_GIT_ALLOW') or {})
        allow = allow.get('value') if isinstance(allow, dict) else allow
        if allow == 'commit':
            out['mayNot'] = ['push']
    if 'reportsTo' in agent and slug_by_id is not None:
        out['reportsTo'] = slug_by_id.get(agent.get('reportsTo')) if agent.get('reportsTo') else None
    return out
