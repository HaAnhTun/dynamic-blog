"""Fails when a tracked file contains a term of a private blocklist (names, logins, employers of a real owner).

usage: python scripts/check-personal-data.py [--blocklist FILE] [--exclude PREFIX ...]

The blocklist is one case-insensitive term per line (`#` starts a comment). It is never part of the repository: the default
path is `private/blocklist/personal-data.txt`, and without that file the check is skipped (exit 0, says so), which is the
case in a clean clone or in CI. The report names the file and the term only, never the line. Files under `private/` and,
until part E removes them, `seed/` are not scanned.
"""
import argparse
import os
import subprocess
import sys

DEFAULT_BLOCKLIST = os.path.join('private', 'blocklist', 'personal-data.txt')
DEFAULT_EXCLUDES = ('private/', 'seed/')


def load_terms(path):
    with open(path, encoding='utf-8') as handle:
        return [line.strip() for line in handle if line.strip() and not line.lstrip().startswith('#')]


def tracked_files(root):
    out = subprocess.run(['git', 'ls-files', '-z'], cwd=root, capture_output=True, check=True).stdout
    return [name for name in out.decode('utf-8').split('\0') if name]


def scan(root, terms, excludes):
    lowered = [(term, term.lower()) for term in terms]
    hits = []
    for name in tracked_files(root):
        if name.startswith(tuple(excludes)):
            continue
        try:
            with open(os.path.join(root, name), encoding='utf-8') as handle:
                text = handle.read().lower()
        except (OSError, UnicodeDecodeError):
            continue
        hits.extend((name, term) for term, low in lowered if low in text)
    return hits


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--blocklist', default=DEFAULT_BLOCKLIST)
    parser.add_argument('--exclude', action='append', default=None)
    args = parser.parse_args(argv)
    root = subprocess.run(['git', 'rev-parse', '--show-toplevel'], capture_output=True, check=True).stdout.decode().strip()
    blocklist = args.blocklist if os.path.isabs(args.blocklist) else os.path.join(root, args.blocklist)
    if not os.path.isfile(blocklist):
        print('check-personal-data: no blocklist at ' + args.blocklist + ', skipped')
        return 0
    terms = load_terms(blocklist)
    hits = scan(root, terms, args.exclude if args.exclude is not None else DEFAULT_EXCLUDES)
    for name, term in hits:
        print(f'{name}: contains a blocklisted term ({term[:3]}...)')
    print(f'check-personal-data: {len(hits)} hit(s), {len(terms)} term(s)')
    return 1 if hits else 0


if __name__ == '__main__':
    sys.exit(main())
