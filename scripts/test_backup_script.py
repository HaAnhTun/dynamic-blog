"""Tests of the backup script printed in docs/BACKUP-AND-RESTORE.md (offline, a few seconds, standard library only).

The dump holds password hashes, reader accounts, newsletter and contact email addresses, and the docs say to treat it like `.env`.
The script is meant to be copied into a root cron job, whose default umask is 022: left alone it would make the folder 0755 and the
dumps 0644, readable by every local user, and `rsync -a` would copy those modes to the other machine. These tests extract the script
from the document, so the text the reader copies is the text that is tested.

run: python scripts/test_backup_script.py
The modes are checked on a POSIX machine with `rsync` (the CI job); elsewhere only the text of the script is checked.
"""
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
DOC = os.path.join(os.path.dirname(HERE), 'docs', 'BACKUP-AND-RESTORE.md')

POSIX = os.name == 'posix' and shutil.which('sh') is not None and shutil.which('install') is not None
RSYNC = shutil.which('rsync') is not None


def fenced_blocks(text):
    """Every fenced block as (info string, body)."""
    blocks = []
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        match = re.match(r'^(\s*)(`{3,})(\S*)\s*$', lines[i])
        if match:
            fence = match.group(2)
            body = []
            i += 1
            while i < len(lines) and not lines[i].lstrip().startswith(fence):
                body.append(lines[i])
                i += 1
            blocks.append((match.group(3), '\n'.join(body)))
        i += 1
    return blocks


def read_doc():
    with open(DOC, encoding='utf-8') as handle:
        return handle.read()


def cron_script():
    found = [body for _, body in fenced_blocks(read_doc()) if '# /usr/local/bin/blog-backup' in body]
    assert len(found) == 1, 'expected exactly one block holding the blog-backup script, found %d' % len(found)
    return found[0]


def adhoc_dump_command():
    found = [body for _, body in fenced_blocks(read_doc()) if 'pg_dump -Fc' in body and 'blog-backup' not in body]
    assert found, 'expected a block with the ad-hoc pg_dump command'
    return found[0]


def position(script, pattern):
    match = re.search(pattern, script, re.MULTILINE)
    return match.start() if match else None


class BackupScriptTextTest(unittest.TestCase):
    def test_umask_is_set_before_anything_is_created(self):
        script = cron_script()
        umask = position(script, r'^umask 077\b')
        self.assertIsNotNone(umask, 'the script must set `umask 077`')
        for creator in (r'^\s*mkdir\b', r'^\s*install\b', r'>\s*"?\$'):
            first = position(script, creator)
            if first is not None:
                self.assertLess(umask, first, 'umask 077 must come before ' + creator)

    def test_the_folder_is_private_even_when_it_already_exists(self):
        script = cron_script()
        self.assertIn('install -d -m 700 "$dir"', script)
        self.assertIsNotNone(position(script, r'^chmod 700 "\$dir"'), 'an existing folder created as 0755 must be fixed')

    def test_the_copy_to_the_other_machine_does_not_keep_open_modes(self):
        script = cron_script()
        self.assertIsNotNone(
            position(script, r'^rsync -a --chmod=D700,F600 '), 'rsync -a copies the modes of the source unless told otherwise'
        )

    def test_the_ad_hoc_dump_is_made_under_a_private_umask(self):
        command = adhoc_dump_command()
        umask = position(command, r'^umask 077\b')
        dump = position(command, r'pg_dump -Fc')
        self.assertIsNotNone(umask, 'the ad-hoc dump command must be preceded by `umask 077`')
        self.assertLess(umask, dump)

    def test_the_text_states_the_modes_and_advises_encrypting_off_the_host(self):
        text = read_doc()
        self.assertTrue('0700' in text and '0600' in text, 'the document must state the modes: folder 0700, dump 0600')
        self.assertTrue(re.search(r'(?i)encrypt', text), 'the document must advise encrypting copies kept off the host')


@unittest.skipUnless(POSIX and RSYNC, 'needs a POSIX machine with sh, install and rsync (the CI job has them)')
class BackupScriptRunTest(unittest.TestCase):
    """Runs the script of the document under the umask of a cron job (022) against a fake `docker`, a local folder and a local rsync."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='blog-backup-test-')
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.app = os.path.join(self.tmp, 'app')
        self.backups = os.path.join(self.tmp, 'backups')
        self.remote = os.path.join(self.tmp, 'remote')
        bin_dir = os.path.join(self.tmp, 'bin')
        for folder in (self.app, bin_dir, self.remote):
            os.makedirs(folder)
        with open(os.path.join(bin_dir, 'docker'), 'w', encoding='utf-8', newline='\n') as handle:
            handle.write("#!/bin/sh\nprintf 'dump-bytes'\n")
        os.chmod(os.path.join(bin_dir, 'docker'), 0o755)
        script = cron_script()
        script = script.replace('cd /opt/blog', 'cd ' + self.app)
        script = script.replace('dir=/var/backups/blog', 'dir=' + self.backups)
        script = script.replace('backup@<other-machine>:blog-backups/', self.remote + '/')
        self.assertNotIn('/var/backups', script)
        self.assertNotIn('<other-machine>', script)
        self.script = os.path.join(self.tmp, 'blog-backup')
        with open(self.script, 'w', encoding='utf-8', newline='\n') as handle:
            handle.write(script + '\n')
        self.env = dict(os.environ, PATH=bin_dir + os.pathsep + os.environ['PATH'])

    def run_script(self):
        # `umask 022` is what a root cron job starts with.
        result = subprocess.run(['sh', '-c', 'umask 022; exec sh "$0"', self.script], env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    @staticmethod
    def mode(path):
        return stat.S_IMODE(os.stat(path).st_mode)

    def test_a_new_backup_folder_and_dump_are_private_under_umask_022(self):
        self.run_script()
        self.assertEqual(self.mode(self.backups), 0o700)
        dumps = [n for n in os.listdir(self.backups) if n.startswith('blog-') and n.endswith('.dump')]
        self.assertEqual(len(dumps), 1)
        self.assertEqual(self.mode(os.path.join(self.backups, dumps[0])), 0o600)
        with open(os.path.join(self.backups, dumps[0]), 'rb') as handle:
            self.assertEqual(handle.read(), b'dump-bytes')
        self.assertEqual([n for n in os.listdir(self.backups) if n.endswith('.part')], [])

    def test_a_folder_and_dumps_left_open_by_an_earlier_script_are_closed(self):
        os.makedirs(self.backups)
        os.chmod(self.backups, 0o755)
        old = os.path.join(self.backups, 'blog-2000-01-01.dump')
        with open(old, 'wb') as handle:
            handle.write(b'older')
        os.chmod(old, 0o644)
        self.run_script()
        self.assertEqual(self.mode(self.backups), 0o700)
        self.assertEqual(self.mode(old), 0o600)

    def test_the_copy_on_the_other_machine_is_not_readable_by_group_or_others(self):
        self.run_script()
        copied = [n for n in os.listdir(self.remote) if n.endswith('.dump')]
        self.assertEqual(len(copied), 1)
        self.assertEqual(self.mode(os.path.join(self.remote, copied[0])) & 0o077, 0)
        self.assertEqual(self.mode(self.remote) & 0o077, 0)


if __name__ == '__main__':
    unittest.main()
