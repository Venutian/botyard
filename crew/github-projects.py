#!/usr/bin/env python3
"""Turns the signed-in GitHub account's real projects into Botyard projects. No AI. Read-only on GitHub.

    github-projects.py            dry run: list what would be added and dropped, with a reason each, change nothing
    github-projects.py --add      add the missing projects (and tell the lead)
    github-projects.py --json     the same list as JSON (the Projects page reads this)

Botyard's timetable runs it daily with --add. The repositories come from `gh api user/repos`, run here
with the owner's sign-in, which is never read, kept or printed: only each repo's name, description,
visibility, dates and size are used. The rule is crew/github-project-rules.json. A repo that matches and
has no project gets one (status backlog, the studio's worktree policy), with its local clone as workspace
when one is found under the rules' cloneRoots (matched by its remote URL), and no workspace otherwise:
this script never clones. A repo whose project the owner archived or deleted is remembered and left out.
"""
import argparse
import fnmatch
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
import uuid
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, HERE)
import botyard_home  # noqa: E402

RULES = os.path.join(HERE, 'github-project-rules.json')
STATE = botyard_home.state('github-projects.json')
LOG = botyard_home.state('github-projects.log')
SIGN = '\n\n<!-- botyard-script: github-projects -->'
FIELDS = '{name,full_name,description,private,fork,archived,pushed_at,size,default_branch,html_url,owner:.owner.login}'


def gh(*args):
    """Run gh and return its stdout; '' on any failure. Its token stays inside gh."""
    try:
        done = subprocess.run(['gh', *args], capture_output=True, text=True, timeout=120, env={**os.environ, 'GH_PROMPT_DISABLED': '1'})
    except (OSError, subprocess.TimeoutExpired):
        return ''
    return done.stdout if done.returncode == 0 else ''


def repos():
    """The account's own repositories: name, description, visibility and dates only."""
    out = gh('api', 'user/repos?affiliation=owner&per_page=100', '--paginate', '--jq', f'.[] | {FIELDS}')
    found = []
    for line in out.splitlines():
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if isinstance(r, dict) and r.get('name'):
            found.append({k: r.get(k) for k in ('name', 'full_name', 'description', 'private', 'fork', 'archived', 'pushed_at', 'size', 'default_branch', 'html_url', 'owner')})
    return found


def load_rules(path=RULES):
    with open(path, encoding='utf8') as f:
        return json.load(f)


def months_ago(stamp, now=None):
    try:
        then = datetime.fromisoformat(str(stamp).replace('Z', '+00:00'))
    except ValueError:
        return 9999
    now = now or datetime.now(timezone.utc)
    return (now.year - then.year) * 12 + now.month - then.month


def root_files(repo):
    out = gh('api', f"repos/{repo['full_name']}/contents", '--jq', '.[].name')
    return out.split()


def commit_count(repo, cap=5):
    out = gh('api', f"repos/{repo['full_name']}/commits?per_page={cap}", '--jq', '.[].sha')
    return len(out.split())


def verdict(repo, rules, now=None, files=root_files, commits=commit_count):
    """(True|False, reason) for one repo."""
    name = repo['name']
    low = name.lower()
    if rules.get('excludeForks', True) and repo.get('fork'):
        return False, 'a fork'
    if rules.get('excludeArchived', True) and repo.get('archived'):
        return False, 'archived on GitHub'
    for d in rules.get('deny', []):
        if isinstance(d, str):
            d = {'name': d, 'reason': 'on your deny list'}
        if (d.get('name') or '').lower() == low:
            return False, d.get('reason') or 'on your deny list'
    if low == f"{(repo.get('owner') or '').lower()}.github.io":
        return False, "the account's own pages repo"
    for e in rules.get('excludeNames', []):
        if fnmatch.fnmatch(low, e['pattern'].lower()):
            return False, e.get('reason') or f"name matches {e['pattern']}"
    if rules.get('needsReadmeOrDescription', True) and not (repo.get('description') or '').strip():
        # A README is found at the root listing below; a repo with neither is not a project.
        if not any(f.lower().startswith('readme') for f in files(repo)):
            return False, 'no README or description'
    if months_ago(repo.get('pushed_at'), now) <= rules.get('pushedWithinMonths', 24):
        return True, f"pushed within {rules.get('pushedWithinMonths', 24)} months"
    more = rules.get('orElse') or {}
    manifests = more.get('manifestAtRoot', [])
    found = [f for f in files(repo) if any(fnmatch.fnmatch(f, m) for m in manifests)]
    if found and commits(repo, more.get('minCommits', 5)) >= more.get('minCommits', 5):
        return True, f'old, but {more.get("minCommits", 5)}+ commits and a {found[0]}'
    return False, 'not pushed lately and no manifest with enough commits'


# ── matching to local clones and existing projects ───────────────────────────────

def norm(url):
    """A remote URL in one shape (host/owner/repo, lower case) so https and ssh forms match."""
    u = (url or '').strip().lower()
    u = re.sub(r'^git@([^:]+):', r'\1/', u)
    u = re.sub(r'^[a-z+]+://([^@/]*@)?', '', u)
    return re.sub(r'(\.git)?/*$', '', u)


def origin_of(folder):
    try:
        done = subprocess.run(['git', '-C', folder, 'remote', 'get-url', 'origin'], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return ''
    return norm(done.stdout) if done.returncode == 0 else ''


def roots_of(rules):
    return rules.get('cloneRoots') or [botyard_home.projects()]


def clones(roots):
    """{normalised origin: folder} for each git folder one level under the clone roots (and the roots themselves)."""
    found = {}
    for root in roots:
        root = os.path.expanduser(root)
        for d in [root] + [os.path.join(root, n) for n in sorted(os.listdir(root))] if os.path.isdir(root) else []:
            if os.path.exists(os.path.join(d, '.git')):
                o = origin_of(d)
                if o:
                    found.setdefault(o, d)
    return found


def project_origins(project):
    """Normalised remotes this project's workspaces stand for."""
    out = set()
    for w in project.get('workspaces') or []:
        if w.get('repoUrl'):
            out.add(norm(w['repoUrl']))
        if w.get('cwd') and os.path.isdir(w['cwd']):
            o = origin_of(w['cwd'])
            if o:
                out.add(o)
    return out


def humanise(name):
    words = [w for w in re.split(r'[-_.\s]+', name) if w]
    return ' '.join(w if w.isupper() or any(c.isupper() for c in w[1:]) else w[:1].upper() + w[1:] for w in words) or name


def plan(rules, listed, projects, state, local, this_origin, **kw):
    """Decide each repo. Returns {'add': [...], 'drop': [...], 'have': [...], 'suggest': [...]}."""
    out = {'add': [], 'drop': [], 'have': [], 'suggest': []}
    origins = [(p, project_origins(p)) for p in projects]
    remembered = set(state.get('made') or [])
    for r in sorted(listed, key=lambda x: x['name'].lower()):
        key = norm(r['html_url']) if r.get('html_url') else norm(f"github.com/{r['full_name']}")
        row = {'repo': r['name'], 'url': r.get('html_url'), 'private': bool(r.get('private')), 'description': r.get('description') or ''}
        mine = [p for p, o in origins if key in o]
        if mine:
            live = [p for p in mine if not p.get('archivedAt')]
            if live:
                out['have'].append({**row, 'project': live[0]['name'], 'reason': 'already a project'})
                if key == this_origin and live[0]['name'] != 'Botyard':
                    out['suggest'].append({'project': live[0]['name'], 'id': live[0]['id'], 'alias': 'Botyard',
                                           'text': f'"{live[0]["name"]}" is this Botyard repository. Rename it to Botyard if you like.'})
            else:
                out['drop'].append({**row, 'reason': 'you archived its project'})
            continue
        if r['name'] in remembered:
            out['drop'].append({**row, 'reason': 'its project was archived or deleted'})
            continue
        ok, why = verdict(r, rules, **kw)
        if not ok:
            out['drop'].append({**row, 'reason': why})
            continue
        title = humanise(r['name'])
        if any(p['name'].lower() == title.lower() for p in projects):
            out['drop'].append({**row, 'reason': f'a project named {title} exists (not matched by its repo)'})
            continue
        folder = local.get(key)
        out['add'].append({**row, 'name': title, 'reason': why, 'folder': folder,
                           'note': None if folder else f'needs a local copy: clone {r.get("html_url")} to {os.path.join(os.path.expanduser(roots_of(rules)[0]), r["name"])}'})
    return out


# ── the engine ───────────────────────────────────────────────────────────────────

API = botyard_home.api()


def call(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as res:
        raw = res.read()
    return json.loads(raw) if raw else {}


def read_state():
    try:
        with open(STATE, encoding='utf8') as f:
            s = json.load(f)
        return s if isinstance(s, dict) else {}
    except (OSError, ValueError):
        return {}


def write_state(state):
    with open(STATE + '.tmp', 'w', encoding='utf8') as f:
        json.dump(state, f)
    os.replace(STATE + '.tmp', STATE)


POLICY = {'enabled': True, 'defaultMode': 'isolated_workspace', 'allowIssueOverride': True,
          'workspaceStrategy': {'type': 'git_worktree', 'baseRef': 'main'}}


def create(company, item):
    body = {'name': item['name'], 'description': item['description'] or None, 'status': 'backlog', 'executionWorkspacePolicy': POLICY}
    if item.get('folder'):
        body['workspace'] = {'cwd': item['folder'], 'repoUrl': item['url']}
    return call('POST', f'/companies/{company}/projects', body)


def tell_lead(company, names):
    from importlib import util
    spec = util.spec_from_file_location('setup_bots', os.path.join(HERE, 'setup-bots.py'))
    bots = util.module_from_spec(spec)
    spec.loader.exec_module(bots)
    agents = call('GET', f'/companies/{company}/agents')
    lead = next((a['id'] for a in agents if a['name'] == bots.LEAD), None)
    if not lead:
        return
    chat = call('POST', f'/companies/{company}/chats/{lead}', {})
    text = f"{len(names)} new project{'s' if len(names) != 1 else ''} from GitHub: {', '.join(names)}"
    call('POST', f"/issues/{chat['id']}/comments", {'body': text + SIGN, 'clientRequestId': str(uuid.uuid4())})


def run(add=False, as_json=False, listed=None, projects=None, rules=None, company=None):
    rules = rules or load_rules()
    listed = repos() if listed is None else listed
    company = company or botyard_home.studio_id()
    projects = call('GET', f'/companies/{company}/projects') if projects is None else projects
    state = read_state()
    here = botyard_home.repo()
    result = plan(rules, listed, projects, state, clones(roots_of(rules)), origin_of(here))
    made = []
    if add:
        for item in result['add']:
            create(company, item)
            made.append(item['name'])
            state.setdefault('made', []).append(item['repo'])
        write_state(state)
        if made:
            tell_lead(company, made)
    line = f"{time.strftime('%Y-%m-%d %H:%M')} github-projects: {len(listed)} repos, {len(result['add'])} {'added' if add else 'would be added'}, {len(result['drop'])} dropped, {len(result['have'])} already projects"
    if add:
        try:
            with open(LOG, 'a', encoding='utf8') as f:
                f.write(line + '\n')
        except OSError:
            pass
    result['summary'] = line
    return result


def show(result):
    for k, title in (('add', 'WOULD ADD'), ('drop', 'DROPPED'), ('have', 'ALREADY PROJECTS')):
        print(f'{title} ({len(result[k])})')
        for i in result[k]:
            extra = f" -> {i['name']}" + (f" in {i['folder']}" if i.get('folder') else f" ({i['note']})") if k == 'add' else (f" = {i['project']}" if k == 'have' else '')
            print(f"  {i['repo']}{' [private]' if i['private'] else ''}{extra}: {i['reason']}")
    for s in result['suggest']:
        print('SUGGESTION:', s['text'])
    print(result['summary'])


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--add', action='store_true')
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args(argv)
    try:
        result = run(add=a.add)
    except (OSError, ValueError) as e:
        print('github-projects: could not run:', getattr(e, 'reason', e))
        return 1
    if a.json:
        print(json.dumps(result))
    else:
        show(result)
    return 0


if __name__ == '__main__':
    sys.exit(main())
