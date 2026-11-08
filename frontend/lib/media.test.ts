// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mediaPath, mediaUrl } from './media'

const FILE = '3f2a9c1e-8b4d-4e6f-9a0b-1c2d3e4f5a6b.jpg'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('mediaPath', () => {
  it('is a same-origin path to the /media route', () => {
    expect(mediaPath({ fileName: 'x.jpg' })).toBe('/media/x.jpg')
    expect(mediaPath({ fileName: FILE })).toBe(`/media/${FILE}`)
    expect(mediaPath({ fileName: FILE.replace('.jpg', '.png') })).toBe(`/media/${FILE.replace('.jpg', '.png')}`)
  })

  it('never produces a query string or adds a path segment', () => {
    // next/image throws at render time for a local src with a query string (E871/E426), so a whole
    // page would 500 because of one odd file name from the backend. Encoding turns it into a file name
    // that does not exist: a broken image, the page stays up, and the /media route returns 404.
    for (const fileName of ['x.jpg?v=2', 'x.jpg#top', '../secret.jpg', 'a/b.jpg']) {
      const path = mediaPath({ fileName })
      const url = new URL(path, 'https://blog.example.com')

      expect(url.search, fileName).toBe('')
      expect(url.hash, fileName).toBe('')
      expect(url.pathname.split('/'), fileName).toHaveLength(3)
      expect(url.pathname.startsWith('/media/'), fileName).toBe(true)
    }
  })
})

describe('mediaUrl', () => {
  it('is an absolute URL against the configured origin, for og:image and JSON-LD', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://blog.example.com/')

    expect(mediaUrl({ fileName: FILE })).toBe(`https://blog.example.com/media/${FILE}`)
  })

  it('uses the same path as mediaPath, not a second spelling', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://blog.example.com')

    expect(mediaUrl({ fileName: FILE })).toBe(`https://blog.example.com${mediaPath({ fileName: FILE })}`)
  })
})

describe('lib/media.ts', () => {
  it('is usable on the client: does not pull server-only in', () => {
    // The lightbox (client) and the admin preview both call mediaPath. A server-only import here would
    // turn the build of both red, visible only at next build.
    const source = readFileSync(join(process.cwd(), 'lib/media.ts'), 'utf8')

    expect(source).not.toMatch(/['"]server-only['"]/)
    expect(source).not.toMatch(/from ['"]@?\/?(lib\/)?api['"]|from ['"]\.\/api['"]/)
  })
})
