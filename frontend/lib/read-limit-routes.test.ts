// @vitest-environment node
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The expensive anonymous reads each ask `limitReads` before they do anything (lib/read-limit.ts). The behavior of each route is tested
 * in its own file; this keeps a route that is added next to them, or a refactor that drops the line, from going unnoticed.
 */
const root = process.cwd()

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === '.next') return []
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return routeFiles(path)
    return /^route\.tsx?$/.test(name) ? [path] : []
  })
}

describe('routes that call limitReads', () => {
  const files = routeFiles(join(root, 'app')).map((path) => relative(root, path).split(sep).join('/'))

  it.each([
    ['app/media/[file]/route.ts', 'media'],
    ['app/api/og/posts/[slug]/route.tsx', 'og'],
  ])('%s asks for the %s allowance first', (file, kind) => {
    expect(files).toContain(file)
    const text = readFileSync(join(root, file), 'utf8')
    expect(text).toContain(`limitReads(request, '${kind}')`)
  })

  it('every feed route asks for the feed allowance', () => {
    const feeds = files.filter((file) => /feed\.xml\/route\.ts$/.test(file))
    expect(feeds).toHaveLength(4)
    for (const file of feeds) {
      expect(readFileSync(join(root, file), 'utf8'), file).toContain("limitReads(request, 'feed')")
    }
  })
})
