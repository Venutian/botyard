"""The owner's notes for the bots (crew/brain.py): work notes for every bot, personal notes for a Claude run
only, decided from the processes that started the script and never from what a run says or sets; and the
OpenCode rules that keep a free model's own tools out of the personal folders. Runs on the demo vault."""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

CREW = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
DEMO = os.path.join(os.path.dirname(CREW), 'studio', 'demo', 'brain')
SCRIPT = os.path.join(CREW, 'brain.py')
sys.path.insert(0, CREW)
spec = importlib.util.spec_from_file_location('brain', SCRIPT)
brain = importlib.util.module_from_spec(spec)
spec.loader.exec_module(brain)
spec = importlib.util.spec_from_file_location('skill_sets', os.path.join(CREW, 'skill_sets.py'))
sets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sets)

PERSONAL_NOTE = '2026-11-01-learn-to-sail'
WORK_NOTE = 'plain-copy'


def under(tool, *args, env=None):
    """Runs brain.py as a child of a program called `tool` (a Python that is named so), as a model's tool
    would start it. Gives (exit code, what it printed)."""
    with tempfile.TemporaryDirectory() as tmp:
        fake = os.path.join(tmp, tool)
        os.symlink(sys.executable, fake)
        code = f'import subprocess, sys; r = subprocess.run([sys.argv[1], {SCRIPT!r}, *sys.argv[2:]], capture_output=True, text=True); print(r.stdout, end=""); sys.exit(r.returncode)'
        out = subprocess.run([fake, '-c', code, sys.executable, *args], capture_output=True, text=True, env={**os.environ, 'BOTYARD_BRAIN_DIR': DEMO, **(env or {})})
        return out.returncode, out.stdout


class Caller(unittest.TestCase):
    def tree(self, *names):
        """A made-up process tree: pid 10+i is names[i], each the child of the next."""
        procs = {10 + i: (11 + i if i + 1 < len(names) else 1, {n}) for i, n in enumerate(names)}
        return lambda pid: procs.get(pid)

    def test_claude_above(self):
        self.assertEqual(brain.caller(10, self.tree('python3', 'bash', 'claude', 'node')), 'claude')

    def test_opencode_anywhere_above_is_not_claude(self):
        self.assertEqual(brain.caller(10, self.tree('python3', 'bash', 'opencode', 'python3')), 'other')
        self.assertEqual(brain.caller(10, self.tree('python3', 'claude', 'opencode')), 'other')
        self.assertEqual(brain.caller(10, self.tree('python3', 'opencode', 'claude')), 'other')

    def test_nothing_known_is_unknown(self):
        self.assertEqual(brain.caller(10, self.tree('python3', 'bash', 'systemd')), 'unknown')


class Privacy(unittest.TestCase):
    def test_a_free_model_run_cannot_read_a_personal_note(self):
        code, out = under('opencode', 'read', PERSONAL_NOTE)
        self.assertEqual(code, 3)
        self.assertNotIn('Saturdays', out)
        self.assertIn('personal note', out)

    def test_saying_it_is_claude_does_not_help(self):
        code, out = under('opencode', 'read', PERSONAL_NOTE, env={'CLAUDECODE': '1', 'BOTYARD_AI': 'claude'})
        self.assertEqual(code, 3)
        self.assertNotIn('Saturdays', out)

    def test_a_free_model_run_reads_work_notes_and_never_sees_personal_ones_listed(self):
        code, out = under('opencode', 'read', WORK_NOTE)
        self.assertEqual(code, 0)
        self.assertIn('Write what a thing is and does', out)
        code, out = under('opencode', 'list')
        self.assertEqual(code, 0)
        self.assertNotIn('learn-to-sail', out)
        self.assertNotIn('savings', out)
        self.assertIn('personal note(s) are not shown', out)
        code, out = under('opencode', 'search', 'sail')
        self.assertNotIn('learn-to-sail', out)

    def test_a_claude_run_reads_personal_notes(self):
        code, out = under('claude', 'read', PERSONAL_NOTE)
        if brain.caller() == 'other':
            self.skipTest('these tests run under another model\'s tool')
        self.assertEqual(code, 0)
        self.assertIn('Saturdays', out)

    def test_a_run_of_unknown_origin_gets_work_notes_only(self):
        self.assertEqual(brain.main(['read', PERSONAL_NOTE], env={'BOTYARD_BRAIN_DIR': DEMO}, who='unknown'), 3)

    def test_private_true_in_a_work_folder_is_personal(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(os.path.join(tmp, 'preferences'))
            open(os.path.join(tmp, 'preferences', 'secret-ish.md'), 'w').write('---\nprivate: true\n---\n# Mine\n')
            open(os.path.join(tmp, 'preferences', 'open.md'), 'w').write('# Open\n')
            got = {n[0]: n[4] for n in brain.notes(tmp)}
            self.assertEqual(got, {'secret-ish': True, 'open': False})


class OpenCodeRules(unittest.TestCase):
    def test_free_bots_config_denies_the_personal_folders_from_anywhere(self):
        rules = sets.brain_denials({'BOTYARD_BRAIN_DIR': DEMO})
        for tool in ('read', 'glob', 'grep', 'list', 'edit'):
            self.assertEqual(rules[tool]['*'], 'allow')
            for folder in ('life', 'money'):
                self.assertEqual(rules[tool][f'*brain/{folder}/*'], 'deny', (tool, folder))
                self.assertEqual(rules[tool][f'{DEMO}/{folder}/*'], 'deny')
        self.assertEqual(rules['edit']['*brain/*'], 'deny', 'no bot writes a note')
        self.assertEqual(rules['bash']['*life/*'], 'deny')

    def test_the_rules_go_into_each_free_bots_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            old = sets.OUT
            sets.OUT = tmp
            try:
                os.environ['BOTYARD_BRAIN_DIR'] = DEMO
                env = sets.write_for('free-bot', 'opencode_local', skills=[], want=['botyard'])
                config = json.load(open(env['OPENCODE_CONFIG']['value']))
                self.assertEqual(config['permission']['read'][f'*brain/life/*'], 'deny')
            finally:
                sets.OUT = old
                os.environ.pop('BOTYARD_BRAIN_DIR', None)

    def test_no_notes_no_rules(self):
        self.assertEqual(sets.brain_denials({'BOTYARD_BRAIN_DIR': '/nowhere/at/all'}), {})


if __name__ == '__main__':
    unittest.main()
