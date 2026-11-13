"""Every Claude bot's loop guard refuses the fifth identical call with nothing changed between, and a
wait inside the run: a loop with no end, one long wait, or more waiting than a run's budget."""
import importlib.util
import os
import unittest

CREW = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
spec = importlib.util.spec_from_file_location('loop_guard', os.path.join(CREW, 'loop-guard.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def call(tool, **tool_input):
    return {'tool_name': tool, 'tool_input': tool_input}


class LoopGuard(unittest.TestCase):
    def test_fifth_identical_call_is_refused(self):
        state = {}
        told = [guard.check(call('Bash', command='npm test'), state) for _ in range(5)]
        self.assertEqual(told[:4], [None] * 4)
        self.assertIn('5 times', told[4])

    def test_an_edit_between_starts_the_count_again(self):
        state = {}
        for _ in range(4):
            guard.check(call('Bash', command='npm test'), state)
        guard.check(call('Edit', file_path='a.js'), state)
        self.assertIsNone(guard.check(call('Bash', command='npm test'), state))

    def test_a_wait_with_no_end_or_a_long_one_is_refused_at_once_and_told_how_to_wait(self):
        for command in ("until [ -f tmp/job.done ]; do sleep 30; done",
                        "while ! grep -q DONE build.log; do sleep 10; done; tail build.log",
                        "timeout 540 bash -c 'until [ -f tmp/job.done ]; do sleep 20; done'",
                        'sleep 300 && tail build.log', 'sleep 3m; cat out.txt', 'sleep 60; sleep 60; sleep 60'):
            told = guard.check(call('Bash', command=command), {})
            self.assertIsNotNone(told, command)
            self.assertIn('botyard-wait', told)
            self.assertIn('end your run', told)

    def test_short_waits_are_counted_by_what_they_say_so_a_new_number_each_time_is_still_seen(self):
        state = {}
        # Twenty polls, no two alike: none is the "same call", and together they are ten minutes.
        told = [guard.check(call('Bash', command=f'sleep {25 + n % 10} && tail -n {n + 1} build.log'), state) for n in range(25)]
        refused = next(i for i, t in enumerate(told) if t)
        self.assertEqual(told[:refused], [None] * refused)
        self.assertLessEqual(state['waited'], guard.waits.BUDGET)
        self.assertGreater(state['waited'] + 25, guard.waits.BUDGET - 35)
        self.assertIn('already spent', told[refused])
        self.assertTrue(all(told[refused:]), 'once the budget is spent every further wait is refused')
        # An edit starts the count of identical calls again, not the waiting.
        guard.check(call('Edit', file_path='a.js'), state)
        self.assertIsNotNone(guard.check(call('Bash', command='sleep 30'), state))
        self.assertIsNone(guard.check(call('Bash', command='npm test'), state), 'work is never refused for the waiting')

    def test_a_bounded_poll_a_detached_job_and_a_word_that_only_looks_like_a_wait_are_allowed(self):
        state = {}
        for command, background in (("timeout 90 bash -c 'until [ -f tmp/job.done ]; do sleep 5; done'", False),
                                    ("setsid nohup bash -c 'npm run build > job.log 2>&1; touch job.done' > /dev/null 2>&1 &", False),
                                    ('sleep 3600', True), ('grep -rn "sleep 500" src/', False), ('npm test -- --timeout 900', False)):
            self.assertIsNone(guard.check({'tool_name': 'Bash', 'tool_input': {'command': command, 'run_in_background': background}}, state), command)
        self.assertEqual(state['waited'], 90, 'only the bounded poll counted, as its bound')

    def test_a_new_description_does_not_make_a_new_call(self):
        state = {}
        told = [guard.check(call('Bash', command='echo same', description=f'try {n}'), state) for n in range(5)]
        self.assertIsNotNone(told[4])

    def test_different_inputs_do_not_count_together(self):
        state = {}
        for n in range(10):
            self.assertIsNone(guard.check(call('Read', file_path=f'f{n}.js'), state))


if __name__ == '__main__':
    unittest.main()
