#!/usr/bin/env python3
"""Offline pattern and entropy scan for a release snapshot (the documented fallback when gitleaks is unavailable).

usage: python scripts/release/scan-generic.py [--root DIR] [--allow FILE] [--no-git] [--strict] [--owner LOGIN]

Without --root the repository of the current directory is scanned (tracked files). With --root DIR the files of DIR are
scanned: `git ls-files` when DIR is a git repository, else a directory walk (--no-git forces the walk).

Rules (the id is the first column of the allow file):
  email        an email address outside example.com, example.org, example.net, blog.local, localhost, noreply and *.test, *.invalid, *.example
  abs-path     an absolute home or drive path such as C:\\Users\\name or /home/name
  private-ref  a reference to the private/ folder
  github-url   a github.com/<login> URL whose login is not OWNER, nor the owner of this repository (see --owner)
  placeholder-image  an image name in the placeholder namespace of the GitHub registry (the word "owner" as the account): a pull of
               it would fetch whatever that account publishes, not this project
  placeholder  (--strict only) an unfilled <...> placeholder of the security contact, the copyright holder or the release date
  pem          a PEM block marker
  token        a well known token format (cloud keys, personal access tokens, JWTs)
  secret       a long hex or base64 value on a line that talks about a secret, token, password or key
  entropy      a long quoted string with high entropy

--strict is the mode for a release snapshot, where the placeholders of the working tree must all have been filled in: a
URL of the placeholder account (the word OWNER as the login) is a github-url finding, and a placeholder for the security contact, the copyright holder or the release date
is a `placeholder` finding. Without it the placeholders are the working tree's normal content.

--owner LOGIN names the GitHub account that owns the repository, so that the project may link to its own pages (the README, the
issue template and the changelog of a published repository do). Without the flag the owner is read from GITHUB_REPOSITORY_OWNER (set
by GitHub Actions) and else from the `origin` remote of the scanned repository. Only that exact login (any case) is let through, and
never in --strict mode, which is the mode of a release snapshot.

The allow file has one entry per line: `RULE | PATH_GLOB | MATCH | reason` (`*` as MATCH allows every match of the rule in
those files, otherwise MATCH must be a substring of the matched text). The reason is mandatory. `#` starts a comment line.

The report names the file, the line number, the rule and the first three characters of the match. It never prints the line
or the full match. Exit code 0 when clean, 1 on findings.
"""
import argparse
import fnmatch
import math
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_ALLOW = os.path.join(HERE, 'scan-generic-allow.txt')

SKIP_NAMES = {'package-lock.json'}  # integrity hashes: base64 by design
SKIP_PATHS = {'scripts/release/scan-generic-allow.txt'}  # the allow list quotes the patterns it permits
BINARY_EXTENSIONS = {
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.pdf', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.zip',
    '.gz', '.jar', '.class', '.mp4', '.webm', '.mp3', '.bin', '.tsbuildinfo',
}
MAX_FILE_BYTES = 2_000_000

SAFE_EMAIL_DOMAINS = ('example.com', 'example.org', 'example.net', 'blog.local', 'localhost')
EMAIL = re.compile(r'(?<![\w.%+-])[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})(?![\w-])')
WIN_PATH = re.compile(r'(?<![\w])[A-Za-z]:[\\/](?:Users|Documents and Settings|home)[\\/]|(?<![\w])[A-Z]:[\\/][\w.-]+[\\/]')
NIX_PATH = re.compile(r'(?<![\w.-])/(?:home|Users)/([A-Za-z_][\w.-]*)')
GENERIC_HOME_NAMES = {'runner', 'user', 'node', 'app', 'you', 'name', 'username', 'me', 'someone', 'blog'}
PRIVATE_REF = re.compile(r'(?<![\w.-])private[\\/][\w.-]')
GITHUB_URL = re.compile(r'github\.com[/:]([A-Za-z0-9][A-Za-z0-9-]*)')
# Assembled from parts so that this file does not contain the strings it looks for.
PLACEHOLDERS = ('<security ' + 'contact>', '<copyright ' + 'holder>', '<release ' + 'date>')
PLACEHOLDER_IMAGE = re.compile(r'(?<![\w.])ghcr\.io/owner/', re.IGNORECASE)
PEM = re.compile(r'-----BEGIN [A-Z0-9 ]+-----')
TOKEN = re.compile(
    r'\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}'
    r'|\bsk-[A-Za-z0-9]{32,}\b|\bAIza[0-9A-Za-z_-]{35}\b|\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}'
)
SECRET_WORDS = re.compile(r'secret|token|passw(?:or)?d|passwd|api[-_]?key|private[-_]?key|master[-_]?key|\bkey\b', re.IGNORECASE)
LONG_HEX = re.compile(r'(?<![A-Za-z0-9])[A-Fa-f0-9]{32,}(?![A-Za-z0-9])')
LONG_B64 = re.compile(r'(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9+/=_-])')
QUOTED = re.compile(r'''["']([A-Za-z0-9+/_=-]{40,})["']''')
SECRET_ENTROPY = 3.6
QUOTED_ENTROPY = 4.5


def entropy(text):
    """Shannon entropy in bits per character."""
    if not text:
        return 0.0
    counts = {}
    for ch in text:
        counts[ch] = counts.get(ch, 0) + 1
    n = len(text)
    return -sum(c / n * math.log2(c / n) for c in counts.values())


def _looks_random(value, minimum):
    digits = sum(c.isdigit() for c in value)
    if value.count('_') + value.count('-') >= 3:  # an identifier, slug or sentence, not a random value
        return False
    return digits >= 3 and any(c.isalpha() for c in value) and not value.startswith('/') and entropy(value) >= minimum


def load_allow(path):
    """Parse the allow file into (rule, glob, match, reason) tuples. Raises ValueError on a malformed entry."""
    entries = []
    if not path or not os.path.isfile(path):
        return entries
    with open(path, encoding='utf-8') as handle:
        for number, raw in enumerate(handle, 1):
            line = raw.strip()
            if not line or line.startswith('#'):
                continue
            parts = [p.strip() for p in line.split('|', 3)]
            if len(parts) != 4 or not all(parts):
                raise ValueError(f'{os.path.basename(path)}:{number}: expected `RULE | PATH_GLOB | MATCH | reason`')
            entries.append(tuple(parts))
    return entries


def _allowed(allow, rule, relpath, matched):
    for a_rule, glob, needle, _reason in allow:
        if a_rule != rule or not fnmatch.fnmatchcase(relpath, glob):
            continue
        if needle == '*' or needle in matched:
            return True
    return False


def _email_ok(domain):
    d = domain.lower()
    if d.endswith(('.test', '.invalid', '.example')) or 'noreply' in d:
        return True
    return any(d == s or d.endswith('.' + s) for s in SAFE_EMAIL_DOMAINS)


def _line_findings(line, strict=False, owner=None):
    """Yield (rule, matched text) for one line. `strict` is the snapshot mode: unfilled placeholders are findings."""
    for m in EMAIL.finditer(line):
        local = m.group(0).split('@', 1)[0].lower()
        if not (_email_ok(m.group(1)) or local.startswith('noreply') or local.startswith('no-reply')):
            yield 'email', m.group(0)
    for m in WIN_PATH.finditer(line):
        yield 'abs-path', m.group(0)
    for m in NIX_PATH.finditer(line):
        if m.group(1).lower() not in GENERIC_HOME_NAMES:
            yield 'abs-path', m.group(0)
    for m in PRIVATE_REF.finditer(line):
        yield 'private-ref', m.group(0)
    for m in GITHUB_URL.finditer(line):
        if strict or (m.group(1) != 'OWNER' and not (owner and m.group(1).lower() == owner)):
            yield 'github-url', m.group(0)
    if strict:
        for placeholder in PLACEHOLDERS:
            if placeholder in line:
                yield 'placeholder', placeholder
    for m in PLACEHOLDER_IMAGE.finditer(line):
        yield 'placeholder-image', m.group(0)
    for m in PEM.finditer(line):
        yield 'pem', m.group(0)
    for m in TOKEN.finditer(line):
        yield 'token', m.group(0)
    if SECRET_WORDS.search(line):
        for m in LONG_HEX.finditer(line):
            if _looks_random(m.group(0), 2.5):
                yield 'secret', m.group(0)
        for m in LONG_B64.finditer(line):
            if _looks_random(m.group(0), SECRET_ENTROPY):
                yield 'secret', m.group(0)
    for m in QUOTED.finditer(line):
        if _looks_random(m.group(1), QUOTED_ENTROPY):
            yield 'entropy', m.group(1)


def scan_text(relpath, text, allow=(), strict=False, owner=None):
    """Return findings as (relpath, line number, rule, match prefix) for one text."""
    findings = []
    for number, line in enumerate(text.splitlines(), 1):
        if len(line) > 4000:
            line = line[:4000]
        seen = set()
        for rule, matched in _line_findings(line, strict, owner):
            if (rule, matched) in seen or _allowed(allow, rule, relpath, matched):
                continue
            seen.add((rule, matched))
            findings.append((relpath, number, rule, matched[:3] + '...'))
    return findings


def list_files(root, use_git=True):
    if use_git and os.path.exists(os.path.join(root, '.git')):
        out = subprocess.run(['git', 'ls-files', '-z'], cwd=root, capture_output=True, check=True).stdout
        return [n for n in out.decode('utf-8').split('\0') if n]
    names = []
    for base, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d != '.git']
        for f in files:
            names.append(os.path.relpath(os.path.join(base, f), root).replace(os.sep, '/'))
    return sorted(names)


def read_text(path):
    """Return the text of a file, or None for binary, huge or unreadable files."""
    if os.path.splitext(path)[1].lower() in BINARY_EXTENSIONS:
        return None
    try:
        if os.path.getsize(path) > MAX_FILE_BYTES:
            return None
        with open(path, 'rb') as handle:
            data = handle.read()
    except OSError:
        return None
    if b'\0' in data[:8192]:
        return None
    return data.decode('utf-8', errors='replace')


def scan_tree(root, allow=(), files=None, use_git=True, strict=False, owner=None):
    findings = []
    for name in files if files is not None else list_files(root, use_git):
        if os.path.basename(name) in SKIP_NAMES or name in SKIP_PATHS or name.startswith('private/'):
            continue
        text = read_text(os.path.join(root, name))
        if text is not None:
            findings.extend(scan_text(name, text, allow, strict, owner))
    return findings


def repo_owner(root):
    """The lower-cased GitHub login that owns the repository: GITHUB_REPOSITORY_OWNER, else the `origin` remote of `root`, else None."""
    env = os.environ.get('GITHUB_REPOSITORY_OWNER', '').strip()
    if env:
        return env.lower()
    try:
        url = subprocess.run(['git', '-C', root, 'config', '--get', 'remote.origin.url'], capture_output=True).stdout.decode().strip()
    except OSError:
        return None
    match = re.search(r'github\.com[:/]([A-Za-z0-9-]+)/', url)
    return match.group(1).lower() if match else None


def main(argv=None):
    parser = argparse.ArgumentParser(description='Offline pattern and entropy scan.')
    parser.add_argument('--root', default=None)
    parser.add_argument('--allow', default=DEFAULT_ALLOW)
    parser.add_argument('--no-git', action='store_true')
    parser.add_argument('--strict', action='store_true', help='snapshot mode: unfilled placeholders are findings')
    parser.add_argument('--owner', default=None, help='GitHub login of the repository owner, whose URLs are allowed (default: see above)')
    args = parser.parse_args(argv)
    root = args.root
    if root is None:
        root = subprocess.run(['git', 'rev-parse', '--show-toplevel'], capture_output=True, check=True).stdout.decode().strip()
    try:
        allow = load_allow(args.allow)
    except ValueError as error:
        print('scan-generic: ' + str(error), file=sys.stderr)
        return 2
    owner = args.owner.lower() if args.owner else repo_owner(root)
    findings = scan_tree(root, allow, use_git=not args.no_git, strict=args.strict, owner=owner)
    for relpath, number, rule, prefix in findings:
        print(f'{relpath}:{number}: {rule} ({prefix})')
    print(f'scan-generic: {len(findings)} finding(s), {len(allow)} allow entr(ies)')
    return 1 if findings else 0


if __name__ == '__main__':
    sys.exit(main())
