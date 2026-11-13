"""The free list offers only models the tool has, and a check never runs on the build's family when
another answers; when none does, the check says so on its own job and the lead hears of it."""
import importlib.util
import json
import os
import sys
import tempfile
import time
import unittest

CREW = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
sys.path.insert(0, CREW)


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(CREW, file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bots = load('setup_bots_offer', 'setup-bots.py')
fred = load('free_runner_offer', 'free-runner.py')


class ToolListing(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.saved = bots.FREE_LISTED
        bots.FREE_LISTED = os.path.join(self.dir, 'free-listed.json')

    def tearDown(self):
        bots.FREE_LISTED = self.saved

    def test_a_model_its_provider_no_longer_lists_is_not_offered(self):
        listed = {'opencode/deepseek-v4.1-flash-free', 'opencode/glm-5.3-flash-free', 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free'}
        rows = [m for m, _, _ in bots.free_list(has_key=lambda p: True, listed=listed)]
        self.assertIn('opencode/deepseek-v4.1-flash-free', rows)
        self.assertNotIn('opencode/flint-40b-free', rows, 'OpenCode lists its models and this is not one')
        self.assertNotIn('openrouter/cohere/north-mini-code:free', rows, 'OpenRouter lists its models and this is not one')
        # A provider that lists nothing here (no key, never asked) decides nothing about its models.
        self.assertIn('nvidia/nvidia/nemotron-3-ultra-550b-a55b', rows)

    def test_with_no_listing_known_the_list_is_as_written(self):
        self.assertEqual(bots.tool_models(), None)
        self.assertEqual([m for m, _, _ in bots.free_list(has_key=lambda p: True, listed=set())], [m for m, _, _ in bots.free_list(has_key=lambda p: True)])

    def test_a_listing_is_kept_and_read_back_and_an_empty_or_old_one_is_not_used(self):
        self.assertFalse(bots.keep_tool_models([]), 'offline is not every model going away')
        self.assertTrue(bots.keep_tool_models(['opencode/a-free', 'not a model', 'opencode/b-free']))
        self.assertEqual(bots.tool_models(), {'opencode/a-free', 'opencode/b-free'})
        self.assertIsNone(bots.tool_models(now=time.time() + bots.LISTED_FOR + 60))

    def test_a_run_asks_the_tool_again_when_the_listing_is_old_and_not_when_it_is_fresh(self):
        asked = []

        class Out:
            stdout = 'opencode/deepseek-v4.1-flash-free\nopencode/glm-5.3-flash-free\n'

        run = lambda *a, **k: asked.append(a[0]) or Out()
        self.assertTrue(fred.list_again(bots, run=run))
        self.assertEqual(asked[0][1:], ['models'])
        self.assertFalse(fred.list_again(bots, run=run), 'fresh: not asked again')
        self.assertEqual(len(asked), 1)
        self.assertEqual(bots.tool_models(), {'opencode/deepseek-v4.1-flash-free', 'opencode/glm-5.3-flash-free'})


class Bots:
    OPENCODE = 'opencode'

    def __init__(self, rows):
        self.rows = rows

    def free_list(self):
        return self.rows

    def free_aside(self):
        return {}

    def free_family(self, model):
        return next((f for m, f, _ in self.rows if m == model), 'x')


class CheckerFamily(unittest.TestCase):
    def setUp(self):
        self.saved = fred.claim, set(fred.NEVER), fred.note
        fred.claim = lambda model: set()
        # Nothing a test does is written to a real studio's log.
        fred.note = lambda line: None
        fred.NEVER.clear()
        if hasattr(fred.say_same_family, 'said'):
            del fred.say_same_family.said

    def tearDown(self):
        fred.claim, fred.note = self.saved[0], self.saved[2]
        fred.NEVER.clear()
        fred.NEVER.update(self.saved[1])

    def test_a_check_takes_another_family_even_a_lighter_model_before_the_builds_own(self):
        rows = [('opencode/step-5-free', 'step', 'strong'), ('opencode/step-5-mini-free', 'step', 'strong'), ('opencode/glm-free', 'glm', 'light')]
        fred.NEVER.add('step')
        b = Bots(rows)
        self.assertEqual(fred.pick(b), 'opencode/glm-free')
        self.assertFalse(fred.same_family(b, 'opencode/glm-free'))

    def test_a_build_with_no_check_family_picks_as_before(self):
        rows = [('opencode/step-5-free', 'step', 'strong'), ('opencode/glm-free', 'glm', 'light')]
        self.assertEqual(fred.pick(Bots(rows)), 'opencode/step-5-free')

    def test_when_only_the_builds_family_answers_the_check_runs_and_says_so_once(self):
        rows = [('opencode/step-5-free', 'step', 'strong')]
        fred.NEVER.add('step')
        b = Bots(rows)
        model = fred.pick(b)
        self.assertEqual(model, 'opencode/step-5-free', 'a check now, rather than a check that waits')
        self.assertTrue(fred.same_family(b, model))
        posted = []
        self.assertTrue(fred.say_same_family(b, model, post=lambda text: posted.append(text) or True))
        self.assertFalse(fred.say_same_family(b, model, post=lambda text: posted.append(text) or True), 'once a run')
        (text,) = posted
        self.assertTrue(text.startswith(fred.SAME_FAMILY))
        self.assertIn('not an independent check', text)


pipeline = load('pipeline_offer', 'pipeline.py')


class PipelineHearsIt(unittest.TestCase):
    def test_a_pass_from_a_same_family_check_is_told_to_the_lead_as_not_independent(self):
        comments = {'c1': [{'body': 'SAME-FAMILY CHECK: no free model of another family answers now...'},
                           {'body': 'VERDICT: PASS', 'authorAgentId': 'checker'}],
                    'c2': [{'body': 'VERDICT: PASS', 'authorAgentId': 'checker'}]}
        saved = pipeline.call
        pipeline.call = lambda method, path, body=None: comments.get(path.split('/')[2], [])
        try:
            self.assertTrue(pipeline.same_family('c1'))
            self.assertFalse(pipeline.same_family('c2'))
        finally:
            pipeline.call = saved


if __name__ == '__main__':
    unittest.main()
