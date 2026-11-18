"""A provider whose free offer ran out into paid credits ("Payment Required: Your credits are used up") is not on
the free list, however it was found, and one that merely hit a rate limit still is."""
import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.realpath(__file__))
spec = importlib.util.spec_from_file_location('setup_bots', os.path.join(os.path.dirname(HERE), 'setup-bots.py'))
bots = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bots)

LIMITS = {'models': {
    'paidco/model-a': {'rounds': [{'why': 'Payment Required: Your credits are used up. Add credits at https://billing.example'}]},
    'paidco/model-b': {'rounds': []},
    'otherco/model-c': {'rounds': [{'why': 'Too Many Requests: free model usage limit reached'}]},
    'plainco/model-d': {'rounds': [{'why': 'insufficient credits for this request'}]},
}}


class CreditOnly(unittest.TestCase):
    def test_providers_that_asked_for_credits_are_found(self):
        self.assertEqual(bots.credit_only_providers(LIMITS), {'paidco', 'plainco'})

    def test_a_rate_limit_is_not_a_credit_wall(self):
        self.assertNotIn('otherco', bots.credit_only_providers(LIMITS))

    def test_empty_or_unreadable_records_find_none(self):
        self.assertEqual(bots.credit_only_providers({}), set())
        self.assertEqual(bots.credit_only_providers({'models': None}), set())

    def test_their_models_are_off_the_free_list_even_when_found_and_reachable(self):
        found = [['paidco/model-b', 'x', 'strong'], ['otherco/model-c', 'y', 'strong']]
        saved = bots.read_json
        bots.read_json = lambda path, empty: found if path == bots.FREE_FOUND else empty
        try:
            rows = bots.free_list(has_key=lambda p: True, listed=None, credit_only={'paidco'})
        finally:
            bots.read_json = saved
        models = [m for m, _, _ in rows]
        self.assertNotIn('paidco/model-b', models)
        self.assertIn('otherco/model-c', models)


if __name__ == '__main__':
    unittest.main()
