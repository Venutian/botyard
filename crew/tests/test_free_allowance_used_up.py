#!/usr/bin/env python3
"""When OpenCode's free allowance is used up, the ask ends at once and the owner is told why and what to do
(23 Nov 2026: a new yard's first hello showed "Writing an answer" for half an hour while every free model was
asked in turn and OpenCode retried each one in silence)."""
import importlib.util
import os
import stat
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.realpath(__file__))
spec = importlib.util.spec_from_file_location('free_runner_allowance', os.path.join(HERE, '..', 'free-runner.py'))
fred = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fred)

LIMIT = ('AI_APICallError: Free usage limit reached. Free models work in OpenCode; subscribe to keep going')


def fake_opencode(folder, script):
    path = os.path.join(folder, 'opencode')
    with open(path, 'w') as f:
        f.write('#!/bin/sh\n' + script)
    os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC)
    return path


class AllowanceUsedUp(unittest.TestCase):
    def test_the_refusal_is_caught_as_it_is_logged_not_at_the_timeout(self):
        with tempfile.TemporaryDirectory() as folder:
            # Logs the refusal, then keeps retrying in silence as OpenCode does.
            tool = fake_opencode(folder, f'echo "level=ERROR error.error=\\"{LIMIT}\\"" >&2\nsleep 60\n')
            start = time.time()
            self.assertEqual(fred.probe(tool, 'opencode/x-free', timeout=20), 'out')
            self.assertLess(time.time() - start, 10)
            self.assertIn('free usage limit reached', fred.SAID['opencode/x-free'].lower())

    def test_an_answer_is_still_an_answer(self):
        with tempfile.TemporaryDirectory() as folder:
            tool = fake_opencode(folder, 'echo pong\n')
            self.assertEqual(fred.probe(tool, 'opencode/y-free'), 'ok')

    def test_opencode_free_usage_limit_sets_every_opencode_model_aside(self):
        self.assertTrue(fred.provider_wide(LIMIT, 'opencode/x-free'))

    def test_the_owner_is_told_why_and_the_ways_on(self):
        fred.SAID['opencode/x-free'] = LIMIT
        text = fred.no_free_model(['opencode/x-free'])
        self.assertIn("today's free allowance is used up", text)
        self.assertIn('Setup page', text)
        fred.SAID['opencode/z-free'] = 'nothing'
        self.assertIn('busy or did not reply', fred.no_free_model(['opencode/z-free']))


if __name__ == '__main__':
    unittest.main()
