"""Tests for scripts/check-personal-data.py. No framework: run `python scripts/test_check_personal_data.py`."""
import importlib.util
import os
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('check_personal_data', os.path.join(HERE, 'check-personal-data.py'))
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)


def make_repo(files):
    root = tempfile.mkdtemp()
    subprocess.run(['git', 'init', '-q'], cwd=root, check=True)
    for name, text in files.items():
        path = os.path.join(root, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8', newline='') as handle:
            handle.write(text)
    subprocess.run(['git', 'add', '-A'], cwd=root, check=True)
    return root


class ScanTest(unittest.TestCase):
    def test_finds_a_term_case_insensitively_and_reports_file_and_term(self):
        root = make_repo({'a/b.txt': 'Hello SomeOne Example', 'c.txt': 'clean'})
        self.assertEqual(tool.scan(root, ['someone example'], tool.DEFAULT_EXCLUDES), [('a/b.txt', 'someone example')])

    def test_private_and_seed_folders_are_not_scanned(self):
        root = make_repo({'private/n.txt': 'secret-name', 'seed/s.md': 'secret-name', 'x.txt': 'ok'})
        self.assertEqual(tool.scan(root, ['secret-name'], tool.DEFAULT_EXCLUDES), [])

    def test_comments_and_blank_lines_in_the_blocklist_are_ignored(self):
        root = tempfile.mkdtemp()
        path = os.path.join(root, 'list.txt')
        with open(path, 'w', encoding='utf-8') as handle:
            handle.write('# a comment\n\nterm-one\n  term-two  \n')
        self.assertEqual(tool.load_terms(path), ['term-one', 'term-two'])

    def test_without_a_blocklist_the_check_is_skipped(self):
        self.assertEqual(tool.main(['--blocklist', os.path.join(tempfile.mkdtemp(), 'missing.txt')]), 0)


if __name__ == '__main__':
    unittest.main()
