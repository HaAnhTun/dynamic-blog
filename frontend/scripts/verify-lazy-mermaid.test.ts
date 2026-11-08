import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const SCRIPT = join(process.cwd(), 'scripts', 'verify-lazy-mermaid.mjs')
const KEY = 'components\\site\\blocks\\DiagramView.tsx -> mermaid'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A build directory with the files the script reads: the loadable manifest and a few pages. */
function build({ loadable, pages }: { loadable?: Record<string, unknown>; pages: Record<string, string> }) {
  const dir = mkdtempSync(join(tmpdir(), 'lazy-mermaid-'))
  made.push(dir)
  if (loadable) writeFileSync(join(dir, 'react-loadable-manifest.json'), JSON.stringify(loadable))
  for (const [name, text] of Object.entries(pages)) {
    const file = join(dir, 'server', 'app', name)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, text)
  }
  return dir
}

const run = (dir: string) => spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' })
const LOADABLE = { [KEY]: { id: 1, files: ['static/chunks/9374.abc.js', 'static/chunks/2e1c.def.js'] } }

describe('scripts/verify-lazy-mermaid.mjs', () => {
  it('passes when no page and no route manifest lists a chunk of the mermaid import', () => {
    const dir = build({
      loadable: LOADABLE,
      pages: {
        'en.html': '<script src="/_next/static/chunks/main.js"></script>',
        'x_client-reference-manifest.js': 'chunks:["static/chunks/6068.js"]',
      },
    })

    const result = run(dir)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('ok')
  })

  it('fails and names the page when a prerendered page loads a chunk of the import up front', () => {
    const dir = build({ loadable: LOADABLE, pages: { 'en.html': '<script src="/_next/static/chunks/9374.abc.js"></script>' } })

    const result = run(dir)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('en.html')
    expect(result.stderr).toContain('9374.abc.js')
  })

  it('fails when a route manifest lists one', () => {
    const dir = build({ loadable: LOADABLE, pages: { 'posts/page_client-reference-manifest.js': '"static/chunks/2e1c.def.js"' } })

    expect(run(dir).status).toBe(1)
  })

  it('fails when mermaid is no longer a dynamic import of the diagram island', () => {
    const dir = build({
      loadable: { 'components\\site\\Header.tsx -> ./search/SearchPalette': { id: 2, files: ['a.js'] } },
      pages: { 'en.html': '' },
    })

    const result = run(dir)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('imported statically or moved')
  })

  it('fails instead of passing when there is no manifest or no page to check', () => {
    expect(run(build({ pages: { 'en.html': '' } })).status).toBe(1)
    expect(run(build({ loadable: LOADABLE, pages: {} })).status).toBe(1)
  })
})
