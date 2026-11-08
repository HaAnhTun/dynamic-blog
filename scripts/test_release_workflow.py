"""Guard for the release workflow (offline, standard library only).

`release.yml` pushes images to `ghcr.io` with `packages: write` on any `v*` tag push. These checks keep the parts of the gate
that live in the file. The workflow has three jobs, `scan`, `images` and `release`; a text check reads each by indentation (no YAML
library in CI):

- `scan` scans the backend image before anything can be published. It has exactly `contents: read` and `actions: read` (no package, no OIDC
  token; the second only lists the CI runs), no registry login and no push; it proves that the tagged commit is on `master` and that
  `ci.yml` has a successful push run on `master` for it (a red, running or cancelled CI refuses the release), both before the build;
  builds the image once for `linux/amd64` into an archive
  (`push: false`, nothing public) and scans it with Trivy (HIGH and CRITICAL findings with a fix fail the job). It has no `if:` and no
  `continue-on-error`, so the scan cannot be skipped or ignored;
- `images` pushes. It `needs: scan`: nothing is pushed until the scan passed (a scan inside the push job would run after the approval
  and could leave a half-published release). It has no job-level `if:` and no `continue-on-error`, the same
  matrix as `scan` (the pushed image is the scanned one), and builds the same context with the same arguments and cache as the scan. It holds
  the approval environment and the proof that the tagged commit is on `master`, both before anything is built or pushed;
- the provenance and SBOM attestations on the pushed image;
- the signature: cosign is installed before the push (a failed install must not leave an unsigned image), then after the push the
  pushed digest (not a tag) is signed, keyless through the OIDC token of the job (`id-token: write` on the `images` job only), and the
  signature is verified against the identity of this workflow;
- `release` needs `images`, so a GitHub release exists only for images that were pushed, signed and verified.

The parts that live in the repository settings cannot be checked here and are a manual checklist, see
docs/DEVELOPMENT.md, "Release": the reviewers of the `release` environment, the tag ruleset for `v*` and the branch ruleset for `master`.

run: python scripts/test_release_workflow.py
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RELEASE = ROOT / ".github" / "workflows" / "release.yml"

JOB_KEY = re.compile(r"^  ([A-Za-z0-9_-]+):\s*$")
STEP_START = re.compile(r"^      - ")
OIDC_ISSUER = "https://token.actions.githubusercontent.com"


def job_text(text, name):
    """The lines of one job of the workflow, from its key to the next job key (two-space indent)."""
    lines = text.splitlines()
    start = None
    for index, line in enumerate(lines):
        match = JOB_KEY.match(line)
        if match and match.group(1) == name:
            start = index
        elif match and start is not None:
            return lines[start:index]
    return lines[start:] if start is not None else []


def steps_of(job_lines):
    """The steps of a job as lists of lines (a step starts with `      - `)."""
    steps = []
    in_steps = False
    for line in job_lines:
        if re.match(r"^    steps:\s*$", line):
            in_steps = True
            continue
        if not in_steps:
            continue
        if STEP_START.match(line):
            steps.append([line])
        elif steps and (line.startswith("        ") or not line.strip()):
            steps[-1].append(line)
        elif line.strip() and not line.startswith("      "):
            break
    return steps


def permissions_of(lines, indent):
    """The `key: value` pairs of the `permissions:` block that sits at the given indent."""
    found = {}
    prefix = " " * indent
    inside = False
    for line in lines:
        if re.match(rf"^{prefix}permissions:\s*$", line):
            inside = True
            continue
        if inside:
            match = re.match(rf"^{prefix}  ([a-z-]+):\s*(\w+)\s*(#.*)?$", line)
            if match:
                found[match.group(1)] = match.group(2)
            elif line.strip() and not line.startswith(prefix + "  "):
                break
    return found


def needs_of(job_lines):
    """The job names in the job-level `needs:` (one name, an inline list, or a block list)."""
    names = []
    for index, line in enumerate(job_lines):
        match = re.match(r"^    needs:\s*([^#]*?)\s*(#.*)?$", line)
        if not match:
            continue
        if match.group(1):
            names.extend(re.findall(r"[A-Za-z0-9_-]+", match.group(1)))
        else:
            for following in job_lines[index + 1:]:
                item = re.match(r"^      - ([A-Za-z0-9_-]+)\s*(#.*)?$", following)
                if not item:
                    break
                names.append(item.group(1))
    return names


def matrix_of(job_lines):
    """The lines of the `matrix:` block of a job, without comments and blank lines (None when the job has no matrix)."""
    block = []
    inside = False
    for line in job_lines:
        if re.match(r"^      matrix:\s*$", line):
            inside = True
            continue
        if inside:
            if re.match(r"^    steps:\s*$", line) or (line.strip() and not line.startswith("        ")):
                break
            if line.strip() and not line.lstrip().startswith("#"):
                block.append(line.rstrip())
    return block if inside else None


def index_of(steps, predicate):
    return next((i for i, step in enumerate(steps) if predicate(step)), None)


def builds(step):
    return "docker/build-push-action@" in step


def pushes(step):
    return builds(step) and re.search(r"^\s+push:\s*true\s*$", step, re.M) is not None


def input_of(step, name):
    """The value written after `name:` in a step (None when the step has no such line)."""
    match = re.search(rf"^\s+{re.escape(name)}:[ \t]*(.*?)[ \t]*$", step, re.M)
    return match.group(1) if match else None


def master_check_problems(steps, limit, limit_name, job):
    """The tag must be proven to be on master by a step of the job, before `limit` (the first step that builds or pushes)."""
    check = index_of(steps, lambda step: "git merge-base --is-ancestor" in step)
    if check is None:
        return [f"no step of the `{job}` job runs `git merge-base --is-ancestor` to prove the tag is on master"]
    found = []
    if check > limit:
        found.append(f"the master check of the `{job}` job comes after {limit_name}")
    if "origin/master" not in steps[check] or "GITHUB_SHA" not in steps[check]:
        found.append(f"the master check of the `{job}` job must compare $GITHUB_SHA with origin/master")
    checkout = index_of(steps, lambda step: "actions/checkout@" in step)
    if checkout is None or checkout > check:
        found.append(f"the master check of the `{job}` job needs an actions/checkout step before it")
    elif not re.search(r"^\s+fetch-depth:\s*0\s*$", steps[checkout], re.M):
        found.append(f"the checkout before the master check of the `{job}` job needs `fetch-depth: 0` (the default is one commit)")
    return found


def ci_gate_problems(steps, limit):
    """The `scan` job must refuse a tagged commit that has no successful push run of ci.yml on master, before the build (`limit`)."""
    gate = index_of(steps, lambda step: "gh api" in step and "workflows/ci.yml/runs" in step)
    if gate is None:
        return ["no step of the `scan` job asks `gh api` for the runs of `workflows/ci.yml`: a tag on a commit with a red or running CI would be released"]
    found = []
    step = steps[gate]
    if gate > limit:
        found.append("the CI gate of the `scan` job comes after the build for the scan")
    for needle, why in (
        ("head_sha=${GITHUB_SHA}", "ask for the runs of exactly the tagged commit (`head_sha=${GITHUB_SHA}`)"),
        ("event=push", "count only push runs (`event=push`)"),
        ("branch=master", "count only runs on master (`branch=master`)"),
        ("status=success", "count only successful runs (`status=success`)"),
        (".total_count", "read `.total_count`"),
        ("GH_TOKEN", "pass the token through `GH_TOKEN` in `env:`"),
        ("exit 1", "exit 1 when there is no successful run"),
    ):
        if needle not in step:
            found.append(f"the CI gate of the `scan` job must {why}")
    if not re.search(r'\[\s*"\$runs"\s+-eq\s+0\s*\]', step):
        found.append("the CI gate of the `scan` job must fail when the count is 0 (`[ \"$runs\" -eq 0 ]`)")
    if "[!0-9]" not in step:
        found.append("the CI gate of the `scan` job must fail on a count that is not a number, not pass it")
    return found


def images_problems(text):
    """The `images` job: the approval gate, the push with its attestations, the signature and its verification."""
    found = []
    job = job_text(text, "images")
    if not job:
        return ["no `images` job"]
    if not any(re.match(r"^    environment:\s*release\s*(#.*)?$", line) for line in job):
        found.append("the `images` job has no `environment: release` (the approval gate)")

    top = text.split("\njobs:")[0].splitlines()
    if permissions_of(top, 0).get("id-token"):
        found.append("`id-token` is granted for the whole workflow; only the `images` job may have it")
    permissions = permissions_of(job, 4)
    if permissions.get("packages") != "write":
        found.append("the `images` job needs `packages: write` to push")
    if permissions.get("id-token") != "write":
        found.append("the `images` job needs `id-token: write` for keyless signing")
    if permissions.get("contents") != "read":
        found.append("the `images` job must keep `contents: read`")

    steps = ["\n".join(step) for step in steps_of(job)]
    push = index_of(steps, pushes)
    if push is None:
        return found + ["no docker/build-push-action step with `push: true`"]

    found += master_check_problems(steps, push, "the step that pushes the images", "images")

    if not re.search(r"^\s+provenance:\s*mode=max\s*$", steps[push], re.M):
        found.append("the push step needs `provenance: mode=max`")
    # `sbom: true` or, with a pinned scanner image (scripts/test_image_pinning.py checks the pin), `sbom: generator=<image>`.
    if not re.search(r"^\s+sbom:\s*(true|generator=\S+)\s*$", steps[push], re.M):
        found.append("the push step needs `sbom: true` or `sbom: generator=<image>`")

    # The signature: the pushed digest, after the push, then a verification of the signature against this workflow.
    push_id = re.search(r"^\s+(?:-\s+)?id:\s*(\S+)\s*$", steps[push], re.M)
    install = index_of(steps, lambda step: "sigstore/cosign-installer@" in step)
    sign = index_of(steps, lambda step: re.search(r"^\s+run:.*\bcosign sign\b|^\s+cosign sign\b", step, re.M) is not None)
    verify = index_of(steps, lambda step: re.search(r"\bcosign verify\b", step) is not None)
    if install is None:
        found.append("no sigstore/cosign-installer step")
    elif install > push:
        found.append("cosign is installed after the push: a failed install would leave an image in the registry that nobody signed")
    if sign is None:
        found.append("no step signs the image with `cosign sign`")
    else:
        if sign < push:
            found.append("the signature step comes before the push")
        if install is not None and install > sign:
            found.append("cosign is installed after the signature step")
        if "--yes" not in steps[sign]:
            found.append("`cosign sign` needs `--yes` (the job cannot answer a prompt)")
        if not push_id or not re.search(rf"steps\.{re.escape(push_id.group(1))}\.outputs\.digest", steps[sign]) or "@" not in steps[sign]:
            found.append("`cosign sign` must sign the pushed digest (`IMAGE@DIGEST` from the push step's `digest` output), not a tag")
    if verify is None:
        found.append("no step runs `cosign verify` on the signed digest")
    else:
        if sign is not None and verify < sign:
            found.append("the verification comes before the signature")
        if "--certificate-identity" not in steps[verify] or f"--certificate-oidc-issuer {OIDC_ISSUER}" not in steps[verify]:
            found.append(f"`cosign verify` must pin the identity of this workflow and `--certificate-oidc-issuer {OIDC_ISSUER}`")
        if not re.search(r"workflows/release\\?\.yml@refs/tags/", steps[verify]):
            found.append("`cosign verify` must pin the identity to .github/workflows/release.yml")
    return found


def scan_problems(text):
    """The `scan` job: read-only, builds an archive of the image and fails on a Trivy finding, before anything is published."""
    job = job_text(text, "scan")
    if not job:
        return ["no `scan` job: the images must be scanned in a job of their own, which the job that pushes needs"]
    found = []
    if permissions_of(job, 4) != {"contents": "read", "actions": "read"}:
        found.append(
            "the `scan` job must have exactly `permissions: contents: read` and `actions: read` (no package, no id-token: it cannot publish or sign;"
            " actions: read lists the CI runs for the CI gate)"
        )
    if re.search(r"^\s+(?:-\s+)?(if|continue-on-error):", "\n".join(job), re.M):
        found.append("the `scan` job has an `if:` or `continue-on-error`: a scan that can be skipped or ignored gates nothing")

    steps = ["\n".join(step) for step in steps_of(job)]
    if any(pushes(step) for step in steps):
        found.append("the `scan` job must not push (`push: true`)")
    if index_of(steps, lambda step: "docker/login-action@" in step) is not None:
        found.append("the `scan` job must not log in to a registry")

    # A build that publishes nothing, then Trivy on the archive.
    local = index_of(steps, lambda step: builds(step) and re.search(r"^\s+push:\s*false\s*$", step, re.M) and "type=docker,dest=" in step)
    trivy = index_of(steps, lambda step: "aquasec/trivy" in step)
    if local is None:
        found.append("no build step with `push: false` and `outputs: type=docker,dest=...` in the `scan` job")
    else:
        found += master_check_problems(steps, local, "the build for the scan", "scan")
        found += ci_gate_problems(steps, local)
    if trivy is None:
        found.append("no Trivy step in the `scan` job")
    else:
        if local is not None and trivy < local:
            found.append("the Trivy scan comes before the build it scans")
        for needle, why in (
            ("image --input", "scan the archive of the local build (`image --input`)"),
            ("--exit-code 1", "fail the job on a finding (`--exit-code 1`)"),
            ("--severity HIGH,CRITICAL", "scan for `--severity HIGH,CRITICAL`"),
            ("--ignore-unfixed", "skip findings without a fix (`--ignore-unfixed`), as the CI scan does"),
        ):
            if needle not in steps[trivy]:
                found.append(f"the Trivy step must {why}")
        if not re.search(r"-v\s+\"[^\"]*:ro\"", steps[trivy]):
            found.append("the Trivy container must mount the archive read-only")
    return found


def link_problems(text):
    """How the three jobs hang together: nothing is pushed before the scan passed, and every pushed image was scanned."""
    scan = job_text(text, "scan")
    images = job_text(text, "images")
    release = job_text(text, "release")
    found = []
    if images and "scan" not in needs_of(images):
        found.append("the `images` job must `needs: scan`, so that no image is pushed before every image passed the scan")
    body = "\n".join(images)
    if re.search(r"^    if:", body, re.M) or re.search(r"^\s+continue-on-error:", body, re.M):
        found.append("the `images` job has an `if:` or a `continue-on-error` that could let it run or finish after a failed scan")
    if release and "images" not in needs_of(release):
        found.append("the `release` job must `needs: images`, so that a release exists only for pushed, signed images")
    if scan and images:
        if matrix_of(scan) != matrix_of(images):
            found.append("the `scan` and `images` jobs must have the same matrix, so that every image that is pushed was scanned")
        scanned = next((step for step in ("\n".join(s) for s in steps_of(scan)) if builds(step) and "type=docker,dest=" in step), None)
        pushed = next((step for step in ("\n".join(s) for s in steps_of(images)) if pushes(step)), None)
        if scanned and pushed:
            for name in ("context", "build-args", "cache-from"):
                if input_of(scanned, name) != input_of(pushed, name):
                    found.append(f"the build for the scan and the build that pushes must have the same `{name}`, so that the scan covers the pushed image")
    return found


def problems(text):
    return images_problems(text) + scan_problems(text) + link_problems(text)


HEAD = """\
permissions:
  contents: read

jobs:
"""

SCAN = """\
  scan:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: read
    strategy:
      fail-fast: false
      matrix:
        include:
          - name: backend
            context: ./backend
    steps:
      - uses: actions/checkout@{sha} # v7.0.1
        with:
          fetch-depth: 0
      - name: The tag is on master
        run: git merge-base --is-ancestor "$GITHUB_SHA" origin/master
      - name: CI passed for the tagged commit
        env:
          GH_TOKEN: ${{{{ github.token }}}}
          REPOSITORY: ${{{{ github.repository }}}}
        run: |
          runs=$(gh api "repos/${{REPOSITORY}}/actions/workflows/ci.yml/runs?head_sha=${{GITHUB_SHA}}&event=push&branch=master&status=success&per_page=1" --jq .total_count)
          case "$runs" in ''|*[!0-9]*) exit 1 ;; esac
          if [ "$runs" -eq 0 ]; then exit 1; fi
      - name: Build for the scan
        uses: docker/build-push-action@{sha} # v6.19.2
        with:
          context: ${{{{ matrix.context }}}}
          build-args: ${{{{ matrix.build-args }}}}
          push: false
          outputs: type=docker,dest=/tmp/scan.tar
          cache-from: type=gha,scope=${{{{ matrix.name }}}}
      - name: Scan
        run: >
          docker run --rm -v "$RUNNER_TEMP:/scan:ro" aquasec/trivy:0.76.0@sha256:{digest}
          image --input /scan/scan.tar --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1

""".format(sha="a" * 40, digest="b" * 64)

IMAGES = """\
  images:
    needs: scan
    runs-on: ubuntu-latest
    environment: release
    permissions:
      contents: read
      packages: write
      id-token: write
    strategy:
      fail-fast: true
      matrix:
        include:
          - name: backend
            context: ./backend
    steps:
      - uses: actions/checkout@{sha} # v7.0.1
        with:
          fetch-depth: 0
      - name: The tag is on master
        run: git merge-base --is-ancestor "$GITHUB_SHA" origin/master
      - uses: sigstore/cosign-installer@{sha} # v4.1.2
      - id: push
        uses: docker/build-push-action@{sha} # v6.19.2
        with:
          context: ${{{{ matrix.context }}}}
          build-args: ${{{{ matrix.build-args }}}}
          push: true
          provenance: mode=max
          sbom: generator=docker/buildkit-syft-scanner:1.12.0@sha256:{digest}
          cache-from: type=gha,scope=${{{{ matrix.name }}}}
      - name: Sign
        env:
          DIGEST: ${{{{ steps.push.outputs.digest }}}}
        run: cosign sign --yes "ghcr.io/o/i@${{DIGEST}}"
      - name: Verify
        run: >
          cosign verify "ghcr.io/o/i@${{DIGEST}}"
          --certificate-identity-regexp '^https://{host}/o/r/.github/workflows/release.yml@refs/tags/v'
          --certificate-oidc-issuer https://token.actions.githubusercontent.com

""".format(sha="a" * 40, digest="b" * 64, host="github" + ".com")

RELEASE_JOB = """\
  release:
    needs: images
    runs-on: ubuntu-latest
"""


def workflow(scan=SCAN, images=IMAGES, release=RELEASE_JOB, head=HEAD):
    return head + scan + images + release


GOOD = workflow()


def move(text, first, last, before):
    """`text` with the lines from the one that contains `first` up to (not including) the one that contains `last` moved to just before
    the line that contains `before`, which comes later."""
    lines = text.splitlines(keepends=True)
    start = next(i for i, line in enumerate(lines) if first in line)
    end = next(i for i, line in enumerate(lines) if i > start and last in line)
    target = next(i for i, line in enumerate(lines) if i > end and before in line)
    return "".join(lines[:start] + lines[end:target] + lines[start:end] + lines[target:])


def without(text, start, end):
    """`text` without the lines from the one that contains `start` up to (not including) the one that contains `end`."""
    lines = text.splitlines(keepends=True)
    first = next(i for i, line in enumerate(lines) if start in line)
    last = next(i for i, line in enumerate(lines) if i > first and end in line)
    return "".join(lines[:first] + lines[last:])


class ReleaseWorkflow(unittest.TestCase):
    def mentions(self, found, needle):
        self.assertTrue(any(needle in item for item in found), f"{needle!r} is not in {found}")

    def test_the_release_workflow_has_its_gate(self):
        self.assertEqual([], problems(RELEASE.read_text(encoding="utf-8")))

    def test_no_frontend_image_is_published(self):
        """The frontend bakes the site address, language and HSTS into the bundle: a prebuilt one is only good for localhost."""
        text = RELEASE.read_text(encoding="utf-8")
        for name in ("scan", "images"):
            job = "\n".join(job_text(text, name))
            self.assertNotRegex(job, r"(?m)^\s+- name:\s*frontend\s*$")
            self.assertNotIn("context: ./frontend", job)
            self.assertNotIn("NEXT_PUBLIC_SITE_URL=", job)

    def test_a_complete_workflow_passes(self):
        self.assertEqual([], problems(GOOD))

    # The images job.

    def test_a_missing_environment_is_found(self):
        self.assertEqual(1, len(problems(workflow(images=IMAGES.replace("    environment: release\n", "")))))

    def test_a_master_check_after_the_push_is_found(self):
        moved = move(IMAGES, "The tag is on master", "sigstore/cosign-installer", "- name: Sign")
        self.mentions(problems(workflow(images=moved)), "the master check of the `images` job comes after the step that pushes the images")

    def test_a_shallow_checkout_is_found(self):
        shallow = IMAGES.replace("          fetch-depth: 0\n", "          persist-credentials: false\n")
        self.assertEqual(1, len(problems(workflow(images=shallow))))

    def test_a_missing_check_is_found(self):
        check = '      - name: The tag is on master\n        run: git merge-base --is-ancestor "$GITHUB_SHA" origin/master\n'
        self.mentions(problems(workflow(images=IMAGES.replace(check, ""))), "no step of the `images` job runs `git merge-base --is-ancestor`")

    def test_a_check_against_the_wrong_ref_is_found(self):
        self.assertEqual(1, len(problems(workflow(images=IMAGES.replace("origin/master", "origin/main")))))

    def test_missing_provenance_and_sbom_are_found(self):
        self.assertEqual(1, len(problems(workflow(images=IMAGES.replace("          provenance: mode=max\n", "")))))
        self.assertEqual(1, len(problems(workflow(images=re.sub(r"          sbom: .*\n", "", IMAGES)))))
        self.assertEqual(1, len(problems(workflow(images=IMAGES.replace("provenance: mode=max", "provenance: false")))))

    def test_both_forms_of_the_sbom_are_accepted(self):
        self.assertEqual([], problems(workflow(images=re.sub(r"sbom: generator=\S+", "sbom: true", IMAGES))))

    def test_the_permissions_for_signing_are_required_on_the_job_only(self):
        self.mentions(problems(workflow(images=IMAGES.replace("      id-token: write\n", ""))), "id-token: write")
        wide = HEAD.replace("permissions:\n  contents: read\n", "permissions:\n  contents: read\n  id-token: write\n", 1)
        self.mentions(problems(workflow(head=wide)), "whole workflow")
        self.mentions(problems(workflow(images=IMAGES.replace("      packages: write\n", ""))), "packages: write")

    def test_signing_problems_are_found(self):
        self.mentions(problems(workflow(images=IMAGES.replace("sigstore/cosign-installer", "x/other"))), "sigstore/cosign-installer")
        self.mentions(problems(workflow(images=IMAGES.replace("cosign sign --yes", "cosign sign"))), "`--yes`")
        self.mentions(problems(workflow(images=IMAGES.replace("steps.push.outputs.digest", "steps.meta.outputs.version"))), "pushed digest")
        self.mentions(problems(workflow(images=IMAGES.replace('ghcr.io/o/i@${DIGEST}"', 'ghcr.io/o/i:latest"', 1))), "pushed digest")
        self.mentions(problems(workflow(images=without(IMAGES, "- name: Sign", "- name: Verify"))), "no step signs")

    def test_a_signature_before_the_push_is_found(self):
        lines = IMAGES.splitlines(keepends=True)
        push = next(i for i, line in enumerate(lines) if "- id: push" in line)
        sign = next(i for i, line in enumerate(lines) if "- name: Sign" in line)
        verify = next(i for i, line in enumerate(lines) if "- name: Verify" in line)
        moved = "".join(lines[:push] + lines[sign:verify] + lines[push:sign] + lines[verify:])
        self.mentions(problems(workflow(images=moved)), "the signature step comes before the push")

    def test_cosign_installed_after_the_push_is_found(self):
        # An install that fails (a download, a checksum) after the push would leave an image in the registry that nobody signed.
        moved = move(IMAGES, "sigstore/cosign-installer", "- id: push", "- name: Sign")
        self.mentions(problems(workflow(images=moved)), "cosign is installed after the push")

    def test_a_missing_or_loose_verification_is_found(self):
        self.mentions(problems(workflow(images=IMAGES.split("      - name: Verify")[0] + "\n")), "no step runs `cosign verify`")
        loose = IMAGES.replace("--certificate-oidc-issuer https://token.actions.githubusercontent.com", "")
        self.mentions(problems(workflow(images=loose)), "--certificate-oidc-issuer")
        self.mentions(problems(workflow(images=IMAGES.replace("workflows/release.yml", "workflows/other.yml"))), "release.yml")

    # The scan job.

    def test_a_missing_scan_job_is_found(self):
        self.mentions(problems(workflow(scan="")), "no `scan` job")

    def test_a_scan_that_could_publish_or_sign_is_found(self):
        wide = "      contents: read\n"
        self.mentions(problems(workflow(scan=SCAN.replace(wide, wide + "      packages: write\n"))), "exactly `permissions: contents: read`")
        self.mentions(problems(workflow(scan=SCAN.replace(wide, wide + "      id-token: write\n"))), "exactly `permissions: contents: read`")
        self.mentions(problems(workflow(scan=SCAN.replace("    permissions:\n" + wide + "      actions: read\n", ""))), "exactly `permissions: contents: read`")
        self.mentions(problems(workflow(scan=SCAN.replace("      actions: read\n", ""))), "`actions: read`")
        self.mentions(problems(workflow(scan=SCAN.replace("      actions: read\n", "      actions: write\n"))), "`actions: read`")
        self.mentions(problems(workflow(scan=SCAN.replace("push: false", "push: true"))), "must not push")
        login = "      - uses: docker/login-action@" + "a" * 40 + " # v3.7.0\n"
        self.mentions(problems(workflow(scan=SCAN.replace("      - name: Scan\n", login + "      - name: Scan\n"))), "must not log in")

    def test_a_scan_that_can_be_skipped_or_ignored_is_found(self):
        skipped = SCAN.replace("      - name: Scan\n", "      - name: Scan\n        if: always()\n")
        self.mentions(problems(workflow(scan=skipped)), "`if:` or `continue-on-error`")
        ignored = SCAN.replace("    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    continue-on-error: true\n")
        self.mentions(problems(workflow(scan=ignored)), "`if:` or `continue-on-error`")

    def test_a_missing_or_misplaced_trivy_step_is_found(self):
        self.mentions(problems(workflow(scan=SCAN.split("      - name: Scan")[0] + "\n")), "no Trivy step")
        lines = SCAN.splitlines(keepends=True)
        build = next(i for i, line in enumerate(lines) if "- name: Build for the scan" in line)
        scan = next(i for i, line in enumerate(lines) if "- name: Scan" in line)
        swapped = "".join(lines[:build] + lines[scan:] + lines[build:scan])
        self.mentions(problems(workflow(scan=swapped)), "Trivy scan comes before the build")
        no_archive = SCAN.replace("outputs: type=docker,dest=/tmp/scan.tar", "outputs: type=registry")
        self.mentions(problems(workflow(scan=no_archive)), "no build step with `push: false`")

    def test_a_scan_that_cannot_fail_the_job_is_found(self):
        self.mentions(problems(workflow(scan=SCAN.replace(" --exit-code 1", ""))), "--exit-code 1")
        self.mentions(problems(workflow(scan=SCAN.replace("--severity HIGH,CRITICAL", "--severity LOW"))), "--severity HIGH,CRITICAL")
        self.mentions(problems(workflow(scan=SCAN.replace("--ignore-unfixed", ""))), "--ignore-unfixed")
        self.mentions(problems(workflow(scan=SCAN.replace('"$RUNNER_TEMP:/scan:ro"', '"$RUNNER_TEMP:/scan"'))), "read-only")

    def test_the_scan_proves_that_the_tag_is_on_master_before_it_builds(self):
        check = '      - name: The tag is on master\n        run: git merge-base --is-ancestor "$GITHUB_SHA" origin/master\n'
        self.mentions(problems(workflow(scan=SCAN.replace(check, ""))), "no step of the `scan` job runs")
        late = move(SCAN, "The tag is on master", "- name: Build for the scan", "- name: Scan")
        self.mentions(problems(workflow(scan=late)), "the master check of the `scan` job comes after the build for the scan")
        self.mentions(problems(workflow(scan=SCAN.replace("          fetch-depth: 0\n", ""))), "fetch-depth: 0")

    def test_the_scan_refuses_a_commit_without_a_successful_ci_run_before_it_builds(self):
        start, end = "      - name: CI passed for the tagged commit\n", "      - name: Build for the scan\n"
        self.mentions(problems(workflow(scan=without(SCAN, start, end))), "no step of the `scan` job asks `gh api`")
        late = move(SCAN, "CI passed for the tagged commit", "- name: Build for the scan", "- name: Scan")
        self.mentions(problems(workflow(scan=late)), "the CI gate of the `scan` job comes after the build")
        for needle, wrong in (
            ("head_sha=${GITHUB_SHA}", "head_sha=abc"),
            ("event=push", "event=pull_request"),
            ("branch=master", "branch=dev"),
            ("status=success", "status=completed"),
            (".total_count", ".workflow_runs"),
            ("GH_TOKEN", "TOKEN"),
        ):
            self.mentions(problems(workflow(scan=SCAN.replace(needle, wrong))), needle)
        self.mentions(problems(workflow(scan=SCAN.replace('[ "$runs" -eq 0 ]', '[ "$runs" -eq 1 ]'))), "fail when the count is 0")
        self.mentions(problems(workflow(scan=SCAN.replace("''|*[!0-9]*", "''"))), "not a number")
        ignored = SCAN.replace(start, start + "        continue-on-error: true\n")
        self.mentions(problems(workflow(scan=ignored)), "`if:` or `continue-on-error`")

    # The jobs together.

    def test_images_that_do_not_wait_for_the_scan_are_found(self):
        self.mentions(problems(workflow(images=IMAGES.replace("    needs: scan\n", ""))), "must `needs: scan`")
        self.mentions(problems(workflow(images=IMAGES.replace("    needs: scan\n", "    needs: [other]\n"))), "must `needs: scan`")
        self.assertEqual([], problems(workflow(images=IMAGES.replace("    needs: scan\n", "    needs: [other, scan]\n"))))
        self.assertEqual([], problems(workflow(images=IMAGES.replace("    needs: scan\n", "    needs:\n      - other\n      - scan\n"))))

    def test_images_that_run_or_finish_after_a_failed_scan_are_found(self):
        always = IMAGES.replace("    needs: scan\n", "    needs: scan\n    if: always()\n")
        self.mentions(problems(workflow(images=always)), "could let it run or finish after a failed scan")
        later = IMAGES.replace("      - name: Verify\n", "      - name: Verify\n        continue-on-error: true\n")
        self.mentions(problems(workflow(images=later)), "could let it run or finish after a failed scan")

    def test_a_pushed_image_that_is_not_scanned_is_found(self):
        backend = "          - name: backend\n            context: ./backend\n"
        extra = IMAGES.replace(backend, backend + "          - name: extra\n            context: ./extra\n")
        self.mentions(problems(workflow(images=extra)), "same matrix")
        other_context = IMAGES.replace("            context: ./backend\n", "            context: ./other\n")
        self.mentions(problems(workflow(images=other_context)), "same matrix")

    def test_a_scan_of_another_build_than_the_push_is_found(self):
        self.mentions(problems(workflow(scan=SCAN.replace("context: ${{ matrix.context }}", "context: ./backend"))), "same `context`")
        self.mentions(problems(workflow(scan=SCAN.replace("build-args: ${{ matrix.build-args }}\n", "build-args: ''\n"))), "same `build-args`")
        self.mentions(problems(workflow(scan=SCAN.replace("scope=${{ matrix.name }}", "scope=scan"))), "same `cache-from`")

    def test_a_release_that_does_not_wait_for_the_images_is_found(self):
        self.mentions(problems(workflow(release=RELEASE_JOB.replace("    needs: images\n", ""))), "must `needs: images`")


if __name__ == "__main__":
    unittest.main()
