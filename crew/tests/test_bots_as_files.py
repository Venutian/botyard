"""The bots are files (crew/bots, and a studio's own in its home folder) and setup-bots.py seeds them
through the engine's API.

- What the files generate for every bot the repository ships is held byte for byte to
  fixtures/bots-golden.json; CAPTURE_FIXTURE=1 writes it anew after a change that is meant.
- A seed never writes over what the owner changed in Botyard since the last seed.
- A studio's own copies win over the repository's, a studio that lists its own bots has exactly those,
  and --dry writes nothing.
"""
import importlib.util
import json
import os
import re
import sys
import tempfile
import unittest

CREW = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
sys.path.insert(0, CREW)
import crew_set  # noqa: E402
from crew_set import read_json, read_text  # noqa: E402
import botyard_home  # noqa: E402

GOLDEN = json.load(open(os.path.join(CREW, 'tests', 'fixtures', 'bots-golden.json'), encoding='utf8'))
ON = {'': None, 'claude': 'claude', 'gemini': 'gemini', 'codex': 'codex', 'sonnet': 'claude'}


def seeder():
    spec = importlib.util.spec_from_file_location('setup_bots_under_test', os.path.join(CREW, 'setup-bots.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.skills_env = lambda bot: {}
    module.free_start = lambda: '<free>'
    return module


class Engine:
    """Stands in for the engine: keeps bots, answers the calls the seeder makes."""
    def __init__(self):
        self.agents, self.sent = {}, []

    def call(self, method, path, body=None):
        self.sent.append((method, path, body))
        if method == 'GET' and path.endswith('/agents'):
            return [dict(a) for a in self.agents.values()]
        if method == 'POST' and path.endswith('/agents'):
            agent = {'id': 'id-' + crew_set.slug_of(body['name']), 'status': 'idle', **{k: v for k, v in body.items() if k != 'replaceAdapterConfig'}}
            self.agents[agent['id']] = agent
            return dict(agent)
        if method == 'PATCH' and path.startswith('/agents/'):
            agent = self.agents.setdefault(path.split('/')[2], {'id': path.split('/')[2], 'status': 'idle'})
            agent.update({k: v for k, v in body.items() if k != 'replaceAdapterConfig'})
            return dict(agent)
        if method == 'POST' and path.endswith(('/pause', '/resume')):
            agent = self.agents[path.split('/')[2]]
            agent['status'] = 'paused' if path.endswith('/pause') else 'idle'
            return dict(agent)
        return {'id': 'chat-1'} if '/chats/' in path else {}


class Studio(unittest.TestCase):
    """A studio in a temp folder, laid out the default way so the fixture's paths match."""

    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.crew = f'{self.home}/.botyard/crew'
        # A home chosen by hand is told to every run; these studios are laid out the default way.
        chosen = os.environ.pop('BOTYARD_HOME', None)
        if chosen is not None:
            self.addCleanup(os.environ.__setitem__, 'BOTYARD_HOME', chosen)
        os.makedirs(self.crew)
        self.places = crew_set.Places(env={'HOME': self.home, 'PATH': ''}, home=self.home, crew=self.crew, projects=f'{self.home}/work',
                                      codex='/usr/lib/chatgpt/resources/codex')
        self.m = seeder()
        self.engine = Engine()
        self.m.call = self.engine.call
        self.m.soft = self.engine.call
        self.m.botyard_home = type('home', (), {**vars(botyard_home), 'studio_id': staticmethod(lambda env=None: 'studio-1')})
        self.m.safe_folder = lambda: None
        self.m.launchers = lambda: None
        self.m.skill_sets = type('skills', (), {'write_index': staticmethod(lambda *a: None), 'check': staticmethod(lambda *a: {}), 'inventory': staticmethod(lambda: [])})
        self.m.THINKER = f'{self.crew}/thinker.json'
        self.m.signed_in = lambda ai: False
        self.load()

    def load(self):
        self.files = crew_set.CrewSet(places=self.places, own=f'{self.crew}/bots')
        self.m.use(self.files)

    def norm(self, value):
        return json.loads(json.dumps(value).replace(self.home, '{{home}}'))


VARIANTS = [(slug, None) for slug in ('lead', 'ruler', 'reviewer', 'senior-builder', 'claude-builder', 'builder', 'checker', 'researcher')]


class SameAsTheFixture(Studio):
    def test_every_shipped_bot_is_generated_byte_for_byte(self):
        existing = {self.files.spec(slug)['name']: {'id': f'id-{slug}'} for slug in self.files.slugs()}
        captured = {}
        for slug, ai in VARIANTS:
            key = slug + (f' on {ai}' if ai else '')
            self.engine.sent.clear()
            bot = self.files.build(slug, ai, self.m.free_start)
            self.m.put(bot, existing, existing['Lead']['id'])
            method, path, body = self.engine.sent[0]
            text = read_text(body['adapterConfig']['instructionsFilePath'])
            got = self.norm({'call': [method, path], 'body': body, 'text': text})
            if os.environ.get('CAPTURE_FIXTURE'):
                captured[key] = got
                continue
            self.assertEqual(got['text'], GOLDEN[key]['text'], f'{key}: instructions')
            self.assertEqual(got, GOLDEN[key], key)
        if captured:
            with open(os.path.join(CREW, 'tests', 'fixtures', 'bots-golden.json'), 'w', encoding='utf8') as f:
                json.dump(captured, f, indent=1, sort_keys=True, ensure_ascii=False)

    def test_the_fixture_covers_every_bot_in_the_crew(self):
        self.assertEqual({slug for slug, ai in VARIANTS if not ai}, set(self.files.slugs()))
        self.assertEqual(set(GOLDEN), {slug + (f' on {ai}' if ai else '') for slug, ai in VARIANTS})


class TheFiles(unittest.TestCase):
    def sets(self):
        yield 'bots', crew_set.CrewSet(own='', places=crew_set.Places(env={'HOME': '/home/owner', 'PATH': ''}, crew='/home/owner/.botyard/crew', projects='/home/owner/work'))

    def test_every_bot_file_is_whole_and_renders_with_nothing_left_over(self):
        for name, files in self.sets():
            self.assertIn(files.crew['lead'], files.slugs(), name)
            for slug in files.slugs():
                spec = files.spec(slug)
                self.assertTrue(crew_set.SLUG.match(slug))
                self.assertTrue(os.path.isfile(os.path.join(files.dir, f'{slug}.md')), f'{name}/{slug}.md')
                self.assertIn(spec['ai'], crew_set.AIS)
                self.assertIn('push', spec['mayNot'], f'{slug}: every bot is kept from pushing')
                if spec['reportsTo']:
                    self.assertIn(spec['reportsTo'], files.slugs())
                for ai in [spec['ai'], *spec['fallbacks']]:
                    text = files.render(slug, ai, 'CREW IDS, for assigneeAgentId: a 1')
                    self.assertNotRegex(text, r'\{\{[^{}\n]*\}\}', f'{name}/{slug} on {ai}: a mark was not filled in')
                    self.assertTrue(text.startswith(f"You are {spec['name']}"), f'{name}/{slug}')
                    self.assertIn(files.places.finish, text, f'{name}/{slug}: every bot is told how to close a job')
                    self.assertIsInstance(files.build(slug, ai, lambda: 'm')['config']['timeoutSec'], int)

    def test_a_template_and_its_text_go_both_ways(self):
        for name, files in self.sets():
            for slug in files.slugs():
                ids = 'CREW IDS, for assigneeAgentId: a 1, b 2'
                text = files.render(slug, crew_ids=ids)
                self.assertEqual(files.unrender(slug, text, crew_ids=ids), files.template(slug), f'{name}/{slug}')

    def test_no_secret_and_no_value_of_a_variable_is_in_a_bot_file(self):
        for name, files in self.sets():
            for slug in files.slugs():
                raw = json.load(open(os.path.join(files.dir, f'{slug}.json'), encoding='utf8'))
                self.assertTrue(all(isinstance(v, str) and re.match(r'^[A-Z][A-Z0-9_]*$', v) for v in raw.get('variables', [])), slug)
                self.assertNotIn('env', raw)


class EditsInStudioSurvive(Studio):
    def seed(self, **kw):
        self.load()
        self.m.main(**kw)

    def bob(self):
        return self.engine.agents['id-claude-builder']

    def test_a_seed_keeps_what_the_owner_changed_and_writes_it_back(self):
        self.seed()
        self.assertEqual(len(self.engine.agents), 8)
        self.assertFalse(os.path.exists(f'{self.crew}/bots/claude-builder.json'), 'nothing of the owner\'s yet')
        rules = self.bob()['adapterConfig']['instructionsFilePath']
        # The owner edits the Claude builder in Botyard: a title, a model, the time limit, and a line of his instructions.
        self.bob()['title'] = 'Small fixes'
        self.bob()['adapterConfig'].update(model='claude-haiku-5-5', timeoutSec=30 * 60)
        mine = read_text(rules).replace('You are a Claude Code build session', 'Keep every change small. You are a Claude Code build session')
        open(rules, 'w').write(mine)
        self.seed()
        self.assertEqual(self.bob()['title'], 'Small fixes')
        self.assertEqual(self.bob()['adapterConfig']['model'], 'claude-haiku-5-5')
        self.assertEqual(self.bob()['adapterConfig']['timeoutSec'], 1800)
        self.assertEqual(self.bob()['adapterConfig']['maxTurnsPerRun'], 150, 'what the owner left alone is still the file\'s')
        self.assertTrue(self.bob()['adapterConfig']['command'].endswith('claude-bot.sh'), 'the seeder keeps the launcher')
        self.assertIn('Keep every change small.', read_text(rules))
        # Written back into the studio's own files: only what differs, and shared paragraphs as their marks.
        self.assertEqual(read_json(f'{self.crew}/bots/claude-builder.json'), {'title': 'Small fixes', 'model': 'claude-haiku-5-5', 'minutes': 30})
        template = read_text(f'{self.crew}/bots/claude-builder.md')
        self.assertIn('Keep every change small.', template)
        self.assertIn('{{shared: footer}}', template)
        self.assertIn('{{shared: build-rules}}', template)
        self.assertNotIn(self.home, template)
        # And a third seed changes nothing: the owner's copy is the studio's now.
        before = json.dumps(self.bob(), sort_keys=True), read_text(rules)
        self.seed()
        self.assertEqual((json.dumps(self.bob(), sort_keys=True), read_text(rules)), before)

    def test_a_change_in_the_files_still_reaches_a_bot_the_owner_did_not_touch(self):
        self.seed()
        os.makedirs(f'{self.crew}/bots', exist_ok=True)
        json.dump({'minutes': 20, 'effort': 'low'}, open(f'{self.crew}/bots/claude-builder.json', 'w'))
        open(f'{self.crew}/bots/checker.md', 'w').write('You are {{name}}.\n\nBe kind.\n\n{{shared: footer}}\n')
        self.seed()
        self.assertEqual(self.bob()['adapterConfig']['timeoutSec'], 1200)
        self.assertEqual(self.bob()['adapterConfig']['effort'], 'low')
        self.assertEqual(self.bob()['adapterConfig']['model'], 'claude-sonnet-5-5')
        checker = read_text(self.engine.agents['id-checker']['adapterConfig']['instructionsFilePath'])
        self.assertTrue(checker.startswith('You are Checker.\n\nBe kind.\n\nFINISH EVERY JOB'))

    def test_changing_the_ai_in_studio_gets_that_ais_launcher_and_safety(self):
        self.seed()
        # Botyard's editor sends a clean config for the new AI, with no command of the crew's.
        self.bob().update(adapterType='opencode_local')
        self.bob()['adapterConfig'] = {'model': 'opencode/x-free', 'variant': 'high', 'timeoutSec': 5400,
                                       'instructionsFilePath': self.bob()['adapterConfig']['instructionsFilePath']}
        self.seed()
        config = self.bob()['adapterConfig']
        self.assertTrue(config['command'].endswith('free-runner.py'))
        self.assertIn('GIT_CONFIG_GLOBAL', config['env'])
        self.assertEqual(read_json(f'{self.crew}/bots/claude-builder.json')['ai'], 'free')

    def test_what_studios_editor_writes_by_name_is_the_owners_choice(self):
        self.seed()
        self.bob()['adapterConfig'].update(mayNot=['push', 'edit'], skills=['review', 'qa'])
        self.seed()
        self.assertEqual(read_json(f'{self.crew}/bots/claude-builder.json'), {'mayNot': ['edit', 'push'], 'skills': ['review', 'qa']})
        self.assertIn(',Edit,', self.bob()['adapterConfig']['extraArgs'][1], 'and the seeder enforces it')

    def test_a_setting_missing_in_the_engine_is_never_taken_for_the_owners_choice(self):
        # A bot seeded by an older version (the variable had another name), or rewritten clean by the
        # editor, has nothing that says what it may not do. That is not "the owner forbade commits".
        self.seed()
        builder = self.engine.agents['id-builder']
        del builder['adapterConfig']['env']['BOTYARD_GIT_ALLOW']
        self.bob()['adapterConfig']['extraArgs'] = []
        self.seed()
        self.assertEqual(builder['adapterConfig']['env']['BOTYARD_GIT_ALLOW']['value'], 'commit', 'the free builder can still commit')
        self.assertIn('Bash(git push:*)', self.bob()['adapterConfig']['extraArgs'][1], 'and the Claude builder has its deny list back')
        self.assertFalse(os.path.exists(f'{self.crew}/bots/builder.json'), 'nothing was written into the studio\'s own files')
        self.assertFalse(os.path.exists(f'{self.crew}/bots/claude-builder.json'))

    def test_dry_writes_nothing_anywhere(self):
        self.seed()
        self.bob()['title'] = 'Small fixes'

        def snapshot():
            out = {}
            for root, _, names in os.walk(self.home):
                for name in names:
                    out[os.path.join(root, name)] = read_text(os.path.join(root, name))
            return out
        before, agents = snapshot(), json.dumps(self.engine.agents, sort_keys=True)
        self.engine.sent.clear()
        self.seed(dry=True)
        self.assertEqual(snapshot(), before)
        self.assertEqual(json.dumps(self.engine.agents, sort_keys=True), agents)
        self.assertEqual({method for method, _, _ in self.engine.sent}, {'GET'})

    def test_only_seeds_one_bot(self):
        self.seed(only='checker')
        self.assertEqual(list(self.engine.agents), ['id-checker'])

    def test_on_and_off_follow_the_file_only_when_it_changes(self):
        self.seed()
        self.engine.agents['id-claude-builder']['status'] = 'paused'     # the health check rests him
        self.seed()
        self.assertEqual(self.bob()['status'], 'paused', 'a seed does not wake a bot something else paused')
        json.dump({'on': False}, open(f'{self.crew}/bots/checker.json', 'w'))
        self.seed()
        self.assertEqual(self.engine.agents['id-checker']['status'], 'paused')


class ShippedCrew(Studio):
    def test_a_new_studio_gets_a_whole_crew_that_works_on_free_models_alone(self):
        self.m.main()
        bots = {a['name']: a for a in self.engine.agents.values()}
        self.assertEqual(set(bots), {'Lead', 'Ruler', 'Reviewer', 'Senior Builder', 'Claude Builder', 'Builder', 'Checker', 'Researcher'})
        free = ('Lead', 'Builder', 'Checker', 'Researcher')
        self.assertEqual({bots[n]['adapterType'] for n in free}, {'opencode_local'})
        self.assertEqual({bots[n]['status'] for n in free}, {'idle'}, 'the crew runs with only free models signed in')
        for name in ('Ruler', 'Reviewer', 'Senior Builder', 'Claude Builder'):
            self.assertEqual(bots[name]['status'], 'paused', f'{name} is off until Claude is signed in')
        self.assertEqual(bots['Checker']['adapterConfig']['env']['BOTYARD_CHECKER']['value'], '1', 'kept off the build\'s model family')
        self.assertEqual(bots['Builder']['adapterConfig']['env']['BOTYARD_GIT_ALLOW']['value'], 'commit')
        for name in ('Checker', 'Lead', 'Researcher'):
            self.assertNotIn('BOTYARD_GIT_ALLOW', bots[name]['adapterConfig']['env'], f'{name} cannot commit')
        for name in ('Ruler', 'Reviewer'):
            self.assertIn(',Edit,', bots[name]['adapterConfig']['extraArgs'][1], f'{name} cannot edit')
        self.assertEqual(bots['Builder']['reportsTo'], bots['Lead']['id'])
        lead = read_text(bots['Lead']['adapterConfig']['instructionsFilePath'])
        for name in bots:
            if name != 'Lead':
                self.assertIn(f"{name} {bots[name]['id']}", lead, 'the lead knows who to hand work to after one seed')
        self.assertEqual((self.m._lazy('BUILDER'), self.m._lazy('CHECKER'), self.m._lazy('LEAD')), ('Builder', 'Checker', 'Lead'))
        self.assertEqual(self.m.names_with_role('lead', 'ruler'), ['Lead', 'Ruler'])
        self.assertEqual(self.m.names_with_role('builder'), ['Senior Builder', 'Claude Builder', 'Builder'])
        self.assertEqual(bots['Lead']['role'], 'ceo', 'the engine is told its own word for a lead')
        # Claude gets signed in: the next seed switches those four on, and a later one leaves them alone.
        self.m.signed_in = lambda ai: True
        self.m.main()
        self.assertEqual({a['status'] for a in self.engine.agents.values()}, {'idle'})
        self.engine.agents[bots['Reviewer']['id']]['status'] = 'paused'     # the owner pauses it in Botyard
        self.m.main()
        self.assertEqual(self.engine.agents[bots['Reviewer']['id']]['status'], 'paused')

    def test_the_rules_the_scripts_and_the_bots_share_are_in_every_bot_that_needs_them(self):
        text = {slug: self.files.render(slug) for slug in self.files.slugs()}
        for slug in ('builder', 'claude-builder', 'senior-builder'):
            for words in ('OUTCOME: MET, NOT MET, or REPORT ONLY', 'CHANGE: NONE', 'COMMIT: the full hash', 'PHASES:', 'botyard-wait tmp/job.done'):
                self.assertIn(words, text[slug], f'{slug}: {words}')
        for slug in ('checker', 'reviewer'):
            self.assertIn('VERDICT: PASS, or VERDICT: FAIL', text[slug])
            self.assertIn('Fail only on BLOCKING items', text[slug])
        for words in ('RULING:', 'WHY:', 'COSTS:', 'NEXT:'):
            self.assertIn(words, text['ruler'])
        for words in ('OUTCOME:', 'PROOF:', 'PHASES', 'Ruling: ...', 'Free first', 'NEVER LEAVE A JOB IN LIMBO', 'in_review'):
            self.assertIn(words, text['lead'], words)
        for slug, body in text.items():
            self.assertIn('ALWAYS ASK THE OWNER FIRST', body, slug)
            self.assertTrue(self.files.spec(slug)['does'], f'{slug}: the editor shows what this bot is for')

    def test_every_bot_has_a_role_a_tier_and_a_look_from_its_file(self):
        rows = {row['slug']: row for row in self.files.listing()['bots']}
        self.assertEqual({slug: row['role'] for slug, row in rows.items()},
                         {'lead': 'lead', 'ruler': 'ruler', 'reviewer': 'reviewer', 'senior-builder': 'builder', 'claude-builder': 'builder',
                          'builder': 'builder', 'checker': 'checker', 'researcher': 'researcher'})
        self.assertEqual(len({row['look']['colour'] for row in rows.values()}), 8, 'every bot wears its own colour')
        self.assertEqual(len({row['look']['hat'] for row in rows.values()}), 8)
        for row in rows.values():
            self.assertIn(row['tier'], ('light', 'strong'))
            self.assertRegex(row['look']['colour'], r'^#[0-9a-f]{6}$')
        self.assertEqual(self.files.with_role('builder', ai='free'), ['builder'])


class OwnCrew(Studio):
    """A studio's own bots live in its home folder; the repository never holds them."""
    def own(self, name, text):
        os.makedirs(f'{self.crew}/bots/shared', exist_ok=True)
        with open(f'{self.crew}/bots/{name}', 'w', encoding='utf8') as f:
            f.write(text if isinstance(text, str) else json.dumps(text))

    def test_a_bot_added_in_the_home_folder_joins_the_shipped_crew(self):
        self.own('scout.json', {'name': 'Scout', 'role': 'researcher', 'ai': 'free', 'reportsTo': 'lead', 'mayNot': ['push', 'commit'],
                                'look': {'colour': '#f08a1c', 'hat': 'tophat'}})
        self.own('scout.md', 'You are {{name}}.\n\nRun {{own~}}/find.py.\n\n{{shared: footer}}\n')
        self.load()
        self.m.main()
        self.assertEqual(len(self.engine.agents), 9)
        scout = self.engine.agents['id-scout']
        self.assertEqual(scout['role'], 'researcher')
        self.assertIn('Run ~/.botyard/crew/own/find.py.', read_text(scout['adapterConfig']['instructionsFilePath']))

    def test_a_studio_that_lists_its_own_bots_has_exactly_those(self):
        self.own('crew.json', {'studio': 'Lighthouse Works', 'lead': 'boss', 'bots': ['boss', 'maker']})
        self.own('boss.json', {'name': 'Boss', 'role': 'lead', 'ai': 'codex', 'model': 'gpt-x', 'codexOut': 'claude', 'mayNot': ['push', 'edit']})
        self.own('boss.md', 'You are {{name}} at {{studio}}.\n\n{{crew-ids}}\n\n{{shared: footer}}\n')
        self.own('maker.json', {'name': 'Maker', 'role': 'builder', 'tier': 'light', 'ai': 'free', 'reportsTo': 'boss', 'skills': ['qa']})
        self.own('maker.md', 'You are {{name}}.\n\n{{shared: closing}}\n')
        self.own('shared/closing.md', 'Close with {{finish}}.\n')
        self.load()
        self.m.main()
        self.assertEqual({a['name'] for a in self.engine.agents.values()}, {'Boss', 'Maker'})
        self.assertEqual((self.m._lazy('LEAD'), self.m._lazy('BUILDER'), self.m._lazy('CHECKER')), ('Boss', 'Maker', None))
        boss = read_text(self.engine.agents['id-boss']['adapterConfig']['instructionsFilePath'])
        self.assertTrue(boss.startswith('You are Boss at Lighthouse Works.'))
        self.assertIn('FINISH EVERY JOB', boss, "the repository's shared paragraphs are still there to use")
        self.assertIn(self.files.places.finish, read_text(self.engine.agents['id-maker']['adapterConfig']['instructionsFilePath']))


class CodexOut(Studio):
    def setUp(self):
        super().setUp()
        os.makedirs(f'{self.crew}/bots')
        with open(f'{self.crew}/bots/lead.json', 'w') as f:
            json.dump({'ai': 'codex', 'model': 'gpt-x', 'effort': 'medium', 'codexOut': 'claude'}, f)
        self.load()

    def test_codex_bots_move_where_their_file_says_and_back(self):
        self.m.main()
        lead = self.engine.agents['id-lead']
        self.assertEqual(lead['adapterType'], 'codex_local')
        self.m.move_thinkers('gemini', back=1)
        self.assertEqual((lead['adapterType'], lead['adapterConfig']['model']), ('claude_local', 'claude-haiku-5-5'))
        self.assertIn(',Edit,', lead['adapterConfig']['extraArgs'][1], 'on Claude a thinker cannot edit')
        self.m.move_thinkers('codex')
        self.assertEqual(lead['adapterType'], 'codex_local')
        self.assertEqual(read_json(f'{self.crew}/bots/lead.json'), {'ai': 'codex', 'model': 'gpt-x', 'effort': 'medium', 'codexOut': 'claude'},
                         'a move by the crew is not an edit of the owner\'s')


class FreeModelsWithNoKey(unittest.TestCase):
    def test_the_list_is_shorter_without_a_key_and_whole_with_one(self):
        m = seeder()
        m.FREE_FOUND = m.FREE_SCORES = m.FREE_OUT = m.FREE_LIMITS = '/nonexistent/x.json'
        # Never what this PC's tool lists today or which providers asked for credits here: that changes by the day.
        m.tool_models = lambda: []
        providers = lambda rows: {model.split('/')[0] for model, _, _ in rows}
        none = m.free_list(has_key=lambda name: False)
        self.assertEqual(providers(none), {'opencode'}, "OpenCode's own free models need no key")
        self.assertTrue(any(tier == 'strong' for _, _, tier in none), 'a builder can still build')
        self.assertTrue(len({family for _, family, tier in none if tier == 'strong'}) >= 2, 'and a checker finds another family')
        self.assertEqual(len(m.free_list(has_key=lambda name: True)), len(m.FREE))
        self.assertEqual(providers(m.free_list(has_key=lambda name: name == 'nvidia')), {'opencode', 'nvidia'})

    def test_a_studio_with_its_home_chosen_tells_its_runs(self):
        m = seeder()
        home = tempfile.mkdtemp()
        files = crew_set.CrewSet(own='', places=crew_set.Places(env={'HOME': home, 'PATH': ''}, crew=f'{home}/crew'))
        m.use(files)
        bot = files.build('builder', None, lambda: 'm')
        os.environ['BOTYARD_HOME'] = home
        try:
            self.assertEqual(m.body_for(bot, 'x.md', {}, None)['adapterConfig']['env']['BOTYARD_HOME']['value'], home)
        finally:
            del os.environ['BOTYARD_HOME']
        self.assertNotIn('BOTYARD_HOME', m.body_for(bot, 'x.md', {}, None)['adapterConfig']['env'])


class Installer(unittest.TestCase):
    def test_it_links_the_crew_from_any_clone_into_an_empty_home_and_installs_nothing_else(self):
        import subprocess
        home = tempfile.mkdtemp()
        out = subprocess.run(['sh', os.path.join(CREW, 'install.sh')], capture_output=True, text=True,
                             env={'HOME': home, 'PATH': '/usr/bin:/bin'})
        self.assertEqual(out.returncode, 0, out.stderr)
        crew = f'{home}/.botyard/crew'
        for name in ('fallback.py', 'claude-bot.sh', 'free-runner.py', 'botyard_home.py', 'setup-bots.py', 'agy-bin', 'bot-settings.json'):
            self.assertEqual(os.path.realpath(f'{crew}/{name}'), os.path.join(CREW, name))
        self.assertFalse(os.path.exists(f'{home}/.config'), 'nothing but the links')


if __name__ == '__main__':
    unittest.main()
