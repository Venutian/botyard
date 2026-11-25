"""A free model is light when its builds pass clearly less often than the crew's, not under a flat 50%: the checks
fail most builds whatever the model, and with the flat line no free model was strong (23 Nov)."""
import importlib.util
import os
import sys
import unittest

CREW = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
sys.path.insert(0, CREW)
spec = importlib.util.spec_from_file_location('setup_bots_tier', os.path.join(CREW, 'setup-bots.py'))
sb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sb)

# The real counts of 23 Nov, shortened: the crew passed 26% of its checked builds.
SCORES = {'a/ernie': {'pass': 23, 'fail': 26}, 'b/deepseek': {'pass': 14, 'fail': 15}, 'c/nemotron': {'pass': 2, 'fail': 5},
          'd/flint': {'pass': 1, 'fail': 18}, 'e/hy4': {'pass': 1, 'fail': 51}, 'f/mimo': {'pass': 0, 'fail': 16}}


class Relative(unittest.TestCase):
    def test_the_crew_rate_is_every_check_together(self):
        self.assertAlmostEqual(sb.crew_rate(SCORES), 41 / 172)
        self.assertIsNone(sb.crew_rate({}))
        self.assertIsNone(sb.crew_rate({'x': 'junk'}))

    def test_models_near_the_crew_stay_strong_and_clearly_worse_ones_are_light(self):
        rate = sb.crew_rate(SCORES)
        got = {m: sb.weak(s, rate) for m, s in SCORES.items()}
        self.assertEqual(got, {'a/ernie': False, 'b/deepseek': False, 'c/nemotron': False,
                               'd/flint': True, 'e/hy4': True, 'f/mimo': True})

    def test_few_checks_say_nothing_and_never_passing_is_light(self):
        self.assertFalse(sb.weak({'pass': 0, 'fail': 2}, 0.5))
        self.assertTrue(sb.weak({'pass': 0, 'fail': 3}, None))
        self.assertFalse(sb.weak({'pass': 1, 'fail': 9}, None))
        self.assertFalse(sb.weak({}, 0.3))
        self.assertFalse(sb.weak('junk', 0.3))

    def test_free_list_uses_it(self):
        saved = (sb.read_json, sb.FREE, sb.reachable, sb.offered, sb.credit_only_providers)
        sb.FREE = [('a/ernie', 'ernie', 'strong'), ('d/flint', 'flint', 'strong')]
        sb.read_json = lambda path, default=None: SCORES if path == sb.FREE_SCORES else ([] if path == sb.FREE_FOUND else {})
        sb.reachable = lambda *a: True
        sb.offered = lambda *a: True
        sb.credit_only_providers = lambda: set()
        try:
            rows = sb.free_list(listed=['a/ernie', 'd/flint'])
        finally:
            sb.read_json, sb.FREE, sb.reachable, sb.offered, sb.credit_only_providers = saved
        self.assertEqual({m: t for m, _, t in rows}, {'a/ernie': 'strong', 'd/flint': 'light'})


if __name__ == '__main__':
    unittest.main()
