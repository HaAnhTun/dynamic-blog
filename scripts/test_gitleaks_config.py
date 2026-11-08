"""Guard for the secret scanning of the repository (standard library only; the scanner cases need Docker).

CI runs gitleaks twice (the `guards` job of `.github/workflows/ci.yml`): `dir` over the files of the checkout and `git` over the
history, because a secret that was added and removed again within a pull request is in no file any more but still in the history.
`.gitleaks.toml` allows a handful of invented test values. These checks keep that file honest:

- the shape of every allowlist (text checks, always run): an entry is the anchored regex of ONE exact value and nothing else. A file
  is never exempt as a whole: in `gitleaks dir` a file that matches the `paths` of any allowlist is not scanned at all, even with
  `condition = "AND"` and a regex (gitleaks 8.30, `shouldSkipPath`), so `paths` are not allowed here;
- the CI workflow runs both scans, with the checkout mounted read-only (text check);
- with Docker (the pinned scanner image of ci.yml): a token added in one commit and removed in the next is found by `git` and, as a
  reminder of why the second scan exists, not by `dir`; the allowlisted value alone is accepted, but a token in the same file is found,
  and so is any other secret-shaped value. The fake tokens are generated at run time, so no token-shaped text sits in this file.
  The scanner runs with `--exit-code 2`, so a leak (2) cannot be confused with a scanner error (1, such as a bad config).
  Set REQUIRE_DOCKER=1 (CI does) to fail instead of skipping when Docker is missing.

run: python scripts/test_gitleaks_config.py
"""
import os
import random
import re
import shutil
import string
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

try:
    import tomllib
except ImportError:  # Python before 3.11: the shape checks are skipped, the scanner cases still run
    tomllib = None

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / ".gitleaks.toml"
CI = ROOT / ".github" / "workflows" / "ci.yml"
IMAGE = re.compile(r"ghcr\.io/gitleaks/gitleaks:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}")

# A file name for the scratch trees, and one allowlisted value, read from .gitleaks.toml (the entry whose description starts with
# ALLOWED_ENTRY, chosen by name so that reordering the file cannot change it; its regex is `^value$`, with an escape removed), so that
# no secret-shaped literal is repeated in this file.
ALLOWED_PATH = "app/route.test.ts"
ALLOWED_ENTRY = "Development encryption key"

# The exit code of a scan that found a leak. The tests ask the scanner for 2 (CI keeps the default 1) so that a scanner error, which is
# always 1, cannot pass as a leak.
LEAKS = 2
CLEAN = 0

# The seed of the "another secret-shaped value" case. A random value is not always reported: the generic-api-key rule drops a value that
# holds one of its stopwords or no digit (about 2 of 100 random values of 40 letters and digits), so a random value would turn the CI job
# red now and then. This seed gives a value that the pinned scanner reports; `GenericValue` keeps the
# assumptions (40 characters, a digit) in view, and the scan case fails loudly if a scanner upgrade ever drops the value.
GENERIC_VALUE_SEED = 1


def allowed_value():
    if tomllib is None:
        return None
    entries = tomllib.loads(CONFIG.read_text(encoding="utf-8"))["allowlists"]
    entry = next(entry for entry in entries if entry["description"].startswith(ALLOWED_ENTRY))
    return re.sub(r"\\(.)", r"\1", entry["regexes"][0][1:-1])


def fake_github_token():
    """A string shaped like a GitHub personal access token, made now, so that no such text is in the repository."""
    alphabet = string.ascii_letters + string.digits
    return "ghp" + "_" + "".join(random.SystemRandom().choice(alphabet) for _ in range(36))


def generic_secret_value():
    """A 40-character value of letters and digits for the generic rule, assembled now from a fixed seed: no such literal sits in this
    file, and the value is the same on every run."""
    alphabet = string.ascii_letters + string.digits
    generator = random.Random(GENERIC_VALUE_SEED)
    return "".join(generator.choice(alphabet) for _ in range(40))


def docker_ready():
    if not shutil.which("docker"):
        return False
    try:
        return subprocess.run(["docker", "info"], capture_output=True, timeout=60).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


class GenericValue(unittest.TestCase):
    def test_the_value_is_stable_and_holds_a_digit(self):
        value = generic_secret_value()
        self.assertEqual(40, len(value))
        self.assertEqual(value, generic_secret_value(), "the value must not change between runs")
        self.assertTrue(any(character.isdigit() for character in value), "the generic rule drops a value without a digit")


class ConfigShape(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if tomllib is None:
            raise unittest.SkipTest("tomllib needs Python 3.11 or newer")
        cls.config = tomllib.loads(CONFIG.read_text(encoding="utf-8"))

    def test_the_default_rules_stay_on(self):
        self.assertTrue(self.config["extend"]["useDefault"])

    def test_no_global_allowlist_exempts_paths_or_regexes(self):
        self.assertNotIn("allowlist", self.config)

    def test_every_entry_is_one_exact_value_and_nothing_else(self):
        entries = self.config["allowlists"]
        self.assertTrue(entries)
        for entry in entries:
            name = entry.get("description", entry)
            self.assertEqual({"description", "regexTarget", "regexes"}, set(entry), f"{name}: only a description and exact values are allowed")
            self.assertEqual("secret", entry["regexTarget"], name)
            self.assertTrue(entry["regexes"], f"{name}: no value")
            for regex in entry["regexes"]:
                self.assertTrue(regex.startswith("^") and regex.endswith("$"), f"{name}: the regex `{regex}` must match one exact value")
                self.assertNotRegex(regex, r"\.\*|\.\+", f"{name}: the regex `{regex}` is open-ended")

    def test_ci_scans_the_files_and_the_history_read_only(self):
        ci = CI.read_text(encoding="utf-8")
        scanner = IMAGE.search(ci)
        self.assertTrue(scanner, "ci.yml does not run the pinned gitleaks image")
        commands = [line for line in ci.splitlines() if scanner.group(0) in line]
        modes = {re.search(r"@sha256:[0-9a-f]{64}\s+(dir|git)\b", line).group(1) for line in commands if re.search(r"@sha256:[0-9a-f]{64}\s+(dir|git)\b", line)}
        self.assertEqual({"dir", "git"}, modes, "ci.yml must run `gitleaks dir` and `gitleaks git`")
        for line in commands:
            self.assertIn(':/repo:ro"', line, "the scanner container must mount the checkout read-only")
            self.assertIn("--redact", line)


class Scanner(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not docker_ready():
            if os.environ.get("REQUIRE_DOCKER") == "1":
                raise AssertionError("REQUIRE_DOCKER=1 but Docker is not available")
            raise unittest.SkipTest("Docker is not available")
        found = IMAGE.search(CI.read_text(encoding="utf-8"))
        if not found:
            raise AssertionError("ci.yml names no pinned gitleaks image")
        cls.image = found.group(0)

    def make_tree(self):
        tree = Path(tempfile.mkdtemp(prefix="gitleaks-test-"))
        self.addCleanup(shutil.rmtree, tree, True)
        shutil.copy(CONFIG, tree / ".gitleaks.toml")
        return tree

    def scan(self, tree, mode):
        command = ["docker", "run", "--rm", "-v", f"{tree}:/repo:ro", self.image, mode, "/repo", "--no-banner", "--redact", "--exit-code", str(LEAKS)]
        result = subprocess.run(command, capture_output=True, text=True, timeout=300)
        self.assertIn(result.returncode, (CLEAN, LEAKS), f"the scanner failed instead of scanning (exit {result.returncode}): {result.stderr[-500:]}")
        return result.returncode

    def git(self, tree, *args):
        env = dict(os.environ, GIT_AUTHOR_NAME="test", GIT_AUTHOR_EMAIL="test@example.test", GIT_COMMITTER_NAME="test",
                   GIT_COMMITTER_EMAIL="test@example.test")
        subprocess.run(["git", "-c", "commit.gpgsign=false", *args], cwd=tree, env=env, check=True, capture_output=True)

    def put(self, tree, relative, text):
        path = tree / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def test_a_token_added_and_removed_again_is_found_in_the_history_only(self):
        tree = self.make_tree()
        self.git(tree, "init", "-q")
        self.put(tree, "notes.txt", "nothing here\n")
        self.git(tree, "add", "-A")
        self.git(tree, "commit", "-q", "-m", "A: base")
        self.put(tree, "deploy.txt", f"token: {fake_github_token()}\n")
        self.git(tree, "add", "-A")
        self.git(tree, "commit", "-q", "-m", "B: adds a token")
        (tree / "deploy.txt").unlink()
        self.git(tree, "add", "-A")
        self.git(tree, "commit", "-q", "-m", "C: removes it")
        self.assertEqual(CLEAN, self.scan(tree, "dir"), "the file scan cannot see a removed token")
        self.assertEqual(LEAKS, self.scan(tree, "git"), "the history scan must see it")

    def test_the_allowlisted_value_alone_is_accepted(self):
        tree = self.make_tree()
        self.put(tree, ALLOWED_PATH, f"const TOKEN = '{allowed_value()}'\n")
        self.assertEqual(CLEAN, self.scan(tree, "dir"))

    def test_a_file_with_an_allowlisted_value_is_not_exempt_as_a_whole(self):
        tree = self.make_tree()
        self.put(tree, ALLOWED_PATH, f"const TOKEN = '{allowed_value()}'\nconst OTHER = '{fake_github_token()}'\n")
        self.assertEqual(LEAKS, self.scan(tree, "dir"), "another secret in the same file is found")

    def test_another_secret_shaped_value_is_found(self):
        tree = self.make_tree()
        self.put(tree, ALLOWED_PATH, f"const TOKEN = '{generic_secret_value()}'\n")
        self.assertEqual(LEAKS, self.scan(tree, "dir"), "the generic rule is still on")


if __name__ == "__main__":
    sys.exit(0 if unittest.main(exit=False).result.wasSuccessful() else 1)
