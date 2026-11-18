"""Each bot sees only its own skills of the PC's: a Claude bot through its own settings, an OpenCode bot
through its own config, and every skill on the PC is in the Library's index with who has it or why not."""
import importlib.util
import json
import os
import re
import tempfile
import unittest

CREW = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
spec = importlib.util.spec_from_file_location('skill_sets', os.path.join(CREW, 'skill_sets.py'))
sets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sets)

SKILLS = [
    {'name': 'qa', 'kind': 'user', 'dir': '/s/qa', 'plugin': None},
    {'name': 'roblox-ui', 'kind': 'user', 'dir': '/s/roblox-ui', 'plugin': None},
    {'name': 'botyard', 'kind': 'user', 'dir': '/s/botyard', 'plugin': None},
    {'name': 'seo-audit', 'kind': 'plugin', 'dir': '/p/seo/skills/seo-audit', 'plugin': 'claude-seo@m'},
    {'name': 'frontend-design', 'kind': 'plugin', 'dir': '/p/fd/skills/frontend-design', 'plugin': 'frontend-design@o'},
]


class SkillSets(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = sets.OUT, sets.INDEX
        sets.OUT, sets.INDEX = self.tmp.name, os.path.join(self.tmp.name, 'skills-index.json')

    def tearDown(self):
        sets.OUT, sets.INDEX = self.old
        self.tmp.cleanup()

    def test_a_claude_bot_keeps_the_crew_hooks_and_sees_only_its_set(self):
        env = sets.write_for('Builder', 'claude_local', SKILLS, want={'qa', 'botyard', 'frontend-design'})
        settings = json.load(open(env['BOTYARD_BOT_SETTINGS']['value']))
        self.assertIn('PreToolUse', settings['hooks'])
        self.assertEqual(settings['skillOverrides'], {'roblox-ui': 'off'})
        self.assertEqual(settings['enabledPlugins'], {'claude-seo@m': False, 'frontend-design@o': True})

    def test_an_opencode_bot_is_denied_all_but_its_set_and_finds_its_plugin_skills(self):
        env = sets.write_for('Scout', 'opencode_local', SKILLS, want={'qa', 'seo-audit'})
        config = json.load(open(env['OPENCODE_CONFIG']['value']))
        self.assertEqual(config['permission']['skill']['*'], 'deny')
        self.assertEqual(config['permission']['skill']['seo-audit'], 'allow')
        self.assertNotIn('roblox-ui', config['permission']['skill'])
        self.assertEqual(config['skills']['paths'], ['/p/seo/skills'])

    def test_other_engines_and_bots_without_a_set_are_left_alone(self):
        self.assertEqual(sets.write_for('Builder', 'gemini_local', SKILLS, want={'qa'}), {})
        sets.sets = lambda: {}
        # A bot with no list sees every skill (nothing is switched off) and still gets the settings that keep what no bot may touch closed.
        env = sets.write_for('Clerk', 'claude_local', SKILLS)
        settings = json.load(open(env['BOTYARD_BOT_SETTINGS']['value']))
        self.assertNotIn('skillOverrides', settings)
        self.assertIn('PreToolUse', settings['hooks'])
        config = json.load(open(sets.write_for('Clerk', 'opencode_local', SKILLS)['OPENCODE_CONFIG']['value']))
        self.assertNotIn('skill', config['permission'])
        self.assertIn('external_directory', config['permission'])

    def test_the_index_says_who_has_each_skill_or_why_nobody_does(self):
        given = {'Builder': {'qa', 'botyard'}, 'Checker': {'botyard'}}
        sets.left_out = lambda: [(re.compile('^roblox-'), 'No project of ours is on this engine.')]
        rows = {r['name']: r for r in sets.write_index(SKILLS, given)}
        self.assertEqual(rows['botyard']['bots'], ['Builder', 'Checker'])
        self.assertTrue(rows['botyard']['everyBot'])
        self.assertEqual(rows['roblox-ui']['bots'], [])
        self.assertIn('engine', rows['roblox-ui']['leftOut'])
        self.assertEqual(rows['qa']['id'], sets.write_index(SKILLS, given)[0]['id'])
        self.assertTrue(os.path.exists(sets.INDEX))

    def test_every_name_in_a_set_is_a_skill_on_this_pc(self):
        if not os.path.isdir(sets.USER_SKILLS):
            self.skipTest('no ~/.claude/skills here')
        self.assertEqual(sets.check(), {})


if __name__ == '__main__':
    unittest.main()
