// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The frontend image is built from `frontend/` alone (docker-compose.yml: `context: ./frontend`). Two things keep that build
 * working on a clean clone: test files are left out of the context (some import `scripts/fixtures` at the repository root,
 * and `next build` type-checks every TypeScript file it can see), and the application code itself never imports from outside
 * this folder.
 */
const root = process.cwd()

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === '.next' || name === 'e2e' || name === 'test') return []
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(?:ts|tsx|mjs)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

/** Every file and folder under `dir`, as a path relative to the frontend folder. */
function allEntries(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? [relative(root, path), ...allEntries(path)] : [relative(root, path)]
  })
}

describe('frontend Docker build context', () => {
  const ignore = readFileSync(join(root, '.dockerignore'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())

  it('leaves test files out of the image build', () => {
    expect(ignore).toContain('**/*.test.ts')
    expect(ignore).toContain('**/*.test.tsx')
  })

  it('application code imports nothing from outside the frontend folder', () => {
    const outside = /(?:from\s+|import\s*\(\s*|require\(\s*)['"](?:\.\.\/)+(?:\.\.\/)(?:scripts|backend|docs|fixtures|seed)\//
    const offenders = sourceFiles(root)
      .filter((file) => outside.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file))
    expect(offenders).toEqual([])
  })

  it('ships no dotfile in public/, which Next serves from the web root', () => {
    // Measured on Next 16: a request for a dotfile of public/ (GET /.gitkeep) is matched by the static handler, then refused, and
    // surfaces as an HTTP 500 instead of a 404, which error alerting counts. A placeholder to keep
    // the folder in git is not needed: the tracked public/images files keep it, and the Dockerfile COPY needs the folder to exist.
    const dotfiles = allEntries(join(root, 'public')).filter((path) => path.split(/[\\/]/).some((part) => part.startsWith('.')))
    expect(dotfiles).toEqual([])
  })
})
