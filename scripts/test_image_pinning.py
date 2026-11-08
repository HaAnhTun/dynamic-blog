"""Guard for the container images the repository builds from, composes and runs in CI (offline, standard library only).

`test_workflow_pinning.py` already pins every `uses:` and every `image:` line of the workflows. This file covers the rest of the
places where an image tag can float: the `FROM` lines of the Dockerfiles (they decide what the published images contain), the
`image:` lines of the compose files, the images a workflow action pulls on its own (the QEMU emulator image, the BuildKit image,
the SBOM scanner image), the images that `scripts/release/export-clean-snapshot.py` runs, and the bind mounts of the scanners.
A mutable tag lets a hijacked upstream put code into the build, the scan or the release.

The same scanner image must also be the same digest wherever it is named (Dependabot cannot update a `docker run` line, so the
copies are updated by hand and this check keeps them from drifting), and so must PostgreSQL: the CI e2e service, the compose files and
the export script run one database image, so the suite is not tested against another patch release than the one that is deployed.

run: python scripts/test_image_pinning.py
"""
import re
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKFLOWS = sorted((ROOT / ".github" / "workflows").glob("*.yml"))
DOCKERFILES = [ROOT / "backend" / "Dockerfile", ROOT / "frontend" / "Dockerfile"]
COMPOSE_FILES = [ROOT / "docker-compose.yml", ROOT / "backend" / "docker-compose.yml"]
EXPORT_SCRIPT = ROOT / "scripts" / "release" / "export-clean-snapshot.py"

# name:tag@sha256:<64 hex>; the tag is required so that a reader (and Dependabot) can tell which version the digest is.
TAG_AND_DIGEST = re.compile(r"^[\w./-]+:[\w.-]+@sha256:[0-9a-f]{64}$")
DIGEST = re.compile(r"@sha256:[0-9a-f]{64}")


def pinned(reference):
    return bool(TAG_AND_DIGEST.match(reference)) and not reference.split("@")[0].endswith(":latest")


def dockerfile_violations(path):
    found = []
    stages = set()
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        match = re.match(r"^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?\s*$", line, re.I)
        if not match:
            continue
        reference, stage = match.group(1), match.group(2)
        if stage:
            stages.add(stage.lower())
        if reference.lower() in stages or reference.lower() == "scratch":
            continue
        if not pinned(reference):
            found.append(f"{path.name}:{number}: base image without `name:tag@sha256:` pin: {reference}")
    return found


def compose_violations(path):
    found = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        match = re.match(r"^\s*image:\s*(\S+)\s*(?:#.*)?$", line)
        if not match:
            continue
        reference = match.group(1)
        # `${NAME:-local-name:tag}`: a name built on this machine (docker compose build), nothing to pin.
        if reference.startswith("${") or reference.startswith('"${'):
            continue
        if not pinned(reference.strip("\"'")):
            found.append(f"{path.parent.name}/{path.name}:{number}: compose image without `name:tag@sha256:` pin: {reference}")
    return found


def step_blocks(lines):
    """Split a workflow into its steps: lists of (line number, text), a step starting at a line with `- `."""
    blocks = []
    for number, line in enumerate(lines, 1):
        if re.match(r"^\s*-\s+(name|uses|run|id|if|env|with):", line):
            blocks.append([])
        if blocks:
            blocks[-1].append((number, line))
    return blocks


def workflow_violations(path):
    """Images that an action pulls by default, and the bind mounts of the scanner containers."""
    found = []
    lines = path.read_text(encoding="utf-8").splitlines()
    for block in step_blocks(lines):
        text = "\n".join(line for _, line in block)
        first = block[0][0]
        place = f"{path.name}:{first}"
        if "docker/setup-qemu-action@" in text:
            image = re.search(r"^\s+image:\s*(\S+)", text, re.M)
            if not image:
                found.append(f"{place}: setup-qemu-action without `image:` (the default is tonistiigi/binfmt:latest)")
            elif not pinned(image.group(1)):
                found.append(f"{place}: setup-qemu-action image without `name:tag@sha256:` pin: {image.group(1)}")
        if "docker/setup-buildx-action@" in text:
            image = re.search(r"driver-opts:.*?image=([^\s'\"]+)", text, re.S)
            if not image:
                found.append(f"{place}: setup-buildx-action without `driver-opts: image=...` (the default BuildKit image floats)")
            elif not pinned(image.group(1)):
                found.append(f"{place}: BuildKit image without `name:tag@sha256:` pin: {image.group(1)}")
        for number, line in block:
            sbom = re.match(r"^\s+sbom:\s*(\S+)", line)
            if sbom:
                value = sbom.group(1)
                generator = re.match(r"generator=(\S+)$", value)
                if value == "false":
                    continue
                if not generator:
                    found.append(f"{path.name}:{number}: `sbom: {value}` uses the floating default scanner image; set `sbom: generator=<name:tag@sha256:...>`")
                elif not pinned(generator.group(1)):
                    found.append(f"{path.name}:{number}: SBOM scanner image without `name:tag@sha256:` pin: {generator.group(1)}")
    found.extend(mount_violations(path, lines))
    return found


WRITABLE_ROOTS = ("$GITHUB_WORKSPACE", "$HOME/.m2", "$RUNNER_TEMP")


def mount_violations(path, lines):
    """A scanner container reads the checkout (or a build output); it has no reason to write to it."""
    found = []
    for number, line in enumerate(lines, 1):
        for match in re.finditer(r'-v\s+"?([^\s"]+)"?', line):
            mount = match.group(1)
            if mount.startswith(WRITABLE_ROOTS) and not mount.endswith(":ro"):
                found.append(f"{path.name}:{number}: bind mount `{mount}` is writable; add `:ro`")
    return found


def export_script_violations(path):
    found = []
    text = path.read_text(encoding="utf-8")
    for match in re.finditer(r"""['"]((?:ghcr\.io/gitleaks/gitleaks|postgres)(?:[:@][^'"]*)?)['"]""", text):
        reference = match.group(1)
        if not pinned(reference):
            number = text.count("\n", 0, match.start()) + 1
            found.append(f"{path.name}:{number}: image without `name:tag@sha256:` pin: {reference}")
    for match in re.finditer(r"""f'\{dest\}:/repo([^']*)'""", text):
        if match.group(1) != ":ro":
            number = text.count("\n", 0, match.start()) + 1
            found.append(f"{path.name}:{number}: the gitleaks container mounts the snapshot writable; add `:ro`")
    return found


# Images that several files name and that no tool bumps together: the scanners (a `docker run` line), and PostgreSQL (the compose files, the
# service of the CI e2e job and the export script), so that CI tests against the database that the compose file runs.
SCANNER_IMAGES = ("aquasec/trivy", "ghcr.io/gitleaks/gitleaks", "postgres")
SCANNER_FILES = [*WORKFLOWS, *COMPOSE_FILES, EXPORT_SCRIPT, ROOT / "docs" / "DEVELOPMENT.md"]


def scanner_digests(paths):
    """{image: {digest: [file names]}} for the scanner images named in the given files."""
    found = {}
    for path in paths:
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        for image in SCANNER_IMAGES:
            for digest in re.findall(re.escape(image) + r"(?::[\w.-]+)?@(sha256:[0-9a-f]{64})", text):
                found.setdefault(image, {}).setdefault(digest, []).append(path.name)
    return found


def drift(digests):
    return [f"{image} is pinned to {len(by_digest)} different digests: {dict(by_digest)}" for image, by_digest in digests.items() if len(by_digest) > 1]


class ImagePinning(unittest.TestCase):
    def test_dockerfile_bases_are_pinned(self):
        found = [item for path in DOCKERFILES for item in dockerfile_violations(path)]
        self.assertEqual([], found, "\n" + "\n".join(found))

    def test_compose_images_are_pinned(self):
        found = [item for path in COMPOSE_FILES for item in compose_violations(path)]
        self.assertEqual([], found, "\n" + "\n".join(found))

    def test_workflow_helper_images_and_mounts_are_pinned(self):
        found = [item for path in WORKFLOWS for item in workflow_violations(path)]
        self.assertEqual([], found, "\n" + "\n".join(found))

    # The exporter of the private history is not part of the published product (scripts/release/allowlist.txt excludes it).
    @unittest.skipUnless(EXPORT_SCRIPT.exists(), "the release exporter is not in this checkout")
    def test_the_export_script_runs_pinned_images(self):
        self.assertEqual([], export_script_violations(EXPORT_SCRIPT))

    def test_a_shared_image_has_one_digest_everywhere(self):
        digests = scanner_digests(SCANNER_FILES)
        for image in SCANNER_IMAGES:
            self.assertTrue(digests.get(image), f"{image} is named nowhere with a digest: {digests}")
        self.assertEqual([], drift(digests))

    def write(self, name, text):
        directory = Path(tempfile.mkdtemp())
        path = directory / name
        path.write_text(text, encoding="utf-8")
        return path

    def test_detects_a_floating_dockerfile_base(self):
        good = "a" * 64
        path = self.write(
            "Dockerfile",
            f"FROM node:22-alpine AS deps\nFROM node:22-alpine@sha256:{good} AS build\nFROM build AS again\nFROM scratch\nFROM node:latest@sha256:{good}\n"
            "FROM --platform=linux/amd64 alpine@sha256:" + good + "\n",
        )
        found = dockerfile_violations(path)
        self.assertEqual(3, len(found), found)
        self.assertIn("Dockerfile:1", found[0])
        self.assertIn("Dockerfile:5", found[1])
        self.assertIn("Dockerfile:6", found[2])  # a digest without a tag does not say which version it is

    def test_detects_a_floating_compose_image(self):
        good = "b" * 64
        path = self.write(
            "docker-compose.yml",
            f"services:\n  a:\n    image: postgres:18\n  b:\n    image: ${{IMAGE:-x:local}}\n  c:\n    image: postgres:18@sha256:{good} # 18\n",
        )
        found = compose_violations(path)
        self.assertEqual(1, len(found), found)
        self.assertIn(":3:", found[0])

    def test_detects_the_default_images_of_the_build_actions(self):
        sha = "a" * 40
        digest = "c" * 64
        bad = (
            f"steps:\n  - uses: docker/setup-qemu-action@{sha} # v3.7.0\n"
            f"  - uses: docker/setup-buildx-action@{sha} # v3.12.0\n"
            f"  - uses: docker/build-push-action@{sha} # v6.19.2\n    with:\n      sbom: true\n"
        )
        self.assertEqual(3, len(workflow_violations(self.write("bad.yml", bad))))
        good = (
            f"steps:\n  - uses: docker/setup-qemu-action@{sha} # v3.7.0\n    with:\n      image: tonistiigi/binfmt:qemu-v10.2.3@sha256:{digest}\n"
            f"  - uses: docker/setup-buildx-action@{sha} # v3.12.0\n    with:\n      driver-opts: image=moby/buildkit:v0.33.1@sha256:{digest}\n"
            f"  - uses: docker/build-push-action@{sha} # v6.19.2\n    with:\n      sbom: generator=docker/buildkit-syft-scanner:1.12.0@sha256:{digest}\n"
        )
        self.assertEqual([], workflow_violations(self.write("good.yml", good)))

    def test_detects_a_writable_scanner_mount(self):
        digest = "d" * 64
        bad = f'steps:\n  - run: docker run --rm -v "$GITHUB_WORKSPACE:/repo" x/y:1@sha256:{digest} dir /repo\n'
        found = workflow_violations(self.write("bad.yml", bad))
        self.assertEqual(1, len(found), found)
        self.assertIn("writable", found[0])
        ok = f'steps:\n  - run: docker run --rm -v "$GITHUB_WORKSPACE:/repo:ro" x/y:1@sha256:{digest} dir /repo\n'
        self.assertEqual([], workflow_violations(self.write("ok.yml", ok)))

    def test_detects_a_floating_image_in_the_export_script(self):
        digest = "e" * 64
        bad = f"cmd = ['docker', 'run', '-v', f'{{dest}}:/repo', 'ghcr.io/gitleaks/gitleaks:latest']\nother = 'postgres:18'\n"
        found = export_script_violations(self.write("export.py", bad))
        self.assertEqual(3, len(found), found)
        ok = f"cmd = ['docker', 'run', '-v', f'{{dest}}:/repo:ro', 'ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:{digest}']\nmsg = 'postgres did not become ready'\n"
        self.assertEqual([], export_script_violations(self.write("ok.py", ok)))

    def test_detects_scanner_digest_drift(self):
        one = self.write("a.yml", "ghcr.io/gitleaks/gitleaks@sha256:" + "1" * 64)
        two = self.write("b.py", "'ghcr.io/gitleaks/gitleaks:v8@sha256:" + "2" * 64 + "'")
        self.assertEqual(1, len(drift(scanner_digests([one, two]))))
        self.assertEqual([], drift(scanner_digests([one, one])))


if __name__ == "__main__":
    sys.exit(0 if unittest.main(exit=False).result.wasSuccessful() else 1)
