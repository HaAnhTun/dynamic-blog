"""Tests for scripts/validate-english.py. No framework: run `python scripts/test_validate_english.py`.
The verification cases build a throw-away git repository, so they prove the tool against real git revisions."""
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, 'validate-english.py')
spec = importlib.util.spec_from_file_location('validate_english', TOOL)
ve = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ve)

VI_WORD = 'Ki\u1ec3m tra'


def kinds(text, ext):
    return [(k, text[s:e]) for k, s, e in ve.tokenize(text, ext)]


class TokenizerTest(unittest.TestCase):
    def test_comment_markers_inside_java_strings_are_code(self):
        src = 'String a = "// not a comment"; /* real */ char c = \'"\'; // tail\n'
        comments = [t for k, t in kinds(src, 'java') if k == 'comment']
        self.assertEqual(comments, ['/* real */', '// tail'])

    def test_java_text_block_is_a_string(self):
        src = 'String s = """\n  // inside\n  /* inside */\n  """;\n'
        self.assertEqual([k for k, _ in kinds(src, 'java') if k == 'comment'], [])

    def test_template_literal_with_nested_expression(self):
        src = 'const x = `a // b ${f(`/* c */`)} d`; // real\n'
        comments = [t for k, t in kinds(src, 'ts') if k == 'comment']
        self.assertEqual(comments, ['// real'])

    def test_sql_string_with_dashes(self):
        src = "SELECT '-- no' AS a; -- yes\n/* block */ SELECT 1;\n"
        self.assertEqual([t for k, t in kinds(src, 'sql') if k == 'comment'], ['-- yes', '/* block */'])

    def test_yaml_hash_needs_leading_space_and_python_docstring_is_comment(self):
        self.assertEqual([t for k, t in kinds('url: http://x/#frag # note\n', 'yml') if k == 'comment'], ['# note'])
        py = 'def f():\n    """Doc."""\n    return "# no"  # yes\n'
        self.assertEqual([t for k, t in kinds(py, 'py') if k == 'comment'], ['"""Doc."""', '# yes'])

    def test_batch_comments_only_at_line_start(self):
        src = 'rem comment\n@echo rem not a comment\n:: also\n'
        self.assertEqual(len([1 for k, _ in kinds(src, 'bat') if k == 'comment']), 2)

    def test_xml_comment(self):
        self.assertEqual([t for k, t in kinds('<a><!-- c --></a>', 'xml') if k == 'comment'], ['<!-- c -->'])


class CheckTest(unittest.TestCase):
    def kinds_found(self, path, text, strict=False):
        return sorted({k for _, k, _ in ve.check_text(path, text, strict)})

    def test_comment_and_identifier_are_flagged_but_strings_are_not(self):
        src = f'class A {{ // {VI_WORD}\n void x() {{ String s = "{VI_WORD}"; }}\n void ch\u1ea1y() {{}} }}\n'
        self.assertEqual(self.kinds_found('backend/src/main/java/A.java', src), ['comment', 'identifier'])

    def test_strict_mode_flags_strings_and_prose(self):
        src = f'String s = "{VI_WORD}";\n'
        self.assertEqual(self.kinds_found('backend/src/main/java/A.java', src), [])
        self.assertEqual(self.kinds_found('backend/src/main/java/A.java', src, strict=True), ['string'])
        self.assertEqual(self.kinds_found('README.md', VI_WORD), ['prose'])

    def test_quoted_vietnamese_is_waived_in_comment_mode_only(self):
        java = f'// the "{VI_WORD}" button\n@DisplayName("shows \\"{VI_WORD}\\"")\nvoid a() {{}}\n'
        self.assertEqual(self.kinds_found('backend/src/test/java/ATest.java', java), [])
        self.assertEqual(self.kinds_found('backend/src/test/java/ATest.java', java, strict=True), ['comment', 'test_title'])
        md = f'Click "{VI_WORD}".\nOwner {VI_WORD} <!-- validate-english: allow-vi -->\n'
        self.assertEqual(self.kinds_found('README.md', md), [])
        self.assertEqual([n for n, _, _ in ve.check_text('README.md', md, True)], [1])

    def test_java_test_title_is_flagged_in_comment_mode(self):
        src = f'@DisplayName("{VI_WORD}")\nvoid a() {{}}\n'
        self.assertEqual(self.kinds_found('backend/src/test/java/ATest.java', src), ['test_title'])

    def test_allowlist(self):
        self.assertTrue(ve.allowed('backend/src/main/resources/db/migration/V1__x.sql', False))
        self.assertTrue(ve.allowed('frontend/messages/vi.json', False))
        self.assertTrue(ve.allowed('frontend/messages/vi.json', True))


class VerifyTest(unittest.TestCase):
    """Runs the real CLI inside a temporary git repository."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='ve-test-')
        self.git('init', '-q')
        self.git('config', 'user.email', 't@example.com')
        self.git('config', 'user.name', 't')

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def git(self, *args):
        subprocess.run(['git', *args], cwd=self.dir, check=True, capture_output=True)

    def write(self, name, text):
        p = os.path.join(self.dir, *name.split('/'))
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'w', encoding='utf-8', newline='') as fh:
            fh.write(text)

    def run_tool(self, *args):
        r = subprocess.run([sys.executable, TOOL, *args], cwd=self.dir, capture_output=True, text=True, encoding='utf-8')
        return r.returncode, r.stdout + r.stderr

    def verify(self, *extra):
        return self.run_tool('verify-comment-only', *extra)

    def commit_base(self, files):
        for name, text in files.items():
            self.write(name, text)
        self.git('add', '-A')
        self.git('commit', '-qm', 'base')

    def test_translation_passes_and_logic_change_fails_for_every_language(self):
        base = {
            'A.java': 'class A {\n // m\u1ed9t\n String s = "// keep"; /* hai */ int f() { return 1; }\n}\n',
            'a.ts': 'const s = `// keep ${1} /* keep */`; // m\u1ed9t\nconst r = /\\/\\*/; /* hai */\n',
            'a.tsx': 'export const J = () => <p>// text {/* m\u1ed9t */}</p> // hai\n',
            'a.sql': "SELECT '-- keep'; -- m\u1ed9t\n",
            'a.yml': 'key: "# keep" # m\u1ed9t\n',
            'a.py': 'x = "# keep"  # m\u1ed9t\n',
            'a.sh': 'echo "# keep" # m\u1ed9t\n',
            'a.css': 'a { color: red; /* m\u1ed9t */ }\n',
        }
        self.commit_base(base)
        for name, text in base.items():
            self.write(name, text.replace('m\u1ed9t', 'one').replace('hai', 'two'))
        code, out = self.verify()
        self.assertEqual(code, 0, out)
        self.assertIn('8 file(s) proven comment-only', out)
        logic = {
            'A.java': ('return 1', 'return 2'), 'a.ts': ('${1}', '${2}'), 'a.tsx': ('// text', '// texts'),
            'a.sql': ("'-- keep'", "'-- kept'"), 'a.yml': ('"# keep"', '"# kept"'), 'a.py': ('"# keep"', '"# kept"'),
            'a.sh': ('"# keep"', '"# kept"'), 'a.css': ('red', 'blue'),
        }
        for name, (old, new) in logic.items():
            with self.subTest(name):
                self.write(name, base[name].replace(old, new))
                code, out = self.verify(name)
                self.assertEqual(code, 1, out)
                self.assertIn('FAIL ' + name, out)
                self.write(name, base[name])

    def test_directive_comment_change_is_caught(self):
        self.commit_base({'a.ts': '// @ts-expect-error: reason\nconst a: number = "x"\n'})
        self.write('a.ts', '// @ts-ignore: reason\nconst a: number = "x"\n')
        code, out = self.verify()
        self.assertEqual(code, 1, out)
        self.assertIn('directive', out)

    def test_titles_need_the_mask_flag(self):
        self.commit_base({
            'a.test.ts': "it('c\u0169', () => { expect(1).toBe(1) })\n",
            'T.java': 'class T { @DisplayName("c\u0169") void a() {} }\n',
        })
        self.write('a.test.ts', "it('new', () => { expect(1).toBe(1) })\n")
        self.write('T.java', 'class T { @DisplayName("new") void a() {} }\n')
        self.assertEqual(self.verify()[0], 1)
        code, out = self.verify('--mask-titles')
        self.assertEqual(code, 0, out)
        self.write('a.test.ts', "it('new', () => { expect(1).toBe(2) })\n")
        self.assertEqual(self.verify('--mask-titles')[0], 1)

    def test_format_only_accepts_layout_and_rejects_logic_or_comment_edits(self):
        self.commit_base({
            'a.ts': "const f = (a: number) => {\n  return [a, 2]\n}\n// keep this words\n",
            'a.css': "a { color: red; }\n",
        })
        self.write('a.ts', "const f = (a: number) => { return [\n a,\n 2,\n] }\n// keep   this\n// words\n")
        self.write('a.css', "a {\n  color: red;\n}\n")
        code, out = self.run_tool('verify-format-only')
        self.assertEqual(code, 0, out)
        self.assertIn('2 file(s) proven layout-only', out)
        self.write('a.ts', "const f = (a: number) => { return [\n a,\n 3,\n] }\n// keep this words\n")
        code, out = self.run_tool('verify-format-only')
        self.assertEqual(code, 1, out)
        self.write('a.ts', "const f = (a: number) => {\n  return [a, 2]\n}\n// other words\n")
        self.assertEqual(self.run_tool('verify-format-only')[0], 1)

    def test_added_file_is_rejected(self):
        self.commit_base({'a.ts': 'const a = 1\n'})
        self.write('b.ts', 'const b = 1\n')
        self.git('add', '-A')
        code, out = self.verify('a.ts', 'b.ts')
        self.assertEqual(code, 1, out)
        self.assertIn('added or removed', out)

    def test_applied_migration_change_fails_and_new_migration_passes(self):
        mig = 'backend/src/main/resources/db/migration/'
        self.commit_base({mig + 'V1__a.sql': '-- m\u1ed9t\nSELECT 1;\n'})
        self.write(mig + 'V1__a.sql', '-- one\nSELECT 1;\n')
        self.assertEqual(self.run_tool('migrations')[0], 1)
        self.git('checkout', '--', '.')
        self.write(mig + 'V2__b.sql', 'SELECT 2;\n')
        self.git('add', '-A')
        self.assertEqual(self.run_tool('migrations')[0], 0)

    def test_apply_renames_only_touches_code(self):
        self.commit_base({'T.java': 'class T {\n // ch\u1ea1y th\u1eed\n void ch\u1ea1y_th\u1eed() {}\n @MethodSource("ch\u1ea1y_th\u1eed") void x() { ch\u1ea1y_th\u1eed(); }\n}\n'})
        self.write('map.json', '{"T.java": {"ch\u1ea1y_th\u1eed": "runs"}}')
        code, out = self.run_tool('apply-renames', 'map.json')
        self.assertEqual(code, 0, out)
        with open(os.path.join(self.dir, 'T.java'), encoding='utf-8') as fh:
            text = fh.read()
        self.assertEqual(text, 'class T {\n // ch\u1ea1y th\u1eed\n void runs() {}\n @MethodSource("runs") void x() { runs(); }\n}\n')


if __name__ == '__main__':
    unittest.main()
