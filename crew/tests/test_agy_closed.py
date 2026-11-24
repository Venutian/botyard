"""A Gemini run (through agy-acp.py) never reaches a folder the studio closed: not by a command, not by a file tool."""
import importlib.util
import os
import unittest

CREW = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))


def load():
    spec = importlib.util.spec_from_file_location('agy_acp', os.path.join(CREW, 'agy-acp.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class AgyClosed(unittest.TestCase):
    def test_a_closed_folder_is_refused_to_a_gemini_run_whoever_its_readers_are(self):
        agy = load()
        agy.closed_folders = lambda: ['.botyard/private']
        self.assertIn('closed', agy.verdict('s', {'name': 'run_command', 'args': {'CommandLine': 'cat ~/.botyard/private/lines.json'}}) or '')
        self.assertIn('closed', agy.verdict('s', {'name': 'view_file', 'args': {'AbsolutePath': '/home/owner/.botyard/private/lines.json'}}) or '')
        self.assertIsNone(agy.verdict('s', {'name': 'run_command', 'args': {'CommandLine': 'ls src'}}))


if __name__ == '__main__':
    unittest.main()
