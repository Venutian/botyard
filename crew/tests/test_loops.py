#!/usr/bin/env python3
"""A free model going round in circles is caught; re-running after a change, or a deliberate wait, is not."""
import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.realpath(__file__))
spec = importlib.util.spec_from_file_location('free_runner', os.path.join(HERE, '..', 'free-runner.py'))
fred = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fred)


def step(snapshot):
    return {'type': 'step_start', 'part': {'type': 'step-start', 'snapshot': snapshot}}


def call(command, status='completed'):
    return {'type': 'tool_use', 'part': {'type': 'tool', 'tool': 'bash',
                                         'state': {'status': status, 'input': {'command': command}, 'output': 'x'}}}


class LoopsTest(unittest.TestCase):
    def test_the_fifth_identical_call_with_nothing_changed_is_a_loop(self):
        loops = fred.Loops()
        said = [loops.feed(e) for _ in range(5) for e in (step('a'), call('npm test'))]
        self.assertEqual(said[:-1], [None] * 9)
        self.assertEqual(said[-1], ('bash `npm test`', 5))

    def test_running_again_after_the_files_changed_is_a_new_question(self):
        loops = fred.Loops()
        said = [loops.feed(e) for n in range(8) for e in (step(f'tree-{n}'), call('npm test'))]
        self.assertEqual(set(said), {None})

    def test_waiting_inside_the_run_is_caught_by_what_the_wait_says_even_when_no_two_calls_are_alike(self):
        loops = fred.Loops()
        said = [loops.feed(e) for n in range(30) for e in (step(f'tree-{n}'), call(f'sleep {50 + n % 5} && tail -n {n + 1} build.log'))]
        caught = next(s for s in said if s)
        self.assertIn('sleep 5', caught[0])
        self.assertIsInstance(caught[1], str, 'a wait says why, where a circle says how many times')
        self.assertIn('botyard-wait', caught[1])
        self.assertLessEqual(loops.waited, fred.waits.BUDGET)
        # One wait with no end, or a long one, is caught the first time it is seen.
        self.assertIn('no end', fred.Loops().feed(call('until [ -f job.done ]; do sleep 30; done'))[1])
        self.assertIn('5 minutes', fred.Loops().feed(call('sleep 300; cat out.log'))[1])
        # A few short waits in a run are ordinary.
        few = fred.Loops()
        self.assertEqual({few.feed(call(f'sleep {n}; curl -s localhost:{8000 + n}')) for n in (1, 2, 3)}, {None})

    def test_other_events_and_unfinished_calls_count_for_nothing(self):
        loops = fred.Loops()
        for _ in range(10):
            self.assertIsNone(loops.feed({'type': 'text', 'part': {'text': 'hi'}}))
            self.assertIsNone(loops.feed(call('ls', status='running')))


if __name__ == '__main__':
    unittest.main()
