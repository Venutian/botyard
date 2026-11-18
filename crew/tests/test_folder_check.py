"""Every bot runs in a folder that exists, with access to exactly the folders its jobs need, and a refusal is seen. folder-check.py reads the
engine's store and each adapter's own rules on a demo yard (a temporary home); nothing of this computer is touched."""
import contextlib
import importlib.util
import io
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
import folders  # noqa: E402
import skill_sets  # noqa: E402

spec = importlib.util.spec_from_file_location('folder_check', os.path.join(HERE, '..', 'folder-check.py'))
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)

SCHEMA = """
CREATE TABLE agents (id TEXT, name TEXT, adapter_type TEXT, status TEXT, raw TEXT);
CREATE TABLE projects (id TEXT, raw TEXT);
CREATE TABLE project_workspaces (project_id TEXT, cwd TEXT, is_primary INTEGER);
CREATE TABLE jobs (id TEXT, identifier TEXT, project_id TEXT, assignee_agent_id TEXT, status TEXT, execution_workspace_id TEXT);
CREATE TABLE workspaces (id TEXT, cwd TEXT);
CREATE TABLE runs (id TEXT, agent_id TEXT, job_id TEXT, status TEXT, started_at TEXT, log_ref TEXT, result_json TEXT, exit_code INTEGER);
CREATE TABLE comments (id TEXT, created_by_run_id TEXT, deleted_at TEXT);
"""


class Yard(unittest.TestCase):
    def setUp(self):
        self.d = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.d, True)
        self.home = os.path.join(self.d, 'yard')
        self.crew = os.path.join(self.home, 'crew')
        for sub in ('crew/own', 'crew/bot-writes', 'crew/codex-safe/skills/botyard', 'keys', 'config', 'run-logs'):
            os.makedirs(os.path.join(self.home, sub))
        for f in ('guards.py', 'owner-guard.py', 'loop-guard.py', 'claude-token'):
            open(os.path.join(self.crew, f), 'w').write('x')
        open(os.path.join(self.crew, 'own', 'guard.json'), 'w').write('{}')
        self.repo = os.path.join(self.d, 'game')
        os.makedirs(os.path.join(self.repo, '.git', 'objects'))
        self.work = os.path.join(self.repo, '.botyard', 'worktrees', 'T-1')
        os.makedirs(self.work)
        self.room = os.path.join(self.d, 'room')   # a bot's own folder, outside the repo
        os.makedirs(self.room)
        self.vault = os.path.join(self.d, 'notes')
        for sub in ('decisions', 'life'):
            os.makedirs(os.path.join(self.vault, sub))
        open(os.path.join(self.vault, 'decisions', 'a.md'), 'w').write('# a\n')
        open(os.path.join(self.vault, 'life', 'b.md'), 'w').write('# b\n')
        self.env = {'BOTYARD_HOME': self.home, 'HOME': self.d, 'BOTYARD_BRAIN_DIR': self.vault}
        self.db_file = os.path.join(self.home, 'studio.db')
        self.db = sqlite3.connect(self.db_file)
        self.db.executescript(SCHEMA)
        self.saved = {k: os.environ.get(k) for k in self.env}
        os.environ.update(self.env)
        self.addCleanup(self.restore)
        orig = folders.tmp_roots
        folders.tmp_roots = lambda: ['/nowhere-tmp']   # the demo yard is itself under /tmp, which every sandbox may write
        self.addCleanup(setattr, folders, 'tmp_roots', orig)
        skill_sets.OUT = os.path.join(self.crew, 'bot-skills')
        os.makedirs(skill_sets.OUT)

    def restore(self):
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    # ── a demo yard's bots, each configured the way setup-bots does ──
    def agent(self, aid, name, adapter, cwd=None, env=None, status='idle'):
        config = {'cwd': cwd or self.room, 'env': {k: {'type': 'plain', 'value': v} for k, v in (env or {}).items()}}
        self.db.execute('INSERT INTO agents VALUES (?,?,?,?,?)', (aid, name, adapter, status, json.dumps({'adapterConfig': config})))
        self.db.commit()

    def codex(self, mode='workspace-write', roots=None):
        home = os.path.join(self.crew, 'codex-safe')
        roots = [os.path.join(self.repo, '.git'), os.path.join(self.crew, 'bot-writes')] if roots is None else roots
        open(os.path.join(home, 'config.toml'), 'w').write(f'sandbox_mode = "{mode}"\n[sandbox_workspace_write]\nwritable_roots = [{", ".join(chr(34) + r + chr(34) for r in roots)}]\n')
        return {'CODEX_HOME': home}

    def opencode(self, name, reads=None, own=None):
        perm = skill_sets.scratch_open(skill_sets.read_only(skill_sets.merged(skill_sets.brain_denials(self.env), skill_sets.protected_denials(self.env)),
                                                            [*(reads or []), *skill_sets.job_skill_folder()], own))
        path = os.path.join(skill_sets.OUT, f'{name}.opencode.json')
        json.dump({'permission': perm}, open(path, 'w'))
        return {'OPENCODE_CONFIG': path}

    def claude(self, name, denials=True):
        path = os.path.join(skill_sets.OUT, f'{name}.claude.json')
        json.dump({'permissions': {'deny': skill_sets.claude_denials(self.env)}} if denials else {}, open(path, 'w'))
        return {'BOTYARD_BOT_SETTINGS': path}

    def job(self, jid, aid, project='p1', status='in_progress', workspace=None):
        self.db.execute('INSERT INTO jobs VALUES (?,?,?,?,?,?)', (jid, jid.upper(), project, aid, status, workspace))
        self.db.commit()

    def project(self, root=None):
        self.db.execute('INSERT INTO projects VALUES (?,?)', ('p1', json.dumps({'primaryWorkspace': {'cwd': root or self.repo}})))
        self.db.commit()

    def faults(self, **kw):
        return folders.faults(self.env, self.db_file, **{'logs': False, **kw})

    def say(self, result):
        return '\n'.join(result.faults)

    def good_yard(self):
        self.project()
        self.agent('a1', 'Lead', 'codex_local', self.room, self.codex())
        self.agent('a2', 'Builder', 'opencode_local', self.room, self.opencode('builder', own=self.room))
        self.agent('a3', 'Checker', 'claude_local', self.room, self.claude('checker'))
        self.job('j1', 'a1')
        self.job('j2', 'a2')
        self.job('j3', 'a3')


class Folders(Yard):
    def test_a_yard_whose_bots_are_set_up_right_has_no_fault(self):
        self.good_yard()
        got = self.faults()
        self.assertEqual(got.faults, [], self.say(got))

    def test_a_bot_whose_folder_is_gone_is_named(self):
        self.good_yard()
        shutil.rmtree(self.room)
        self.assertIn(f'Builder: {self.room} does not exist (its own folder)', self.say(self.faults()))

    def test_a_job_in_a_project_whose_folder_is_gone_is_named(self):
        self.good_yard()
        shutil.rmtree(self.repo)
        text = self.say(self.faults())
        self.assertIn(f'Lead: {self.repo} does not exist (the project folder of J1)', text)

    def test_a_removed_bot_is_not_checked(self):
        self.good_yard()
        self.agent('a9', 'Old', 'claude_local', os.path.join(self.d, 'nowhere'), status='terminated')
        self.assertEqual(self.faults().faults, [])

    def test_codex_without_the_repo_git_data_as_a_root_cannot_commit_a_job(self):
        self.good_yard()
        self.db.execute("UPDATE agents SET raw = ? WHERE id = 'a1'", (json.dumps({'adapterConfig': {'cwd': self.room, 'env': {'CODEX_HOME': {'value': self.codex(roots=[os.path.join(self.crew, 'bot-writes')])['CODEX_HOME']}}}}),))
        self.db.commit()
        self.assertIn(f"Lead: cannot write {os.path.join(self.repo, '.git')}", self.say(self.faults()))

    def test_codex_with_a_retired_root_or_a_read_only_sandbox_is_named(self):
        self.good_yard()
        gone = os.path.join(self.d, 'retired')
        env = self.codex(roots=[os.path.join(self.repo, '.git'), os.path.join(self.crew, 'bot-writes'), gone + '/.git'])
        self.db.execute("UPDATE agents SET raw = ? WHERE id = 'a1'", (json.dumps({'adapterConfig': {'cwd': self.room, 'env': {'CODEX_HOME': {'value': env['CODEX_HOME']}}}}),))
        self.db.commit()
        self.assertIn(f'names {gone}/.git, which does not exist', self.say(self.faults()))
        env = self.codex(mode='read-only')
        self.assertIn('sandbox_mode "read-only"', self.say(self.faults()))

    def test_a_folder_the_studio_says_its_scripts_write_must_be_a_root(self):
        self.good_yard()
        scripts = os.path.join(self.d, 'scripts-write')
        os.makedirs(scripts)
        json.dump({'writes': [{'path': scripts, 'bots': ['Lead'], 'why': 'its scripts write there'}]}, open(os.path.join(self.crew, 'own', 'folder-check.json'), 'w'))
        self.assertIn(f'Lead: cannot write {scripts} (its scripts write there)', self.say(self.faults()))

    def test_opencode_must_be_able_to_read_the_folders_its_file_lists(self):
        self.good_yard()
        product = os.path.join(self.d, 'product')
        os.makedirs(product)
        self.bot_reads = {'Judge': [product]}
        self.agent('a4', 'Judge', 'opencode_local', self.room, self.opencode('judge', reads=[]))   # the file lists it, the config does not
        orig = folders.reads_of
        folders.reads_of = lambda name, env=None: [product] if name == 'Judge' else []
        self.addCleanup(setattr, folders, 'reads_of', orig)
        text = self.say(self.faults())
        self.assertIn(f'Judge: cannot read {product} (a folder its bot file says it reads ("reads"))', text)
        self.assertIn('its bot file\'s "reads" list', text)
        # with the folder in its config the fault is gone
        self.db.execute("UPDATE agents SET raw = ? WHERE id = 'a4'", (json.dumps({'adapterConfig': {'cwd': self.room, 'env': {'OPENCODE_CONFIG': {'value': self.opencode('judge', reads=[product])['OPENCODE_CONFIG']}}}}),))
        self.db.commit()
        self.assertNotIn('Judge: cannot read', self.say(self.faults()))

    def test_a_read_folder_that_holds_the_job_worktrees_would_refuse_their_edits(self):
        self.good_yard()
        self.agent('a5', 'Reader', 'opencode_local', self.d + '/room', self.opencode('reader', reads=[self.d]))
        self.job('j5', 'a5')
        text = self.say(self.faults())
        self.assertIn('Reader: cannot write', text)
        self.assertIn('the worktrees of its jobs', text)

    def test_a_missing_launcher_or_config_file_is_named(self):
        self.good_yard()
        self.db.execute("UPDATE agents SET raw = ? WHERE id = 'a2'", (json.dumps({'adapterConfig': {'cwd': self.room, 'command': os.path.join(self.d, 'gone.sh'), 'env': {'OPENCODE_CONFIG': {'value': os.path.join(self.d, 'nope.json')}}}}),))
        self.db.commit()
        text = self.say(self.faults())
        self.assertIn('Builder: its launcher', text)
        self.assertIn('Builder: its OpenCode config', text)


class Wide(Yard):
    def test_a_bot_with_no_denials_is_found_wider_than_it_should_be(self):
        self.project()
        self.agent('a3', 'Checker', 'claude_local', self.room, self.claude('checker', denials=False))
        text = self.say(self.faults())
        self.assertIn('Checker: can write', text)
        self.assertIn(os.path.join(self.home, 'keys'), text)
        self.assertIn(f"the owner's notes ({self.vault})", text)
        self.assertIn('Checker: can read', text)

    def test_the_seeders_denials_close_it(self):
        self.project()
        self.agent('a3', 'Checker', 'claude_local', self.room, self.claude('checker'))
        self.agent('a2', 'Builder', 'opencode_local', self.room, self.opencode('builder'))
        got = self.faults()
        self.assertEqual(got.faults, [], self.say(got))

    def test_the_opencode_denials_keep_the_keys_guards_and_notes_shut(self):
        perm = skill_sets.merged(skill_sets.brain_denials(self.env), skill_sets.protected_denials(self.env))
        keys = os.path.join(self.home, 'keys', 'k')
        guard = os.path.join(self.crew, 'guards.py')
        self.assertEqual(folders.decide(perm['edit'], keys, 'allow'), 'deny')
        self.assertEqual(folders.decide(perm['read'], keys, 'allow'), 'deny')
        self.assertEqual(folders.decide(perm['edit'], guard, 'allow'), 'deny')
        self.assertEqual(folders.decide(perm['read'], guard, 'allow'), 'allow', 'a guard may be read')
        self.assertEqual(folders.decide(perm['read'], os.path.join(self.vault, 'life', 'b.md'), 'allow'), 'deny')
        self.assertEqual(folders.decide(perm['read'], os.path.join(self.vault, 'decisions', 'a.md'), 'allow'), 'allow')
        self.assertEqual(folders.decide(perm['edit'], os.path.join(self.vault, 'decisions', 'a.md'), 'allow'), 'deny')
        self.assertEqual(folders.decide(perm['edit'], os.path.join(self.room, 'file'), 'allow'), 'allow')

    def test_a_bots_own_folder_holding_a_guard_is_said_so(self):
        self.agent('a1', 'Lead', 'codex_local', self.crew, self.codex())
        self.assertIn('lie inside its own folder', self.say(self.faults()))

    def test_the_studios_never_list_is_kept_too(self):
        secret = os.path.join(self.d, 'support-key')
        os.makedirs(secret)
        json.dump({'never': [{'path': secret, 'read': False, 'why': 'the support inbox key'}]}, open(os.path.join(self.crew, 'own', 'folder-check.json'), 'w'))
        self.agent('a3', 'Checker', 'claude_local', self.room, self.claude('checker', denials=False))
        self.assertIn(f'the support inbox key ({secret})', self.say(self.faults()))
        self.assertIn(f'Edit(/{secret}/**)', skill_sets.claude_denials(self.env))
        self.assertIn(f'Read(/{secret}/**)', skill_sets.claude_denials(self.env))

    def test_what_no_config_can_close_is_a_gap_not_a_fault(self):
        self.agent('a1', 'Lead', 'codex_local', self.room, self.codex())
        got = self.faults()
        self.assertTrue(any('has no rule for reading' in g for g in got.gaps))
        self.assertFalse(any('can read' in f for f in got.faults))


class Rules(unittest.TestCase):
    def test_the_last_opencode_rule_that_matches_wins(self):
        rules = {'*': 'ask', '/a/*': 'allow', '/a/secret/*': 'deny', '/a/secret/ok': 'allow'}
        self.assertEqual(folders.decide(rules, '/b/x'), 'ask')
        self.assertEqual(folders.decide(rules, '/a/x'), 'allow')
        self.assertEqual(folders.decide(rules, '/a/secret/x'), 'deny')
        self.assertEqual(folders.decide(rules, '/a/secret/ok'), 'allow')
        self.assertEqual(folders.decide('allow', '/anything'), 'allow')

    def test_claude_deny_rules(self):
        deny = {'deny': ['Edit(//k/**)', 'Read(//k/token)', 'Write']}
        self.assertTrue(folders.claude_denies(deny, ('Edit',), '/k/a/b'))
        self.assertFalse(folders.claude_denies(deny, ('Edit',), '/other/a'))
        self.assertTrue(folders.claude_denies(deny, ('Read',), '/k/token'))
        self.assertFalse(folders.claude_denies(deny, ('Read',), '/k/other'))
        self.assertTrue(folders.claude_denies(deny, ('Write',), '/anything'), 'a bare tool name denies it everywhere')


class Refusals(Yard):
    def log(self, run, lines):
        ref = f'co/a2/{run}.ndjson'
        os.makedirs(os.path.dirname(os.path.join(self.home, 'run-logs', ref)), exist_ok=True)
        with open(os.path.join(self.home, 'run-logs', ref), 'w') as f:
            for i, (stream, chunk) in enumerate(lines):
                f.write(json.dumps({'ts': '2026-11-18T10:00:00Z', 'stream': stream, 'chunk': chunk + '\n', 'seq': i}) + '\n')
        return ref

    def add_run(self, rid, ref, summary='', status='succeeded', code=0, started=None, spoke=False):
        started = started or time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())
        self.db.execute('INSERT INTO runs VALUES (?,?,?,?,?,?,?,?)', (rid, 'a2', 'j2', status, started, ref, json.dumps({'summary': summary}), code))
        if spoke:
            self.db.execute('INSERT INTO comments VALUES (?,?,?)', ('c-' + rid, rid, None))
        self.db.commit()

    def test_every_refusal_word_is_seen_with_its_path(self):
        self.good_yard()
        ref = self.log('r1', [
            ('stderr', '\x1b[93m! \x1b[0mpermission requested: external_directory (/data/product/*); auto-rejecting'),
            ('stdout', json.dumps({'type': 'item.completed', 'item': {'type': 'command_execution', 'command': 'python3 x.py',
                                                                      'aggregated_output': "OSError: [Errno 30] Read-only file system: '/yard/crew/focus.json'\nbash: /yard/crew/x.log: Read-only file system"}})),
            ('stdout', json.dumps({'type': 'item.completed', 'item': {'type': 'command_execution', 'aggregated_output': 'cannot write to /roots/outside: outside writable roots'}})),
            ('stdout', json.dumps({'type': 'item.completed', 'item': {'type': 'command_execution', 'aggregated_output': "bwrap: cannot mount `/gone/repo` (No such file or directory)"}})),
            ('stdout', json.dumps({'type': 'item.completed', 'item': {'type': 'command_execution', 'aggregated_output': "touch: cannot touch '/etc/x': Operation not permitted"}})),
            ('stdout', json.dumps({'type': 'item.completed', 'item': {'type': 'command_execution', 'aggregated_output': "cat: /srv/locked/file: Permission denied"}})),
        ])
        self.add_run('r1', ref, summary='did something')
        found = {(r['kind'], r['path']) for r in folders.refusals(self.db, self.env)}
        self.assertEqual(found, {('external_directory', '/data/product'), ('read-only', '/yard/crew/focus.json'), ('read-only', '/yard/crew/x.log'),
                                 ('writable-roots', '/roots/outside'), ('mount', '/gone/repo'), ('not-permitted', '/etc/x'), ('denied', '/srv/locked/file')})

    def test_the_models_own_words_and_the_commands_it_ran_are_not_refusals(self):
        self.good_yard()
        ref = self.log('r2', [
            ('stdout', json.dumps({'type': 'item.completed', 'item': {'type': 'agent_message', 'text': 'It failed: Read-only file system: /not/a/refusal'}})),
            ('stdout', json.dumps({'type': 'item.completed', 'item': {'type': 'command_execution', 'command': "grep 'Permission denied: /nor/this' x", 'aggregated_output': 'ok'}})),
            ('stdout', json.dumps({'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': 'Operation not permitted /nor/this'}]}})),
        ])
        self.add_run('r2', ref)
        self.assertEqual(folders.refusals(self.db, self.env), [])

    def test_a_run_that_ended_with_exit_0_and_no_report_after_a_refusal_is_a_silent_success(self):
        self.good_yard()
        refused = ('stderr', 'permission requested: external_directory (/data/product/*); auto-rejecting')
        self.add_run('r3', self.log('r3', [('stdout', 'working'), refused]), summary='')
        self.add_run('r4', self.log('r4', [refused, ('stdout', 'carried on')]), summary='')          # refused, then went on: not silent
        self.add_run('r5', self.log('r5', [('stdout', 'x'), refused]), summary='', spoke=True)       # it commented: not silent
        got = {r['run']: r['silent'] for r in folders.refusals(self.db, self.env)}
        self.assertEqual(got, {'r3': True, 'r4': False, 'r5': False})
        out = self.say(self.faults(logs=True))
        self.assertIn('Builder: refused in 3 run(s), most at /data/product (external_directory, 3); 1 of them ended with exit 0 and no report', out)

    def test_old_runs_are_left_out_and_the_check_fails_on_a_refusal(self):
        self.good_yard()
        old = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime(time.time() - 30 * 3600))
        self.add_run('r6', self.log('r6', [('stderr', 'permission requested: external_directory (/data/p/*); auto-rejecting')]), started=old)
        self.assertEqual(self.faults(logs=True).faults, [])
        self.assertEqual(self.faults(logs=True, hours=48).faults[0][:7], 'Builder')

    def test_a_huge_line_is_not_slow(self):
        self.good_yard()
        ref = self.log('r7', [('stdout', 'a ' * 3_000_000 + ' Permission denied')])
        self.add_run('r7', ref)
        t = time.time()
        folders.refusals(self.db, self.env)
        self.assertLess(time.time() - t, 5)


class Wired(unittest.TestCase):
    def test_health_and_the_timetable_run_the_check(self):
        with open(os.path.join(HERE, '..', 'health.py')) as f:
            self.assertIn("'folders'", f.read())
        with open(os.path.join(HERE, '..', 'timetable.json')) as f:
            jobs = {j['name']: j for j in json.load(f)['jobs']}
        row = jobs['folder-check']
        self.assertEqual(row['every'], '1h')
        self.assertIn('{scripts}/folder-check.py', row['command'])
        self.assertNotIn('--fix', row['command'], 'the check never changes a config')

    def test_the_cli_exits_1_on_a_fault_and_prints_one_line_each(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, True)
        with contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(check.main(['--home', d]), 1)
        self.assertIn('no bot\'s folders can be checked', out.getvalue())


if __name__ == '__main__':
    unittest.main()
