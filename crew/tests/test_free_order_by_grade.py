"""The free models are tried best first by their published coding benchmark (model-grades.json), whatever the
provider; a model no benchmark covers comes after the graded Haiku-level ones, and a weak one last."""
import importlib.util
import os
import unittest

CREW = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
spec = importlib.util.spec_from_file_location('setup_bots', os.path.join(CREW, 'setup-bots.py'))
bots = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bots)

TABLE = {'models': [
    {'match': ['glm-5.3-flash'], 'grade': '+Sonnet'},
    {'match': ['nemotron-3.5-super-vl'], 'grade': '+Haiku'},
    {'match': ['nemotron-3.5-lightning'], 'grade': '-Haiku'},
]}


class FreeOrder(unittest.TestCase):
    def test_a_better_benchmark_grade_ranks_first_on_any_provider(self):
        rank = lambda m: bots.grade_rank(m, TABLE)
        self.assertGreater(rank('opencode/glm-5.3-flash-free'), rank('kilo/nvidia/nemotron-3.5-super-vl:free'))
        self.assertEqual(rank('hyperbolic/glm-5.3-flash'), rank('opencode/glm-5.3-flash-free'))
        self.assertGreater(rank('opencode/deepseek-v4.1-flash-free'), rank('opencode/nemotron-3.5-lightning-free'), 'ungraded sits above a weak one')
        self.assertLess(rank('opencode/deepseek-v4.1-flash-free'), rank('kilo/nvidia/nemotron-3.5-super-vl:free'))

    def test_the_real_table_puts_glm_flash_before_nemotron_super(self):
        self.assertGreater(bots.grade_rank('opencode/glm-5.3-flash-free'), bots.grade_rank('kilo/nvidia/nemotron-3.5-super-vl:free'))


if __name__ == '__main__':
    unittest.main()
