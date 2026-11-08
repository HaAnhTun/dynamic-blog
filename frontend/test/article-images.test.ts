import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every diagram an article points at exists, and every diagram that exists is used.
 *
 * This is the gate for a failure that has no error anywhere: a renamed or mistyped
 * `/images/...` leaves the reader an alt-text stub where a diagram should be. Nothing
 * throws, the build is green, the page is 200, and only a person looking at that one
 * article ever finds out. seed/push.py's linter reports the same thing when pushing from
 * a shell; this is the one that fails a test run.
 *
 * It reads the SEED FILES rather than the database: the files are the source of truth
 * for the bootstrap articles, they are what review sees, and a test that needs a running
 * Postgres to check a filename would not run in CI.
 */
const ARTICLES = join(process.cwd(), '..', 'seed', 'articles')
const PUBLIC = join(process.cwd(), 'public')
const IMAGES = join(PUBLIC, 'images')

/** `![alt](/images/x.svg "title")` — the title is optional and stops at the space. */
const MARKDOWN_IMAGE = /!\[[^\]]*\]\((\/images\/[^)\s"]+)/g

/** Fixtures written by lib/markdown-images.test.tsx, which may be mid-run beside this
 *  file. Excluded from the orphan check so the two suites cannot fight. */
const isFixture = (name: string) => name.startsWith('__')

function articles(): { name: string; body: string }[] {
  return readdirSync(ARTICLES)
    .filter((name) => name.endsWith('.md'))
    .map((name) => ({ name, body: readFileSync(join(ARTICLES, name), 'utf8') }))
}

function references(): { article: string; src: string }[] {
  return articles().flatMap(({ name, body }) => [...body.matchAll(MARKDOWN_IMAGE)].map((m) => ({ article: name, src: m[1]! })))
}

// The owner's bootstrap articles are not part of the exported product: the check applies where they exist.
describe.skipIf(!existsSync(ARTICLES))('article diagrams', () => {
  it('reads the seed articles at all', () => {
    // The guard that makes every assertion below mean something. Resolving to the wrong
    // directory would yield an empty list, and a test that iterates over nothing passes
    // while checking nothing — which is how a check in this repo has silently died before.
    expect(articles().length, `no .md files under ${ARTICLES}`).toBeGreaterThan(5)
    expect(references().length, 'no article references an image').toBeGreaterThan(0)
  })

  it('points every image reference at a file that exists', () => {
    const missing = references().filter(({ src }) => {
      try {
        readFileSync(join(PUBLIC, src.replace(/^\//, '')))
        return false
      } catch {
        return true
      }
    })

    expect(missing.map((m) => `${m.article} → ${m.src}`)).toEqual([])
  })

  it('uses every diagram that ships', () => {
    // The other direction: a diagram nobody references is dead weight in the image
    // directory, and usually means an insertion that was reverted or a renamed file whose
    // old copy stayed behind.
    const used = new Set(references().map(({ src }) => src.replace('/images/', '')))
    const orphans = readdirSync(IMAGES)
      .filter((name) => name.endsWith('.svg') && !isFixture(name))
      .filter((name) => !used.has(name))

    expect(orphans).toEqual([])
  })

  it('gives every diagram alt text that is not the caption', () => {
    // alt and title answer different questions, and the quickest way to get this wrong is
    // to paste the same sentence into both. The renderer turns the title into a visible
    // <figcaption>, so a reader who cannot see the image would then hear the caption
    // twice and learn nothing about the picture.
    const withBoth = articles().flatMap(({ name, body }) =>
      [...body.matchAll(/!\[([^\]]*)\]\(\/images\/[^)\s"]+\s+"([^"]+)"\)/g)].map((m) => ({
        article: name,
        alt: m[1]!,
        title: m[2]!,
      })),
    )

    expect(withBoth.length, 'no captioned image found to check').toBeGreaterThan(0)
    for (const { article, alt, title } of withBoth) {
      expect(alt.length, `${article}: empty alt`).toBeGreaterThan(20)
      expect(alt, `${article}: alt repeats the caption`).not.toBe(title)
    }
  })
})
