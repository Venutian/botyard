"""A provider set up by hand in OpenCode's own config, with a key in its options, counts as one the
computer can ask, like a sign-in: its models reach the free list once the scout has passed them."""
import os
import sys
import tempfile
import unittest

CREW = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
sys.path.insert(0, CREW)
import botyard_home  # noqa: E402

CONFIG = '''{
  "$schema": "https://opencode.ai/config.json",
  // a comment line, and a "// not a comment" inside a string below
  "provider": {
    "openrouter": { "models": { "x:free": { "name": "x // free" } } },
    "acme": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "https://api.acme.example/v1", "apiKey": "{file:~/.config/opencode/acme.key}" }, // trailing
      "models": { "big-coder": {} },
    },
  }
}
'''


class Configured(unittest.TestCase):
    def home(self, text=None, name='opencode.jsonc'):
        home = tempfile.mkdtemp()
        if text is not None:
            os.makedirs(os.path.join(home, '.config', 'opencode'))
            with open(os.path.join(home, '.config', 'opencode', name), 'w') as f:
                f.write(text)
        return {'HOME': home, 'BOTYARD_HOME': os.path.join(home, '.botyard')}

    def test_a_provider_with_a_key_in_its_options_counts(self):
        env = self.home(CONFIG)
        self.assertEqual(botyard_home.configured_providers(env), {'acme'})
        self.assertTrue(botyard_home.has_key('acme', env))
        self.assertFalse(botyard_home.has_key('openrouter', env), 'models listed without a key are not a sign-in')

    def test_no_config_or_a_broken_one_counts_nothing(self):
        self.assertEqual(botyard_home.configured_providers(self.home()), set())
        self.assertEqual(botyard_home.configured_providers(self.home('{ not json')), set())
        self.assertEqual(botyard_home.configured_providers(self.home('{"provider": {"acme": {"options": {}}}}', 'opencode.json')), set())


if __name__ == '__main__':
    unittest.main()
