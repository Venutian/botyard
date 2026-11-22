"""A folder reached through a link in the crew's folder gets the same rules as its target, in the same order (21 Nov 2026: a bot
was refused its skills through such a link for a day)."""
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import skill_sets  # noqa: E402


class Aliases(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.target = os.path.join(self.dir, 'projects', 'studio', 'own')
        os.makedirs(os.path.join(self.target, 'skills'))
        self.crew = os.path.join(self.dir, 'crew')
        os.makedirs(self.crew)
        os.symlink(self.target, os.path.join(self.crew, 'own'))
        open(os.path.join(self.crew, 'plain.py'), 'w').close()
        os.symlink(os.path.join(self.crew, 'plain.py'), os.path.join(self.crew, 'file-link.py'))

    def test_only_linked_folders_are_aliases(self):
        self.assertEqual(skill_sets.folder_aliases(self.crew), [(os.path.join(self.crew, 'own'), os.path.realpath(self.target))])

    def test_rules_on_the_target_or_a_parent_are_said_again_for_the_link_in_order(self):
        alias, target = skill_sets.folder_aliases(self.crew)[0]
        parent = os.path.dirname(os.path.dirname(target))
        perm = {'external_directory': {'*': 'deny', f'{parent}/*': 'allow', f'{target}/guard.json': 'deny'},
                'edit': {'*': 'allow', f'{target}/*': 'deny'}, 'bash': {'*': 'allow'}, 'skill': 'allow'}
        out = skill_sets.with_aliases(perm, [(alias, target)])
        ext = list(out['external_directory'].items())
        self.assertEqual(ext, [('*', 'deny'), (f'{parent}/*', 'allow'), (alias, 'allow'), (f'{alias}/*', 'allow'),
                               (f'{target}/guard.json', 'deny'), (f'{alias}/guard.json', 'deny')],
                         'the refused file stays refused through the link: it comes after the allow')
        self.assertEqual(out['edit'][f'{alias}/*'], 'deny')
        self.assertEqual(out['bash'], {'*': 'allow'})
        self.assertEqual(out['skill'], 'allow')

    def test_no_aliases_leaves_the_rules_as_they_are(self):
        perm = {'read': {'*': 'allow'}}
        self.assertIs(skill_sets.with_aliases(perm, []), perm)


if __name__ == '__main__':
    unittest.main()
