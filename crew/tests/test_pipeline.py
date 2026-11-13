"""pipeline.py moves the crew's work along with no AI: a finished build goes to its check, a verdict is
acted on, a stuck job is woken, a ruling reaches the lead. Each thing happens once, and bots are found
by role. The engine here is a stand-in that keeps jobs, comments and what was asked of it."""
import importlib.util
import os
import sys
import tempfile
import time
import unittest

CREW = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
sys.path.insert(0, CREW)
spec = importlib.util.spec_from_file_location('pipeline', os.path.join(CREW, 'pipeline.py'))
pipeline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pipeline)

BOTS = [('lead', 'Lead', 'opencode_local'), ('builder', 'Builder', 'opencode_local'), ('checker', 'Checker', 'opencode_local'),
        ('senior', 'Senior Builder', 'claude_local'), ('reviewer', 'Reviewer', 'claude_local'), ('ruler', 'Ruler', 'claude_local')]


class Roles:
    """What setup-bots.py says about the crew."""
    LEAD = 'Lead'
    ROLES = {'builder': ['Senior Builder', 'Builder'], 'checker': ['Checker'], 'reviewer': ['Reviewer'], 'ruler': ['Ruler']}

    def names_with_role(self, *roles):
        return [name for role in roles for name in self.ROLES.get(role, [])]


class Engine:
    def __init__(self):
        self.agents = {i: {'id': i, 'name': n, 'adapterType': a, 'status': 'idle'} for i, n, a in BOTS}
        self.jobs, self.comments, self.wakes, self.runs, self.n = {}, {}, [], [], 0

    def job(self, title, who, status='todo', **more):
        self.n += 1
        job = {'id': f'j{self.n}', 'identifier': f'LH-{self.n}', 'title': title, 'assigneeAgentId': who, 'status': status,
               'description': 'OUTCOME: it works.', 'updatedAt': time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime()), **more}
        self.jobs[job['id']] = job
        return job

    def report(self, job, text, status='done'):
        self.comments.setdefault(job['id'], []).append({'body': text, 'authorAgentId': job['assigneeAgentId'], 'createdAt': f'{len(self.comments):04}'})
        job['status'] = status

    def said_to_lead(self):
        return [c['body'] for comments in self.comments.values() for c in comments if 'botyard-script: pipeline' in c['body']]

    def call(self, method, path, body=None):
        if method == 'GET' and path.endswith('/agents'):
            return list(self.agents.values())
        if method == 'GET' and '/issues?' in path:
            return list(self.jobs.values())
        if method == 'GET' and path.endswith('/comments'):
            return self.comments.get(path.split('/')[2], [])
        if method == 'GET' and 'heartbeat-runs' in path:
            return self.runs
        if method == 'POST' and path.endswith('/issues'):
            return self.job(body['title'], body.get('assigneeAgentId'), **{k: v for k, v in body.items() if k not in ('title', 'assigneeAgentId', 'status')})
        if method == 'POST' and '/chats/' in path:
            return self.jobs.setdefault('chat', {'id': 'chat', 'identifier': 'LH-0', 'title': 'Chat with Lead', 'status': 'in_progress',
                                                 'assigneeAgentId': 'lead', 'executionRunId': 'r0'})
        if method == 'POST' and path.endswith('/comments'):
            thread = self.comments.setdefault(path.split('/')[2], [])
            if not any(c.get('clientRequestId') == body.get('clientRequestId') for c in thread):
                thread.append({**body, 'createdAt': 'x'})
            return {}
        if method == 'POST' and path.endswith('/wakeup'):
            self.wakes.append((path.split('/')[2], body['payload']['issueId']))
            return {}
        raise AssertionError(f'unexpected call {method} {path}')


BUILT = 'hello.py prints the date.\n\nOUTCOME: MET\nCHANGE: SMALL\nCOMMIT: 0123456789abcdef0123456789abcdef01234567 LH-2-hello'


class Pipeline(unittest.TestCase):
    def setUp(self):
        self.engine = Engine()
        self.dir = tempfile.mkdtemp()
        pipeline.call = self.engine.call
        pipeline.STATE = os.path.join(self.dir, 'pipeline.json')
        pipeline.DRY = False
        pipeline.botyard_home.studio_id = lambda env=None: 'studio-1'
        self.addCleanup(setattr, pipeline, 'DRY', False)
        self.plan = self.engine.job('Lighthouse: say hello', 'lead', status='blocked')
        self.build = self.engine.job('Lighthouse: a hello script', 'builder', parentId=self.plan['id'], projectId='p1')
        self.go()       # a first pass on a studio with nothing finished

    def go(self):
        pipeline.one_pass(Roles())

    def titled(self, start):
        return [j for j in self.engine.jobs.values() if j['title'].startswith(start)]

    def test_a_free_build_goes_to_the_checker_once_and_a_pass_reaches_the_lead_on_its_own_job(self):
        # The build's run is still closing when its job is done: what it started on is what is known.
        self.engine.runs = [{'id': 'r1', 'issueId': self.build['id'], 'status': 'running', 'contextSnapshot': {'model': 'opencode/glow-free'}}]
        self.engine.report(self.build, BUILT)
        self.go()
        self.go()
        (check,) = self.titled('Check ')
        self.assertEqual((check['title'], check['assigneeAgentId'], check['parentId'], check['projectId']),
                         ('Check LH-2: Lighthouse: a hello script', 'checker', self.build['id'], 'p1'))
        self.assertIn('0123456789abcdef', check['description'])
        self.assertIn('OUTCOME: it works.', check['description'], 'the checker gets the brief')
        self.assertIn('<!-- built-on: opencode/glow-free -->', check['description'], 'so the check avoids the build\'s model family')
        self.engine.report(check, 'BLOCKING: none.\nNOTES: name the file better.\nVERDICT: PASS')
        self.go()
        self.go()
        (told,) = self.engine.said_to_lead()
        self.assertIn('LH-2 (Lighthouse: a hello script) passed its check', told)
        self.assertIn('name the file better', told, 'notes go to the lead for the next brief')
        self.assertEqual(len(self.engine.comments[self.plan['id']]), 1, 'on the job the build belongs to, which wakes the lead')
        self.assertEqual(self.titled('Fix '), [])

    def test_a_build_by_another_ai_goes_to_the_reviewer_or_to_the_checker_while_the_reviewer_is_off(self):
        senior = self.engine.job('Lighthouse: the hard part', 'senior')
        self.engine.report(senior, BUILT)
        self.go()
        self.assertEqual(self.titled('Check LH-3')[0]['assigneeAgentId'], 'reviewer')
        self.engine.agents['reviewer']['status'] = 'paused'
        again = self.engine.job('Lighthouse: another hard part', 'senior')
        self.engine.report(again, BUILT)
        self.go()
        self.assertEqual(self.titled(f"Check {again['identifier']}")[0]['assigneeAgentId'], 'checker')

    def test_a_failed_check_goes_back_to_the_builder_once_then_to_the_lead(self):
        self.engine.report(self.build, BUILT)
        self.go()
        self.engine.report(self.titled('Check ')[0], 'BLOCKING: it prints yesterday.\nVERDICT: FAIL')
        self.go()
        self.go()
        (fix,) = self.titled('Fix ')
        self.assertEqual((fix['title'], fix['assigneeAgentId'], fix['parentId']), ('Fix 1 of Lighthouse: a hello script', 'builder', self.plan['id']))
        self.assertIn('it prints yesterday', fix['description'])
        self.assertIn('0123456789abcdef', fix['description'], 'it starts from the build\'s commit')
        self.assertEqual(self.engine.said_to_lead(), [])
        self.engine.report(fix, BUILT)
        self.go()
        self.engine.report(self.titled('Check LH-4')[0], 'BLOCKING: still yesterday.\nVERDICT: FAIL')
        self.go()
        self.go()
        self.assertEqual(len(self.titled('Fix ')), 1, 'never a second round by script')
        (told,) = self.engine.said_to_lead()
        self.assertIn('failed its check after 1 fix round', told)
        self.assertIn('Do not send it back to Builder', told)

    def test_a_build_that_kept_nothing_or_said_nothing_gets_no_check_and_the_lead_is_told(self):
        self.engine.report(self.build, 'Measured it: 40 ms.\n\nOUTCOME: REPORT ONLY\nCHANGE: NONE\nCOMMIT: none')
        silent = self.engine.job('Lighthouse: tidy', 'builder')
        self.engine.report(silent, 'All done!')
        self.go()
        self.go()
        self.assertEqual(self.titled('Check '), [])
        told = sorted(self.engine.said_to_lead())
        self.assertEqual(len(told), 2)
        self.assertIn('nothing kept in the project', told[0])
        self.assertIn('without its closing lines', told[1])
        self.assertIn(told[1], [c['body'] for c in self.engine.comments['chat']], 'a job with no parent is told in the lead\'s chat')

    def test_nobody_on_to_check_is_said_not_hidden(self):
        self.engine.agents['checker']['status'] = 'paused'
        self.engine.agents['reviewer']['status'] = 'paused'
        self.engine.report(self.build, BUILT)
        self.go()
        self.assertEqual(self.titled('Check '), [])
        self.assertIn('nobody checked it', self.engine.said_to_lead()[0])

    def test_a_job_in_progress_with_no_run_is_woken_three_times_an_hour_apart_then_the_lead_is_told(self):
        old = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime(time.time() - 3 * 3600))
        self.build.update(status='in_progress', updatedAt=old)
        self.go()
        self.go()
        self.assertEqual(self.engine.wakes, [('builder', self.build['id'])], 'once an hour at most')
        for _ in range(4):
            state = pipeline.read_state()
            state['woken'][self.build['id']]['at'] -= 2 * 3600
            with open(pipeline.STATE, 'w') as f:
                import json
                json.dump(state, f)
            self.go()
        self.assertEqual(len(self.engine.wakes), 3)
        (told,) = self.engine.said_to_lead()
        self.assertIn('waking it 3 times did not move it', told)
        # A job with a run, a job of a paused bot and a fresh job are left alone.
        self.engine.wakes.clear()
        self.engine.job('Lighthouse: running', 'builder', status='in_progress', updatedAt=old, executionRunId='r1')
        self.engine.agents['senior']['status'] = 'paused'
        self.engine.job('Lighthouse: waits for Claude', 'senior', status='in_progress', updatedAt=old)
        self.engine.job('Lighthouse: just started', 'checker', status='in_progress')
        self.go()
        self.assertEqual(self.engine.wakes, [])

    def test_a_ruling_reaches_the_lead_with_its_line(self):
        ruling = self.engine.job('Ruling: keep the old date format?', 'ruler')
        self.engine.report(ruling, 'RULING: keep it.\nWHY: users parse it.\nCOSTS: nothing.\nNEXT: a test for the format, for Builder.')
        self.go()
        self.go()
        (told,) = self.engine.said_to_lead()
        self.assertIn('is ruled: keep it.', told)

    def test_work_finished_long_before_the_first_pass_is_left_alone_and_a_dry_pass_changes_nothing(self):
        os.remove(pipeline.STATE)
        old = self.engine.job('Lighthouse: last month', 'builder', updatedAt='2020-01-01T00:00:00.000Z')
        self.engine.report(old, BUILT)
        self.go()
        self.assertEqual(self.titled('Check '), [])
        self.engine.report(self.build, BUILT)
        pipeline.DRY = True
        before = dict(self.engine.jobs), open(pipeline.STATE).read()
        self.go()
        self.assertEqual((dict(self.engine.jobs), open(pipeline.STATE).read()), before)
        pipeline.DRY = False
        self.go()
        self.assertEqual(len(self.titled('Check ')), 1)


if __name__ == '__main__':
    unittest.main()
