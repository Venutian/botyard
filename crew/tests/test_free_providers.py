"""The free providers file decides each provider's key variable, which of its models are free, and the OpenCode block of one
OpenCode does not know (21 Nov 2026)."""
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
import botyard_home  # noqa: E402

spec = importlib.util.spec_from_file_location('free_scout', os.path.join(HERE, 'free-scout.py'))
scout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scout)


class FreeProviders(unittest.TestCase):
    def test_every_entry_is_whole(self):
        providers = botyard_home.free_providers()
        self.assertGreaterEqual(len(providers), 6)
        for p in providers:
            self.assertRegex(p['id'], r'^[a-z0-9-]+$')
            self.assertTrue(p['signup'].startswith('https://'), p['id'])
            self.assertTrue(p['env'] or isinstance(p.get('opencode'), dict), f"{p['id']}: no key and no OpenCode block")
        self.assertNotIn('groq', [p['id'] for p in providers], 'its free plan is too small for a coding run (free-scout.py)')

    def test_keyed_providers_give_their_variable(self):
        self.assertEqual(botyard_home.KEY_VARS['google'], 'GEMINI_API_KEY')
        self.assertEqual(botyard_home.KEY_VARS['openrouter'], 'OPENROUTER_API_KEY')
        self.assertNotIn('pollinations', botyard_home.KEY_VARS)

    def test_which_models_are_free(self):
        self.assertTrue(scout.is_free('google/gemini-3.5-flash'))
        self.assertFalse(scout.is_free('google/gemini-3.5-pro'), 'Pro bills the key')
        self.assertFalse(scout.is_free('google/gemini-3.5-flash-lite'), 'too small')
        self.assertTrue(scout.is_free('mistral/devstral-medium-2'))
        self.assertTrue(scout.is_free('sambanova/gpt-oss-120b'))
        self.assertTrue(scout.is_free('cohere/command-a-03-2025'))
        self.assertTrue(scout.is_free('pollinations/openai-fast'))
        self.assertTrue(scout.is_free('openrouter/x/y:free'))
        self.assertFalse(scout.is_free('openrouter/x/y'))

    def test_the_providers_file_for_tools_started_without_a_bots_settings(self):
        home = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, home, True)
        env = {**os.environ, 'BOTYARD_HOME': home}
        path = botyard_home.providers_config(env)
        with open(path) as f:
            blocks = json.load(f)['provider']
        self.assertIn('pollinations', blocks)
        self.assertEqual(blocks['pollinations']['options']['baseURL'], 'https://text.pollinations.ai/openai')
        before = os.stat(path).st_mtime_ns
        self.assertEqual(botyard_home.providers_config(env), path)
        self.assertEqual(os.stat(path).st_mtime_ns, before, 'written only when it differs')


if __name__ == '__main__':
    unittest.main()
