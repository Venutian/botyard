#!/usr/bin/env python3
"""A bot whose file says "ai": "free" never falls back to Antigravity, Codex or Claude for its work. The
lead's own chain (Codex, then Antigravity, then Claude) is unchanged."""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_bots_as_files import Studio, crew_set  # noqa: E402


class NoPaidEngineForFreeBots(Studio):
    def setUp(self):
        super().setUp()
        os.makedirs(f'{self.crew}/bots')
        for slug, ai in (('lead', 'codex'), ('hunter', 'free')):
            with open(f'{self.crew}/bots/{slug}.json', 'w') as f:
                json.dump({'name': slug.capitalize(), 'role': 'researcher' if slug == 'hunter' else 'lead', 'ai': ai,
                           'model': 'auto' if ai == 'free' else 'gpt-x', 'effort': 'medium', 'tier': 'strong',
                           'fallbacks': {'gemini': {'model': 'gemini-3.8-flash-high'}, 'claude': {'model': 'claude-sonnet-5-5'}}}, f)
            with open(f'{self.crew}/bots/{slug}.md', 'w') as f:
                f.write('You are {{name}}.\n')
        self.load()

    def test_a_script_cannot_move_a_free_bot_to_any_paid_engine(self):
        for ai in ('gemini', 'codex', 'claude'):
            with self.assertRaises(crew_set.PaidEngine, msg=ai):
                self.files.build('hunter', ai)
            with self.assertRaises(crew_set.PaidEngine, msg=ai):
                self.m.on_engine('hunter', {'gemini': 'gemini', 'codex': 'codex', 'sonnet': 'sonnet'}.get(ai, 'sonnet'))
        self.assertEqual(self.files.build('hunter')['ai'], 'free')
        self.assertEqual(self.m.on_engine('hunter', 'free')['adapter'], 'opencode_local')

    def test_only_a_person_asking_by_hand_can(self):
        self.files.paid_by_hand = True
        self.assertEqual(self.files.build('hunter', 'gemini')['ai'], 'gemini')

    def test_the_leads_own_chain_still_moves_codex_bots_and_leaves_free_bots_alone(self):
        self.m.main()
        free_before = dict(self.engine.agents['id-hunter'])
        self.m.move_thinkers('gemini', back=1)
        self.assertEqual(self.engine.agents['id-lead']['adapterType'], 'gemini_local')
        self.assertEqual(self.engine.agents['id-hunter']['adapterType'], 'opencode_local')
        self.assertEqual(self.engine.agents['id-hunter']['adapterConfig'], free_before['adapterConfig'])
        self.m.move_thinkers('codex')
        self.assertEqual(self.engine.agents['id-lead']['adapterType'], 'codex_local')
        self.assertEqual(self.m.ai_now('hunter'), 'free')

    def test_fallback_py_only_ever_looks_at_codex_and_antigravity_bots(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('fallback_n', os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'fallback.py'))
        fb = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fb)
        self.assertNotIn(crew_set.AIS['free'], fb.THINKERS)


if __name__ == '__main__':
    unittest.main()
