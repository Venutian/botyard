#!/usr/bin/env python3
"""free-limits.py learns each free model's limit from what it is seen to do."""
import importlib.util
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.realpath(__file__))
spec = importlib.util.spec_from_file_location('free_limits', os.path.join(HERE, '..', 'free-limits.py'))
limits = importlib.util.module_from_spec(spec)
spec.loader.exec_module(limits)
M = 'opencode/test-free'


class Learns(unittest.TestCase):
    def setUp(self):
        self.path = os.path.join(tempfile.mkdtemp(), 'limits.json')

    def round(self, start, work, rest):
        """One round: answers at start, does `work` seconds of runs, stops, and is back after `rest`."""
        limits.answered(M, now=start, path=self.path)
        limits.used(M, 1000 * work, work, run=f'r{start}', now=start + 1, path=self.path)
        limits.stopped(M, 'did not answer', now=start + work, path=self.path)
        limits.answered(M, now=start + work + rest, path=self.path)
        return start + work + rest

    def test_a_model_never_seen_is_tried_at_growing_gaps(self):
        limits.stopped(M, 'did not answer', now=1000, path=self.path)
        self.assertEqual(limits.retry_in(M, now=1000, path=self.path), 120)
        limits.stopped(M, 'did not answer', now=1120, path=self.path)
        self.assertEqual(limits.retry_in(M, now=1120, path=self.path), 300)
        for _ in range(9):
            limits.stopped(M, 'did not answer', now=2000, path=self.path)
        self.assertEqual(limits.retry_in(M, now=2000, path=self.path), 3600)

    def test_repeated_failures_do_not_open_new_rounds(self):
        limits.stopped(M, 'x', now=1000, path=self.path)
        limits.stopped(M, 'x', now=1100, path=self.path)
        self.assertEqual(len(limits.read(self.path)['models'][M]['rounds']), 1)

    def test_work_and_rest_are_learned_from_rounds(self):
        now = 0
        for work, rest in ((3000, 1800), (3600, 2400), (4200, 1200)):
            now = self.round(now, work, rest)
        know = limits.learned(limits.read(self.path)['models'][M])
        self.assertEqual(know['seconds']['usual'], 3600)
        self.assertEqual(know['rest']['usual'], 1800)
        self.assertEqual(know['tokens']['seen'], 3)

    def test_forecast_says_how_much_is_left_and_when_it_is_back(self):
        now = 0
        for work, rest in ((3000, 1800), (3600, 2400), (4200, 1200)):
            now = self.round(now, work, rest)
        limits.used(M, 5, 600, run="now", now=now + 600, path=self.path)
        row = limits.forecast(now=now + 600, path=self.path)[0]
        self.assertEqual(row['left'], 3000)
        self.assertIn('about 50 min left', limits.line(row, now + 600))
        limits.stopped(M, 'x', now=now + 700, path=self.path)
        row = limits.forecast(now=now + 700, path=self.path)[0]
        self.assertEqual(row['back'], now + 700 + 1800)
        # Asked again a little before the usual rest is over, so a shorter rest can still be learned.
        self.assertAlmostEqual(limits.retry_in(M, now=now + 700, path=self.path), 1800 * limits.EARLY)

    def test_one_round_is_not_enough_to_guess(self):
        self.round(0, 3000, 1800)
        row = limits.forecast(now=5000, path=self.path)[0]
        self.assertIsNone(row['left'])
        self.assertIn('not known yet', limits.line(row, 5000))

    def test_a_run_is_counted_once(self):
        limits.answered(M, now=0, path=self.path)
        limits.used(M, 100, 60, run='a', now=1, path=self.path)
        limits.used(M, 100, 60, run='a', now=2, path=self.path)
        self.assertEqual(limits.read(self.path)['models'][M]['seconds'], 60)

    def test_a_providers_own_reset_is_kept_and_not_learned_from(self):
        limits.answered(M, now=0, path=self.path)
        limits.stopped(M, 'day used up', now=100, fixed_until=9000, path=self.path)
        self.assertEqual(limits.retry_in(M, now=1000, path=self.path), 8000)
        limits.answered(M, now=9000, path=self.path)
        self.assertIsNone(limits.learned(limits.read(self.path)['models'][M])['rest'])


if __name__ == '__main__':
    unittest.main()
