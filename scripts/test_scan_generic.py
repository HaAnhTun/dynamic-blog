#!/usr/bin/env python3
"""Tests of scripts/release/scan-generic.py: the owner of the repository may link to its own GitHub account, nobody else may be linked."""
import importlib.util
import os
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location('scan_generic', os.path.join(HERE, 'release', 'scan-generic.py'))
scanner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(scanner)

OWN = 'See https://github.com/Some-Owner/some-repo/issues'
OTHER = 'See https://github.com/someone-else/their-repo'


def rules(text, **kwargs):
    return [finding[2] for finding in scanner.scan_text('README.md', text, **kwargs)]


class OwnerLoginTest(unittest.TestCase):
    def test_without_an_owner_every_login_is_a_finding(self):
        self.assertEqual(rules(OWN), ['github-url'])
        self.assertEqual(rules(OTHER), ['github-url'])

    def test_the_owner_of_the_repository_may_link_to_itself_in_any_case(self):
        self.assertEqual(rules(OWN, owner='some-owner'), [])
        self.assertEqual(rules(OWN, owner='SOME-OWNER'.lower()), [])

    def test_another_account_is_still_a_finding_when_an_owner_is_given(self):
        self.assertEqual(rules(OTHER, owner='some-owner'), ['github-url'])

    def test_a_login_that_only_starts_like_the_owner_is_still_a_finding(self):
        self.assertEqual(rules('https://github.com/some-owner-two/x', owner='some-owner'), ['github-url'])

    def test_strict_mode_of_a_snapshot_ignores_the_owner(self):
        self.assertEqual(rules(OWN, owner='some-owner', strict=True), ['github-url'])


class RepoOwnerTest(unittest.TestCase):
    def test_the_actions_variable_wins_and_is_lower_cased(self):
        previous = os.environ.get('GITHUB_REPOSITORY_OWNER')
        os.environ['GITHUB_REPOSITORY_OWNER'] = 'Some-Owner'
        try:
            self.assertEqual(scanner.repo_owner(tempfile.gettempdir()), 'some-owner')
        finally:
            if previous is None:
                os.environ.pop('GITHUB_REPOSITORY_OWNER')
            else:
                os.environ['GITHUB_REPOSITORY_OWNER'] = previous

    def test_the_owner_comes_from_the_origin_remote_without_the_variable(self):
        previous = os.environ.pop('GITHUB_REPOSITORY_OWNER', None)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                subprocess.run(['git', 'init', '-q', tmp], check=True)
                subprocess.run(['git', '-C', tmp, 'remote', 'add', 'origin', 'https://github.com/Some-Owner/some-repo.git'], check=True)
                self.assertEqual(scanner.repo_owner(tmp), 'some-owner')
                subprocess.run(['git', '-C', tmp, 'remote', 'set-url', 'origin', 'git@github.com:Other-Owner/x.git'], check=True)
                self.assertEqual(scanner.repo_owner(tmp), 'other-owner')
            with tempfile.TemporaryDirectory() as tmp:
                self.assertIsNone(scanner.repo_owner(tmp))
        finally:
            if previous is not None:
                os.environ['GITHUB_REPOSITORY_OWNER'] = previous


if __name__ == '__main__':
    unittest.main()
