import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The frontend folder (the tests run from it) and the repository root above it.
const FRONTEND = resolve(__dirname, '..', '..')
const REPOSITORY = resolve(FRONTEND, '..')

type Lock = { packages: Record<string, { version?: string; hasInstallScript?: boolean }> }
type Manifest = { scripts?: Record<string, string> }

const lock = JSON.parse(readFileSync(join(FRONTEND, 'package-lock.json'), 'utf8')) as Lock
const manifest = JSON.parse(readFileSync(join(FRONTEND, 'package.json'), 'utf8')) as Manifest

// Every package of the lock file whose registry entry declares an install script (preinstall, install or postinstall). The installs of
// CI and of the Docker image run with `--ignore-scripts`, so these scripts never run there; this list is the reviewed set. A new entry
// (for example from a Dependabot pull request) fails the test until somebody has read the script and decided that either the build
// does not need it or `npm rebuild <package>` has to follow the install.
//
//   @parcel/watcher   a file watcher of the dev server and of next-intl's extractor; ships prebuilt binaries as optional platform packages
//   @swc/core         the same for the compiler that next-intl's extractor loads; the platform binary is its own optional package
//   fsevents          macOS only (an optional dependency), its script compiles a binary that other systems skip
//   unrs-resolver     a resolver used by the lint tooling; its script (napi-postinstall) only checks that the platform binary is present
const REVIEWED_INSTALL_SCRIPTS = [
  'node_modules/@parcel/watcher',
  'node_modules/@swc/core',
  'node_modules/fsevents',
  'node_modules/unrs-resolver',
]

function installCommands(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .filter((line) => /\bnpm\s+(ci|install|i|add)\b/.test(line))
}

describe('npm lifecycle scripts', () => {
  it('names the packages whose install script is skipped, and no other', () => {
    const declared = Object.entries(lock.packages)
      .filter(([, entry]) => entry.hasInstallScript === true)
      .map(([name]) => name)
      .sort()
    expect(declared).toEqual([...REVIEWED_INSTALL_SCRIPTS].sort())
  })

  it('has no install hook of its own in package.json (it would never run under --ignore-scripts)', () => {
    const own = Object.keys(manifest.scripts ?? {}).filter((name) =>
      ['preinstall', 'install', 'postinstall', 'prepare'].includes(name),
    )
    expect(own).toEqual([])
  })

  it('installs with --ignore-scripts in the Docker image', () => {
    const dockerfile = readFileSync(join(FRONTEND, 'Dockerfile'), 'utf8')
    const commands = installCommands(dockerfile)
    expect(commands.length).toBeGreaterThan(0)
    expect(commands.filter((command) => !command.includes('--ignore-scripts'))).toEqual([])
  })

  it('installs with --ignore-scripts in every CI workflow step', () => {
    const folder = join(REPOSITORY, '.github', 'workflows')
    const workflows = readdirSync(folder).filter((name) => name.endsWith('.yml'))
    expect(workflows.length).toBeGreaterThan(0)
    const commands = workflows.flatMap((name) =>
      installCommands(readFileSync(join(folder, name), 'utf8')).map((command) => `${name}: ${command.trim()}`),
    )
    expect(commands.length).toBeGreaterThan(0)
    expect(commands.filter((command) => !command.includes('--ignore-scripts'))).toEqual([])
  })
})
