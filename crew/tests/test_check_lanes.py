#!/usr/bin/env python3
"""A checker never lets a check wait on busy free models: the checker's file lists lanes ("fallbacks" marked
"for": "checks") in the order they are tried, and fallback.py picks the first that answers now. Free models first
(with a provider's rest after a 429), then each lane, and Claude only when every other is out. A different family than
the build's is taken where one answers. A lane is an agent of its own that setup-bots.py makes from the checker's file;
the checker herself is never moved off the free models."""
import importlib.util
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
sys.path.insert(0, HERE)
import crew_set  # noqa: E402
from test_bots_as_files import Studio  # noqa: E402

spec = importlib.util.spec_from_file_location('fallback_lanes', os.path.join(HERE, '..', 'fallback.py'))
fb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fb)

ORDER = ['free', 'codex', 'gemini', 'claude']
FAMILY = {'opencode/deepseek-free': 'deepseek', 'openrouter/qwen:free': 'qwen'}.get


class Picking(unittest.TestCase):
    def pick(self, ready, **kw):
        return fb.pick_engine(ORDER, ready, free_family=FAMILY, **kw)

    def test_free_models_come_first(self):
        got = self.pick({'free': 'opencode/deepseek-free', 'codex': True, 'gemini': True, 'claude': True})
        self.assertEqual((got['ai'], got['model']), ('free', 'opencode/deepseek-free'))

    def test_busy_or_resting_free_models_move_the_check_to_codex(self):
        self.assertEqual(self.pick({'codex': True, 'gemini': True, 'claude': True})['ai'], 'codex')

    def test_a_check_that_has_waited_its_budget_moves_down_even_if_a_free_model_answers(self):
        got = self.pick({'free': 'opencode/deepseek-free', 'codex': True}, waited=fb.CHECK_WAIT)
        self.assertEqual(got['ai'], 'codex')
        self.assertEqual(self.pick({'free': 'opencode/deepseek-free', 'codex': True}, waited=fb.CHECK_WAIT - 1)['ai'], 'free')

    def test_the_order_is_free_then_codex_then_gemini(self):
        self.assertEqual(self.pick({'gemini': True, 'claude': True})['ai'], 'gemini')

    def test_claude_is_the_last_resort(self):
        self.assertEqual(self.pick({'claude': True})['ai'], 'claude')
        self.assertEqual(self.pick({'claude': True, 'codex': False})['ai'], 'claude')
        self.assertNotEqual(self.pick({'claude': True, 'gemini': True})['ai'], 'claude')

    def test_a_waiting_free_model_beats_nothing(self):
        got = self.pick({'free': 'opencode/deepseek-free'}, waited=10 * fb.CHECK_WAIT)
        self.assertEqual(got['ai'], 'free')
        self.assertIn('nothing else answers', got['why'])

    def test_nothing_answering_picks_nothing(self):
        self.assertIsNone(self.pick({}))

    def test_a_codex_builds_check_goes_to_gemini_not_codex(self):
        got = self.pick({'codex': True, 'gemini': True, 'claude': True}, builder_family='openai')
        self.assertEqual(got['ai'], 'gemini')
        self.assertFalse(got['sameFamily'])

    def test_a_free_model_of_the_builders_family_yields_to_another_family(self):
        got = self.pick({'free': 'opencode/deepseek-free', 'codex': True}, builder_family='deepseek')
        self.assertEqual(got['ai'], 'codex')

    def test_the_same_family_is_taken_when_no_other_answers_and_said(self):
        got = self.pick({'codex': True}, builder_family='openai')
        self.assertEqual((got['ai'], got['sameFamily']), ('codex', True))

    def test_the_same_family_still_beats_claude(self):
        self.assertEqual(self.pick({'codex': True, 'claude': True}, builder_family='openai')['ai'], 'codex')

    def test_a_projects_checks_can_refuse_an_ai(self):
        self.assertEqual(self.pick({'claude': True, 'gemini': True}, never=('claude',))['ai'], 'gemini')
        self.assertIsNone(self.pick({'claude': True}, never=('claude',)))
        self.assertIsNone(self.pick({'codex': True, 'gemini': True, 'claude': True}, never=('codex', 'gemini', 'claude')))

    def test_free_only_projects_never_leave_free_models(self):
        spec = {'freeOnly': ['Hidden Project']}
        self.assertEqual(fb.checker_never(spec, 'Hidden Project'), ('codex', 'gemini', 'claude'))
        self.assertEqual(fb.checker_never(spec, 'Other'), ())


class Resting(unittest.TestCase):
    def test_a_lane_that_was_refused_rests_and_comes_back(self):
        import tempfile
        old = fb.CHECK_REST
        fb.CHECK_REST = os.path.join(tempfile.mkdtemp(), 'rest.json')
        try:
            fb.rest_engine('codex', 100, now=1000)
            self.assertEqual(fb.engines_resting(now=1050), {'codex': 1100})
            self.assertEqual(fb.engines_resting(now=1101), {})
        finally:
            fb.CHECK_REST = old


class Bots:
    """What engines_ready reads from setup-bots."""
    def __init__(self, signed=('codex', 'gemini', 'claude')):
        self.signed = set(signed)

    def free_aside(self):
        return {}

    def free_list(self):
        return [('opencode/deepseek-free', 'deepseek', 'strong'), ('openrouter/qwen:free', 'qwen', 'strong'), ('nvidia/x', 'x', 'light')]

    def free_family(self, model):
        return FAMILY(model) or 'x'

    def signed_in(self, ai):
        return ai in self.signed


class Ready(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.dir = tempfile.mkdtemp()
        self.saved = (fb.CHECK_REST, fb.READY_CACHE, fb.THINKER, fb.runner, fb.gemini_ready, fb.antigravity_has_room)
        fb.CHECK_REST, fb.READY_CACHE, fb.THINKER = (f'{self.dir}/rest.json', f'{self.dir}/ready.json', f'{self.dir}/thinker.json')
        self.rested = {}
        fb.runner = lambda: type('R', (), {'resting': staticmethod(lambda now=None: self.rested)})()
        fb.gemini_ready, fb.antigravity_has_room = (lambda: True), (lambda: True)

    def tearDown(self):
        fb.CHECK_REST, fb.READY_CACHE, fb.THINKER, fb.runner, fb.gemini_ready, fb.antigravity_has_room = self.saved

    def test_everything_answers(self):
        got = fb.engines_ready(Bots(), build_family='deepseek', now=1000)
        self.assertEqual(got, {'free': 'openrouter/qwen:free', 'codex': True, 'gemini': True, 'claude': True})

    def test_a_provider_resting_after_a_429_is_passed_over(self):
        self.rested = {'openrouter': 2000, 'opencode': 2000}
        got = fb.engines_ready(Bots(), now=1000)
        self.assertNotIn('free', got)

    def test_light_free_models_do_not_count(self):
        self.rested = {'openrouter': 2000, 'opencode': 2000}
        self.assertNotIn('free', fb.engines_ready(Bots(), now=1000))   # only the light nvidia one is left

    def test_codex_is_out_when_the_thinkers_moved_to_gemini(self):
        with open(fb.THINKER, 'w') as f:
            json.dump({'on': 'gemini'}, f)
        self.assertNotIn('codex', fb.engines_ready(Bots(), now=1000))

    def test_a_lane_that_is_not_signed_in_or_has_no_agent_is_skipped(self):
        self.assertNotIn('gemini', fb.engines_ready(Bots(signed=('codex',)), now=1000))
        self.assertNotIn('claude', fb.engines_ready(Bots(), have={'codex'}, now=1000))

    def test_a_rested_lane_is_skipped(self):
        fb.rest_engine('codex', 600, now=1000)
        self.assertNotIn('codex', fb.engines_ready(Bots(), now=1100))
        self.assertIn('codex', fb.engines_ready(Bots(), now=1700))

    def test_check_engine_ties_it_together(self):
        self.rested = {'openrouter': 2000, 'opencode': 2000}
        got = fb.check_engine(Bots(), ORDER, builder_ai='codex', have={'codex', 'gemini', 'claude'})
        self.assertEqual(got['ai'], 'gemini')


class Lanes(Studio):
    def setUp(self):
        super().setUp()
        os.makedirs(f'{self.crew}/bots', exist_ok=True)
        for slug, ai, extra in (('lead', 'codex', {}), ('checker', 'free', {
                'role': 'checker', 'fallbacks': {'codex': {'model': 'gpt-x', 'for': 'checks'}, 'gemini': {'for': 'checks'},
                                                  'claude': {'model': 'claude-sonnet-5-5', 'for': 'checks', 'mayNot': ['push', 'edit']}}})):
            with open(f'{self.crew}/bots/{slug}.json', 'w') as f:
                json.dump({'name': slug.capitalize(), 'role': extra.get('role', 'lead'), 'ai': ai, 'model': 'auto' if ai == 'free' else 'gpt-x',
                           'effort': 'medium', 'tier': 'strong', 'fallbacks': {'gemini': {'model': 'gemini-3.8-flash-high'}, **extra.get('fallbacks', {})}
                           if slug == 'checker' else {}, 'mayNot': ['push', 'commit'], 'checker': slug == 'checker'}, f)
            with open(f'{self.crew}/bots/{slug}.md', 'w') as f:
                f.write('You are {{name}}.\n')
        self.load()

    def test_the_order_is_the_order_of_the_file(self):
        self.assertEqual(self.files.check_order('checker'), ['free', 'gemini', 'codex', 'claude'])

    def test_only_marked_fallbacks_are_lanes(self):
        self.assertEqual(self.files.check_lanes('checker'), ['gemini', 'codex', 'claude'])
        self.assertEqual(self.files.check_lanes('lead'), [])

    def test_a_lane_is_built_only_when_the_file_lists_it(self):
        lane = self.files.build('checker', 'codex', lane=True)
        self.assertEqual((lane['name'], lane['adapter'], lane['rulesFile']), ('Checker on Codex', 'codex_local', 'checker-codex'))
        self.assertEqual(lane['laneOf'], 'Checker')
        with self.assertRaises(crew_set.PaidEngine):
            self.files.build('lead', 'gemini', lane=True)

    def test_without_lane_a_free_bot_is_still_never_moved(self):
        with self.assertRaises(crew_set.PaidEngine):
            self.files.build('checker', 'codex')

    def test_the_claude_lane_may_not_edit(self):
        lane = self.files.build('checker', 'claude', lane=True)
        self.assertIn('--disallowedTools', lane['config']['extraArgs'])
        self.assertIn('Edit', lane['config']['extraArgs'][1])

    def test_a_seed_makes_each_lane_beside_the_checker(self):
        self.m.main()
        names = {a['name']: a['adapterType'] for a in self.engine.agents.values()}
        self.assertEqual(names['Checker'], 'opencode_local')
        self.assertEqual({n: t for n, t in names.items() if n.startswith('Checker on')},
                         {'Checker on Gemini': 'gemini_local', 'Checker on Codex': 'codex_local', 'Checker on Claude': 'claude_local'})
        self.assertTrue(os.path.isfile(f'{self.crew}/checker-codex.md'))

    def test_a_dry_seed_writes_nothing_for_lanes(self):
        self.m.main(dry=True)
        self.assertEqual([a for a in self.engine.agents.values() if a['name'].startswith('Checker on')], [])
        self.assertFalse(os.path.exists(f'{self.crew}/checker-codex.md'))


class Routing(Lanes):
    """route_checks moves a waiting check down the order; one on its way is not touched."""

    def setUp(self):
        super().setUp()
        import tempfile
        d = tempfile.mkdtemp()
        self.saved = (fb.setup, fb.CHECK_REST, fb.READY_CACHE, fb.THINKER, fb.runner, fb.SWITCHES, fb.gemini_ready, fb.antigravity_has_room)
        fb.CHECK_REST, fb.READY_CACHE, fb.THINKER, fb.SWITCHES = (f'{d}/rest.json', f'{d}/ready.json', f'{d}/thinker.json', f'{d}/switches.log')
        self.rested = {'openrouter': 1e12, 'opencode': 1e12}
        fb.runner = lambda: type('R', (), {'resting': staticmethod(lambda now=None: self.rested)})()
        fb.gemini_ready, fb.antigravity_has_room = (lambda: True), (lambda: True)
        files, bots = self.files, Bots()
        bots.crew = lambda: files
        fb.setup = lambda: bots
        self.agents = [{'id': 'a-checker', 'name': 'Checker'}, {'id': 'a-codex', 'name': 'Checker on Codex'},
                       {'id': 'a-gemini', 'name': 'Checker on Gemini'}, {'id': 'a-claude', 'name': 'Checker on Claude'}]
        self.jobs = {'a-checker': [], 'a-codex': [], 'a-gemini': [], 'a-claude': []}
        self.sent = []

    def tearDown(self):
        fb.setup, fb.CHECK_REST, fb.READY_CACHE, fb.THINKER, fb.runner, fb.SWITCHES, fb.gemini_ready, fb.antigravity_has_room = self.saved

    def call(self, method, path, body=None):
        self.sent.append((method, path, body))
        if path.endswith('/agents'):
            return self.agents
        if 'heartbeat-runs' in path:
            return []
        if '/issues?assigneeAgentId=' in path:
            return self.jobs[path.split('assigneeAgentId=')[1].split('&')[0]]
        return {}

    def job(self, text='', title='Check NGE-1: x'):
        return {'id': 'j1', 'identifier': 'NGE-2', 'title': title, 'createdAt': '2026-11-18T10:00:00Z', 'description': text}

    def test_a_check_waiting_while_free_models_rest_goes_to_the_first_lane(self):
        self.jobs['a-checker'] = [self.job()]
        # the file's own order is free, gemini, codex, claude
        moves = fb.route_checks(self.call, now=1795000000)
        self.assertEqual(len(moves), 1)
        patched = [b for m, p, b in self.sent if m == 'PATCH']
        self.assertEqual(patched, [{'assigneeAgentId': 'a-gemini'}])
        self.assertTrue(any(p == '/agents/a-gemini/wakeup' for _m, p, _b in self.sent))

    def test_a_codex_build_is_not_checked_on_codex(self):
        self.jobs['a-checker'] = [self.job('<!-- built-by: codex -->')]
        fb.route_checks(self.call, now=1795000000)
        self.assertEqual([b for m, p, b in self.sent if m == 'PATCH'], [{'assigneeAgentId': 'a-gemini'}])

    def test_a_check_with_a_live_run_is_left_alone(self):
        self.jobs['a-checker'] = [{**self.job(), 'executionRunId': 'r1'}]
        self.assertEqual(fb.route_checks(self.call, now=1795000000), [])

    def test_a_job_that_is_not_a_check_is_left_alone(self):
        self.jobs['a-checker'] = [self.job(title='Audit: repo, 18 Nov')]
        self.assertEqual(fb.route_checks(self.call, now=1795000000), [])

    def test_a_free_only_check_never_leaves_free_models(self):
        self.jobs['a-checker'] = [self.job('<!-- check-engines: free -->')]
        self.assertEqual(fb.route_checks(self.call, now=1795000000), [])

    def test_a_check_on_a_lane_does_not_flip_back_up_the_order(self):
        self.rested = {}
        self.jobs['a-codex'] = [self.job()]
        self.assertEqual(fb.route_checks(self.call, now=1795000000 + 5), [])

    def test_a_check_on_a_resting_lane_moves_on(self):
        self.rested = {}
        fb.rest_engine('codex', 600, now=1795000000)
        import datetime
        fresh = datetime.datetime.fromtimestamp(1795000005, datetime.timezone.utc).isoformat().replace('+00:00', 'Z')
        self.jobs['a-codex'] = [{**self.job(), 'updatedAt': fresh}]
        fb.route_checks(self.call, now=1795000010)
        self.assertEqual([b['assigneeAgentId'] for m, p, b in self.sent if m == 'PATCH'], ['a-checker'])

    def test_a_studio_with_no_lanes_changes_nothing(self):
        self.agents = [{'id': 'a-checker', 'name': 'Checker'}]
        self.jobs['a-checker'] = [self.job()]
        self.assertEqual(fb.route_checks(self.call, now=1795000000), [])


if __name__ == '__main__':
    unittest.main()
