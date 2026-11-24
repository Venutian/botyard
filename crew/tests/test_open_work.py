"""Open work that is not moving: an older try of a goal is closed, a job in progress with nothing done is blocked, and
nothing with a run going, open jobs under it or a moving track request is touched."""
import datetime as dt
import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
spec = importlib.util.spec_from_file_location('open_work', os.path.join(HERE, 'open-work-check.py'))
ow = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ow)
NOW = dt.datetime(2026, 11, 24, 12, tzinfo=dt.timezone.utc)


def job(code, title, status, created, touched=None, parent=None):
    return {'id': code.lower(), 'identifier': code, 'title': title, 'status': status, 'createdAt': created,
            'lastActivityAt': touched or created, 'parentId': parent}


class OpenWork(unittest.TestCase):
    def test_an_older_try_is_closed_and_a_resting_job_blocked(self):
        jobs = [job('LH-1', 'Crew: lamp lands', 'blocked', '2026-11-20T00:00:00Z'),
                job('LH-2', 'Fix 1 of Crew: lamp lands', 'in_progress', '2026-11-22T00:00:00Z'),
                job('LH-3', 'Crew: door opens', 'in_progress', '2026-11-21T00:00:00Z'),
                job('LH-4', 'Crew: roof holds', 'in_progress', '2026-11-24T08:00:00Z')]
        actions, say = ow.plan(jobs, live=set(), now=NOW)
        got = {a['job']: a['to'] for a in actions}
        self.assertEqual(got['LH-1'], 'cancelled')
        self.assertIn('LH-2', next(a['why'] for a in actions if a['job'] == 'LH-1'))
        self.assertEqual(got['LH-3'], 'blocked')
        self.assertNotIn('LH-4', got, 'touched four hours ago: left alone')
        self.assertEqual(say['duplicates'], [])

    def test_nothing_with_a_run_open_steps_or_a_moving_request_is_touched(self):
        jobs = [job('LH-1', 'Crew: lamp lands', 'in_progress', '2026-11-20T00:00:00Z'),
                job('LH-2', 'Crew: lamp lands · Build', 'todo', '2026-11-21T00:00:00Z', parent='lh-1'),
                job('LH-5', 'Crew: door opens', 'in_progress', '2026-11-20T00:00:00Z'),
                job('LH-6', 'Crew: door opens · Build', 'in_progress', '2026-11-21T00:00:00Z'),
                job('LH-7', 'Crew: roof holds', 'in_progress', '2026-11-19T00:00:00Z')]
        actions, say = ow.plan(jobs, live={'lh-6'}, now=NOW, requests={'lh-5'})
        self.assertEqual([a['job'] for a in actions if a['job'] in ('LH-1', 'LH-5', 'LH-6')], [])
        self.assertEqual([a['job'] for a in actions], ['LH-7'], 'only the job resting alone is blocked')


if __name__ == '__main__':
    unittest.main()
