#!/usr/bin/env python3
"""Keeps the repository English and proves that translations changed nothing but comments.

Commands:
  check [--strict] [PATH...]      report Vietnamese text that must not be there (comment mode by default)
  verify-comment-only [--base REV] [--head REV] [--mask-titles] [--javac] [FILE...]
                                  prove that only comments (and, with --mask-titles, test titles) differ
  migrations [--base REV]         fail when an already applied Flyway migration changed or disappeared
  apply-renames MAP.json          rename Java identifiers in code (not in comments) as listed in the map

Comment mode flags Vietnamese letters in comments, in code identifiers and in test titles, and in prose
files. Strings, JSX text and expected copy are ignored: they are user-facing and belong to the message
catalog. Strict mode (--strict) also flags every string and JSX text outside the allowlist, and no longer
waives Vietnamese quoted inside comments, test titles and Markdown (Markdown allow-vi markers still apply).

Known limits: it cannot detect Vietnamese written without diacritics, and the tokenizer behind `check`
does not understand regular expression literals (TypeScript verification uses the compiler instead).
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata

ROOT = subprocess.run(['git', 'rev-parse', '--show-toplevel'], capture_output=True, text=True, encoding='utf-8').stdout.strip() or os.getcwd()
HERE = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------- Vietnamese letters


def _is_vi_char(c):
    if c in '\u0111\u0110':
        return True
    d = unicodedata.normalize('NFD', c)
    return len(d) > 1 and unicodedata.category(c).startswith('L') and any(m in d[1:] for m in '̛̣̀́̂̃̆̉')


_VI_CHARS = ''.join(chr(i) for i in range(0xC0, 0x250) if _is_vi_char(chr(i))) + ''.join(chr(i) for i in range(0x1EA0, 0x1EFA))
VI = re.compile('[' + _VI_CHARS + ']')

# ---------------------------------------------------------------- tokenizer

CSTYLE = {'java', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'css'}
TS_FAMILY = {'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'}
HASH = {'gitignore', 'py', 'sh', 'yml', 'yaml', 'properties', 'env', 'toml', 'conf'}
EXTS = CSTYLE | HASH | {'sql', 'bat', 'cmd', 'xml', 'html'}


def file_ext(path):
    name = path.rsplit('/', 1)[-1]
    if name.startswith('.env'):
        return 'env'
    if name == 'Dockerfile' or name.startswith('Dockerfile.'):
        return 'conf'
    return name.rsplit('.', 1)[-1].lower() if '.' in name else ''


def tokenize(text, ext):
    """Return merged runs (kind, start, end); kind is 'code', 'comment' or 'string'."""
    if ext in ('bat', 'cmd'):
        return _tokenize_bat(text)
    if ext in ('xml', 'html'):
        return _tokenize_markup(text)
    runs = []

    def add(kind, s, e):
        if e <= s:
            return
        if runs and runs[-1][0] == kind and runs[-1][2] == s:
            runs[-1] = (kind, runs[-1][1], e)
        else:
            runs.append((kind, s, e))

    n = len(text)
    i = 0
    code_start = 0
    line_c = '//' if ext in CSTYLE and ext != 'css' else '--' if ext == 'sql' else '#' if ext in HASH else None
    block = ext in CSTYLE or ext == 'sql'
    templ = ext in TS_FAMILY
    stack = []  # template literal nesting: brace depth inside ${ }

    def flush(upto):
        add('code', code_start, upto)

    while i < n:
        c = text[i]
        if line_c and text.startswith(line_c, i):
            if ext in HASH and ext != 'py' and i > 0 and not text[i - 1].isspace():
                i += 1
                continue
            flush(i)
            j = text.find('\n', i)
            j = n if j < 0 else j
            add('comment', i, j)
            i = code_start = j
            continue
        if block and text.startswith('/*', i):
            flush(i)
            j = text.find('*/', i + 2)
            j = n if j < 0 else j + 2
            add('comment', i, j)
            i = code_start = j
            continue
        if stack and c == '}' and stack[-1] == 0:
            stack.pop()
            flush(i)
            i, code_start = _scan_template(text, i + 1, add, stack)
            continue
        if stack and c == '{':
            stack[-1] += 1
        elif stack and c == '}':
            stack[-1] -= 1
        quote = c in '"\''
        if ext == 'css':
            quote = False
        if quote or (templ and c == '`'):
            flush(i)
            if c == '`':
                i, code_start = _scan_template(text, i + 1, add, stack, start=i)
                continue
            triple = text[i:i + 3]
            if (ext == 'java' and triple == '"""') or (ext == 'py' and triple in ('"""', "'''")):
                j = text.find(triple, i + 3)
                j = n if j < 0 else j + 3
                kind = 'string'
                if ext == 'py':
                    line_start = text.rfind('\n', 0, i) + 1
                    if not text[line_start:i].strip():
                        kind = 'comment'  # a docstring or bare string statement documents code
                add(kind, i, j)
                i = code_start = j
                continue
            j = i + 1
            while j < n and text[j] != c and text[j] != '\n':
                j += 2 if text[j] == '\\' else 1
            j = min(j + 1, n) if j < n and text[j] == c else j
            add('string', i, j)
            i = code_start = j
            continue
        i += 1
    flush(n)
    return runs


def _scan_template(text, i, add, stack, start=None):
    """Scan a template literal body starting after the opening backtick (or after a closing brace of ${ })."""
    n = len(text)
    s = i if start is None else start
    while i < n:
        c = text[i]
        if c == '\\':
            i += 2
        elif c == '`':
            add('string', s, i + 1)
            return i + 1, i + 1
        elif c == '$' and text.startswith('${', i):
            add('string', s, i + 2)
            stack.append(0)
            return i + 2, i + 2
        else:
            i += 1
    add('string', s, n)
    return n, n


def _tokenize_markup(text):
    runs = []
    pos = 0
    for m in re.finditer(r'<!--.*?-->', text, re.S):
        runs += [('code', pos, m.start()), ('comment', m.start(), m.end())]
        pos = m.end()
    runs.append(('code', pos, len(text)))
    return [r for r in runs if r[2] > r[1]]


def _tokenize_bat(text):
    runs = []
    pos = 0
    for line in text.split('\n'):
        end = pos + len(line)
        if re.match(r'\s*(rem(\s|$)|::)', line, re.I):
            runs.append(('comment', pos, end))
        else:
            runs.append(('code', pos, end))
        pos = end + 1
    return runs


def strip_comments(text, ext):
    runs = tokenize(text, ext)
    out = []
    for kind, s, e in runs:
        if kind != 'comment':
            out.append(text[s:e])
    return ''.join(out)


def normalize(text):
    return '\n'.join(l.rstrip() for l in text.replace('\r\n', '\n').split('\n') if l.strip())


DIRECTIVE = re.compile(r'@ts-|eslint-(?:disable|enable)|\beslint\s+(?:--|[a-z-]+:)|prettier-ignore|istanbul|c8 ignore|webpack|/// *<reference|NOSONAR|noinspection|^#!|^#.*coding[:=]|noqa|#\s*type:|shellcheck|syntax=|@vitest|v8 ignore|biome-ignore', re.I)


def directives(text, ext):
    return sorted(text[s:e].strip() for k, s, e in tokenize(text, ext) if k == 'comment' and DIRECTIVE.search(text[s:e]))


QUOTED = re.compile(r'"[^"\n]*"|“[^”\n]*”|`[^`\n]*`')
QUOTED_TITLE = re.compile(r'"[^"\n]*"|“[^”\n]*”')
QUOTED_JAVA_TITLE = re.compile(r'\\"[^"\n]*?\\"|“[^”\n]*”')  # a Java title is delimited by plain quotes: only escaped ones are copy


def _quote_re(kind, ext):
    if kind == 'comment':
        return QUOTED
    return QUOTED_JAVA_TITLE if ext == 'java' else QUOTED_TITLE


# ids and paths from the owner's private notes: a public reader cannot resolve them
PRIVATE_REF = re.compile(r'R-\d{3}|(?<!RFC \d{4} )(?<!Grid )§\s?[A-Z0-9]|V[5-9][a-d]?\s+(?:P\d|D\d+|§)|V[5-9][a-d]?\s+[A-Z]\d|docs/(?:RISKS|IDEAS|TODO|v\d|superpowers|seo-audit|plans|reports)|private/')
TITLE_LINE = re.compile(r'\b(it|test|describe)\b\s*(\.\w+)*\s*\(|@DisplayName|@ParameterizedTest|@Nested')
MASK_DISPLAY = re.compile(r'(@DisplayName\s*\(\s*|@ParameterizedTest\s*\([^)]*?\bname\s*=\s*)"(?:[^"\\\n]|\\.)*"')


def mask_java_titles(text):
    return MASK_DISPLAY.sub(lambda m: m.group(1) + '""', text)


# ---------------------------------------------------------------- allowlist and areas

ALLOW_ALWAYS = [
    r'^backend/src/main/resources/db/migration/',  # applied migrations are immutable (Flyway checksums)
    r'^scripts/release/migrations-en/V32__',  # the SQL code of V32 holds a Vietnamese letter literal (translate map); its comments are English
    r'^private/',
    r'^seed/articles/', r'^seed/series\.json$',  # owner content, handled by the content export (D1)
    r'^backend/src/main/resources/search/static-content\.json$',  # generated from messages/vi.json and frontend/content (npm run search:export); per-locale search is part C
    r'(^|/)node_modules/', r'(^|/)\.next/', r'(^|/)target/', r'(^|/)test-results/', r'(^|/)playwright-report/',
    r'package-lock\.json$',
    r'^frontend/messages/vi\.json$',  # the Vietnamese message catalog: Vietnamese by design (parity with en.json is a unit test)
]
ALLOW_STRICT = [
    r'^docs/vi/', r'^README\.vi\.md$', r'(^|/)fixtures/vi/', r'^frontend/content/',
    r'^backend/src/main/resources/sample-content/vi/',  # the Vietnamese demo posts loaded from the admin
    r'^backend/src/main/resources/i18n/newsletter_vi\.properties$',
    r'^backend/src/main/resources/site-import/defaults-vi\.json$',  # example content of the profile template, tested against frontend/content/defaults/vi
]
SKIP_BIN = re.compile(r'\.(png|jpe?g|gif|ico|woff2?|jar|pdf|svg|webp|class|mp4|zip|gz)$', re.I)
TEST_FILE = re.compile(r'^backend/src/test/|^frontend/e2e/|^frontend/test/|\.(test|spec)\.(ts|tsx|mts|js)$')


def allowed(path, strict):
    pats = ALLOW_ALWAYS + (ALLOW_STRICT if strict else [])
    return any(re.search(p, path) for p in pats)


def git_files(paths=None):
    cmd = ['git', 'ls-files', '--cached', '--others', '--exclude-standard']
    if paths:
        cmd += ['--'] + paths
    out = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', cwd=ROOT).stdout.splitlines()
    return [f for f in out if os.path.isfile(os.path.join(ROOT, f))]


def ts_helper(payload):
    node = shutil.which('node')
    helper = os.path.join(HERE, 'validate-english-ts.mjs')
    if not node:
        raise RuntimeError('node is required for TypeScript checks')
    r = subprocess.run([node, helper], input=json.dumps(payload), capture_output=True, text=True, encoding='utf-8', cwd=ROOT)
    if r.returncode != 0:
        raise RuntimeError('typescript helper failed: ' + r.stderr[-800:])
    return json.loads(r.stdout)


# ---------------------------------------------------------------- check


def check_text(path, text, strict, scan=None):
    """Return findings as (line, kind, snippet) for one file."""
    ext = file_ext(path)
    findings = []
    lines = text.split('\n')

    def report(line, kind):
        # Comment mode: Vietnamese inside quotation marks is quoted UI copy or a fixture value, not prose to translate.
        # Strict mode: the copy lives in the catalog now, so a quote names the English text or the key instead.
        if not strict and kind in ('comment', 'test_title') and not VI.search(_quote_re(kind, ext).sub('', lines[line - 1])):
            return
        findings.append((line, kind, lines[line - 1].strip()[:100]))

    if not VI.search(text):
        return findings
    if ext not in EXTS:
        if ext == 'md':
            # quoted UI copy (also across a wrapped line, comment mode only) and blocks marked allow-vi are not prose
            masked = text if strict else re.sub(r'"[^"]{0,300}"|`[^`]{0,200}`|“[^”]{0,300}”', lambda m: re.sub(r'[^\n]', ' ', m.group(0)), text)
            skip = False
            for n, l in enumerate(masked.split('\n'), 1):
                if 'validate-english: allow-vi-start' in lines[n - 1]:
                    skip = True
                elif 'validate-english: allow-vi-end' in lines[n - 1]:
                    skip = False
                elif not skip and 'validate-english: allow-vi' not in lines[n - 1] and VI.search(l):
                    report(n, 'prose')
            return findings
        for n, l in enumerate(lines, 1):
            if VI.search(l):
                report(n, 'prose')
        return findings
    is_test = bool(TEST_FILE.search(path))
    seen = set()
    for kind, s, e in tokenize(text, ext):
        if not VI.search(text[s:e]):
            continue
        first = text.count('\n', 0, s) + 1
        for off, seg in enumerate(text[s:e].split('\n')):
            if not VI.search(seg):
                continue
            n = first + off
            if kind == 'comment':
                k = None if (scan is not None and ext in TS_FAMILY) else 'comment'
            elif kind == 'code':
                if ext in TS_FAMILY and scan is not None:
                    k = 'identifier' if n in scan['idents'] else ('text' if strict else None)
                elif ext in ('tsx', 'jsx'):
                    k = 'jsx_text' if strict else None
                elif ext in ('bat', 'cmd', 'xml', 'html'):
                    k = 'text' if strict else None
                else:
                    k = 'identifier'
            else:
                if scan is not None and is_test and ext in TS_FAMILY:
                    k = 'test_title' if n in scan['lines'] else ('string' if strict else None)
                elif is_test and TITLE_LINE.search(lines[n - 1]):
                    k = 'test_title'
                else:
                    k = 'string' if strict else None
            if k and (n, k) not in seen:
                seen.add((n, k))
                report(n, k)
    for kind, s0, e0 in tokenize(text, ext) if ext in EXTS else []:
        if kind == 'comment' and PRIVATE_REF.search(text[s0:e0]):
            first = text.count('\n', 0, s0) + 1
            for off, seg in enumerate(text[s0:e0].split('\n')):
                if PRIVATE_REF.search(seg):
                    findings.append((first + off, 'private_ref', lines[first + off - 1].strip()[:100]))
    if scan is not None and ext in TS_FAMILY:
        for n in scan.get('comments', ()):
            if (n, 'comment') not in seen:
                report(n, 'comment')
    return sorted(findings)


def cmd_check(args):
    files = git_files(args.paths) if args.paths else git_files()
    files = [f for f in files if not SKIP_BIN.search(f) and not allowed(f, args.strict)]
    texts = {}
    for f in files:
        try:
            texts[f] = open(os.path.join(ROOT, f), encoding='utf-8').read()
        except (UnicodeDecodeError, OSError):
            continue
    ts_files = [f for f in texts if file_ext(f) in TS_FAMILY and VI.search(texts[f])]
    scans = {}
    if ts_files:
        try:
            res = ts_helper({'mode': 'scan', 'viChars': _VI_CHARS, 'items': [{'path': f, 'head': texts[f]} for f in ts_files]})
            scans = {r['path']: {'lines': set(r['lines']), 'idents': set(r['idents']), 'comments': set(r['comments'])} for r in res}
        except RuntimeError as exc:
            print('warning: compiler scan unavailable, using line patterns:', exc, file=sys.stderr)
    total = 0
    by_kind = {}
    for f, text in texts.items():
        for line, kind, snip in check_text(f, text, args.strict, scans.get(f)):
            total += 1
            by_kind[kind] = by_kind.get(kind, 0) + 1
            if not args.summary:
                print(f'{f}:{line}: {kind}: {snip}')
    mode = 'strict' if args.strict else 'comment'
    print(f'validate-english check ({mode} mode): {total} finding(s) in {len(texts)} files ' + json.dumps(by_kind, sort_keys=True))
    return 1 if total else 0


# ---------------------------------------------------------------- verify-comment-only


def git_show(rev, path):
    r = subprocess.run(['git', 'show', f'{rev}:{path}'], capture_output=True, cwd=ROOT)
    return r.stdout.decode('utf-8') if r.returncode == 0 else None


def read_head(head, path):
    if head:
        return git_show(head, path)
    p = os.path.join(ROOT, path)
    return open(p, encoding='utf-8').read() if os.path.isfile(p) else None


def changed_files(base, head):
    cmd = ['git', 'diff', '--name-status', base] + ([head] if head else [])
    out = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', cwd=ROOT).stdout.splitlines()
    files = [l.split('\t')[-1] for l in out]
    if not head:
        files += subprocess.run(['git', 'ls-files', '--others', '--exclude-standard'], capture_output=True, text=True, encoding='utf-8', cwd=ROOT).stdout.splitlines()
    return sorted(set(files))


def cmd_verify(args):
    base = args.base or 'HEAD'
    files = [f.replace('\\', '/') for f in args.files] or changed_files(base, args.head)
    failures = []
    verified = 0
    ts_items = []
    java_changed = False
    for f in files:
        ext = file_ext(f)
        a, b = git_show(base, f), read_head(args.head, f)
        if a is None or b is None:
            failures.append((f, 'file added or removed; a comment-only batch must not add or delete files'))
            continue
        if a == b:
            continue
        if ext not in EXTS:
            failures.append((f, 'not a verifiable language (review the diff by hand)'))
            continue
        if directives(a, ext) != directives(b, ext):
            failures.append((f, 'a directive comment (ts-ignore, eslint, NOSONAR, shebang, ...) changed'))
            continue
        if ext in TS_FAMILY:
            ts_items.append({'path': f, 'base': a, 'head': b})
            continue
        if ext == 'java':
            java_changed = True
            if args.mask_titles:
                a, b = mask_java_titles(a), mask_java_titles(b)
        if normalize(strip_comments(a, ext)) != normalize(strip_comments(b, ext)):
            failures.append((f, 'code differs once comments are removed: ' + _first_diff(strip_comments(a, ext), strip_comments(b, ext))))
        else:
            verified += 1
    if ts_items:
        res = ts_helper({'mode': 'compare', 'maskTitles': args.mask_titles, 'items': ts_items})
        for r in res:
            if r['equal']:
                verified += 1
            else:
                failures.append((r['path'], 'compiler output differs once comments are removed: ' + r.get('diff', '')))
    if args.javac and java_changed and not failures:
        ok, msg = java_class_compare(base, args.head, args.mask_titles)
        print(msg)
        if not ok:
            failures.append(('backend (javac -g:none)', msg))
    for f, why in failures:
        print(f'FAIL {f}: {why}')
    print(f'verify-comment-only: {verified} file(s) proven comment-only, {len(failures)} failure(s)')
    return 1 if failures else 0


def comment_words(text, ext):
    """Words of every comment, markers and layout stripped, so a reflowed comment compares equal."""
    out = []
    for kind, s, e in tokenize(text, ext):
        if kind == 'comment':
            out += re.sub(r'(^|\s)(/\*+|\*+/|\*+|//+|#+|--)(?=\s|$)', ' ', text[s:e]).split()
    return out


def cmd_verify_format(args):
    """Prove a formatter run changed layout only: same compiled classes (Java), same compiler print (TS), same comment words."""
    base = args.base or 'HEAD'
    files = [f.replace('\\', '/') for f in args.files] or changed_files(base, args.head)
    failures, verified, ts_items, java_changed = [], 0, [], False
    for f in files:
        ext = file_ext(f)
        a, b = git_show(base, f), read_head(args.head, f)
        if a is None or b is None:
            failures.append((f, 'file added or removed'))
            continue
        if a.replace('\r\n', '\n') == b.replace('\r\n', '\n'):
            continue
        if ext not in EXTS:
            failures.append((f, 'not a verifiable language (review the diff by hand)'))
            continue
        if directives(a, ext) != directives(b, ext):
            failures.append((f, 'a directive comment changed'))
            continue
        if ext not in TS_FAMILY and comment_words(a, ext) != comment_words(b, ext):
            failures.append((f, 'comment words differ'))
            continue
        if ext in TS_FAMILY:
            ts_items.append({'path': f, 'base': a, 'head': b})
        elif ext == 'java':
            java_changed = True
            verified += 1
        elif ext == 'css':
            q = lambda t: re.sub(r'\s+', '', strip_comments(t, ext).replace("'", '"'))
            if q(a) != q(b):
                failures.append((f, 'css differs beyond whitespace and quotes'))
            else:
                verified += 1
        else:
            failures.append((f, 'no format-only proof for this language'))
    if ts_items:
        for r in ts_helper({'mode': 'ast', 'items': ts_items}):
            if r['equal']:
                verified += 1
            else:
                failures.append((r['path'], 'compiler output differs: ' + r.get('diff', '')))
    if java_changed and not failures:
        ok, msg = java_class_compare(base, args.head, False)
        print(msg)
        if not ok:
            failures.append(('backend (javac -g:none)', msg))
    for f, why in failures:
        print(f'FAIL {f}: {why}')
    print(f'verify-format-only: {verified} file(s) proven layout-only, {len(failures)} failure(s)')
    return 1 if failures else 0


def _first_diff(a, b):
    la, lb = normalize(a).split('\n'), normalize(b).split('\n')
    for i, (x, y) in enumerate(zip(la, lb), 1):
        if x != y:
            return f'normalized line {i}: {x.strip()[:70]!r} vs {y.strip()[:70]!r}'
    return f'length {len(la)} vs {len(lb)} lines'


def _cp_file():
    p = os.path.join(ROOT, 'private', 'cache', 'be-cp.txt')
    if not os.path.isfile(p):
        os.makedirs(os.path.dirname(p), exist_ok=True)
        subprocess.run(['mvn', '-B', '-o', '-q', 'dependency:build-classpath', f'-Dmdep.outputFile={p}', '-Dmdep.includeScope=test'], cwd=os.path.join(ROOT, 'backend'), capture_output=True)
    return open(p, encoding='utf-8').read().strip()


def _compile_hashes(tree, mask):
    """Compile backend main then test sources of a source tree with -g:none and hash every class."""
    cp = _cp_file()
    out = tempfile.mkdtemp(prefix='ve-classes-')
    try:
        for part, extra in (('main', ''), ('test', os.path.join(out, 'main'))):
            srcs = []
            for d, _, fs in os.walk(os.path.join(tree, 'backend', 'src', part, 'java')):
                srcs += [os.path.join(d, x) for x in fs if x.endswith('.java')]
            argfile = os.path.join(out, part + '.args')
            with open(argfile, 'w', encoding='utf-8') as fh:
                fh.write('\n'.join('"' + s.replace('\\', '/') + '"' for s in srcs))
            os.makedirs(os.path.join(out, part), exist_ok=True)
            classpath = (extra + os.pathsep if extra else '') + cp
            r = subprocess.run(['javac', '-g:none', '-proc:full', '-nowarn', '-encoding', 'UTF-8', '--release', '25', '-d', os.path.join(out, part), '-cp', classpath, '@' + argfile], capture_output=True, text=True, encoding='utf-8')
            if r.returncode != 0:
                return None, (part + ' sources do not compile:\n' + r.stderr[-1500:])
        hashes = {}
        for part in ('main', 'test'):
            for d, _, fs in os.walk(os.path.join(out, part)):
                for x in fs:
                    p = os.path.join(d, x)
                    hashes[part + ':' + os.path.relpath(p, os.path.join(out, part)).replace('\\', '/')] = hashlib.sha256(open(p, 'rb').read()).hexdigest()
        return hashes, ''
    finally:
        shutil.rmtree(out, ignore_errors=True)


def _materialize(rev, mask):
    tree = tempfile.mkdtemp(prefix='ve-src-')
    files = [f for f in subprocess.run(['git', 'ls-tree', '-r', '--name-only', rev or 'HEAD', 'backend/src'], capture_output=True, text=True, encoding='utf-8', cwd=ROOT).stdout.splitlines() if f.endswith('.java')] if rev else [f for f in git_files(['backend/src']) if f.endswith('.java')]
    for f in files:
        text = git_show(rev, f) if rev else open(os.path.join(ROOT, f), encoding='utf-8').read()
        if mask:
            text = mask_java_titles(text)
        dest = os.path.join(tree, *f.split('/'))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, 'w', encoding='utf-8', newline='') as fh:
            fh.write(text)
    return tree


def java_class_compare(base, head, mask):
    cache = os.path.join(ROOT, 'private', 'cache', f'javac-{_rev(base)}-{int(mask)}.json')
    a = None
    if os.path.isfile(cache):
        a = json.load(open(cache, encoding='utf-8'))
    else:
        tree = _materialize(base, mask)
        try:
            a, err = _compile_hashes(tree, mask)
        finally:
            shutil.rmtree(tree, ignore_errors=True)
        if a is None:
            return False, 'base ' + err
        os.makedirs(os.path.dirname(cache), exist_ok=True)
        json.dump(a, open(cache, 'w', encoding='utf-8'))
    tree = _materialize(head, mask)
    try:
        b, err = _compile_hashes(tree, mask)
    finally:
        shutil.rmtree(tree, ignore_errors=True)
    if b is None:
        return False, 'head ' + err
    diff = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))
    if diff:
        return False, f'{len(diff)} class file(s) differ between {base} and the head, first: ' + ', '.join(diff[:6])
    return True, f'javac -g:none: {len(a)} class files, identical hashes'


def _rev(rev):
    return subprocess.run(['git', 'rev-parse', '--short', rev], capture_output=True, text=True, cwd=ROOT).stdout.strip()


# ---------------------------------------------------------------- migrations


def cmd_migrations(args):
    base = args.base or 'HEAD'
    d = 'backend/src/main/resources/db/migration'
    out = subprocess.run(['git', 'diff', '--name-status', base, '--', d], capture_output=True, text=True, encoding='utf-8', cwd=ROOT).stdout.splitlines()
    bad = [l for l in out if not l.startswith('A')]
    for l in bad:
        print('FAIL applied migration changed or removed:', l)
    print(f'migrations: {len(bad)} applied migration(s) changed since {base}')
    return 1 if bad else 0


# ---------------------------------------------------------------- apply-renames


def apply_renames(path, mapping):
    text = open(os.path.join(ROOT, path), encoding='utf-8').read()
    runs = tokenize(text, 'java')
    out = []
    count = 0
    for kind, s, e in runs:
        chunk = text[s:e]
        for old, new in mapping.items():
            if kind == 'code':
                chunk, k = re.subn(r'(?<![\w$])' + re.escape(old) + r'(?![\w$])', new, chunk)
                count += k
            elif kind == 'string' and chunk == '"' + old + '"':
                chunk, count = '"' + new + '"', count + 1
        out.append(chunk)
    new_text = ''.join(out)
    names = set(mapping.values())
    existing = {m for m in re.findall(r'[\w$]+', strip_comments(text, 'java'))}
    clash = sorted(n for n in names if n in existing)
    if clash:
        raise SystemExit(f'{path}: new name already used in the file: {clash[:5]}')
    if len(set(mapping.values())) != len(mapping):
        raise SystemExit(f'{path}: two methods would get the same name')
    open(os.path.join(ROOT, path), 'w', encoding='utf-8', newline='').write(new_text)
    return count


def cmd_renames(args):
    data = json.load(open(args.map, encoding='utf-8'))
    total = 0
    for path, mapping in data.items():
        total += apply_renames(path, mapping)
    print(f'apply-renames: {total} replacement(s) in {len(data)} file(s)')
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    sub = ap.add_subparsers(dest='cmd', required=True)
    c = sub.add_parser('check')
    c.add_argument('--strict', action='store_true')
    c.add_argument('--summary', action='store_true')
    c.add_argument('paths', nargs='*')
    v = sub.add_parser('verify-comment-only')
    v.add_argument('--base')
    v.add_argument('--head')
    v.add_argument('--mask-titles', action='store_true')
    v.add_argument('--javac', action='store_true')
    v.add_argument('files', nargs='*')
    f = sub.add_parser('verify-format-only')
    f.add_argument('--base')
    f.add_argument('--head')
    f.add_argument('files', nargs='*')
    m = sub.add_parser('migrations')
    m.add_argument('--base')
    r = sub.add_parser('apply-renames')
    r.add_argument('map')
    args = ap.parse_args(argv)
    return {'check': cmd_check, 'verify-comment-only': cmd_verify, 'verify-format-only': cmd_verify_format, 'migrations': cmd_migrations, 'apply-renames': cmd_renames}[args.cmd](args)


if __name__ == '__main__':
    sys.exit(main())
