"""Connectors the owner gave a bot in Botyard reach its launcher, and the keys' folder is out of a bot's reach."""
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest

CREW = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(CREW, file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


guard = load('owner_guard', 'owner-guard.py')
runner = load('free_runner', 'free-runner.py')


class Connectors(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.given = os.path.join(self.dir, 'connectors')
        os.makedirs(self.given)

    def claude_args(self, env):
        """What claude-bot.sh would start Claude with, by putting a stand-in in Claude's place."""
        fake = os.path.join(self.dir, 'claude')
        with open(fake, 'w') as f:
            f.write('#!/bin/sh\nprintf "%s\\n" "$@"\n')
        os.chmod(fake, 0o755)
        out = subprocess.run(['sh', os.path.join(CREW, 'claude-bot.sh'), '--print', 'hi'], capture_output=True, text=True, cwd=self.dir,
                             env={'PATH': '/usr/bin:/bin', 'HOME': self.dir, 'BOTYARD_CLAUDE': fake, 'BOTYARD_BOT_CONNECTORS': self.given, **env})
        return out.stdout.split('\n')

    def test_a_claude_bot_given_a_connector_starts_with_it_and_one_given_none_starts_as_before(self):
        settings = os.path.join(self.dir, 'lead.claude.json')
        open(settings, 'w').write('{}')
        mine = os.path.join(self.given, 'lead.claude.json')
        json.dump({'mcpServers': {}}, open(mine, 'w'))
        self.assertNotIn('--mcp-config', self.claude_args({'BOTYARD_BOT_SETTINGS': settings}))
        json.dump({'mcpServers': {'cloudflare': {'type': 'http', 'url': 'http://127.0.0.1:5274/api/mcp/cloudflare/pass'}}}, open(mine, 'w'))
        args = self.claude_args({'BOTYARD_BOT_SETTINGS': settings})
        self.assertEqual(args[args.index('--mcp-config') + 1], mine)
        self.assertEqual(args[-3:-1], ['--print', 'hi'])
        # The way back: one word switches them off for every Claude bot.
        self.assertNotIn('--mcp-config', self.claude_args({'BOTYARD_BOT_SETTINGS': settings, 'BOTYARD_CONNECTORS': 'off'}))

    def test_an_opencode_bot_given_a_connector_runs_on_its_own_settings_plus_the_connector(self):
        own = os.path.join(self.dir, 'builder.opencode.json')
        json.dump({'permission': {'skill': {'*': 'deny'}}}, open(own, 'w'))
        env = {'OPENCODE_CONFIG': own, 'BOTYARD_BOT_CONNECTORS': self.given}
        self.assertEqual(runner.with_connectors(env), own, 'given nothing, nothing changes')
        json.dump({'mcp': {}}, open(os.path.join(self.given, 'builder.opencode.json'), 'w'))
        self.assertEqual(runner.with_connectors(env), own)
        json.dump({'mcp': {'context7': {'type': 'remote', 'url': 'http://127.0.0.1:5274/api/mcp/context7/pass', 'enabled': True}}},
                  open(os.path.join(self.given, 'builder.opencode.json'), 'w'))
        merged = runner.with_connectors(env)
        self.assertNotEqual(merged, own)
        config = json.load(open(merged))
        self.assertEqual(config['permission'], {'skill': {'*': 'deny'}})
        self.assertEqual(config['mcp']['context7']['type'], 'remote')
        self.assertEqual(os.stat(merged).st_mode & 0o777, 0o600)
        self.assertEqual(runner.with_connectors({**env, 'BOTYARD_CONNECTORS': 'off'}), own)

    def test_the_connectors_keys_are_out_of_a_bots_reach(self):
        for event in [{'tool_name': 'Bash', 'tool_input': {'command': 'cat ~/.botyard/keys/connectors.json'}},
                      {'tool_name': 'Read', 'tool_input': {'file_path': '/home/owner/.botyard/keys/connectors.json'}},
                      {'tool_name': 'Grep', 'tool_input': {'pattern': 'token', 'path': '/home/owner/.botyard/keys'}}]:
            self.assertIn('Botyard only', guard.check(event) or '', event)
        self.assertIsNone(guard.check({'tool_name': 'mcp__cloudflare__search', 'tool_input': {'query': 'workers'}}))


if __name__ == '__main__':
    unittest.main()
