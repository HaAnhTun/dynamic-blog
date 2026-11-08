// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearPrerenderedPages } from './clear-prerendered-pages.mjs'

/** The `.next/standalone/.next` folder the Dockerfile cleans: a manifest and the pages it names, in `server/app`. */
let dist: string

function put(relative: string): string {
  const path = join(dist, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, 'x')
  return path
}

beforeEach(() => {
  dist = mkdtempSync(join(tmpdir(), 'prerendered-'))
  writeFileSync(
    join(dist, 'prerender-manifest.json'),
    JSON.stringify({
      routes: {
        '/bookmarks': { routeType: 'page', initialRevalidateSeconds: 300 },
        '/en/case-studies/example': { routeType: 'page', initialRevalidateSeconds: 300 },
        '/_global-error': { routeType: 'page', initialRevalidateSeconds: false },
        '/icon.png': { routeType: 'route', initialRevalidateSeconds: false },
        '/opengraph-image': { routeType: 'route', initialRevalidateSeconds: 300 },
      },
    }),
  )
  for (const route of ['bookmarks', 'en/case-studies/example']) {
    for (const extension of ['html', 'rsc', 'meta']) put(`server/app/${route}.${extension}`)
    put(`server/app/${route}.segments/_full.segment.rsc`)
  }
  for (const file of ['_global-error.html', 'icon.png.body', 'opengraph-image.body', 'bookmarks/page.js'])
    put(`server/app/${file}`)
})

afterEach(() => rmSync(dist, { recursive: true, force: true }))

describe('clearPrerenderedPages: the image holds no copy of a page that revalidates', () => {
  it('removes every file and segment folder of a revalidating page, and keeps the pages that never change and the route bodies', async () => {
    expect(await clearPrerenderedPages(dist)).toBe(8)

    for (const route of ['bookmarks', 'en/case-studies/example']) {
      for (const extension of ['html', 'rsc', 'meta', 'segments']) {
        expect(existsSync(join(dist, `server/app/${route}.${extension}`)), `${route}.${extension}`).toBe(false)
      }
    }
    for (const kept of ['_global-error.html', 'icon.png.body', 'opengraph-image.body', 'bookmarks/page.js']) {
      expect(existsSync(join(dist, 'server/app', kept)), kept).toBe(true)
    }
  })

  it('throws without a manifest, so the image build fails instead of shipping the seed', async () => {
    rmSync(join(dist, 'prerender-manifest.json'))
    await expect(clearPrerenderedPages(dist)).rejects.toThrow()
  })

  it('runs as the Dockerfile runs it: prints a count, exits 0, and exits 1 without a manifest', () => {
    const script = join(process.cwd(), 'scripts', 'clear-prerendered-pages.mjs')
    const done = spawnSync(process.execPath, [script, dist], { encoding: 'utf8' })
    expect(done.status).toBe(0)
    expect(done.stdout).toMatch(/removed 8 prerendered page files/)
    expect(done.stdout).not.toContain(dist)
    expect(existsSync(join(dist, 'server/app/bookmarks.html'))).toBe(false)

    const failed = spawnSync(process.execPath, [script, join(dist, 'missing')], { encoding: 'utf8' })
    expect(failed.status).toBe(1)
    expect(failed.stderr).not.toContain(dist)
  })
})
