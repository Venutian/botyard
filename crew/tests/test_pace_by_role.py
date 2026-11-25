"""23 Nov 2026: a scout was paced as a scout only because it took the light free models, so moving it to strong models
would have paced it as a build. The pace now follows the bot's role (pace in its file), apart from the models it takes."""
import importlib.util
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
import crew_set  # noqa: E402,F401
from test_bots_as_files import Studio  # noqa: E402

spec = importlib.util.spec_from_file_location('runner_pace_role', os.path.join(HERE, '..', 'free-runner.py'))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class Kind(unittest.TestCase):
    def test_the_role_sets_the_pace_whatever_the_tier(self):
        self.assertEqual(runner.pace_kind({'BOTYARD_PACE_KIND': 'scout'}), 'scout')
        self.assertEqual(runner.pace_kind({'BOTYARD_PACE_KIND': 'scout', 'BOTYARD_CHECKER': '1'}), 'scout')

    def test_without_a_role_the_old_signs_still_hold(self):
        self.assertEqual(runner.pace_kind({'BOTYARD_FREE_TIER': 'light'}), 'scout')
        self.assertEqual(runner.pace_kind({'BOTYARD_CHECKER': '1'}), 'check')
        self.assertEqual(runner.pace_kind({'BOTYARD_PACE_KIND': 'nonsense'}), 'build')
        self.assertEqual(runner.pace_kind({}), 'build')

    def test_a_strong_scout_takes_strong_models(self):
        os.environ.pop('BOTYARD_FREE_TIER', None)
        self.assertFalse(runner.light_first())


class Config(Studio):
    def setUp(self):
        super().setUp()
        os.makedirs(f'{self.crew}/bots', exist_ok=True)
        for slug, extra in (('scout', {'pace': 'scout'}), ('light', {'freeModels': 'light'}), ('plain', {})):
            with open(f'{self.crew}/bots/{slug}.json', 'w') as f:
                json.dump({'name': slug.capitalize(), 'role': 'researcher', 'ai': 'free', 'model': 'auto', 'effort': 'medium',
                           'tier': 'strong', 'mayNot': ['push', 'commit'], **extra}, f)
            with open(f'{self.crew}/bots/{slug}.md', 'w') as f:
                f.write('You are {{name}}.\n')
        self.load()

    def env(self, slug):
        return self.files.build(slug, 'free')['config']['env']

    def test_a_scout_on_strong_models_is_paced_as_a_scout(self):
        env = self.env('scout')
        self.assertEqual(env['BOTYARD_PACE_KIND']['value'], 'scout')
        self.assertNotIn('BOTYARD_FREE_TIER', env)

    def test_the_tier_and_the_pace_are_set_apart(self):
        self.assertEqual(self.env('light')['BOTYARD_FREE_TIER']['value'], 'light')
        self.assertNotIn('BOTYARD_PACE_KIND', self.env('light'))
        self.assertNotIn('BOTYARD_PACE_KIND', self.env('plain'))


if __name__ == '__main__':
    unittest.main()
