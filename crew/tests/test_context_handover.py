"""A prompt that outgrew a model's context window hands the run to another model instead of failing it."""
import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('free_runner_ctx', os.path.join(HERE, '..', 'free-runner.py'))
fred = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fred)


class Context(unittest.TestCase):
    def test_context_errors_are_recognised_and_others_are_not(self):
        for text in ('This model\'s maximum context length is 131072 tokens', 'prompt is too long: 200000 tokens', 'Input exceeds the context window'):
            self.assertTrue(fred.context_error(text), text)
        for text in ('Too Many Requests', 'network error', '', None):
            self.assertFalse(fred.context_error(text), text)


if __name__ == '__main__':
    unittest.main()
