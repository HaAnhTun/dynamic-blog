"""Runs the trust checks of scripts/content-sync (PowerShell, no database, no Docker) as part of the Python test suite.

`scripts/content-sync/unittest.ps1` exercises package-trust.ps1: the HMAC signature of a content package (a replaced dump whose
checksum was recomputed must be refused), the entries of the ZIP, and the allow-list for `pg_restore -l`. It needs PowerShell 7
(`pwsh`), which GitHub's Ubuntu runners have; the test is skipped where there is none. The end-to-end proof on two real databases is
`scripts/content-sync/selftest.ps1` (needs Docker; docs/BACKUP-AND-RESTORE.md and the README of the folder).

run: python scripts/test_content_sync.py
"""
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "content-sync" / "unittest.ps1"


@unittest.skipUnless(shutil.which("pwsh"), "needs PowerShell 7 (pwsh)")
class ContentSyncTrust(unittest.TestCase):
    def test_the_powershell_checks_pass(self):
        result = subprocess.run(
            [shutil.which("pwsh"), "-NoProfile", "-NonInteractive", "-File", str(SCRIPT)],
            capture_output=True, text=True, timeout=300)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("All checks passed.", result.stdout)
        self.assertNotIn("FAIL", result.stdout)

    def test_the_scripts_check_before_they_restore(self):
        """Static guard on the order: the import verifies the package before it talks to Docker or runs pg_restore."""
        text = (ROOT / "scripts" / "content-sync" / "import-content.ps1").read_text(encoding="utf-8")
        signature = text.index("Test-PackageSignature")
        listing = text.index("Get-DumpTocProblems")
        first_docker = text.index("Invoke-Docker exec $Container pg_isready")
        restore = text.index("'pg_restore', '-U'")
        self.assertLess(signature, first_docker, "the signature is checked before any docker command")
        self.assertLess(listing, restore, "the restore list is checked before pg_restore runs")
        self.assertIn("-AllowUnsigned", text)
        self.assertIn("--no-privileges", text)

    def test_nothing_is_copied_into_or_out_of_the_read_only_database_container(self):
        """`docker cp` fails on the read-only postgres container of the compose file (issue 060 follow-up): files travel on stdin/stdout."""
        folder = ROOT / "scripts" / "content-sync"
        for name in ("export-content.ps1", "import-content.ps1", "selftest.ps1"):
            text = (folder / name).read_text(encoding="utf-8")
            code = chr(10).join(line for line in text.splitlines() if not line.lstrip().startswith("#"))
            self.assertNotRegex(code, r"docker(\.exe)?\s+cp|Invoke-Docker\s+cp", name)
            self.assertNotIn("/tmp/cs-", code, name)
        for name in ("export-content.ps1", "import-content.ps1"):
            self.assertIn("docker-stream.ps1", (folder / name).read_text(encoding="utf-8"), name)


if __name__ == "__main__":
    unittest.main()
