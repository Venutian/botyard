"""19 Nov 2026: a headless run had nobody to answer OpenCode's "ask", so writes to plain /tmp were refused and the run
ended on the refusal; the notes rules refused any command naming a folder called money/ or life/; and the connectors
file name grew a ".with-connectors" each start."""
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
import skill_sets  # noqa: E402

spec = importlib.util.spec_from_file_location('free_runner_headless', os.path.join(HERE, '..', 'free-runner.py'))
fred = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fred)


def matches(rules, text):
    """OpenCode's rule order: the last pattern that matches wins."""
    import fnmatch
    got = None
    for pattern, verdict in rules.items():
        if fnmatch.fnmatch(text, pattern):
            got = verdict
    return got


class Headless(unittest.TestCase):
    def setUp(self):
        self.vault = tempfile.mkdtemp(prefix='vault-')
        for d in ('money', 'life', 'decisions'):
            os.makedirs(os.path.join(self.vault, d))
        open(os.path.join(self.vault, 'money', 'x.md'), 'w').write('---\ntitle: x\n---\nprivate\n')
        open(os.path.join(self.vault, 'decisions', 'y.md'), 'w').write('---\ntitle: y\n---\nwork\n')

    def perms(self):
        import brain
        with mock.patch.object(brain, 'folder', lambda env=None: self.vault):
            return skill_sets.brain_denials()

    def test_outside_the_run_is_refused_not_asked(self):
        out = self.perms()['external_directory']
        self.assertEqual(out['*'], 'deny')
        self.assertNotIn('ask', out.values())
        self.assertEqual(skill_sets.read_only({}, ['/srv'])['external_directory']['*'], 'deny')

    def test_the_notes_rules_name_the_vault_not_any_folder_called_money(self):
        shell = self.perms()['bash']
        self.assertEqual(matches(shell, 'ls pages/money'), 'allow')
        self.assertEqual(matches(shell, 'cat own/lifecycle/plan.md'), 'allow')
        self.assertEqual(matches(shell, f'cat {self.vault}/money/x.md'), 'deny')
        self.assertEqual(matches(shell, f'cat ~/{os.path.basename(self.vault)}/money/x.md'), 'deny')


class Connectors(unittest.TestCase):
    def test_one_merged_file_whatever_it_starts_from(self):
        d = tempfile.mkdtemp()
        own = os.path.join(d, 'bot.opencode.json')
        json.dump({'permission': {}}, open(own, 'w'))
        given = os.path.join(d, 'given')
        os.makedirs(given)
        json.dump({'mcp': {'svc': {'type': 'remote'}}}, open(os.path.join(given, 'bot.opencode.json'), 'w'))
        first = fred.with_connectors({'OPENCODE_CONFIG': own}, folder=given)
        again = fred.with_connectors({'OPENCODE_CONFIG': first}, folder=given)
        self.assertEqual(first, again)
        self.assertEqual(os.path.basename(first), 'bot.with-connectors.opencode.json')
        self.assertEqual(sorted(os.listdir(given)), ['bot.opencode.json', 'bot.with-connectors.opencode.json'])


if __name__ == '__main__':
    unittest.main()
