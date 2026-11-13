"""The owner moves the Claude ceilings from Botyard; the guard follows them and never lets the lead's fall below the crew's."""
import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('token_guard', os.path.join(HERE, '..', 'token-guard.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class Ceilings(unittest.TestCase):
    def test_defaults_when_nothing_is_set(self):
        self.assertEqual(guard.ceilings({}), (0.90, 0.97))

    def test_the_owners_ceilings_are_used(self):
        self.assertEqual(guard.ceilings({'weekCeiling': 0.8, 'leadCeiling': 0.95}), (0.8, 0.95))

    def test_tony_never_stops_before_the_crew(self):
        self.assertEqual(guard.ceilings({'weekCeiling': 0.99, 'leadCeiling': 0.9}), (0.99, 0.99))

    def test_nonsense_falls_back(self):
        self.assertEqual(guard.ceilings({'weekCeiling': 'high', 'leadCeiling': 0}), (0.90, 0.97))
        self.assertEqual(guard.ceilings({'weekCeiling': 0.1, 'leadCeiling': 7}), (0.5, 1.0))


if __name__ == '__main__':
    unittest.main()
