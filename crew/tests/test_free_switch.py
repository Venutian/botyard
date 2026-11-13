#!/usr/bin/env python3
"""A free model is asked before it is handed the session, and one that can never serve this PC is set aside
for a month, not an hour (12 November 2026: runs kept switching to a model blocked in the owner's region,
each switch sending it the whole session only to be refused)."""
import importlib.util
import os
import time
import unittest

HERE = os.path.dirname(os.path.realpath(__file__))
spec = importlib.util.spec_from_file_location('free_runner', os.path.join(HERE, '..', 'free-runner.py'))
fred = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fred)


class Bots:
    OPENCODE = 'opencode'

    def __init__(self, rows):
        self.rows = rows

    def free_list(self):
        return self.rows

    def free_aside(self):
        return {}

    def free_family(self, model):
        return next((f for m, f, _ in self.rows if m == model), 'x')


class Fallback:
    def __init__(self, bots):
        self.bots, self.aside = bots, {}

    def set_free_aside(self, bots, model, why, until=None):
        self.aside[model] = (until, why)

    def setup(self):
        return self.bots

    def limits(self):
        return type('L', (), {'answered': lambda self, m: None})()


ROWS = [('openrouter/a:free', 'a', 'strong'), ('openrouter/b:free', 'b', 'light'), ('opencode/c-free', 'c', 'strong')]


class Switching(unittest.TestCase):
    def setUp(self):
        self.bots = Bots(ROWS)
        self.fb = Fallback(self.bots)
        self.saved = fred.probe, fred.pick, fred.claim

    def tearDown(self):
        fred.probe, fred.pick, fred.claim = self.saved

    def test_a_region_block_sets_the_model_aside_for_a_month(self):
        fred.set_aside(self.fb, self.bots, 'openrouter/a:free', 'This model is not available in your region.')
        until, why = self.fb.aside['openrouter/a:free']
        self.assertGreater(until, time.time() + 29 * 86400)
        self.assertIn('never serves', why)

    def test_a_daily_cap_sets_every_model_of_that_provider_aside_until_its_day_resets(self):
        fred.set_aside(self.fb, self.bots, 'openrouter/a:free', 'Rate limit exceeded: free-models-per-day-high-balance.')
        self.assertEqual(set(self.fb.aside), {'openrouter/a:free', 'openrouter/b:free'})
        self.assertLessEqual(self.fb.aside['openrouter/b:free'][0], time.time() + 86400 + 400)

    def test_a_busy_model_keeps_the_learned_pause(self):
        fred.set_aside(self.fb, self.bots, 'opencode/c-free', None)
        self.assertIsNone(self.fb.aside['opencode/c-free'][0])

    def test_the_next_model_is_asked_first_and_a_dead_one_is_skipped(self):
        order = iter(['openrouter/a:free', 'opencode/c-free'])
        fred.pick = lambda bots, avoid_family=None: next(order, None)
        fred.claim = lambda m: set()
        fred.probe = lambda oc, m: 'gone' if m == 'openrouter/a:free' else 'ok'
        got, _ = fred.next_working(self.fb, self.bots)
        self.assertEqual(got, 'opencode/c-free')
        self.assertIn('openrouter/a:free', self.fb.aside)

    def test_none_when_no_model_answers(self):
        fred.pick = lambda bots, avoid_family=None: 'opencode/c-free'
        fred.claim = lambda m: set()
        fred.probe = lambda oc, m: 'out'
        self.assertEqual(fred.next_working(self.fb, self.bots, tries=2)[0], None)

    def test_the_providers_error_is_read_from_opencodes_event(self):
        event = {'type': 'error', 'error': {'name': 'APIError', 'data': {'message': 'This model is not available in your region.', 'statusCode': 403}}}
        self.assertEqual(fred.error_of(event), 'This model is not available in your region.')
        self.assertIsNone(fred.error_of({'type': 'text'}))


if __name__ == '__main__':
    unittest.main()
