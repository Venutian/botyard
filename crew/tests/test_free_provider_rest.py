"""A 429 rests the whole provider for a while and runs go on another provider's model; a scout takes the light models."""
import importlib.util
import os
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('free_runner_rest', os.path.join(HERE, '..', 'free-runner.py'))
fred = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fred)


class Bots:
    def __init__(self, rows):
        self.rows = rows

    def free_list(self):
        return self.rows

    def free_aside(self):
        return {}

    def free_family(self, model):
        return next((f for m, f, _ in self.rows if m == model), 'x')


ROWS = [('alpha/a1', 'a', 'strong'), ('alpha/a2', 'b', 'strong'), ('beta/b1', 'c', 'strong'), ('beta/b2', 'd', 'light')]


class ProviderRest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.saved = fred.RESTING, fred.BUSY, os.environ.get('BOTYARD_FREE_TIER')
        fred.RESTING = os.path.join(self.dir, 'free-rest.json')
        fred.BUSY = os.path.join(self.dir, 'free-busy.json')
        os.environ.pop('BOTYARD_FREE_TIER', None)

    def tearDown(self):
        fred.RESTING, fred.BUSY, tier = self.saved
        if tier is None:
            os.environ.pop('BOTYARD_FREE_TIER', None)
        else:
            os.environ['BOTYARD_FREE_TIER'] = tier

    def test_a_429_rests_the_whole_provider_and_the_pick_goes_elsewhere(self):
        self.assertEqual(fred.pick(Bots(ROWS)), 'alpha/a1')
        self.assertEqual(fred.rest('alpha/a1'), 'alpha')
        self.assertIn('alpha', fred.resting())
        self.assertEqual(fred.pick(Bots(ROWS)), 'beta/b1')

    def test_the_rest_ends(self):
        fred.rest('alpha/a1', seconds=60, now=time.time() - 120)
        self.assertEqual(fred.resting(), {})
        self.assertEqual(fred.pick(Bots(ROWS)), 'alpha/a1')

    def test_with_every_provider_resting_a_run_still_gets_a_model(self):
        fred.rest('alpha/a1')
        fred.rest('beta/b1')
        self.assertEqual(fred.pick(Bots(ROWS)), 'alpha/a1')

    def test_a_scout_takes_the_light_models_and_builds_keep_the_strong(self):
        os.environ['BOTYARD_FREE_TIER'] = 'light'
        self.assertEqual(fred.pick(Bots(ROWS)), 'beta/b2')
        os.environ.pop('BOTYARD_FREE_TIER')
        self.assertEqual(fred.pick(Bots(ROWS)), 'alpha/a1')
        os.environ['BOTYARD_FREE_TIER'] = 'light'
        self.assertEqual(fred.pick(Bots([r for r in ROWS if r[2] == 'strong'])), 'alpha/a1')


if __name__ == '__main__':
    unittest.main()
