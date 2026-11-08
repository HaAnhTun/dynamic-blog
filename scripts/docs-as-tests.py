"""Extracts the runnable shell blocks of the install docs and optionally runs them.

usage: python scripts/docs-as-tests.py [--list] [--run DIR] [--env KEY=VALUE ...] FILE.md [FILE.md ...]
       python scripts/docs-as-tests.py --check-loopback FILE.md [FILE.md ...]

A fenced block is runnable when the line right before the opening fence is `<!-- docs-test: run -->`. Blocks run in order,
per file, with `bash -e` inside DIR (the clean clone), stdout and stderr streamed; the first failing block stops the run with
its exit code. Without --run the blocks are only printed (--list), which is what the docs tests use.

--check-loopback is a different check, on every shell block of the files (marked or not): a recipe for a development or E2E stack must
not open it to the whole network. It fails on a `docker run` that publishes a port without a `127.0.0.1:` (or `[::1]:`) host address,
on `next start`, `next dev` and `npm run dev` without `-H localhost` (and on `-H 127.0.0.1`, which is no way out: Next's locale
middleware then redirects `/` to itself for ever), and on a backend command that unlocks the development password
(`SETUP_LOCK_DEV_SEED=false`) without `SERVER_ADDRESS=127.0.0.1` (or `--server.address=127.0.0.1`). A line that must be an exception
says `# loopback-ok: <why>`. Docker opens a published port with its own firewall rules, which `ufw` does not see.
"""
import argparse
import os
import re
import subprocess
import sys

MARKER = '<!-- docs-test: run -->'
SHELL_LANGUAGES = {'', 'bash', 'sh', 'shell', 'zsh', 'console', 'powershell', 'pwsh', 'ps1'}
EXEMPT = 'loopback-ok:'
LOOPBACK_HOST = re.compile(r'^(?:127\.0\.0\.1|\[::1\]):')
DEV_SERVER_HOST = re.compile(r'(?:^|\s)(?:-H|--hostname)(?:=|\s+)localhost(?:\s|$)')
LITERAL_LOOPBACK_HOST = re.compile(r'(?:^|\s)(?:-H|--hostname)(?:=|\s+)(?:127\.0\.0\.1|\[?::1\]?)(?:\s|$)')
BACKEND_START = re.compile(r'\bjava\b[^\n]*\s-jar\b|spring-boot:run')
BACKEND_LOOPBACK = re.compile(r'(?:SERVER_ADDRESS=|--server\.address=)127\.0\.0\.1(?:\s|$)')


def extract(text):
    """Returns the commands of every marked block, in order."""
    lines = text.splitlines()
    blocks = []
    i = 0
    while i < len(lines):
        if lines[i].strip() == MARKER and i + 1 < len(lines) and lines[i + 1].lstrip().startswith('```'):
            fence = lines[i + 1].lstrip()
            ticks = fence[: len(fence) - len(fence.lstrip('`'))]
            body = []
            i += 2
            while i < len(lines) and not lines[i].lstrip().startswith(ticks):
                body.append(lines[i])
                i += 1
            blocks.append('\n'.join(body))
        i += 1
    return blocks


def code_blocks(text):
    """(1-based line of the first command, language, lines) of every fenced block."""
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        stripped = lines[i].lstrip()
        if stripped.startswith('```'):
            ticks = stripped[: len(stripped) - len(stripped.lstrip('`'))]
            language = stripped[len(ticks):].strip().split(' ')[0].lower()
            start = i + 2
            body = []
            i += 1
            while i < len(lines) and not lines[i].lstrip().startswith(ticks):
                body.append(lines[i])
                i += 1
            yield start, language, body
        i += 1


def commands(start, body):
    """(line, command): the lines of a block with the continuation lines (a trailing backslash or backtick) joined."""
    joined, first = '', None
    for offset, line in enumerate(body):
        stripped = line.strip()
        if not joined and (not stripped or stripped.startswith('#')):
            continue
        if first is None:
            first = start + offset
        if stripped.endswith('\\') or stripped.endswith('`'):
            joined += stripped[:-1] + ' '
            continue
        yield first, joined + stripped
        joined, first = '', None
    if joined:
        yield first, joined


def loopback_problems(text):
    """Problems of the shell blocks of one Markdown text, as strings that name the line. See --check-loopback."""
    problems = []
    for start, language, body in code_blocks(text):
        if language not in SHELL_LANGUAGES:
            continue
        for line, command in commands(start, body):
            if EXEMPT in command:
                continue
            for run in re.finditer(r'\bdocker\s+run\b[^&;|\n]*', command):
                segment = run.group(0)
                if re.search(r'(?:^|\s)-P(?:\s|$)', segment):
                    problems.append(f'line {line}: docker run -P publishes every port on every interface')
                for port in re.finditer(r'(?:^|\s)(?:-p|--publish)(?:=|\s+)(\S+)', segment):
                    if not LOOPBACK_HOST.match(port.group(1)):
                        problems.append(f'line {line}: docker run publishes {port.group(1)} on every interface (use 127.0.0.1:{port.group(1)})')
            for server in re.finditer(r'\bnext\s+(?:start|dev)\b[^&;|\n]*|\bnpm\s+run\s+dev\b[^&;|\n]*', command):
                if LITERAL_LOOPBACK_HOST.search(server.group(0)):
                    problems.append(f'line {line}: -H with a literal loopback address makes the locale redirect of Next loop; use -H localhost')
                elif not DEV_SERVER_HOST.search(server.group(0)):
                    problems.append(f'line {line}: a dev or start server without -H localhost listens on every interface')
            if 'SETUP_LOCK_DEV_SEED=false' in command and BACKEND_START.search(command) and not BACKEND_LOOPBACK.search(command + ' '):
                problems.append(f'line {line}: a backend with the development password unlocked must set SERVER_ADDRESS=127.0.0.1')
    return problems


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('files', nargs='+')
    parser.add_argument('--check-loopback', action='store_true')
    parser.add_argument('--list', action='store_true')
    parser.add_argument('--run', metavar='DIR')
    parser.add_argument('--env', action='append', default=[])
    args = parser.parse_args(argv)
    if args.check_loopback:
        found = 0
        for name in args.files:
            with open(name, encoding='utf-8') as handle:
                for problem in loopback_problems(handle.read()):
                    print(f'{name}: {problem}')
                    found += 1
        print(f'docs-as-tests: {found} loopback problem(s)')
        return 1 if found else 0
    env = dict(os.environ)
    env.update(pair.split('=', 1) for pair in args.env)
    total = 0
    for name in args.files:
        with open(name, encoding='utf-8') as handle:
            blocks = extract(handle.read())
        for index, block in enumerate(blocks, 1):
            total += 1
            print(f'--- {name} block {index}\n{block}', flush=True)
            if args.run and not args.list:
                code = subprocess.run(['bash', '-e', '-c', block], cwd=args.run, env=env).returncode
                print(f'--- exit {code}', flush=True)
                if code:
                    return code
    print(f'docs-as-tests: {total} block(s)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
