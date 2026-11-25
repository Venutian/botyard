"""23 Nov 2026: the money scout should run on the strongest free model answering. "Strongest" is measured: how surely a
model's real builds pass the checks, not its benchmark grade alone."""
import importlib.util
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
from test_bots_as_files import Studio  # noqa: E402


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, '..', file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


bots_mod = load('setup_bots_best', 'setup-bots.py')
runner = load('runner_best', 'free-runner.py')
SCORES = {'a/big': {'pass': 2, 'fail': 1}, 'b/steady': {'pass': 23, 'fail': 26}, 'c/new': {}, 'd/weak': {'pass': 2, 'fail': 17}}
ROWS = [('a/big', 'a', 'strong'), ('c/new', 'c', 'strong'), ('b/steady', 'b', 'strong'), ('d/weak', 'd', 'light')]


class Ranking(unittest.TestCase):
    def test_many_checks_count_above_a_lucky_few(self):
        self.assertGreater(bots_mod.proven(SCORES['b/steady']), bots_mod.proven(SCORES['a/big']))
        self.assertEqual(bots_mod.proven({}), 0.0)
        self.assertEqual(bots_mod.proven(None), 0.0)

    def test_the_best_measured_strong_model_comes_first_and_light_ones_never(self):
        self.assertEqual(bots_mod.free_best(ROWS, SCORES), ['b/steady', 'a/big', 'c/new'])


class Pick(unittest.TestCase):
    def setUp(self):
        d = tempfile.mkdtemp()
        self.saved = (runner.BUSY, runner.RESTING, os.environ.get('BOTYARD_FREE_TIER'))
        runner.BUSY, runner.RESTING = os.path.join(d, 'busy.json'), os.path.join(d, 'rest.json')
        with open(runner.BUSY, 'w') as f:
            json.dump({str(os.getppid()): 'b/steady'}, f)   # another live run is on the best model

        class Bots:
            FREE_SCORES = 'scores'
            def free_list(self): return ROWS
            def free_aside(self): return {}
            def free_family(self, m): return m[0]
            def read_json(self, *a): return SCORES
            free_best = staticmethod(bots_mod.free_best)
        self.bots = Bots()

    def tearDown(self):
        runner.BUSY, runner.RESTING, tier = self.saved
        os.environ.pop('BOTYARD_FREE_TIER', None)
        if tier is not None:
            os.environ['BOTYARD_FREE_TIER'] = tier

    def test_a_best_bot_takes_the_best_measured_model_even_one_in_use(self):
        os.environ['BOTYARD_FREE_TIER'] = 'best'
        self.assertEqual(runner.pick(self.bots), 'b/steady')

    def test_other_bots_still_spread_over_the_strong_models(self):
        os.environ.pop('BOTYARD_FREE_TIER', None)
        self.assertEqual(runner.pick(self.bots), 'a/big')


class Config(Studio):
    def test_a_bot_file_asks_for_the_best_free_model(self):
        os.makedirs(f'{self.crew}/bots', exist_ok=True)
        with open(f'{self.crew}/bots/scout.json', 'w') as f:
            json.dump({'name': 'Scout', 'role': 'researcher', 'ai': 'free', 'model': 'auto', 'effort': 'medium', 'tier': 'strong',
                       'mayNot': ['push', 'commit'], 'freeModels': 'best', 'pace': 'scout'}, f)
        with open(f'{self.crew}/bots/scout.md', 'w') as f:
            f.write('You are {{name}}.\n')
        self.load()
        env = self.files.build('scout', 'free')['config']['env']
        self.assertEqual((env['BOTYARD_FREE_TIER']['value'], env['BOTYARD_PACE_KIND']['value']), ('best', 'scout'))


if __name__ == '__main__':
    unittest.main()
