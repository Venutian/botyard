"""A retired folder left in the Codex bots' sandbox config made every shell command fail (18 Nov: the lead's chat could
not answer). sandbox-roots.py finds such folders and takes them out, keeping the rest of the config as it was."""
import importlib.util
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('sandbox_roots', os.path.join(HERE, '..', 'sandbox-roots.py'))
sr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sr)


class SandboxRoots(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.live = os.path.join(self.d, 'live')
        os.makedirs(os.path.join(self.live, '.git'))
        self.gone = os.path.join(self.d, 'retired')
        self.cfg = os.path.join(self.d, 'config.toml')
        self.text = (f'model = "x"\n\n[sandbox_workspace_write]\nnetwork_access = true\n'
                     f'writable_roots = ["{self.live}/.git", "{self.gone}/.git"]\n\n'
                     f'[projects."{self.live}"]\ntrust_level = "trusted"\n\n'
                     f'[projects."{self.gone}"]\ntrust_level = "trusted"\n\n[apps]\nenabled = false\n')
        open(self.cfg, 'w').write(self.text)
        self.state = os.environ.get('BOTYARD_HOME')
        os.environ['BOTYARD_HOME'] = self.d

    def tearDown(self):
        if self.state is None:
            os.environ.pop('BOTYARD_HOME', None)
        else:
            os.environ['BOTYARD_HOME'] = self.state

    def test_a_missing_folder_is_found_and_the_check_fails(self):
        self.assertEqual(sr.missing(self.text), [f'{self.gone}/.git', self.gone])
        self.assertEqual(sr.main([f'--config={self.cfg}']), 1)

    def test_fix_takes_out_only_what_is_gone(self):
        got = sr.fixed(self.text)
        self.assertNotIn(self.gone, got)
        self.assertIn(f'writable_roots = ["{self.live}/.git"]', got)
        self.assertIn(f'[projects."{self.live}"]\ntrust_level = "trusted"', got)
        self.assertIn('[apps]\nenabled = false', got)
        self.assertIn('network_access = true', got)
        self.assertEqual(sr.missing(got), [])

    def test_fix_writes_the_file_and_keeps_the_old_one(self):
        os.makedirs(os.path.join(self.d, 'crew'), exist_ok=True)
        self.assertEqual(sr.main([f'--config={self.cfg}', '--fix']), 0)
        self.assertEqual(sr.missing(open(self.cfg).read()), [])
        self.assertEqual(open(self.cfg + '.bak').read(), self.text)
        self.assertEqual(sr.main([f'--config={self.cfg}']), 0)


if __name__ == '__main__':
    unittest.main()
