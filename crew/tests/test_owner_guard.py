"""Bots never send mail or publish online without the owner's card; pushing to GitHub and website deploys go through."""
import importlib.util
import os
import subprocess
import unittest

CREW = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
spec = importlib.util.spec_from_file_location('owner_guard', os.path.join(CREW, 'owner-guard.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def bash(command):
    return guard.check({'tool_name': 'Bash', 'tool_input': {'command': command}})


class OwnerGuard(unittest.TestCase):
    def test_sending_and_publishing_are_refused(self):
        for command in ['npx eas submit -p ios', 'cd app && eas update --branch production', 'npm publish',
                        'echo hi | mail -s "x" a@b.c', 'sendmail -t < m.txt', 'gh release create v1.2',
                        'fastlane supply --track production', 'curl smtp://mail.example.com',
                        'curl -X POST https://hooks.slack.com/services/x', 'butler push build lighthouse/game:linux']:
            self.assertIsNotNone(bash(command), command)

    def test_pushing_and_website_deploys_are_fine(self):
        for command in ['git push origin main', 'npx wrangler pages deploy build', 'npm run deploy',
                        'eas build -p android --local', 'npm install', 'grep -r email src/', 'gh pr view 3']:
            self.assertIsNone(bash(command), command)

    def test_connector_tools_that_send_are_refused(self):
        self.assertIsNotNone(guard.check({'tool_name': 'mcp__gmail__send_message'}))
        self.assertIsNotNone(guard.check({'tool_name': 'mcp__acf17dcb__create_draft'}))
        self.assertIsNone(guard.check({'tool_name': 'mcp__gmail__search_threads'}))

    def test_a_folder_the_studio_closed_is_out_of_reach_and_its_own_script_still_runs(self):
        # A studio names folders no bot may touch in its crew/own/guard.json, each with what the bot is told.
        guard.closed_folders = lambda: [('mail-keys', 'Refused: that folder is read by mail.py only.')]
        for command in ['python3 ~/.botyard/crew/own/mail.py fetch', 'mail.py list --all']:
            self.assertIsNone(bash(command), command)
        for command in ['cat ~/.config/mail-keys/config.json', 'cp -r ~/.config/mail-keys /tmp/x',
                        'python3 -c "print(open(\'/home/owner/.config/mail-keys/config.json\').read())"']:
            self.assertIn('mail.py only', bash(command) or '', command)
        for tool, given in (('Read', {'file_path': '/home/owner/.config/mail-keys/config.json'}),
                            ('Write', {'file_path': '/home/owner/.config/mail-keys/config.json', 'content': '{}'}),
                            ('Grep', {'pattern': 'key', 'path': '/home/owner/.config/mail-keys'})):
            self.assertIsNotNone(guard.check({'tool_name': tool, 'tool_input': given}), tool)
        # A script's own source names the folder; a builder's edit of it is an edit like any other.
        self.assertIsNone(guard.check({'tool_name': 'Edit', 'tool_input': {
            'file_path': 'own/mail.py', 'old_string': 'x', 'new_string': "KEY_DIR = '~/.config/mail-keys'"}}))
        # Sending around the script is still refused, as before.
        self.assertIsNotNone(bash('curl -X POST https://api.resend.com/emails -d @mail.json'))

    def test_a_command_the_studio_closed_is_refused_and_reading_it_is_not(self):
        # A studio names commands only its owner runs in its crew/own/guard.json, as patterns, with what a bot is told.
        import re
        saved = guard.closed_commands
        guard.closed_commands = lambda: [(re.compile(r'(?:^|[;&|(]\s*)(?:\S*/)?pc-level\s+(?:none|light|medium|heavy|full)\b'), 'Refused: the PC level is the owner\'s.')]
        try:
            for command in ['pc-level full', 'pc-level none --day', 'cd x && pc-level full --help 2>&1 | head -3']:
                self.assertIn("owner's", bash(command) or '', command)
            for command in ['pc-level show', 'pc-level --help', 'grep pc-level notes.md']:
                self.assertIsNone(bash(command), command)
        finally:
            guard.closed_commands = saved

    def test_a_studio_without_closed_commands_refuses_nothing_more(self):
        self.assertIsInstance(guard.closed_commands(), list)

    def test_stand_ins_for_the_free_bots_refuse_the_same(self):
        stand_in = os.path.join(CREW, 'agy-bin', 'eas')
        refused = subprocess.run([stand_in, 'submit', '-p', 'ios'], capture_output=True, text=True)
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn('owner', refused.stderr)


if __name__ == '__main__':
    unittest.main()
