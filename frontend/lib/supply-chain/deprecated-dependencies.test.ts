import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const FRONTEND = resolve(__dirname, '..', '..')

type Lock = { packages: Record<string, { version?: string; deprecated?: string }> }
type Manifest = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }

const lock = JSON.parse(readFileSync(join(FRONTEND, 'package-lock.json'), 'utf8')) as Lock
const manifest = JSON.parse(readFileSync(join(FRONTEND, 'package.json'), 'utf8')) as Manifest
const direct = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })

// A direct dependency that the registry marks as deprecated (the lock file carries the message) is a package nobody maintains for this
// version any more. It is replaced, or it is listed here with the reason it cannot move yet and the packages that block it. The test
// then also checks that the block still exists: the day a blocker accepts the next major version this test fails and asks for the
// migration, so the exception cannot outlive its reason (and nothing breaks on a date).
const BLOCKED: Record<string, { reason: string; blockedBy: string[]; nextMajor: number }> = {
  eslint: {
    reason:
      'ESLint 9 is in maintenance. ESLint 10 needs the plugins that eslint-config-next brings (react, import, jsx-a11y) to accept it as a peer, and their newest releases declare ^9 at most. It is a development tool that only reads our own source.',
    blockedBy: ['eslint-plugin-react', 'eslint-plugin-import', 'eslint-plugin-jsx-a11y'],
    nextMajor: 10,
  },
}

function installedPeerRange(name: string): string {
  const file = join(FRONTEND, 'node_modules', name, 'package.json')
  expect(existsSync(file), `${name} is not installed`).toBe(true)
  const peers = (JSON.parse(readFileSync(file, 'utf8')) as { peerDependencies?: Record<string, string> }).peerDependencies
  return peers?.eslint ?? '*'
}

// Does a peer range of the form "^7 || ^8 || ^9.7" or ">=9" allow this major version?
function allowsMajor(range: string, major: number): boolean {
  return range.split('||').some((part) => {
    const text = part.trim()
    if (text === '*' || text === '') return true
    const lower = /^(>=|\^|~)?\s*(\d+)/.exec(text)
    if (!lower) return false
    const start = Number(lower[2])
    if (lower[1] === '>=') return major >= start
    return major === start
  })
}

describe('deprecated direct dependencies', () => {
  const deprecated = direct.filter((name) => lock.packages[`node_modules/${name}`]?.deprecated)

  it('has none that is not listed with a reason', () => {
    const unlisted = deprecated.filter((name) => !(name in BLOCKED))
    expect(unlisted.map((name) => `${name}@${lock.packages[`node_modules/${name}`].version}`)).toEqual([])
  })

  it('lists only dependencies that are still deprecated (remove the entry once it is migrated)', () => {
    expect(Object.keys(BLOCKED).filter((name) => !deprecated.includes(name))).toEqual([])
  })

  it('still has a blocker for each listed dependency (when none is left, migrate and remove the entry)', () => {
    for (const [name, entry] of Object.entries(BLOCKED)) {
      const stillBlocking = entry.blockedBy.filter((plugin) => !allowsMajor(installedPeerRange(plugin), entry.nextMajor))
      expect(
        stillBlocking.length,
        `${name}: ${entry.blockedBy.join(', ')} now accept major ${entry.nextMajor}: migrate and remove the exception`,
      ).toBeGreaterThan(0)
    }
  })

  it('says why each exception exists', () => {
    for (const [name, entry] of Object.entries(BLOCKED)) {
      expect(entry.reason.length, name).toBeGreaterThan(40)
      expect(entry.blockedBy.length, name).toBeGreaterThan(0)
    }
  })

  it('understands the peer ranges it reads', () => {
    expect(allowsMajor('^3 || ^8 || ^9.7', 10)).toBe(false)
    expect(allowsMajor('^8 || ^9.0.0 || ^10.0.0', 10)).toBe(true)
    expect(allowsMajor('>=9.0.0', 10)).toBe(true)
    expect(allowsMajor('*', 10)).toBe(true)
    expect(allowsMajor('^7.2.0 || ^8 || ^9', 10)).toBe(false)
  })
})
