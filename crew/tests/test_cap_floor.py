"""The owner's session floor (capFloor in guard.json): the pace never lowers the cap under it, and never above 5."""
import importlib.util
import json
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('token_guard', os.path.join(HERE, '..', 'token-guard.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

NOW = 1_000_000_000.0
HOUR = 3600


def run(old_cap, floor, week, moved=NOW):
    d = tempfile.mkdtemp()
    guard.PACE = os.path.join(d, 'pace.json')
    json.dump({'cap': old_cap, 'moved': moved, 'samples': [[NOW - 3 * HOUR, 0.1]]}, open(guard.PACE, 'w'))
    return guard.pace({'week': week, 'resets': NOW + 100 * HOUR}, now=NOW, floor=floor)


class CapFloor(unittest.TestCase):
    def test_setting_default_and_clamp(self):
        self.assertEqual(guard.cap_floor({}), 1)
        self.assertEqual(guard.cap_floor({'capFloor': 4}), 4)
        self.assertEqual(guard.cap_floor({'capFloor': 9}), 5)
        self.assertEqual(guard.cap_floor({'capFloor': 0}), 1)
        self.assertEqual(guard.cap_floor({'capFloor': 'x'}), 1)

    def test_floor_4_lifts_a_computed_cap_of_1(self):
        self.assertEqual(run(1, 4, 0.1)['cap'], 4)

    def test_floor_does_not_let_a_fast_spend_lower_it(self):
        self.assertEqual(run(4, 4, 0.7, 0)['cap'], 4)

    def test_floor_above_5_clamps_to_5(self):
        self.assertEqual(run(1, 9, 0.1)['cap'], 5)

    def test_default_floor_still_lowers(self):
        self.assertEqual(run(4, 1, 0.7, 0)['cap'], 3)


if __name__ == '__main__':
    unittest.main()
