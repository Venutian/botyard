"""A free run that ends without one tool call did none of its work: the model is set aside and the task starts again
once on another model in a new session (22 Nov: four runs of one scout on one model only asked for access)."""
import importlib.util
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('free_runner_notools', os.path.join(HERE, '..', 'free-runner.py'))
fred = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fred)

TASK = 'Read the job, do the work in the files, and close the job with job-update.sh. ' * 5


def tool(name='bash', status='completed', command='ls'):
    return {'type': 'tool_use', 'part': {'tool': name, 'state': {'status': status, 'input': {'command': command}}}}


class NoTools(unittest.TestCase):
    def test_a_finished_run_with_no_tool_call_on_a_task_did_nothing(self):
        self.assertTrue(fred.no_tools(0, 0, TASK))

    def test_tool_calls_a_failed_exit_or_a_short_prompt_are_not_that(self):
        self.assertFalse(fred.no_tools(0, 1, TASK))
        self.assertFalse(fred.no_tools(1, 0, TASK))
        self.assertFalse(fred.no_tools(0, 0, 'Reply with exactly: pong'))
        self.assertFalse(fred.no_tools(0, 0, None))

    def test_loops_counts_every_finished_tool_call(self):
        loops = fred.Loops()
        loops.feed({'type': 'step_start', 'part': {'snapshot': 'a'}})
        loops.feed({'type': 'text', 'part': {'text': 'Please grant me read access.'}})
        self.assertEqual(loops.tools, 0)
        loops.feed(tool(command='ls'))
        loops.feed(tool(command='cat a', status='error'))
        loops.feed(tool(command='sleep 1', status='running'))
        self.assertEqual(loops.tools, 2)

    def test_the_new_start_carries_no_session(self):
        args = ['run', '--format', 'json', '--session', 'ses_old', '--model', 'a/b']
        self.assertEqual(fred.without_session(args), ['run', '--format', 'json', '--model', 'a/b'])
        self.assertEqual(fred.without_session(['run', '-s', 'ses_old', '--session=ses_x', '-m', 'm']), ['run', '-m', 'm'])
        moved = fred.with_model(fred.without_session(args), 'c/d', None)
        self.assertNotIn('--session', moved)
        self.assertEqual(moved[moved.index('--model') + 1], 'c/d')



class TheRun(unittest.TestCase):
    """free-runner's main() against a fake OpenCode whose starts make the given number of tool calls."""

    def run_main(self, tools):
        with tempfile.TemporaryDirectory() as d:
            fake, counter = os.path.join(d, 'opencode'), os.path.join(d, 'count')
            with open(fake, 'w') as f:
                f.write(f'''#!{sys.executable}
import json, os, sys
n = int(open({counter!r}).read() or 0) if os.path.exists({counter!r}) else 0
open({counter!r}, "w").write(str(n + 1))
open({counter!r} + ".args", "a").write(json.dumps(sys.argv[1:]) + "\\n")
open({counter!r} + ".prompts", "a").write(json.dumps(sys.stdin.read()) + "\\n")
print(json.dumps({{"type": "step_start", "sessionID": "ses_old", "part": {{"snapshot": "s"}}}}))
for i in range({tools!r}[min(n, len({tools!r}) - 1)]):
    print(json.dumps({{"type": "tool_use", "part": {{"tool": "bash", "state": {{"status": "completed", "input": {{"command": "ls " + str(i)}}}}}}}}))
print(json.dumps({{"type": "text", "sessionID": "ses_old", "part": {{"text": "Please grant me read access."}}}}))
''')
            os.chmod(fake, 0o755)
            task = os.path.join(d, 'task')
            with open(task, 'w') as f:
                f.write(TASK)

            class Bots:
                OPENCODE = fake
                FREE_LISTED = 'listed'
                def free_list(self): return [('x/m', 'f', 'strong'), ('y/m', 'g', 'strong')]
                def free_aside(self): return {}
                def free_family(self, m): return m[0]
                def read_json(self, *a): return {'at': 9e12}

            class Fallback:
                aside = []
                def setup(self): return Bots()
                def outage(self, *a): return False
                def limits(self):
                    class L:
                        def answered(self, m): pass
                    return L()
                def set_free_aside(self, bots, model, why, until=None): self.aside.append((model, why, until))

            fb = Fallback()
            saved = (fred.load, fred.pause, fred.probe, fred.BUSY, fred.note, fred.next_working, fred.pick, sys.argv, sys.stdin)
            fred.load = lambda *a: fb
            fred.pause = lambda s: None
            fred.probe = lambda *a: 'ok'
            fred.pick = lambda *a, **k: 'x/m'
            fred.BUSY = os.path.join(d, 'busy.json')
            fred.note = lambda line: None
            fred.next_working = lambda fallback, bots, avoid_family=None, tries=4: ('y/m', bots)
            sys.argv = ['free-runner.py', 'run', '--session', 'ses_old', '-m', 'x/m']
            sys.stdin = open(task)
            env = {k: os.environ.pop(k, None) for k in ('BOTYARD_FREE_PACE', 'BOTYARD_FREE_TIER', 'BOTYARD_CHECKER')}
            try:
                with open(os.path.join(d, 'stdout'), 'w+') as sink, open(os.devnull, 'w') as quiet:
                    out, err, sys.stdout, sys.stderr = sys.stdout, sys.stderr, sink, quiet
                    try:
                        code = fred.main()
                    finally:
                        sys.stdout, sys.stderr = out, err
                    sink.seek(0)
                    self.printed = [json.loads(line) for line in sink if line.startswith('{')]
            finally:
                sys.stdin.close()
                fred.load, fred.pause, fred.probe, fred.BUSY, fred.note, fred.next_working, fred.pick, sys.argv, sys.stdin = saved
                for k, v in env.items():
                    if v is not None:
                        os.environ[k] = v
            with open(counter + '.args') as f:
                calls = [json.loads(line) for line in f]
            with open(counter + '.prompts') as f:
                prompts = [json.loads(line) for line in f]
            return code, calls, prompts, fb.aside

    def test_no_tool_call_sets_the_model_aside_and_starts_again_in_a_new_session(self):
        code, calls, prompts, aside = self.run_main([0, 3])
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 2)
        self.assertIn('--session', calls[0])
        self.assertNotIn('--session', calls[1])
        self.assertEqual(calls[1][calls[1].index('-m') + 1], 'y/m')
        self.assertTrue(prompts[1].startswith(TASK))
        self.assertEqual([a[0] for a in aside], ['x/m'])
        self.assertIn('no tool calls', aside[0][1])

    def test_each_start_names_its_model_on_the_run_output_first(self):
        self.run_main([0, 3])
        named = [e['model'] for e in self.printed if e.get('type') == 'model']
        self.assertEqual(named, ['x/m', 'y/m'])
        self.assertEqual(self.printed[0]['type'], 'model')

    def test_twice_without_a_tool_call_fails_the_run(self):
        code, calls, _, aside = self.run_main([0, 0])
        self.assertEqual(code, 1)
        self.assertEqual(len(calls), 2)
        self.assertEqual([a[0] for a in aside], ['x/m', 'y/m'])

    def test_a_run_with_tool_calls_ends_as_before(self):
        code, calls, _, aside = self.run_main([2])
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 1)
        self.assertEqual(aside, [])


if __name__ == '__main__':
    unittest.main()
