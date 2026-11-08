"""Guard against template injection in the CI workflows (offline, standard library only).

A `${{ ... }}` expression inside a `run:` (or `script:`) value is pasted into the shell script before the shell sees it. When the
value is text that somebody else controls (a branch name, a pull request title, a tag, a step output built from them), that is
command injection with the job token. The safe form passes the value through `env:` and reads the environment variable
(`"$BASE_REF"`), which the shell treats as data.

Only the contexts that the workflow file itself defines are allowed inside a command: `matrix.*`. Everything else
(`github.*`, `inputs.*`, `steps.*`, `needs.*`, `env.*`, `vars.*`, `secrets.*`) goes through `env:`.

run: python scripts/test_workflow_expressions.py
"""
import re
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKFLOWS = sorted((ROOT / ".github" / "workflows").glob("*.yml"))

# A key whose value is a command or a script: `run:` and the `script:` of actions/github-script.
KEY = re.compile(r"^(\s*(?:-\s+)?)(run|script):(.*)$")
BLOCK_INDICATOR = re.compile(r"^[>|][+-]?\d*\s*(#.*)?$")
EXPRESSION = re.compile(r"\$\{\{\s*(.*?)\s*\}\}", re.S)
ALLOWED_CONTEXTS = ("matrix.",)


def command_values(lines):
    """Yield (line number, text) for every `run:` / `script:` value: one line, or the lines of a block scalar."""
    index = 0
    while index < len(lines):
        match = KEY.match(lines[index])
        if not match:
            index += 1
            continue
        key_indent = len(match.group(1))
        value = match.group(3).strip()
        if BLOCK_INDICATOR.match(value):
            block = []
            offset = index + 1
            while offset < len(lines):
                current = lines[offset]
                if current.strip() and len(current) - len(current.lstrip()) <= key_indent:
                    break
                block.append((offset + 1, current))
                offset += 1
            for number, text in block:
                yield number, text
            index = offset
        else:
            yield index + 1, value
            index += 1


def violations(path):
    found = []
    lines = path.read_text(encoding="utf-8").splitlines()
    for number, text in command_values(lines):
        for expression in EXPRESSION.findall(text):
            if not expression.startswith(ALLOWED_CONTEXTS):
                found.append(
                    f"{path.name}:{number}: `${{{{ {expression} }}}}` inside a command; pass it through `env:` and use the variable"
                )
    return found


class WorkflowExpressions(unittest.TestCase):
    def test_workflows_exist(self):
        self.assertTrue(WORKFLOWS, "no workflow found")

    def test_no_context_expression_inside_a_command(self):
        found = [item for path in WORKFLOWS for item in violations(path)]
        self.assertEqual([], found, "\n" + "\n".join(found))

    def check(self, text):
        with tempfile.TemporaryDirectory() as tmp:
            sample = Path(tmp) / "sample.yml"
            sample.write_text(text, encoding="utf-8")
            return violations(sample)

    def test_detects_an_inline_expression(self):
        found = self.check(
            "steps:\n  - run: python tool.py --base origin/${{ github.base_ref }}\n    if: github.event_name == 'x'\n"
        )
        self.assertEqual(1, len(found), found)
        self.assertIn("sample.yml:2", found[0])

    def test_detects_an_expression_in_a_block_scalar(self):
        found = self.check(
            "steps:\n  - name: x\n    run: |\n      echo start\n      echo \"${{ steps.meta.outputs.title }}\"\n"
        )
        self.assertEqual(1, len(found), found)
        self.assertIn("sample.yml:5", found[0])

    def test_detects_an_expression_in_a_folded_scalar_and_in_a_script(self):
        self.assertEqual(1, len(self.check("steps:\n  - run: >-\n      echo ${{ inputs.name }}\n")))
        self.assertEqual(1, len(self.check("steps:\n  - uses: x/y@" + "a" * 40 + "\n    with:\n      script: |\n        core.info('${{ github.head_ref }}')\n")))

    def test_accepts_a_value_passed_through_env(self):
        self.assertEqual(
            [],
            self.check(
                "steps:\n  - run: python tool.py --base \"origin/$BASE_REF\"\n    env:\n      BASE_REF: ${{ github.base_ref }}\n"
                "  - name: y\n    env:\n      TAG: ${{ github.ref_name }}\n    run: |\n      echo \"$TAG\"\n"
            ),
        )

    def test_accepts_a_matrix_value(self):
        self.assertEqual([], self.check("steps:\n  - run: echo ${{ matrix.name }}\n"))

    def test_a_workflow_expression_outside_a_command_is_fine(self):
        self.assertEqual([], self.check("name: x-${{ github.ref }}\nsteps:\n  - uses: a/b@" + "a" * 40 + "\n    with:\n      v: ${{ github.sha }}\n"))


if __name__ == "__main__":
    sys.exit(0 if unittest.main(exit=False).result.wasSuccessful() else 1)
