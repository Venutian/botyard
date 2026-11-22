"""A free model with no benchmark grade is asked about once; a graded one, or one recorded as having no published
score, is never asked about again."""
import importlib.util
import os
import unittest

CREW = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
spec = importlib.util.spec_from_file_location('grade_new', os.path.join(CREW, 'grade-new-models.py'))
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)

TABLE = {'models': [{'match': ['glm-5.3-flash'], 'grade': '+Sonnet'}], 'no_published_score': ['LongCat 2.5']}


class GradeNew(unittest.TestCase):
    def test_only_models_with_no_grade_and_not_asked_yet_are_listed(self):
        models = ['hyperbolic/glm-5.3-flash', 'opencode/longcat-2.5-free', 'omniroute/brand-new-coder:free', 'opencode/asked-before-free']
        self.assertEqual(g.ungraded(models, TABLE, {'opencode/asked-before-free': 1}), ['omniroute/brand-new-coder:free'])

    def test_the_brief_names_each_model_and_the_file(self):
        text = g.brief(['x/new-model'])
        self.assertIn('- x/new-model', text)
        self.assertIn('model-grades.json', text)


if __name__ == '__main__':
    unittest.main()
