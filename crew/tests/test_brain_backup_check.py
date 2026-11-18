"""The notes backup's line in the health report: said when the last push failed or the backup stopped running,
silent when it is fine or not set up."""
import datetime
import importlib.util
import json
import os
import tempfile
import unittest

CREW = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
spec = importlib.util.spec_from_file_location('brain_backup_check', os.path.join(CREW, 'brain-backup-check.py'))
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)
NOW = datetime.datetime(2026, 11, 18, 16, 0, tzinfo=datetime.timezone.utc)


class NotesBackup(unittest.TestCase):
    def say(self, state):
        with tempfile.TemporaryDirectory() as home:
            if state is not None:
                with open(os.path.join(home, 'brain-backup.json'), 'w') as f:
                    json.dump(state, f)
            return check.faults({'BOTYARD_HOME': home}, now=NOW)

    def test_no_backup_set_up_says_nothing(self):
        self.assertEqual(self.say(None), [])

    def test_a_good_recent_run_says_nothing(self):
        self.assertEqual(self.say({'ok': True, 'at': '2026-11-18T16:50:00+01:00'}), [])

    def test_a_failed_push_is_a_fault_with_its_reason(self):
        got = self.say({'ok': False, 'at': '2026-11-18T16:50:00+01:00', 'error': 'push failed: rejected'})
        self.assertEqual(got, ['the notes backup failed: push failed: rejected'])

    def test_a_backup_that_stopped_running_is_a_fault(self):
        got = self.say({'ok': True, 'at': '2026-11-18T10:00:00+01:00'})
        self.assertEqual(len(got), 1)
        self.assertIn('has not run since', got[0])


if __name__ == '__main__':
    unittest.main()
