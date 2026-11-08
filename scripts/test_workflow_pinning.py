"""Guard for the supply chain of the CI workflows (offline, standard library only).

Every `uses:` of .github/workflows/*.yml must be a local path or a full 40-character commit SHA with a version comment, and
no container image may be `:latest` or float on a tag. A mutable tag lets a hijacked upstream run code with the job token.

run: python scripts/test_workflow_pinning.py
"""
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKFLOWS = sorted((ROOT / ".github" / "workflows").glob("*.yml"))

USES = re.compile(r"^\s*(?:-\s+)?uses:\s*(\S+)(.*)$")
IMAGE = re.compile(r"^\s*(?:-\s+)?image:\s*(\S+)")
SHA_REF = re.compile(r"^[\w.-]+/[\w./-]+@[0-9a-f]{40}$")
DIGEST_REF = re.compile(r"@sha256:[0-9a-f]{64}$")


def violations(path):
    found = []
    lines = path.read_text(encoding="utf-8").splitlines()
    for number, line in enumerate(lines, 1):
        place = f"{path.name}:{number}"
        uses = USES.match(line)
        if uses:
            ref, rest = uses.group(1), uses.group(2)
            if ref.startswith("./"):
                continue
            if ref.startswith("docker://"):
                if not DIGEST_REF.search(ref):
                    found.append(f"{place}: docker:// ref without a sha256 digest: {ref}")
                continue
            if not SHA_REF.match(ref):
                found.append(f"{place}: action not pinned to a 40-character commit SHA: {ref}")
            elif not re.search(r"#\s*v\d", rest):
                found.append(f"{place}: pinned action without a '# vX.Y.Z' comment: {ref}")
        image = IMAGE.match(line)
        if image and not DIGEST_REF.search(image.group(1)):
            found.append(f"{place}: container image without a sha256 digest: {image.group(1)}")
        # The image may sit on a continuation line of the command (a few lines at most).
        if "docker run" in line and "sha256:" not in " ".join(lines[number - 1 : number + 4]):
            found.append(f"{place}: docker run image without a sha256 digest")
        if ":latest" in line and ("docker" in line or "image" in line):
            found.append(f"{place}: ':latest' image")
    found.extend(run_block_comment_violations(path, lines))
    return found


RUN_BLOCK = re.compile(r"^(\s*(?:-\s+)?)run:\s*[>|][+-]?\s*$")
INLINE_COMMENT = re.compile(r"\s#(?:\s|$)")


def run_block_comment_violations(path, lines):
    """A ' #' inside a multi-line `run:` block holding `docker run` is part of the shell command, not a YAML comment.

    In a folded scalar (`run: >`) the lines are joined, so bash treats the `#` as the start of a comment and drops the rest
    of the command (the image arguments), which turned a scan step into a no-op that exits 0.
    """
    found = []
    for index, line in enumerate(lines):
        opener = RUN_BLOCK.match(line)
        if not opener:
            continue
        key_indent = len(opener.group(1))
        block = []
        for offset in range(index + 1, len(lines)):
            current = lines[offset]
            if current.strip() and len(current) - len(current.lstrip()) <= key_indent:
                break
            block.append((offset + 1, current))
        if not any("docker run" in text for _, text in block):
            continue
        for number, text in block:
            if INLINE_COMMENT.search(text):
                found.append(f"{path.name}:{number}: '#' inside a run block with docker run (it ends the shell command)")
    return found


class WorkflowPinning(unittest.TestCase):
    def test_workflows_exist(self):
        self.assertTrue(WORKFLOWS, "no workflow found")

    def test_every_reference_is_pinned(self):
        found = [item for path in WORKFLOWS for item in violations(path)]
        self.assertEqual([], found, "\n" + "\n".join(found))

    def test_detects_a_mutable_tag(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            sample = Path(tmp) / "bad.yml"
            sample.write_text(
                "jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v7\n"
                "      - run: docker run --rm ghcr.io/x/y:latest\n"
                "    services:\n      db:\n        image: postgres:18\n",
                encoding="utf-8",
            )
            self.assertEqual(4, len(violations(sample)))

    def test_detects_a_comment_inside_a_folded_docker_run(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            sample = Path(tmp) / "folded.yml"
            sample.write_text(
                "steps:\n  - name: scan\n    run: >\n      docker run --rm\n"
                "      img@sha256:" + "b" * 64 + " # 0.76.0\n      fs --exit-code 1 /src\n",
                encoding="utf-8",
            )
            found = violations(sample)
            self.assertEqual(1, len(found), found)
            self.assertIn("folded.yml:5", found[0])

    def test_accepts_a_comment_outside_the_run_block(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            sample = Path(tmp) / "ok.yml"
            sample.write_text(
                "steps:\n  # img 0.76.0\n  - name: scan\n    run: >\n      docker run --rm\n"
                "      img@sha256:" + "b" * 64 + "\n      fs /src\n  - run: echo hi # fine\n",
                encoding="utf-8",
            )
            self.assertEqual([], violations(sample))

    def test_accepts_pinned_and_local(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            sample = Path(tmp) / "good.yml"
            sample.write_text(
                "steps:\n  - uses: actions/checkout@" + "a" * 40 + " # v7.0.1\n  - uses: ./local\n"
                "  - run: docker run --rm img@sha256:" + "b" * 64 + " dir /x\n",
                encoding="utf-8",
            )
            self.assertEqual([], violations(sample))


if __name__ == "__main__":
    sys.exit(0 if unittest.main(exit=False).result.wasSuccessful() else 1)
