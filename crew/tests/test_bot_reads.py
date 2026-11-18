"""A bot that judges a product reads the product's folder: OpenCode asked for any folder outside the run's own and an
unattended run refused, so the scout's judge job read nothing and ended every 30 minutes (18 Nov). A stopped OpenCode
that is slow to exit is killed instead of crashing the run."""
import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
import folders  # noqa: E402
import skill_sets  # noqa: E402

spec = importlib.util.spec_from_file_location('free_runner_stop', os.path.join(HERE, '..', 'free-runner.py'))
fred = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fred)


class Reads(unittest.TestCase):
    def test_reads_opens_the_folder_for_reading_and_keeps_edits_and_the_notes_closed(self):
        d = tempfile.mkdtemp()
        notes = os.path.join(d, 'notes')
        perm = {'edit': {'*': 'allow', f'{notes}/*': 'deny'}, 'external_directory': {'*': 'ask', notes: 'deny', f'{notes}/*': 'deny'}}
        got = skill_sets.read_only(perm, [d])
        out = got['external_directory']
        self.assertEqual(out[d], 'allow')
        self.assertEqual(out[f'{d}/*'], 'allow')
        self.assertEqual(out['*'], 'ask')
        keys = list(out)
        self.assertEqual(out[notes], 'deny')
        self.assertGreater(keys.index(f'{notes}/*'), keys.index(f'{d}/*'), 'the notes rule comes after, so it wins')
        edit = got['edit']
        self.assertEqual(edit[f'{d}/*'], 'deny')
        self.assertGreater(list(edit).index(f'{notes}/*'), list(edit).index('*'))

    def test_the_bots_own_folder_inside_a_read_folder_stays_editable(self):
        d = tempfile.mkdtemp()
        own = os.path.join(d, 'crew', 'helper')
        edit = skill_sets.read_only({'edit': {'*': 'allow'}}, [d], own)['edit']
        keys = list(edit)
        self.assertEqual(edit[f'{own}/*'], 'allow')
        self.assertGreater(keys.index(f'{own}/*'), keys.index(f'{d}/*'), 'its own folder comes after, so it wins')

    def test_the_worktrees_of_a_projects_folder_stay_editable(self):
        d = tempfile.mkdtemp()
        notes = os.path.join(d, 'notes')
        edit = skill_sets.read_only({'edit': {'*': 'allow', f'{notes}/*': 'deny'}}, [d])['edit']
        keys = list(edit)
        tree = f'{d}/game/.botyard/worktrees/J-1/src/a.js'
        self.assertEqual(folders.decide(edit, tree, 'allow'), 'allow', 'a job worktree of a repo under the read folder')
        self.assertEqual(folders.decide(edit, f'{d}/game/src/a.js', 'allow'), 'deny', 'the repo itself is still read only')
        self.assertEqual(folders.decide(edit, f'{notes}/x.md', 'allow'), 'deny', 'and the notes stay closed')
        self.assertGreater(keys.index(f'{notes}/*'), keys.index(f'{d}/*/.botyard/worktrees/*'))

    def test_no_reads_changes_nothing(self):
        perm = {'external_directory': {'*': 'ask'}}
        self.assertIs(skill_sets.read_only(perm, None), perm)
        self.assertIs(skill_sets.read_only(perm, []), perm)


class SlowExit(unittest.TestCase):
    def test_a_child_that_ignores_the_stop_is_killed_not_left_to_crash_the_run(self):
        child = subprocess.Popen([sys.executable, '-c', 'import signal, sys, time; signal.signal(15, signal.SIG_IGN); print(1, flush=True); time.sleep(30)'],
                                 start_new_session=True, stdout=subprocess.PIPE)
        child.stdout.readline()   # the stop is ignored from here on
        os.killpg(child.pid, 15)
        fred.stop_child(child, wait=0.5)
        self.assertEqual(child.returncode, -9)


if __name__ == '__main__':
    unittest.main()
