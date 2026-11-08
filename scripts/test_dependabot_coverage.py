"""Guard for the dependency update coverage of the repository (offline, standard library only).

Pins only help while somebody moves them: a base image, a compose image or a package that no Dependabot entry watches stays on its
old version until a person remembers it. This file checks, from the files of the repository:

- every folder that holds a Dockerfile, a compose file, a pom.xml or a package.json (and the workflows) has an entry in
  `.github/dependabot.yml` for the matching ecosystem;
- every entry has a `cooldown`, so a release published an hour ago is not proposed (a malicious release is usually pulled within
  days; security updates are not delayed by it);
- the Meilisearch version written in the compose file, the scripts, the tests and the docs is the one pinned in `docker-compose.yml`.
  The engine is named in about ten places that no tool can read from one source, so a bump of the compose pin fails here until the
  copies follow.

The files are the ones `git ls-files` lists (tracked, or untracked and not ignored), so a gitignored folder such as the local tooling of a
developer is never a finding; a tree that is not a git checkout is walked.

run: python scripts/test_dependabot_coverage.py
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEPENDABOT = ROOT / ".github" / "dependabot.yml"
SKIPPED_DIRS = {".git", "node_modules", "target", ".next", "test-results", "playwright-report", ".worktrees", ".scratch", "private"}

MANIFESTS = {
    "docker": ("Dockerfile",),
    "docker-compose": ("docker-compose.yml", "docker-compose.yaml"),
    "maven": ("pom.xml",),
    "npm": ("package.json",),
}


def candidate_files(root):
    """The files to look at. In a git checkout (a folder or a linked worktree) `git ls-files` lists them: what is tracked plus what is
    not yet tracked but not ignored, so a gitignored folder of a developer (local tooling, caches) is never a finding. Without a checkout
    (the temporary trees of the cases below) the folder is walked and the build output folders are skipped."""
    if (root / ".git").exists():
        try:
            listing = subprocess.run(
                ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=root, capture_output=True, check=True, timeout=60
            ).stdout.decode("utf-8")
        except (OSError, subprocess.SubprocessError, UnicodeDecodeError):
            listing = None  # git is missing or refuses the folder: walk it
        if listing is not None:
            paths = {root / name for name in listing.split("\x00") if name}
            return [path for path in paths if path.is_file()]
    found = []
    for folder, directories, files in os.walk(root):
        directories[:] = [d for d in directories if d not in SKIPPED_DIRS]
        found.extend(Path(folder) / name for name in files)
    return found


def repository_files(root, names=(), suffixes=()):
    """Files of the repository whose name is in `names` or ends with one of `suffixes` (build output folders are skipped)."""
    found = []
    for path in candidate_files(root):
        if any(part in SKIPPED_DIRS for part in path.relative_to(root).parts[:-1]):
            continue
        if path.name in names or path.name.endswith(tuple(suffixes)):
            found.append(path)
    return sorted(found)


def dependabot_entries(text):
    """[{ecosystem, directory, cooldown, ignored_majors}] of a dependabot.yml (a text parse: there is no YAML library in CI).
    `ignored_majors` holds the dependency names of the `ignore` rules that skip the major versions."""
    entries = []
    pending = None
    for line in text.splitlines():
        start = re.match(r"^  - package-ecosystem:\s*(\S+)", line)
        if start:
            entries.append({"ecosystem": start.group(1), "directory": None, "cooldown": False, "ignored_majors": set()})
            pending = None
        elif entries:
            directory = re.match(r"""^    directory:\s*["']?([^"'\s]+)""", line)
            if directory:
                entries[-1]["directory"] = directory.group(1)
            if re.match(r"^    cooldown:\s*$", line):
                entries[-1]["cooldown"] = True
            rule = re.match(r"""^      - dependency-name:\s*["']?([^"'\s]+)""", line)
            if rule:
                pending = rule.group(1)
            elif pending and re.match(r"^        update-types:.*semver-major", line):
                entries[-1]["ignored_majors"].add(pending)
    return entries


def directory_name(folder, root):
    relative = folder.relative_to(root).as_posix()
    return "/" if relative == "." else "/" + relative


def coverage_violations(entries, root):
    """The folders no entry watches, and the entries without a cooldown."""
    found = []
    covered = {(entry["ecosystem"], entry["directory"]) for entry in entries}
    wanted = []
    for ecosystem, names in MANIFESTS.items():
        wanted.extend((ecosystem, directory_name(path.parent, root)) for path in repository_files(root, names=names))
    if (root / ".github" / "workflows").is_dir():
        wanted.append(("github-actions", "/"))
    for ecosystem, directory in sorted(set(wanted)):
        if (ecosystem, directory) not in covered:
            found.append(f"dependabot.yml has no `{ecosystem}` entry for `{directory}`")
    for entry in entries:
        if not entry["cooldown"]:
            found.append(f"dependabot.yml: the `{entry['ecosystem']}` entry for `{entry['directory']}` has no `cooldown`")
        if entry["ecosystem"] == "docker-compose" and "postgres" not in entry["ignored_majors"] and names_postgres(root, entry["directory"]):
            found.append(
                f"dependabot.yml: the `docker-compose` entry for `{entry['directory']}` must ignore the major versions of `postgres` "
                "(`ignore` with `update-types: ['version-update:semver-major']`): a new major needs a data migration"
            )
    return found


def names_postgres(root, directory):
    """True when a compose file in the folder runs the PostgreSQL image."""
    folder = root / (directory or "/").lstrip("/")
    for name in MANIFESTS["docker-compose"]:
        path = folder / name
        try:
            if path.is_file() and re.search(r"^\s*image:\s*[\"']?postgres[:@]", path.read_text(encoding="utf-8"), re.M):
                return True
        except (OSError, UnicodeDecodeError):
            continue
    return False


MEILI_SUFFIXES = (".md", ".java", ".bat", ".yml", ".yaml", ".sh", ".ps1")
MEILI_REFERENCE = re.compile(r"getmeili/meilisearch:(v\d+\.\d+\.\d+)|Meilisearch `?(v\d+\.\d+\.\d+)")
MEILI_VERSION_ASSERTION = re.compile(r'path\("version"\)\.asString\(\)\)\.isEqualTo\("(\d+\.\d+\.\d+)"\)')


def meili_versions(files):
    """{version: [file names]} for every Meilisearch version the files name."""
    found = {}
    for path in files:
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for match in MEILI_REFERENCE.finditer(text):
            found.setdefault(match.group(1) or match.group(2), []).append(path.name)
        for match in MEILI_VERSION_ASSERTION.finditer(text):
            found.setdefault("v" + match.group(1), []).append(path.name)
    return found


def meili_files(root):
    # The changelog keeps the history of old versions on purpose.
    return [p for p in repository_files(root, suffixes=MEILI_SUFFIXES) if p.name != "CHANGELOG.md"]


class DependabotCoverage(unittest.TestCase):
    def test_every_manifest_folder_has_an_entry_and_every_entry_a_cooldown(self):
        entries = dependabot_entries(DEPENDABOT.read_text(encoding="utf-8"))
        self.assertTrue(entries)
        found = coverage_violations(entries, ROOT)
        self.assertEqual([], found, "\n" + "\n".join(found))

    def test_the_meilisearch_version_is_the_compose_pin_everywhere(self):
        compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
        pinned = re.search(r"image:\s*getmeili/meilisearch:(v\d+\.\d+\.\d+)@sha256:", compose)
        self.assertTrue(pinned, "docker-compose.yml has no pinned Meilisearch image")
        versions = meili_versions(meili_files(ROOT))
        self.assertIn(pinned.group(1), versions)
        others = {version: names for version, names in versions.items() if version != pinned.group(1)}
        self.assertEqual({}, others, f"docker-compose.yml pins Meilisearch {pinned.group(1)}; these name another version: {others}")

    def write(self, root, name, text):
        path = Path(root) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def test_detects_a_folder_without_an_entry_and_an_entry_without_a_cooldown(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".github" / "workflows").mkdir(parents=True)
            self.write(root, "app/Dockerfile", "FROM x\n")
            self.write(root, "docker-compose.yml", "services: {}\n")
            self.write(root, "node_modules/x/package.json", "{}")
            text = (
                "version: 2\nupdates:\n  - package-ecosystem: docker\n    directory: /app\n    cooldown:\n      default-days: 7\n"
                "  - package-ecosystem: github-actions\n    directory: /\n"
            )
            found = coverage_violations(dependabot_entries(text), root)
        self.assertEqual(2, len(found), found)
        self.assertTrue(any("docker-compose" in item and "`/`" in item for item in found), found)
        self.assertTrue(any("github-actions" in item and "cooldown" in item for item in found), found)

    def test_accepts_full_coverage(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.write(root, "backend/pom.xml", "<project/>")
            self.write(root, "backend/Dockerfile", "FROM x\n")
            self.write(root, "docker-compose.yml", "services: {}\n")
            text = (
                "version: 2\nupdates:\n"
                "  - package-ecosystem: maven\n    directory: /backend\n    cooldown:\n      default-days: 7\n"
                "  - package-ecosystem: docker\n    directory: '/backend'\n    cooldown:\n      default-days: 7\n"
                "  - package-ecosystem: docker-compose\n    directory: /\n    cooldown:\n      default-days: 7\n"
            )
            self.assertEqual([], coverage_violations(dependabot_entries(text), root))

    def test_a_compose_entry_for_postgres_must_ignore_major_versions(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.write(root, "docker-compose.yml", "services:\n  db:\n    image: postgres:18@sha256:" + "a" * 64 + "\n")
            head = "version: 2\nupdates:\n  - package-ecosystem: docker-compose\n    directory: /\n    cooldown:\n      default-days: 7\n"
            found = coverage_violations(dependabot_entries(head), root)
            self.assertEqual(1, len(found), found)
            self.assertIn("postgres", found[0])
            self.assertIn("semver-major", found[0])
            ignored = head + "    ignore:\n      - dependency-name: postgres\n        update-types: ['version-update:semver-major']\n"
            self.assertEqual([], coverage_violations(dependabot_entries(ignored), root))
            # Ignoring only minor versions, or another package, does not help.
            wrong = head + "    ignore:\n      - dependency-name: postgres\n        update-types: ['version-update:semver-minor']\n"
            self.assertEqual(1, len(coverage_violations(dependabot_entries(wrong), root)))
            other = head + "    ignore:\n      - dependency-name: other\n        update-types: ['version-update:semver-major']\n"
            self.assertEqual(1, len(coverage_violations(dependabot_entries(other), root)))

    def test_an_ignored_folder_with_a_manifest_is_not_reported(self):
        # In a git checkout the files come from `git ls-files`, so what .gitignore hides (the local tooling folder of a developer, build
        # output nobody listed in SKIPPED_DIRS) is not a finding. Without a checkout the walk is the fallback (the other cases).
        if not shutil.which("git"):
            self.skipTest("git is not available")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            subprocess.run(["git", "init", "-q"], cwd=root, check=True, capture_output=True)
            self.write(root, ".gitignore", "local-tooling/\n")
            self.write(root, "backend/pom.xml", "<project/>")
            self.write(root, "local-tooling/runtime/package.json", "{}")
            self.write(root, "local-tooling/runtime/Dockerfile", "FROM x\n")
            text = "version: 2\nupdates:\n  - package-ecosystem: maven\n    directory: /backend\n    cooldown:\n      default-days: 7\n"
            self.assertEqual([], coverage_violations(dependabot_entries(text), root))
            self.assertEqual(["backend/pom.xml"], [path.relative_to(root).as_posix() for path in repository_files(root, names=("pom.xml", "package.json"))])
            # The same tree is still checked: a manifest that is not ignored needs its entry.
            self.write(root, "frontend/package.json", "{}")
            found = coverage_violations(dependabot_entries(text), root)
        self.assertEqual(1, len(found), found)
        self.assertIn("`npm` entry for `/frontend`", found[0])

    def test_the_files_of_the_walk_and_of_git_agree_on_a_clean_tree(self):
        if not shutil.which("git"):
            self.skipTest("git is not available")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.write(root, "backend/pom.xml", "<project/>")
            self.write(root, "node_modules/x/package.json", "{}")
            walked = [path.relative_to(root).as_posix() for path in repository_files(root, names=("pom.xml", "package.json"))]
            subprocess.run(["git", "init", "-q"], cwd=root, check=True, capture_output=True)
            listed = [path.relative_to(root).as_posix() for path in repository_files(root, names=("pom.xml", "package.json"))]
        self.assertEqual(["backend/pom.xml"], walked)
        self.assertEqual(walked, listed, "a skipped folder such as node_modules is skipped on both routes")

    def test_detects_a_meilisearch_version_that_differs(self):
        with tempfile.TemporaryDirectory() as tmp:
            one = self.write(tmp, "a.md", "pull getmeili/meilisearch:v1.54.3 and Meilisearch `v1.54.3`")
            two = self.write(tmp, "b.bat", 'set "IMAGE=getmeili/meilisearch:v1.55.0"')
            three = self.write(tmp, "c.java", 'assertThat(meili.path("version").asString()).isEqualTo("1.54.3");')
            versions = meili_versions([one, two, three])
        self.assertEqual({"v1.54.3", "v1.55.0"}, set(versions))
        self.assertEqual(["a.md", "a.md", "c.java"], sorted(versions["v1.54.3"]))


if __name__ == "__main__":
    sys.exit(0 if unittest.main(exit=False).result.wasSuccessful() else 1)
