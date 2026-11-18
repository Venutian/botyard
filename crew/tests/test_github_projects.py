"""github-projects.py: which of the account's repos become projects. A fake `gh` on PATH stands in for GitHub;
the engine is a stand-in too. Nothing real is called, and the sign-in is never in any output."""
import importlib.util
import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

CREW = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
sys.path.insert(0, CREW)
spec = importlib.util.spec_from_file_location('gp', os.path.join(CREW, 'github-projects.py'))
gp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gp)

SECRET = 'ghp_SECRETTOKEN123'
RECENT, OLD = '2026-10-01T00:00:00Z', '2022-01-01T00:00:00Z'


def repo(name, **more):
    return {'name': name, 'full_name': f'me/{name}', 'description': 'a thing', 'private': False, 'fork': False, 'archived': False,
            'pushed_at': RECENT, 'size': 10, 'default_branch': 'main', 'html_url': f'https://github.com/me/{name}', 'owner': 'me', **more}


LIST = [repo('shop'), repo('forked', fork=True), repo('dead', archived=True), repo('HTML-CSS'), repo('oop_cpp'), repo('math-tutorial'),
        repo('hello-world'), repo('me.github.io'), repo('mine', private=True), repo('empty', description=''),
        repo('oldapp', pushed_at=OLD), repo('oldnote', pushed_at=OLD), repo('blocked'), repo('Shop-Two')]
RULES = {**json.load(open(os.path.join(CREW, 'github-project-rules.json'))), 'deny': [{'name': 'blocked', 'reason': 'owner said no'}]}
NOW = None


def files(r):
    return {'oldapp': ['package.json', 'README.md'], 'oldnote': ['notes.txt']}.get(r['name'], [])


def commits(r, cap=5):
    return 9 if r['name'] == 'oldapp' else 1


def judged(r):
    return gp.verdict(r, RULES, files=files, commits=commits)


class Rule(unittest.TestCase):
    def test_keeps_real_projects_drops_the_rest(self):
        keep = {r['name'] for r in LIST if judged(r)[0]}
        self.assertEqual(keep, {'shop', 'mine', 'oldapp', 'Shop-Two'})

    def test_every_drop_has_a_reason(self):
        why = {r['name']: judged(r)[1] for r in LIST if not judged(r)[0]}
        self.assertEqual(why['forked'], 'a fork')
        self.assertIn('archived', why['dead'])
        self.assertIn('coursework', why['HTML-CSS'])
        self.assertIn('coursework', why['oop_cpp'])
        self.assertIn('tutorial', why['math-tutorial'])
        self.assertIn('sample', why['hello-world'])
        self.assertIn('pages', why['me.github.io'])
        self.assertEqual(why['blocked'], 'owner said no')
        self.assertIn('README', why['empty'])
        self.assertIn('manifest', why['oldnote'])


class Plan(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.clone = os.path.join(self.tmp, 'shop')
        os.makedirs(self.clone)
        subprocess.run(['git', 'init', '-q', self.clone], check=True)
        subprocess.run(['git', '-C', self.clone, 'remote', 'add', 'origin', 'git@github.com:me/shop.git'], check=True)

    def plan(self, projects, state=None):
        local = gp.clones([self.tmp])
        return gp.plan(RULES, LIST, projects, state or {}, local, 'github.com/me/mine', files=files, commits=commits)

    def test_workspace_only_when_a_clone_exists_matched_by_remote(self):
        got = {i['repo']: i for i in self.plan([])['add']}
        self.assertEqual(got['shop']['folder'], self.clone)
        self.assertIsNone(got['mine']['folder'])
        self.assertIn('needs a local copy: clone https://github.com/me/mine', got['mine']['note'])
        self.assertEqual(got['shop']['name'], 'Shop')

    def test_existing_project_is_matched_by_repo_not_duplicated_and_suggests_botyard(self):
        mine = {'id': 'p1', 'name': 'Studio', 'workspaces': [{'cwd': self.tmp, 'repoUrl': 'https://github.com/me/mine.git'}]}
        out = self.plan([mine])
        self.assertNotIn('mine', [i['repo'] for i in out['add']])
        self.assertIn('mine', [i['repo'] for i in out['have']])
        self.assertEqual(out['suggest'][0]['alias'], 'Botyard')
        self.assertEqual(out['suggest'][0]['project'], 'Studio')

    def test_archived_or_deleted_project_is_not_readded(self):
        arch = {'id': 'p2', 'name': 'Shop', 'archivedAt': 'x', 'workspaces': [{'cwd': self.clone}]}
        self.assertNotIn('shop', [i['repo'] for i in self.plan([arch])['add']])
        out = self.plan([], {'made': ['shop']})
        self.assertNotIn('shop', [i['repo'] for i in out['add']])
        self.assertIn('archived or deleted', [i['reason'] for i in out['drop'] if i['repo'] == 'shop'][0])

    def test_name_clash_is_not_a_duplicate(self):
        out = self.plan([{'id': 'p3', 'name': 'shop', 'workspaces': []}])
        self.assertNotIn('shop', [i['repo'] for i in out['add']])


class Run(unittest.TestCase):
    """Whole runs with a fake gh on PATH and a fake engine."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        bindir = os.path.join(self.tmp, 'bin')
        os.makedirs(bindir)
        lines = '\n'.join(json.dumps(r) for r in LIST)
        gh = os.path.join(bindir, 'gh')
        open(gh, 'w').write(f"#!/bin/sh\ncase \"$*\" in *user/repos*) cat <<'X'\n{lines}\nX\n;; *contents*) echo package.json;; *commits*) echo a;; esac\n"
              f"echo {SECRET} >&2\n")
        os.chmod(gh, os.stat(gh).st_mode | stat.S_IEXEC)
        self.path = os.environ['PATH']
        os.environ['PATH'] = bindir + os.pathsep + self.path
        self.calls = []
        self.real = (gp.call, gp.tell_lead, gp.STATE, gp.LOG, gp.origin_of, gp.clones)
        gp.call = lambda m, p, b=None: (self.calls.append((m, p, b)), [] if m == 'GET' else {'id': 'x'})[1]
        self.told = []
        gp.tell_lead = lambda company, names: self.told.append(names)
        gp.STATE, gp.LOG = os.path.join(self.tmp, 's.json'), os.path.join(self.tmp, 'l.log')
        gp.origin_of, gp.clones = lambda f: '', lambda roots: {}

    def tearDown(self):
        os.environ['PATH'] = self.path
        gp.call, gp.tell_lead, gp.STATE, gp.LOG, gp.origin_of, gp.clones = self.real

    def test_dry_run_changes_nothing(self):
        out = gp.run(add=False, rules=RULES, company='c')
        self.assertEqual([c for c in self.calls if c[0] != 'GET'], [])
        self.assertFalse(os.path.exists(gp.STATE))
        self.assertEqual(self.told, [])
        self.assertTrue(out['add'])

    def test_add_creates_backlog_projects_with_the_worktree_policy_and_tells_the_lead_once(self):
        out = gp.run(add=True, rules=RULES, company='c')
        posts = [c for c in self.calls if c[0] == 'POST']
        self.assertEqual(len(posts), len(out['add']))
        body = posts[0][2]
        self.assertEqual(body['status'], 'backlog')
        self.assertEqual(body['executionWorkspacePolicy']['workspaceStrategy'], {'type': 'git_worktree', 'baseRef': 'main'})
        self.assertNotIn('workspace', body)
        self.assertEqual(len(self.told), 1)
        self.assertIn('shop', json.load(open(gp.STATE))['made'])
        # a second run, with those projects archived, adds nothing
        self.calls.clear()
        again = gp.run(add=True, rules=RULES, company='c', projects=[])
        self.assertEqual(again['add'], [])

    def test_credentials_never_in_output_or_state(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            gp.show(gp.run(add=True, rules=RULES, company='c'))
        blob = buf.getvalue() + open(gp.STATE).read() + open(gp.LOG).read()
        self.assertNotIn(SECRET, blob)
        self.assertNotIn('token', blob.lower())


if __name__ == '__main__':
    unittest.main()
