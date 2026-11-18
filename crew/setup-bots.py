#!/usr/bin/env python3
"""Seeds a studio's bots into the engine from files. Safe to run again.

The bots are data: crew/bots in the repository, one <slug>.json and one <slug>.md a bot, with a studio's
own in $BOTYARD_HOME/crew/bots winning over them (crew_set.py reads them). This script writes them
through the engine's API and never writes over what the owner changed in Botyard since the last seed:
it keeps what it last wrote per bot, and where the engine's copy differs from that, the engine's copy
is kept and written back into the studio's own file.

    setup-bots.py                 seed this studio's crew
    setup-bots.py --dry           say what would change, write nothing
    setup-bots.py --only SLUG     one bot
    setup-bots.py --list          the crew as JSON, for Botyard's editor (needs no engine)
    setup-bots.py --api URL       the engine to talk to, when not this studio's own

What depends on the moment stays code here and reads the data: which free model a bot starts on
(FREE below, minus what is set aside), and where a Codex bot thinks while Codex is out of its limit.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import time
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import crew_set  # noqa: E402
import skill_sets  # noqa: E402
import botyard_home  # noqa: E402
import git_identity  # noqa: E402

HOME = os.path.expanduser('~')
HERE = os.path.dirname(os.path.realpath(__file__))
DIR = botyard_home.crew_dir()
# Free models build what needs no paid AI. A free builder starts on the best one answering now, and a
# checker checks its work on a model from another family, so one model's blind spots do not pass its own
# mistakes. FREE is in the order a builder takes them, best first, from published coding scores and a
# hidden test of our own (crew/bench): (model, family, tier). A strong model builds; a light one takes
# only light jobs (docs, tests, reproductions, drafts). fallback.py sets a model aside in FREE_OUT when it
# stops answering (its free limit, or the offer ended); free-scout.py adds new free models it has tested
# to FREE_FOUND, and FREE_SCORES keeps the checks' verdicts per model, so one that fails real checks
# drops to light.
# None when OpenCode is not installed: the scripts that run it say what to install (botyard_home.need).
OPENCODE = botyard_home.tool('opencode')
FREE = [('opencode/deepseek-v4.1-flash-free', 'deepseek', 'strong'),
        ('opencode/glm-5.3-flash-free', 'glm', 'strong'),
        # OpenCode publishes one limit, for this model: 100 requests a day. A build uses more, so it is light.
        ('opencode/longcat-2.5-free', 'longcat', 'light'),
        ('opencode/mimo-v2.6-flash-free', 'mimo', 'strong'),
        ('opencode/nemotron-3.5-super-vl-free', 'nemotron', 'strong'),
        # NVIDIA's free tier on the owner's key: 40 requests a minute. Its own Nemotron answers at once and
        # passed 25/25 in 88s; the other makers' models it hosts sat in a queue on 9 November, so the scout
        # tries them again daily.
        ('nvidia/nvidia/nemotron-3-ultra-550b-a55b', 'nemotron', 'strong'),
        # OpenRouter's free models share 1,000 requests a day on the owner's key, so they come after.
        ('openrouter/nvidia/nemotron-3-ultra-550b-a55b:free', 'nemotron', 'strong'),
        ('openrouter/cohere/north-mini-code:free', 'cohere', 'strong'),
        # Small or unknown models: they passed our test, but long agent work needs more than that.
        ('opencode/flint-40b-free', 'flint', 'light'),
        ('opencode/beam-free', 'beam', 'light'),
        ('opencode/iceman-free', 'iceman', 'light'),
        ('opencode/nemotron-3.5-lightning-free', 'nemotron', 'light')]
# Groq is left out: its free tokens-per-minute is smaller than one OpenCode request.
FREE_FOUND = f'{DIR}/free-found.json'
FREE_LIMITS = f'{DIR}/free-limits.json'
# A provider whose "free" offer ran out into paid credits answers every run with this ("Payment Required: Your credits
# are used up"). It is not free, however it was found, so none of its models belong on the list (review of 18 Nov 2026).
CREDIT_WORDS = re.compile(r'Payment Required|credits are used up|insufficient (?:credits|balance|funds)|add credits|out of credits', re.I)
FREE_SCORES = f'{DIR}/free-scores.json'
FREE_OUT = f'{DIR}/free-out.json'
# What OpenCode itself lists on this computer, kept by free-scout.py and free-runner.py: {at, models}.
FREE_LISTED = f'{DIR}/free-listed.json'
LISTED_FOR = 3 * 86400
# Where the thinking bots run now: fallback.py moves them to Gemini while Codex is out of its limit.
THINKER = f'{DIR}/thinker.json'
ANTIGRAVITY = crew_set.ANTIGRAVITY
# What a script calls an engine, and the AI it is in a bot's file.
ENGINES = {'free': 'free', 'gemini': 'gemini', 'codex': 'codex', 'sonnet': 'claude'}


def free_aside():
    """Each free model set aside now, with until when."""
    out = read_json(FREE_OUT, {})
    out = out if isinstance(out, dict) else {}
    return {model: when for model, when in out.items() if isinstance(when, dict) and time.time() < when.get('until', 0)}


def read_json(path, empty):
    try:
        with open(path, encoding='utf8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return empty


# A provider's models need its key; OpenCode's own free offers need none.
NO_KEY = ('opencode',)


def reachable(model, has_key=None):
    """True when this computer can ask the model at all: OpenCode's own free models always, a provider's
    only with its key (pasted in Botyard, or signed in to with `opencode auth login`)."""
    provider = model.split('/')[0]
    return provider in NO_KEY or bool((has_key or botyard_home.has_key)(provider))


def tool_models(now=None):
    """The models OpenCode listed on this computer when it was last asked, or None when that is not known
    (never asked, or asked more than three days ago). Read from a file: nothing is started here."""
    kept = read_json(FREE_LISTED, {})
    if not isinstance(kept, dict) or not isinstance(kept.get('models'), list) or not kept['models']:
        return None
    if (time.time() if now is None else now) - kept.get('at', 0) > LISTED_FOR:
        return None
    return set(kept['models'])


def keep_tool_models(models, now=None):
    """Remember what OpenCode lists. An empty listing (offline, or the tool failed) is not kept: it is not
    every model going away."""
    models = sorted({m for m in models if isinstance(m, str) and '/' in m})
    if not models:
        return False
    tmp = f'{FREE_LISTED}.{os.getpid()}.tmp'
    with open(tmp, 'w', encoding='utf8') as f:
        json.dump({'at': int(time.time() if now is None else now), 'models': models}, f)
    os.replace(tmp, FREE_LISTED)
    return True


def offered(model, listed):
    """False only when the tool is known not to have this model: its provider lists models here, and
    this is not one of them. A provider that lists nothing (no key, or never asked) decides nothing."""
    if not listed or model in listed:
        return True
    provider = model.split('/')[0] + '/'
    return not any(m.startswith(provider) for m in listed)


def credit_only_providers(limits=None):
    """The providers whose models reported that credits are needed, read from what free-limits.py learned
    ({'models': {'provider/model': {'rounds': [{'why': ...}]}}}). Their models stay off the free list."""
    limits = read_json(FREE_LIMITS, {}) if limits is None else limits
    models = limits.get('models') if isinstance(limits, dict) else None
    found = set()
    for model, row in (models or {}).items():
        why = ' '.join(str(r.get('why') or '') for r in (row or {}).get('rounds') or [] if isinstance(r, dict))
        if CREDIT_WORDS.search(why) and '/' in model:
            found.add(model.split('/')[0])
    return found


def free_list(has_key=None, listed=None, credit_only=None):
    """Every free model this computer can ask, with its family and tier now: the list above, then what
    free-scout.py found, less any the tool itself no longer lists (a name that left the offer would only
    fail every run handed to it). With no OpenRouter or NVIDIA key the list is just shorter. A model
    whose real builds fail the checker's or the lead's checks at least half the time, over three or
    more, counts as light whatever its tier."""
    listed = tool_models() if listed is None else listed
    found = [tuple(row) for row in read_json(FREE_FOUND, []) if row[0] not in {m for m, _, _ in FREE}]
    scores = read_json(FREE_SCORES, {})
    rows = []
    paid = credit_only_providers() if credit_only is None else credit_only
    for model, family, tier in FREE + found:
        if model.split('/')[0] in paid:
            continue
        if not reachable(model, has_key) or not offered(model, listed):
            continue
        score = scores.get(model, {})
        checked = score.get('pass', 0) + score.get('fail', 0)
        rows.append((model, family, 'light' if checked >= 3 and score.get('pass', 0) / checked < 0.5 else tier))
    return rows


def free_model(tier='strong', not_family=None):
    """The best free model answering now: a strong one, or any when tier is 'any'; not of not_family.
    None when every such model is set aside."""
    aside = free_aside()
    rows = [r for r in free_list() if r[0] not in aside and r[1] != not_family]
    return next((m for m, _, t in rows if t == 'strong'), None if tier == 'strong' else next((m for m, _, _ in rows), None))


def free_family(model):
    return next((f for m, f, _ in free_list() if m == model), model.split('/')[-1].split('-')[0])


FREE_MODELS = [m for m, _, _ in FREE]


def free_open(tier='any'):
    return free_model(tier) is not None


def free_start():
    """The model a free bot's settings name: any answering now, else the first this computer can ask."""
    return free_model('any') or next((m for m, _, _ in free_list()), FREE_MODELS[0])


def thinking_on():
    state = read_json(THINKER, {})
    return state.get('on', 'codex') if isinstance(state, dict) else 'codex'


# ── this studio's set ────────────────────────────────────────────────────────────────

_CREW = None
_API = None


def crew():
    """This studio's crew, read once."""
    global _CREW
    if _CREW is None:
        _CREW = crew_set.CrewSet()
    return _CREW


def use(crew_files, api=None):
    """Seed from these files (a test's), and talk to this engine."""
    global _CREW, _API
    _CREW = crew_files
    if api:
        _API = api.rstrip('/') + ('' if api.rstrip('/').endswith('/api') else '/api')


def _names(test):
    files = crew()
    return [files.spec(slug)['name'] for slug in files.slugs() if test(files.spec(slug))]


def _lazy(name):
    files = crew()
    if name == 'COMPANY':
        return botyard_home.studio_id()
    if name == 'API':
        return _api()
    if name == 'BOTS':
        return [build(slug) for slug in files.slugs()]
    if name == 'BUILDER':
        # The free builder and the checker, by what they are in this studio's crew: None when it has none.
        return next((files.spec(slug)['name'] for slug in files.with_role('builder', ai='free')), None)
    if name == 'CHECKER':
        return next((files.spec(slug)['name'] for slug in files.with_role('checker')), None)
    if name == 'LEAD':
        return files.spec(files.crew['lead'])['name'] if files.crew.get('lead') else None
    if name == 'ALWAYS_CLAUDE':
        return set(_names(lambda s: s.get('codexOut') == 'claude'))
    if name == 'RETIRED':
        return tuple(files.crew.get('retired') or ())
    if name == 'RENAMED':
        return dict(files.crew.get('renamed') or {})
    raise AttributeError(name)


def __getattr__(name):
    """The names other crew scripts read from here (bots.BUILDER, bots.LEAD, bots.BOTS, ...), worked
    out from the files when asked for, so importing this never needs the engine."""
    return _lazy(name)


def ai_now(slug):
    """Where the bot runs now: its own AI, or its fallback while a Codex bot's Codex is out."""
    spec = crew().spec(slug)
    if spec['ai'] != 'codex':
        return spec['ai']
    state = read_json(THINKER, {})
    if not isinstance(state, dict) or state.get('on') != 'gemini':
        return 'codex'
    # A bot whose file says so ("codexOut": "claude") skips Gemini while Codex is out.
    return 'claude' if spec['name'] in set(state.get('claude') or []) or spec.get('codexOut') == 'claude' else 'gemini'


def build(slug, ai=None):
    return crew().build(slug, ai or ai_now(slug), free_start)


def names_with_role(*roles, ai=None, tier=None):
    """The names of the bots that are this in the crew: names_with_role('lead', 'ruler')."""
    return [crew().spec(slug)['name'] for slug in crew().with_role(*roles, ai=ai, tier=tier)]


def on_engine(slug, engine='free'):
    """A bot on the engine a script picked for it now (free, gemini, codex or sonnet), from its "fallbacks"."""
    return build(slug, ENGINES[engine])


# ── the engine ───────────────────────────────────────────────────────────────────────

def _api():
    global _API
    if _API is None:
        _API = botyard_home.api()
    return _API


def call(method, path, body=None):
    req = urllib.request.Request(_api() + path, method=method,
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as res:
        raw = res.read()
    return json.loads(raw) if raw else {}


def soft(method, path, body=None):
    """A call an engine may not know (older or newer than this script): its refusal changes nothing."""
    try:
        return call(method, path, body)
    except urllib.error.HTTPError:
        return None


# ── what was last written, and what the owner changed since ──────────────────────────

def seeded_file():
    return os.path.join(crew().places.crew, 'bots', '.seeded.json')


def seeded():
    return read_json(seeded_file(), {})


def sha(text):
    return hashlib.sha256(text.encode('utf8')).hexdigest()


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + '.tmp', 'w', encoding='utf8') as f:
        f.write(text)
    os.replace(path + '.tmp', path)


def own_file(slug, kind):
    files = crew()
    return os.path.join(files.own or os.path.join(files.places.crew, 'bots'), f'{slug}.{kind}')


def changed_in_studio(base, theirs, ours):
    """The settings the owner changed in Botyard since the last seed: the engine's value differs from what
    was last written (and from what the files say now)."""
    return {field: theirs[field] for field in (base or {}) if field in theirs and theirs[field] != base[field]
            and theirs[field] != ours.get(field)}


def keep_settings(slug, wins, ai):
    """Writes the owner's changes into the studio's own <slug>.json, which holds only what differs."""
    files = crew()
    spec = files.spec(slug)
    over = files.overlay(slug)
    if 'ai' in wins:
        over['ai'] = wins['ai']
    target = over
    if 'ai' not in wins and ai != spec['ai']:
        # The bot is on its fallback now, so that is what the owner was looking at and changed.
        target = over.setdefault('fallbacks', {}).setdefault(ai, {})
    for field, value in wins.items():
        if field == 'ai':
            continue
        (target if field in ('model', 'effort', 'minutes', 'turns', 'mayNot') else over)[field] = value
    write(own_file(slug, 'json'), json.dumps(over, indent=2, ensure_ascii=False) + '\n')


def engine_text(agent):
    """The bot's instructions as the engine holds them: the file its runs read, which Botyard's editor writes."""
    path = ((agent or {}).get('adapterConfig') or {}).get('instructionsFilePath')
    return crew_set.read_text(path) if path else None


_PC_SKILLS = []


def pc_skills():
    """Every skill on the PC, read once a run of this script."""
    if not _PC_SKILLS:
        _PC_SKILLS.extend(skill_sets.inventory())
    return _PC_SKILLS


def skills_env(bot):
    """The bot's settings file for its AI: only its skills of the PC's when its file lists them ("all" hides none), and what no bot
    may touch closed to every bot."""
    want = bot['spec'].get('skills', 'all')
    return skill_sets.write_for(bot['name'], bot['adapter'], pc_skills() if isinstance(want, list) else [], want=set(want) if isinstance(want, list) else None,
                                reads=bot['spec'].get('reads'), own=(bot.get('config') or {}).get('cwd'))


def body_for(bot, path, existing, boss, dry=False):
    files = crew()
    body = {'name': bot['name'], 'role': bot['role'], 'title': bot['title'], 'capabilities': bot['caps'],
            'adapterType': bot['adapter'],
            # The role and look its settings file gives it: the map draws the bot from these, never from its name.
            # A lane copy says whose it is and on which AI, so every list shows it under its bot, not as one more.
            'metadata': {'role': bot['spec'].get('role', 'general'), 'look': bot['spec'].get('look') or {},
                         **({'laneOf': bot['laneOf'], 'lane': bot['lane']} if bot.get('lane') else {})},
            'runtimeConfig': {'heartbeat': bot['heartbeat']},
            'adapterConfig': {**bot['config'], 'instructionsFilePath': path,
                              'env': {**bot['config'].get('env', {}), **({} if dry else skills_env(bot))}},
            'replaceAdapterConfig': True}
    if (os.environ.get('BOTYARD_HOME') or '').strip():
        # A studio whose home was chosen by hand: its runs must look in the same folders as the service.
        body['adapterConfig']['env']['BOTYARD_HOME'] = crew_set.plain(os.path.abspath(os.environ['BOTYARD_HOME'].strip()))
    if bot['reportsTo']:
        answers_to = existing.get(files.spec(bot['reportsTo'])['name'], {}).get('id') if bot['reportsTo'] in files.slugs() else None
        if answers_to or boss:
            body['reportsTo'] = answers_to or boss
    return body


def crew_ids(bot, existing):
    """The bots that hand out work get the crew's ids, so a small model never has to look them up."""
    if '{{crew-ids}}' not in crew().template(bot['slug']):
        return ''
    return 'CREW IDS, for assigneeAgentId: ' + ', '.join(f"{name} {a['id']}" for name, a in sorted(existing.items()))


def put(bot, existing, boss, dry=False):
    """Create the bot, or bring an existing one in line with its files, keeping what the owner changed
    in Botyard. Returns the engine's answer (None on a dry run)."""
    files = crew()
    slug, ai = bot['slug'], bot['ai']
    state = seeded()
    base = state.get(slug) or {}
    agent = existing.get(bot['name'])
    by_id = {a.get('id'): files.by_name(name) for name, a in existing.items()}
    path = f"{files.places.crew}/{bot['rulesFile']}.md"
    body = body_for(bot, path, existing, boss, dry)
    kept = []
    if agent:
        wins = changed_in_studio(base.get('settings'), crew_set.view(agent, by_id), crew_set.view(body, by_id))
        # Botyard's editor writes two of the owner's choices into the settings by name; the seeder never
        # does, so finding one there means the owner chose it since the last seed.
        chosen = agent.get('adapterConfig') or {}
        if isinstance(chosen.get('mayNot'), list) and sorted(chosen['mayNot']) != sorted(bot['spec']['mayNot']):
            wins['mayNot'] = sorted(chosen['mayNot'])
        if chosen.get('skills') and chosen['skills'] != bot['spec'].get('skills', 'all'):
            wins['skills'] = chosen['skills']
        if wins:
            kept += sorted(wins)
            if dry:
                print(f"{bot['name']:15} changed in Botyard, would be kept: {', '.join(f'{k} = {v}' for k, v in sorted(wins.items()))}")
            else:
                keep_settings(slug, wins, ai)
                ai = wins.get('ai', ai)
                bot = crew().build(slug, ai, free_start)
                body = body_for(bot, path, existing, boss)
    ids = crew_ids(bot, existing)
    text = files.render(slug, ai, ids)
    theirs = engine_text(agent)
    if agent and base.get('text') and theirs is not None and sha(theirs) != base['text'] and theirs != text:
        # The owner edited the instructions in Botyard: theirs stay, and go back into the studio's own file.
        kept.append('instructions')
        if not dry:
            template = files.unrender(slug, theirs, ai, ids)
            write(own_file(slug, 'md'), template)
            if files.render(slug, ai, ids) != theirs:
                write(own_file(slug, 'md'), theirs)
        else:
            print(f"{bot['name']:15} instructions changed in Botyard, would be kept")
        text = theirs
    if dry:
        now = crew_set.view(agent, by_id) if agent else {}
        want = crew_set.view(body, by_id)
        diff = {k: (now.get(k), v) for k, v in want.items() if now.get(k) != v and k not in kept}
        parts = [f'{k}: {a!r} to {b!r}' for k, (a, b) in sorted(diff.items())] if agent else ['new bot']
        if theirs != text:
            parts.append('instructions')
        print(f"{bot['name']:15} {'would change ' + '; '.join(parts) if parts else 'no change'}")
        return None
    if theirs != text:
        write(path, text)
    if agent:
        answer = call('PATCH', f"/agents/{agent['id']}", body)
    else:
        answer = call('POST', f'/companies/{botyard_home.studio_id()}/agents', body)
    state = seeded()
    state[slug] = {**(state.get(slug) or {}), 'id': answer.get('id'), 'settings': crew_set.view(body, {**by_id, answer.get('id'): slug}),
                   'text': sha(text), 'at': int(time.time())}
    write(seeded_file(), json.dumps(state, indent=1, sort_keys=True) + '\n')
    print(f"{bot['name']:15} {answer.get('status')} {bot['adapter']} {bot['config']['model']}"
          + (f"  (kept from Botyard: {', '.join(kept)})" if kept else ''))
    return answer


def signed_in(ai):
    """True when the AI's own tool is installed and has a sign-in this script can see."""
    if ai == 'claude':
        return bool(botyard_home.tool('claude')) and (
            os.path.getsize(botyard_home.state('claude-token')) > 0 if os.path.isfile(botyard_home.state('claude-token')) else
            os.path.isfile(f'{HOME}/.claude/.credentials.json') or bool(os.environ.get('CLAUDE_CODE_OAUTH_TOKEN')))
    if ai == 'codex':
        return bool(botyard_home.tool('codex')) and os.path.isfile(f'{HOME}/.codex/auth.json')
    if ai == 'gemini':
        return bool(botyard_home.tool('agy'))
    return bool(botyard_home.tool('opencode'))


def switch(slug, agent, dry=False):
    """On and off. The engine is the truth afterwards, so a bot is paused or resumed here only when what
    its file asks for changes: "on" was edited, or the AI it "needs" got signed in (or out). A bot that
    something else paused (the health check at a limit, the owner in Botyard) is never woken by a seed."""
    spec = crew().spec(slug)
    state = seeded()
    mine = state.get(slug) or {}
    waits = bool(spec.get('needs')) and not signed_in(spec['needs'])
    # A bot that needs an AI is on exactly when that AI is signed in; any other follows "on" in its file.
    want = (not waits) if spec.get('needs') else bool(spec.get('on', True))
    if mine.get('on') == want:
        return
    paused = agent.get('status') == 'paused'
    first = 'on' not in mine
    if (not want and not paused) or (want and paused and not first):
        if dry:
            print(f"{spec['name']:15} would be {'resumed' if want else 'paused'}")
            return
        soft('POST', f"/agents/{agent['id']}/{'resume' if want else 'pause'}", {})
        why = f" until {spec['needs'].capitalize()} is signed in" if waits else ''
        print(f"{spec['name']:15} {'on' if want else 'off' + why}")
    if not dry:
        state[slug] = {**mine, 'on': want}
        write(seeded_file(), json.dumps(state, indent=1, sort_keys=True) + '\n')


LAUNCHERS = ('claude-bot.sh', 'free-runner.py', 'agy-acp.py', 'agy-bin')


def launchers():
    """A bot's settings name its launcher in the crew's folder. install.sh links them all; on a studio
    that never ran it, the ones a run needs are linked here so a first job can start."""
    folder = crew().places.crew
    for name in LAUNCHERS:
        if not os.path.lexists(f'{folder}/{name}'):
            os.symlink(f'{HERE}/{name}', f'{folder}/{name}')


GITCONFIG = """# Bots have network access, so this removes their ability to authenticate or push.
[credential]
	helper =
[core]
	sshCommand = /bin/false
	askPass = /bin/false
[url "blocked://no-push/"]
	pushInsteadOf = https://github.com/
	pushInsteadOf = git@github.com:
	pushInsteadOf = ssh://git@github.com/
"""
IDENTITY = """[user]
	name = {name}
	email = {mail}
"""


def gitconfig(mail=None):
    """The sandbox git config, with the studio's GitHub no-reply address as the fallback author (BOTYARD_GIT_NOREPLY,
    else the owner's global git user.email when it is one). With no no-reply address there is no [user] at all,
    never a made-up address: identity-check.py then says so."""
    mail = git_identity.no_reply() if mail is None else mail
    return GITCONFIG + (IDENTITY.format(name=os.environ.get('BOTYARD_GIT_NAME') or 'Botyard bot', mail=mail) if mail else '')


def gitconfig_ok_text(text):
    return '@users.noreply.github.com' in text


def gitconfig_ok(path):
    """True when the file's own user.email is a GitHub no-reply address."""
    done = subprocess.run(['git', 'config', '-f', path, 'user.email'], capture_output=True, text=True)
    return bool(git_identity.SAFE.search(done.stdout.strip()))
CODEX_CONFIG = """# Home for this studio's Codex bots. No connected apps or plugins: bots never reach mail, GitHub or a calendar.
sandbox_mode = "workspace-write"

[features]
apps = false
plugins = false

[sandbox_workspace_write]
network_access = true
"""


def safe_folder():
    """The bots' own settings folder: a git config that cannot push, an empty GitHub sign-in, Codex's
    home with connected apps off, and the crew's skills from the repository. What is already there is
    left as it is, apart from the skills, which are the repository's."""
    safe = crew().places.safe
    os.makedirs(f'{safe}/gh-empty', exist_ok=True)
    os.chmod(safe, 0o700)
    # Written when missing, and again when what is there would author a commit under any address but a no-reply
    # (an old test address, say). A good file the owner has edited is left alone.
    mine = gitconfig()
    if not os.path.exists(f'{safe}/gitconfig') or (not gitconfig_ok(f'{safe}/gitconfig') and gitconfig_ok_text(mine)):
        write(f'{safe}/gitconfig', mine)
    if any(crew().spec(slug)['ai'] == 'codex' for slug in crew().slugs()):
        if not os.path.exists(f'{safe}/config.toml'):
            write(f'{safe}/config.toml', CODEX_CONFIG)
            os.chmod(f'{safe}/config.toml', 0o600)
        if not os.path.lexists(f'{safe}/auth.json') and os.path.isfile(f'{HOME}/.codex/auth.json'):
            os.symlink(f'{HOME}/.codex/auth.json', f'{safe}/auth.json')
    # The crew's own skills, for the Codex bots and, in Antigravity, the same folder.
    skills = botyard_home.source('skills')
    # The repository's skills, then the studio's own (its crew/own/skills), which win on the same name.
    for folder in (skills, f'{crew().places.own}/skills'):
        for skill in (sorted(os.listdir(folder)) if os.path.isdir(folder) else []):
            if os.path.isfile(f'{folder}/{skill}/SKILL.md'):
                if os.path.islink(f'{safe}/skills/{skill}'):
                    os.unlink(f'{safe}/skills/{skill}')
                shutil.copytree(f'{folder}/{skill}', f'{safe}/skills/{skill}', dirs_exist_ok=True)
    # Claude Code finds a skill by name in the owner's own skills folder: the job skill is linked there
    # when that folder exists and holds nothing of that name, and never written over.
    mine = f'{HOME}/.claude/skills'
    if os.path.isdir(mine) and not os.path.lexists(f'{mine}/botyard'):
        os.symlink(f'{skills}/botyard', f'{mine}/botyard')


def put_lane(bot, existing, boss, dry=False):
    """A free checker's lane on a paid AI: an agent of its own (fallback.py hands it checks the free models cannot take
    in time). It is made from the checker's file and follows it on every seed; nothing the owner changes in Botyard is
    read back, because the file is the one place its order and models are set."""
    files = crew()
    path = f"{files.places.crew}/{bot['rulesFile']}.md"
    text = files.render(bot['slug'], bot['lane'], crew_ids(bot, existing))
    agent = existing.get(bot['name'])
    if dry:
        print(f"{bot['name']:15} {'would be updated' if agent else 'would be made'} ({bot['adapter']} {bot['config'].get('model')})")
        return None
    write(path, text)
    body = body_for(bot, path, existing, boss)
    answer = call('PATCH', f"/agents/{agent['id']}", body) if agent else call('POST', f'/companies/{botyard_home.studio_id()}/agents', body)
    state = seeded()
    state[f"{bot['slug']}@{bot['lane']}"] = {'id': answer.get('id'), 'text': sha(text), 'at': int(time.time())}
    write(seeded_file(), json.dumps(state, indent=1, sort_keys=True) + '\n')
    print(f"{bot['name']:15} {answer.get('status')} {bot['adapter']} {bot['config']['model']}  (lane)")
    return answer


def seed_lanes(existing, boss, dry=False):
    """Every lane the crew's files list, after the bots themselves: a checker with "fallbacks" marked "for": "checks"."""
    files = crew()
    for slug in files.slugs():
        for ai in files.check_lanes(slug):
            bot = files.build(slug, ai, free_start, lane=True)
            answer = put_lane(bot, existing, boss, dry)
            if answer:
                existing[bot['name']] = {**existing.get(bot['name'], {}), **answer}


def move_thinkers(to, back=None, on_claude_now=()):
    """Moves the Codex bots to Antigravity or back, and those named to cheap Claude when every
    Antigravity model is out too. The Claude bots and their sessions are left alone."""
    with open(THINKER, 'w') as f:
        json.dump({'on': to, 'back': back, 'moved': int(time.time()), 'claude': sorted(on_claude_now)}, f)
    existing = {a['name']: a for a in call('GET', f'/companies/{botyard_home.studio_id()}/agents')}
    boss = existing.get(_lazy('LEAD') or '', {}).get('id')
    for slug in crew().slugs():
        if crew().spec(slug)['ai'] == 'codex':
            put(build(slug), existing, boss)


def main(only=None, dry=False):
    files = crew()
    company = botyard_home.studio_id()
    # Hiring approval stays on afterwards so bots cannot add bots; this script is the owner's setup step.
    if not dry:
        soft('PATCH', f'/companies/{company}', {'requireBoardApprovalForNewAgents': False})
    existing = {a['name']: a for a in call('GET', f'/companies/{company}/agents')}
    # Bots that changed name keep their id, their chats, their jobs and their rules file.
    for old, new in (files.crew.get('renamed') or {}).items():
        if old in existing and not dry:
            existing[new] = call('PATCH', f"/agents/{existing.pop(old)['id']}", {'name': new})
    if not dry:
        launchers()
        safe_folder()
        # Botyard's Library lists every skill on the PC from this file, with who has it or why nobody does.
        given = {files.spec(slug)['name']: set(files.spec(slug)['skills']) for slug in files.slugs()
                 if isinstance(files.spec(slug).get('skills'), list)}
        skill_sets.write_index(pc_skills(), given)
        for name, gone in skill_sets.check(pc_skills(), given).items():
            print(f'{name:15} skills not on this PC: {", ".join(gone)}')
        # Agent Chat is what the phone and desktop talk to the bots through.
        soft('PATCH', '/instance/settings/experimental', {'enableAgentChat': True})
    lead = files.crew.get('lead')
    boss = existing.get(files.spec(lead)['name'], {}).get('id') if lead else None
    before = set(existing)
    for slug in files.slugs():
        if only and slug != only:
            continue
        bot = build(slug)
        agent = put(bot, existing, boss, dry) or existing.get(bot['name'])
        if agent:
            existing[bot['name']] = {**existing.get(bot['name'], {}), **agent} if not dry else agent
            switch(slug, agent, dry)
        if slug == lead and agent:
            boss = agent['id']
    if dry:
        if not only:
            seed_lanes(existing, boss, dry=True)
        return
    if lead and set(existing) != before and not only:
        # The lead was seeded before the bots it hands work to existed: now its list of their ids is whole.
        put(build(lead), existing, boss)
    if not only:
        seed_lanes(existing, boss)
    for name in files.crew.get('retired') or []:
        if name in existing and existing[name].get('status') != 'paused' and not only:
            call('POST', f"/agents/{existing[name]['id']}/pause", {})
            print(f'{name:15} paused')
    soft('PATCH', f'/companies/{company}', {'requireBoardApprovalForNewAgents': True})
    # Only the owner can look a chat up, so the lead's memory script finds its chat through this file.
    chat = soft('POST', f'/companies/{company}/chats/{boss}', {}) if boss else None
    if chat and chat.get('id'):
        with open(f'{files.places.crew}/lead-chat-id', 'w') as f:
            f.write(chat['id'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--dry', action='store_true', help='say what would change and write nothing')
    parser.add_argument('--only', help='seed one bot, by its slug')
    parser.add_argument('--list', action='store_true', help='print the crew as JSON and change nothing')
    parser.add_argument('--api', help="the engine's address, when it is not this studio's own")
    parser.add_argument('--think-on', choices=('codex', 'gemini'), help='move only the Codex bots, as fallback.py does')
    parser.add_argument('--back', type=int, help='with --think-on gemini: when Codex resets, in epoch seconds')
    parser.add_argument('--on-claude', default='', help='with --think-on gemini: bots on cheap Claude, comma-separated, every Antigravity model being out')
    args = parser.parse_args()
    if args.api:
        use(crew(), args.api)
    if args.list:
        listing = crew().listing()
        for row in listing['bots']:
            # Why a bot is off, in plain words, so a page need not work it out.
            needs = row.get('needs')
            row['waits'] = f"Off until {needs.capitalize()} is signed in." if needs and not signed_in(needs) else ''
        print(json.dumps(listing, indent=1, ensure_ascii=False))
    elif args.think_on:
        move_thinkers(args.think_on, args.back, [n for n in args.on_claude.split(',') if n])
    else:
        try:
            main(args.only, args.dry)
        except urllib.error.URLError as err:
            sys.exit(f'The engine at {_api()} did not answer ({getattr(err, "reason", err)}). Start Botyard and run this again.')
