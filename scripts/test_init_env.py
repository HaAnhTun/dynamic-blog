"""Guard for scripts/init-env.sh and scripts/init-env.ps1 (offline, standard library only).

`init-env` writes `.env` with fresh random secrets. Two ways for those secrets to leak on a shared machine:

- A secret on the command line of a process (`sed -e "s|^JWT_SECRET=.*|JWT_SECRET=<value>|"`) is readable by every local user in
  `/proc/<pid>/cmdline` and `ps` while the process runs. The shell script keeps the values in shell variables and hands them to
  `sed` through a script file made by the `printf` builtin (mode 600, removed on exit), so no process receives one as an argument.
  The test puts logging stand-ins for the common tools first on PATH and checks that none of the values written to `.env` was ever
  in an argument list.
- A `.env` with the inherited permissions of its folder. The shell script creates it with mode 600. The PowerShell script, on
  Windows, switches inheritance off and grants the current user alone (on PowerShell 7 elsewhere it runs `chmod 600`).

The bash tests need `bash` and `sed` (skipped otherwise); the permission checks run where the platform has the matching notion
(mode bits on POSIX, ACLs on Windows with PowerShell).

run: python scripts/test_init_env.py
"""
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SECRET_KEYS = ["DB_PASSWORD", "DB_OWNER_PASSWORD", "DB_ADMIN_PASSWORD", "JWT_SECRET", "MFA_ENCRYPTION_KEY", "VIEWS_TOKEN", "CLIENT_IP_TOKEN", "NEWSLETTER_SECRET", "MEILI_MASTER_KEY"]
# Every external command the script may start. Each gets a stand-in that appends its arguments to a log and runs the real one.
WATCHED = ["sed", "awk", "grep", "mv", "chmod", "mktemp", "tr", "cat", "head", "od", "base64", "openssl", "python3", "rm", "cp", "tee", "cut", "dirname"]


def find_bash():
    """A bash that can run the script. On Windows, Git Bash (the `bash` of WSL would not see these paths)."""
    candidates = [shutil.which("bash")]
    if os.name == "nt":
        candidates = [r"C:\Program Files\Git\bin\bash.exe", r"C:\Program Files (x86)\Git\bin\bash.exe"] + candidates
    for candidate in candidates:
        if candidate and Path(candidate).exists() and "system32" not in candidate.lower():
            return candidate
    return None


def posix_path(bash, path):
    """The path as the given bash writes it (Git Bash on Windows wants /c/..., not C:\\...)."""
    if os.name != "nt":
        return str(path)
    out = subprocess.run([bash, "-c", 'cygpath -u "$1"', "_", str(path)], capture_output=True, text=True)
    return out.stdout.strip() if out.returncode == 0 and out.stdout.strip() else str(path).replace("\\", "/")


def make_repo(directory):
    """A minimal checkout: the scripts and the template."""
    (directory / "scripts").mkdir()
    for name in ("init-env.sh", "init-env.ps1"):
        shutil.copyfile(ROOT / "scripts" / name, directory / "scripts" / name)
    shutil.copyfile(ROOT / ".env.example", directory / ".env.example")


def read_env(path):
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            values[key] = value
    return values


BASH = find_bash()


@unittest.skipUnless(BASH, "needs bash")
class InitEnvShell(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="init-env-"))
        self.addCleanup(shutil.rmtree, self.directory, ignore_errors=True)
        make_repo(self.directory)
        self.log = self.directory / "argv.log"
        self.stubs = self.directory / "stubs"
        self.stubs.mkdir()

    def install_stubs(self):
        """Logging stand-ins first on PATH: they record the arguments and then run the real command (found before PATH changes)."""
        for name in WATCHED:
            real = subprocess.run([BASH, "-c", f"command -v {name}"], capture_output=True, text=True).stdout.strip()
            if not real:
                continue
            body = (
                "#!/usr/bin/env bash\n"
                f'printf "%s\\0" "{name}" "$@" >> "{posix_path(BASH, self.log)}"\n'
                f'printf "\\n" >> "{posix_path(BASH, self.log)}"\n'
                f'exec "{real}" "$@"\n'
            )
            stub = self.stubs / name
            stub.write_bytes(body.encode("utf-8"))
            stub.chmod(0o755)

    def run_script(self, **extra):
        self.install_stubs()
        # PATH is set inside bash, in the syntax of that bash (Git Bash on Windows uses /c/... paths and ':' as the separator).
        command = 'PATH="$1:$PATH"; shift; exec "$BASH" "$@"'
        return subprocess.run(
            [BASH, "-c", command, "_", posix_path(BASH, self.stubs), posix_path(BASH, self.directory / "scripts" / "init-env.sh")],
            capture_output=True, text=True, cwd=self.directory, env={**os.environ, **extra}, timeout=120)

    def test_it_writes_every_secret_and_prints_none(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        values = read_env(self.directory / ".env")
        for key in SECRET_KEYS:
            self.assertTrue(values.get(key), f"{key} is empty")
            self.assertNotIn(values[key], result.stdout + result.stderr, f"{key} was printed")

    def test_no_secret_is_ever_an_argument_of_another_process(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        logged = self.log.read_bytes().decode("utf-8", "replace")
        self.assertIn("sed", logged, "the stand-in for sed never ran: the test proves nothing")
        values = read_env(self.directory / ".env")
        for key in SECRET_KEYS:
            self.assertNotIn(values[key], logged, f"the value of {key} was on a command line")
        self.assertIsNone(re.search(r"[0-9a-f]{32,}", logged), "a run of 32 or more hex digits was on a command line")

    def test_the_temporary_script_does_not_stay_behind(self):
        self.assertEqual(self.run_script().returncode, 0)
        leftovers = [p.name for p in self.directory.iterdir() if p.name.startswith(".env") and p.name != ".env" and p.name != ".env.example"]
        self.assertEqual(leftovers, [])

    @unittest.skipUnless(os.name == "posix", "mode bits are only meaningful on POSIX")
    def test_env_is_readable_by_the_owner_only(self):
        self.assertEqual(self.run_script().returncode, 0)
        self.assertEqual(stat.S_IMODE((self.directory / ".env").stat().st_mode), 0o600)

    def test_it_refuses_to_overwrite_an_existing_env(self):
        (self.directory / ".env").write_text("KEEP=1\n", encoding="utf-8")
        result = self.run_script()
        self.assertEqual(result.returncode, 1)
        self.assertEqual((self.directory / ".env").read_text(encoding="utf-8"), "KEEP=1\n")

    def test_the_inputs_land_in_env(self):
        result = self.run_script(SITE_URL="https://blog.example.test", SITE_PORT="3010", DEFAULT_LOCALE="vi")
        self.assertEqual(result.returncode, 0, result.stderr)
        values = read_env(self.directory / ".env")
        self.assertEqual((values["SITE_URL"], values["SITE_PORT"], values["DEFAULT_LOCALE"]), ("https://blog.example.test", "3010", "vi"))


def find_pwsh():
    for name in ("pwsh", "powershell"):
        found = shutil.which(name)
        if found:
            return found
    return None


PWSH = find_pwsh()


@unittest.skipUnless(PWSH, "needs PowerShell")
class InitEnvPowerShell(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="init-env-ps-"))
        self.addCleanup(shutil.rmtree, self.directory, ignore_errors=True)
        make_repo(self.directory)

    def run_script(self):
        return subprocess.run(
            [PWSH, "-NoProfile", "-NonInteractive", "-File", str(self.directory / "scripts" / "init-env.ps1")],
            capture_output=True, text=True, cwd=self.directory, timeout=120)

    def test_it_writes_every_secret_and_prints_none(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        values = read_env(self.directory / ".env")
        for key in SECRET_KEYS:
            self.assertTrue(values.get(key), f"{key} is empty")
            self.assertNotIn(values[key], result.stdout + result.stderr)

    @unittest.skipUnless(os.name == "nt", "ACLs exist on Windows only")
    def test_env_has_one_access_rule_for_the_current_user_and_no_inheritance(self):
        # The folder grants read to every local user, the way a shared machine might.
        subprocess.run(["icacls", str(self.directory), "/grant", "*S-1-5-32-545:(OI)(CI)R"], capture_output=True, check=True)
        self.assertEqual(self.run_script().returncode, 0)
        probe = (
            "$a = Get-Acl -LiteralPath $env:INIT_ENV_PROBE; "
            "$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; "
            "$rules = @($a.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }); "
            "Write-Output ($a.AreAccessRulesProtected); Write-Output ($rules.Count); Write-Output ($rules -contains $me)"
        )
        out = subprocess.run([PWSH, "-NoProfile", "-Command", probe], capture_output=True, text=True,
                             env={**os.environ, "INIT_ENV_PROBE": str(self.directory / ".env")})
        protected, count, has_me = out.stdout.split()
        self.assertEqual(protected, "True", "inheritance is still on")
        self.assertEqual(count, "1", out.stdout)
        self.assertEqual(has_me, "True")

    @unittest.skipUnless(os.name == "posix", "mode bits are only meaningful on POSIX")
    def test_env_is_readable_by_the_owner_only(self):
        self.assertEqual(self.run_script().returncode, 0)
        self.assertEqual(stat.S_IMODE((self.directory / ".env").stat().st_mode), 0o600)

    def test_no_temporary_file_stays_behind(self):
        self.assertEqual(self.run_script().returncode, 0)
        leftovers = [p.name for p in self.directory.iterdir() if p.name.startswith(".env") and p.name not in (".env", ".env.example")]
        self.assertEqual(leftovers, [])


if __name__ == "__main__":
    unittest.main()
