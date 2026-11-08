// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `updateTag` clears the cache of Next and nothing else, so the install guide has to tell an operator who puts a CDN in front what to
 * purge: a withdrawn post, a deleted image (`/media/*` is cached for a year, on purpose) and the 404 cached before a publication
 * (audit issue 64). The text is the only fix for what a CDN does, so a test keeps it.
 */
const root = join(process.cwd(), '..')

/** The text under the first heading of `path` that starts with `prefix`, up to the next heading of its level or above. */
function section(path: string, prefix: string): string | undefined {
  const file = join(root, path)
  if (!existsSync(file)) return undefined
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  const start = text.indexOf(`\n${prefix}`)
  if (start < 0) return ''
  const rest = text.slice(start + 1 + prefix.length)
  const end = rest.search(/\n##? /)
  return end < 0 ? rest : rest.slice(0, end)
}

describe('docs: a CDN in front of the site', () => {
  it('INSTALL.md tells what to purge after an unpublish, a delete and an image deletion', () => {
    const text = section('docs/INSTALL.md', '### A CDN in front')
    if (text === undefined) return // The docs are not in the Docker build context.

    expect(text).toMatch(/Do not cache HTML/)
    expect(text).toMatch(/purge the post URL/)
    expect(text).toMatch(/unpublish or\s+delete/)
    expect(text).toMatch(/\/media\/<uuid>\.<ext>/)
    expect(text).toMatch(/_next\/image/)
    expect(text).toMatch(/a year/)
    expect(text).toMatch(/force-recreate|recreate the\s+frontend container/)
  })

  it('the Vietnamese copy keeps the same advice (the English guard keeps Vietnamese letters out of this file, so it checks the addresses)', () => {
    const text = section('docs/vi/INSTALL.md', '### CDN ')
    if (text === undefined) return

    expect(text).not.toBe('')
    expect(text).toContain('/posts/<slug>')
    expect(text).toContain('/en/posts/<slug>')
    expect(text).toMatch(/\/media\/<uuid>\.<ext>/)
    expect(text).toContain('/_next/image?url=')
    expect(text).toContain('max-age=31536000')
    expect(text).toContain('BACKUP-AND-RESTORE.md#clearing-the-optimized-image-cache')
  })

  it('SECURITY.md no longer says that an idle page serves a stale copy however old it is', () => {
    const file = join(root, 'docs/SECURITY.md')
    if (!existsSync(file)) return
    const text = readFileSync(file, 'utf8')

    expect(text).not.toMatch(/however old it is/)
    expect(text).toMatch(/expireTime/)
    expect(text).toMatch(/a-cdn-in-front/)
  })
})
