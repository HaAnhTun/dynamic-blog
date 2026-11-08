#!/usr/bin/env python3
"""Collects the licenses of the npm and Maven dependencies, checks them against an allowlist, writes the notices file.

usage: python scripts/release/collect-licenses.py [--root DIR] [--check] [--write FILE] [--exceptions FILE]

  --root DIR         repository root (default: the repository of the current directory)
  --check            exit 1 when a dependency has an unknown license or a license outside the allowlist
  --write FILE       write THIRD_PARTY_NOTICES.md style notices to FILE
  --exceptions FILE  documented exceptions (default scripts/release/license-exceptions.txt next to this script)

npm: frontend/package-lock.json (the `license` field of each lock entry), refined by node_modules/*/package.json when
the dependencies are installed. Maven: backend/pom.xml plus the POMs of the local ~/.m2 repository (parent chain, BOM
imports, transitive compile and runtime dependencies); an artifact whose POM is not available locally is reported as
"unknown", which fails --check. No network access, standard library only.

The exceptions file has one entry per line: `ECOSYSTEM:NAME | LICENSE | reason` (NAME may use `*`), for example a
dynamically linked LGPL library. The reason is mandatory. A listed package is accepted with the listed license.
"""
import argparse
import fnmatch
import json
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_EXCEPTIONS = os.path.join(HERE, 'license-exceptions.txt')

ALLOWED = {
    'MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'EPL-1.0', 'EPL-2.0', 'MPL-2.0', 'CC0-1.0', '0BSD',
    'Unlicense', 'BlueOak-1.0.0', 'Python-2.0', 'CC-BY-4.0', 'OFL-1.1', 'MIT-0',
}  # MIT-0 is MIT without the notice duty; LGPL only through the exceptions file
UNKNOWN = 'unknown'


# ---------------------------------------------------------------- license expressions


def normalize_id(token):
    """Map an SPDX-like identifier to the form used in ALLOWED (or keep it)."""
    t = token.strip()
    for suffix in ('-or-later', '-only'):
        if t.endswith(suffix):
            t = t[: -len(suffix)]
    if t.endswith('+'):
        t = t[:-1]
    return {'BSD': 'BSD-3-Clause', 'Apache 2.0': 'Apache-2.0', 'Apache2': 'Apache-2.0', 'GPL-2.0-with-classpath-exception': t}.get(t, t)


def _tokens(expr):
    return re.findall(r'\(|\)|[^\s()]+', expr)


def expression_ok(expr, allowed=ALLOWED):
    """True when an SPDX expression is satisfied by the allowed ids (OR: any branch, AND: every branch)."""
    tokens = _tokens(expr)
    pos = 0

    def parse_or():
        nonlocal pos
        value = parse_and()
        while pos < len(tokens) and tokens[pos].upper() == 'OR':
            pos += 1
            right = parse_and()
            value = value or right
        return value

    def parse_and():
        nonlocal pos
        value = parse_atom()
        while pos < len(tokens) and tokens[pos].upper() == 'AND':
            pos += 1
            right = parse_atom()
            value = value and right
        return value

    def parse_atom():
        nonlocal pos
        if pos >= len(tokens):
            return False
        token = tokens[pos]
        pos += 1
        if token == '(':
            value = parse_or()
            if pos < len(tokens) and tokens[pos] == ')':
                pos += 1
            return value
        if token.upper() == 'WITH':
            return False
        return normalize_id(token) in allowed

    result = parse_or()
    return result and pos >= len(tokens)


def load_exceptions(path):
    entries = []
    if not path or not os.path.isfile(path):
        return entries
    with open(path, encoding='utf-8') as handle:
        for number, raw in enumerate(handle, 1):
            line = raw.strip()
            if not line or line.startswith('#'):
                continue
            parts = [p.strip() for p in line.split('|', 2)]
            if len(parts) != 3 or not all(parts):
                raise ValueError(f'{os.path.basename(path)}:{number}: expected `ECOSYSTEM:NAME | LICENSE | reason`')
            entries.append(tuple(parts))
    return entries


def apply_exceptions(deps, exceptions):
    """An exception that names a concrete license also supplies it for a dependency whose license is unknown."""
    for dep in deps:
        if dep['license'] != UNKNOWN:
            continue
        key = f"{dep['ecosystem']}:{dep['name']}"
        for pattern, listed, _reason in exceptions:
            if fnmatch.fnmatchcase(key, pattern) and listed != '*':
                dep['license'] = listed
                break
    return deps


def license_status(dep, exceptions=()):
    """Return 'ok', 'exception', 'unknown' or 'denied' for a dependency dict (ecosystem, name, license)."""
    key = f"{dep['ecosystem']}:{dep['name']}"
    lic = dep['license']
    for pattern, listed, _reason in exceptions:
        if fnmatch.fnmatchcase(key, pattern) and (listed == '*' or normalize_id(listed) == normalize_id(lic) or listed == lic):
            return 'exception'
    if lic == UNKNOWN or not lic:
        return 'unknown'
    return 'ok' if expression_ok(lic) else 'denied'


# ---------------------------------------------------------------- npm


def _npm_license_value(value):
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return str(value.get('type') or value.get('name') or '')
    if isinstance(value, list):
        parts = [_npm_license_value(v) for v in value]
        return '(' + ' OR '.join(p for p in parts if p) + ')' if parts else ''
    return ''


def collect_npm(root):
    lock_path = os.path.join(root, 'frontend', 'package-lock.json')
    if not os.path.isfile(lock_path):
        return []
    with open(lock_path, encoding='utf-8') as handle:
        lock = json.load(handle)
    deps = {}
    for key, entry in lock.get('packages', {}).items():
        if not key:
            continue
        name = entry.get('name') or key.split('node_modules/')[-1]
        lic = _npm_license_value(entry.get('license') or entry.get('licenses'))
        installed = os.path.join(root, 'frontend', key.replace('/', os.sep), 'package.json')
        if os.path.isfile(installed):
            try:
                with open(installed, encoding='utf-8') as handle:
                    data = json.load(handle)
                lic = _npm_license_value(data.get('license') or data.get('licenses')) or lic
            except (OSError, ValueError):
                pass
        deps[(name, entry.get('version', ''))] = {
            'ecosystem': 'npm', 'name': name, 'version': entry.get('version', ''), 'license': lic or UNKNOWN,
        }
    return sorted(deps.values(), key=lambda d: (d['name'], d['version']))


# ---------------------------------------------------------------- Maven

LICENSE_NAMES = [
    (r'apache.*(2\.0|version 2|v2)|asl 2', 'Apache-2.0'),
    (r'eclipse public license.*(2\.0|v2)|^epl[- ]?2', 'EPL-2.0'),
    (r'eclipse public license|^epl', 'EPL-1.0'),
    (r'eclipse distribution license|^edl|bsd.*3|3.clause|new bsd|revised bsd', 'BSD-3-Clause'),
    (r'bsd.*2|2.clause|simplified bsd', 'BSD-2-Clause'),
    (r'^bsd|bsd license', 'BSD-3-Clause'),
    (r'mozilla public license.*2|^mpl[- ]?2', 'MPL-2.0'),
    (r'^the mit|^mit|mit license|mit-0', 'MIT'),
    (r'^isc', 'ISC'),
    (r'cc0|creative commons zero|public domain', 'CC0-1.0'),
    (r'unlicense', 'Unlicense'),
    (r'lesser general public.*3|lgpl.*3', 'LGPL-3.0'),
    (r'lesser general public|lgpl', 'LGPL-2.1'),
    (r'cddl|common development and distribution', 'CDDL-1.1'),
    (r'general public license|gpl', 'GPL-2.0'),
]


def map_license_name(name, url=''):
    text = (name or url or '').strip().lower()
    if not text:
        return ''
    for pattern, spdx in LICENSE_NAMES:
        if re.search(pattern, text):
            if spdx.startswith('GPL') and 'classpath' in text:
                return 'GPL-2.0-with-classpath-exception'
            return spdx
    return (name or url).strip()


def _strip_ns(root):
    for el in root.iter():
        if isinstance(el.tag, str) and '}' in el.tag:
            el.tag = el.tag.split('}', 1)[1]
    return root


def _child(el, tag):
    found = el.find(tag) if el is not None else None
    return found.text.strip() if found is not None and found.text else ''


class Pom:
    """A parsed POM with its parent chain, properties and managed versions."""

    def __init__(self, repo, group, artifact, version, tree=None, depth=0):
        self.repo, self.group, self.artifact, self.version = repo, group, artifact, version
        self.tree = tree
        self.parent = None
        self.props = {}
        self.managed = {}
        self.deps = []
        self.licenses = []
        if self.tree is None:
            self.tree = self._load(group, artifact, version)
        if self.tree is None:
            return
        self._read(depth)

    def _load(self, group, artifact, version):
        path = os.path.join(self.repo, *group.split('.'), artifact, version, f'{artifact}-{version}.pom')
        if not os.path.isfile(path):
            return None
        try:
            return _strip_ns(ET.parse(path).getroot())
        except ET.ParseError:
            return None

    def _read(self, depth):
        t = self.tree
        parent = t.find('parent')
        if parent is not None and depth < 12:
            pg, pa, pv = _child(parent, 'groupId'), _child(parent, 'artifactId'), _child(parent, 'version')
            self.parent = _POM_CACHE.get((self.repo, pg, pa, pv)) or Pom(self.repo, pg, pa, pv, depth=depth + 1)
            _POM_CACHE[(self.repo, pg, pa, pv)] = self.parent
            if self.parent.tree is None:
                self.parent = None
        self.group = _child(t, 'groupId') or (self.parent.group if self.parent else self.group)
        self.version = _child(t, 'version') or (self.parent.version if self.parent else self.version)
        self.props = dict(self.parent.props) if self.parent else {}
        props = t.find('properties')
        if props is not None:
            for p in props:
                if isinstance(p.tag, str) and p.text:
                    self.props[p.tag] = p.text.strip()
        self.props.update({'project.version': self.version, 'project.groupId': self.group, 'pom.version': self.version,
                           'project.parent.version': self.parent.version if self.parent else ''})
        self.managed = dict(self.parent.managed) if self.parent else {}
        mgmt = t.find('dependencyManagement/dependencies')
        if mgmt is not None:
            for d in mgmt.findall('dependency'):
                g, a, v = (self.resolve(_child(d, x)) for x in ('groupId', 'artifactId', 'version'))
                if _child(d, 'scope') == 'import' and _child(d, 'type') == 'pom' and v and depth < 12:
                    bom = _POM_CACHE.get((self.repo, g, a, v)) or Pom(self.repo, g, a, v, depth=depth + 1)
                    _POM_CACHE[(self.repo, g, a, v)] = bom
                    for k, val in bom.managed.items():
                        self.managed.setdefault(k, val)
                elif v:
                    self.managed[(g, a)] = v
        for d in (t.findall('dependencies/dependency')):
            self.deps.append({
                'group': self.resolve(_child(d, 'groupId')), 'artifact': self.resolve(_child(d, 'artifactId')),
                'version': self.resolve(_child(d, 'version')), 'scope': _child(d, 'scope') or 'compile',
                'optional': _child(d, 'optional') == 'true', 'type': _child(d, 'type') or 'jar',
            })
        for lic in t.findall('licenses/license'):
            self.licenses.append(map_license_name(_child(lic, 'name'), _child(lic, 'url')))

    def resolve(self, text):
        for _ in range(8):
            new = re.sub(r'\$\{([^}]+)\}', lambda m: self.props.get(m.group(1), m.group(0)), text or '')
            if new == text:
                break
            text = new
        return text

    def license(self):
        """The first license of this POM or of the nearest ancestor that declares one."""
        node = self
        while node is not None:
            if node.licenses:
                return ' OR '.join(dict.fromkeys(node.licenses)) if len(node.licenses) > 1 else node.licenses[0]
            node = node.parent
        return ''


_POM_CACHE = {}


def _installed_version(repo, group, artifact):
    base = os.path.join(repo, *group.split('.'), artifact)
    if not os.path.isdir(base):
        return ''
    versions = [v for v in os.listdir(base) if os.path.isfile(os.path.join(base, v, f'{artifact}-{v}.pom'))]
    return sorted(versions, key=lambda v: [int(x) if x.isdigit() else 0 for x in re.split(r'[.-]', v)])[-1] if versions else ''


def collect_maven(root, repo=None):
    pom_path = os.path.join(root, 'backend', 'pom.xml')
    if not os.path.isfile(pom_path):
        return []
    repo = repo or os.path.join(os.path.expanduser('~'), '.m2', 'repository')
    tree = _strip_ns(ET.parse(pom_path).getroot())
    top = Pom(repo, _child(tree, 'groupId'), _child(tree, 'artifactId'), _child(tree, 'version'), tree=tree)
    seen = {}
    queue = [(d, top) for d in top.deps]
    while queue:
        dep, context = queue.pop(0)
        if dep['scope'] not in ('compile', 'runtime') or dep['optional'] or dep['type'] != 'jar':
            continue
        group, artifact = dep['group'], dep['artifact']
        version = top.managed.get((group, artifact)) or dep['version'] or context.managed.get((group, artifact), '')
        key = (group, artifact)
        if key in seen:
            continue
        seen[key] = {'ecosystem': 'maven', 'name': f'{group}:{artifact}', 'version': version, 'license': UNKNOWN}
        if not version or '${' in version:
            continue
        pom = _POM_CACHE.get((repo, group, artifact, version)) or Pom(repo, group, artifact, version)
        if pom.tree is None:  # mediated away by Maven: the license of another installed version is the best local evidence
            alternative = _installed_version(repo, group, artifact)
            if alternative:
                pom = Pom(repo, group, artifact, alternative)
        _POM_CACHE[(repo, group, artifact, version)] = pom
        if pom.tree is None:
            continue
        seen[key]['license'] = pom.license() or UNKNOWN
        queue.extend((d, pom) for d in pom.deps)
    return sorted(seen.values(), key=lambda d: d['name'])


# ---------------------------------------------------------------- report


def collect(root):
    return collect_npm(root) + collect_maven(root)


def render_notices(deps):
    lines = [
        '# Third-party notices', '',
        'This project bundles or depends on the open source components below. Each component remains under its own license.',
        '', f'Components: {len(deps)}', '',
    ]
    groups = {}
    for dep in deps:
        groups.setdefault(dep['license'], []).append(dep)
    lines.append('## Licenses in use')
    lines.append('')
    lines.append('| License | Components |')
    lines.append('|---|---|')
    for lic in sorted(groups):
        lines.append(f'| {lic} | {len(groups[lic])} |')
    for lic in sorted(groups):
        lines += ['', f'## {lic}', '']
        for dep in groups[lic]:
            lines.append(f"- {dep['name']} {dep['version']} ({dep['ecosystem']})".rstrip())
    return '\n'.join(lines) + '\n'


def main(argv=None):
    parser = argparse.ArgumentParser(description='Collect and check dependency licenses.')
    parser.add_argument('--root', default=None)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--write', default=None)
    parser.add_argument('--exceptions', default=DEFAULT_EXCEPTIONS)
    args = parser.parse_args(argv)
    root = args.root or subprocess.run(['git', 'rev-parse', '--show-toplevel'], capture_output=True, check=True).stdout.decode().strip()
    try:
        exceptions = load_exceptions(args.exceptions)
    except ValueError as error:
        print('collect-licenses: ' + str(error), file=sys.stderr)
        return 2
    deps = apply_exceptions(collect(root), exceptions)
    bad = [(d, license_status(d, exceptions)) for d in deps]
    bad = [(d, s) for d, s in bad if s in ('unknown', 'denied')]
    if args.write:
        with open(args.write, 'w', encoding='utf-8', newline='\n') as handle:
            handle.write(render_notices(deps))
    npm = sum(d['ecosystem'] == 'npm' for d in deps)
    print(f'collect-licenses: {len(deps)} dependencies ({npm} npm, {len(deps) - npm} maven), {len(bad)} to review')
    for dep, status in bad:
        print(f"  {status}: {dep['ecosystem']}:{dep['name']} {dep['version']} -> {dep['license']}")
    return 1 if args.check and bad else 0


if __name__ == '__main__':
    sys.exit(main())
