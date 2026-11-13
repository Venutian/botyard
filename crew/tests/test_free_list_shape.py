"""Botyard's server (server/lib/models.mjs) reads the FREE list in setup-bots.py without
running it: it parses `FREE = [('model', 'family', 'strong'|'light'), ...]` with comments between the
tuples, and refuses any other shape. This test holds the list to that grammar, so a change to its form
fails here, next to the list, before the Models screen in the app goes blank.

    python3 -m unittest discover -s crew/tests -t crew/tests
"""
import os
import re
import unittest

SETUP_BOTS = os.path.join(os.path.dirname(__file__), '..', 'setup-bots.py')
# The same grammar as models.mjs: change both together.
TUPLE = re.compile(r"^\(\s*'([^'\s]+)'\s*,\s*'([^'\s]+)'\s*,\s*'(strong|light)'\s*\)$")


def parse_free_list(source):
    start = re.search(r'^FREE = \[', source, re.M)
    if not start:
        raise ValueError('setup-bots.py has no FREE list')
    rest = source[start.end():]
    end = rest.find(']')
    if end < 0:
        raise ValueError('the FREE list never closes')
    lines = [re.sub(r'#.*$', '', line).strip() for line in rest[:end].split('\n')]
    body = ' '.join(line for line in lines if line)
    tuples = re.findall(r'\([^()]*\)', body)
    leftover = re.sub(r'[\s,]', '', re.sub(r'\([^()]*\)', '', body))
    if not tuples or leftover:
        raise ValueError('the FREE list is not a list of (model, family, tier) tuples')
    rows = []
    for tuple_ in tuples:
        match = TUPLE.match(tuple_)
        if not match:
            raise ValueError(f'the FREE list has an entry that is not (model, family, tier): {tuple_}')
        rows.append(match.groups())
    return rows


class FreeListShape(unittest.TestCase):
    def test_the_list_parses_under_the_doors_grammar(self):
        with open(SETUP_BOTS) as f:
            rows = parse_free_list(f.read())
        self.assertGreaterEqual(len(rows), 1)
        for model, family, tier in rows:
            self.assertIn('/', model, model)
            self.assertIn(tier, ('strong', 'light'))
            self.assertTrue(family.islower(), family)
        self.assertEqual(len(rows), len({m for m, _, _ in rows}), 'a model is listed twice')

    def test_the_grammar_refuses_other_shapes(self):
        for bad in ["FRED = 1\n", "FREE = [('a/b', 'b', 'strong', 'x')]\n", "FREE = [('a/b', 'b', 'medium')]\n",
                    "FREE = [{'model': 'a/b'}]\n", "FREE = [\n", "FREE = [('a/b', 'b', 'strong'), MORE]\n"]:
            with self.assertRaises(ValueError, msg=bad):
                parse_free_list(bad)


if __name__ == '__main__':
    unittest.main()
