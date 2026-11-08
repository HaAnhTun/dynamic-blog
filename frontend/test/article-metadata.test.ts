import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The title and excerpt of every seed article, checked for the things that actually make a
 * search result useless.
 *
 * ## What this deliberately does NOT assert
 *
 * A character limit. An SEO audit of this site measured "10/12 titles over 60 characters,
 * 11/12 descriptions over 160" and proposed a test that the counts reach zero. Both numbers
 * are folklore: Google's own documentation says of the title link "while there's no limit on
 * how long a `<title>` element can be, the title link is truncated in Google Search results
 * as needed, typically to fit the device width", and says the same of the snippet. Google
 * truncates by PIXEL width, per device, and does so whether or not a test here is green.
 *
 * A test asserting `excerpt.length < 160` would therefore fail on honest copy, pass on
 * padding, and pressure every future article towards the shorter of two descriptions for a
 * reason nobody could state. The real failures are the ones below — an empty description, a
 * stringified object, raw markdown in a snippet, two articles that cannot be told apart —
 * and none of them is a length.
 *
 * ## Why the seed files and not the database
 *
 * Same reason as test/article-images.test.ts: the files are the source of truth for the
 * bootstrap articles, they are what review sees, and a test that needed a running Postgres
 * to check a sentence would not run in CI. `seed/push.py` is idempotent by slug, so what is
 * here is what is published.
 */
const ARTICLES = join(process.cwd(), '..', 'seed', 'articles')

type Article = { file: string; title: string; excerpt: string }

/**
 * The same front-matter rule `seed/push.py:parse_frontmatter` applies: `key: value` split on
 * the FIRST colon, value taken literally. Reimplemented rather than shelling out to python,
 * and kept to the two fields this file is about.
 */
function articles(): Article[] {
  return readdirSync(ARTICLES)
    .filter((name) => name.endsWith('.md'))
    .map((file) => {
      const text = readFileSync(join(ARTICLES, file), 'utf8')
      const field = (key: string): string => {
        const line = text.split('\n').find((l) => l.startsWith(`${key}:`))
        return line === undefined ? '' : line.slice(key.length + 1).trim()
      }
      return { file, title: field('title'), excerpt: field('excerpt') }
    })
}

// The owner's bootstrap articles are not part of the exported product: the check applies where they exist.
describe.skipIf(!existsSync(ARTICLES))('article titles and descriptions', () => {
  const all = existsSync(ARTICLES) ? articles() : []

  it('reads the seed articles at all', () => {
    // The guard that makes every assertion below mean something: resolving to the wrong
    // directory yields an empty list, and a test that iterates over nothing passes while
    // checking nothing.
    expect(all.length, `no .md files under ${ARTICLES}`).toBeGreaterThan(5)
  })

  it('gives every article a title and a description that are really there', () => {
    for (const { file, title, excerpt } of all) {
      expect(title, `${file}: no title in the front matter`).toBeTruthy()
      expect(excerpt, `${file}: no excerpt in the front matter`).toBeTruthy()

      // The three strings that mean a template ran with nothing in it. They reach a search
      // result verbatim and there is no symptom anywhere on the site.
      for (const field of [title, excerpt]) {
        expect(field, `${file}: a placeholder leaked into the metadata`).not.toMatch(/undefined|\[object Object\]|NaN\b/)
      }
    }
  })

  it('keeps raw markup out of the strings that become meta tags', () => {
    // `excerpt` becomes `<meta name="description">`, `og:description` and `twitter:description`
    // verbatim (app/(site)/posts/[slug]/page.tsx), and `title` becomes `<title>`, `og:title`
    // and the JSON-LD `headline`. None of those render markdown, so a stray `**bold**` or a
    // `[link](/x)` arrives at the reader as the literal characters.
    for (const { file, title, excerpt } of all) {
      for (const [name, field] of [
        ['title', title],
        ['excerpt', excerpt],
      ] as const) {
        expect(field, `${file}: ${name} contains markdown emphasis`).not.toMatch(/\*\*|__/)
        expect(field, `${file}: ${name} contains a markdown link`).not.toMatch(/\[[^\]]*\]\(/)
        expect(field, `${file}: ${name} contains a code span`).not.toMatch(/`/)
        // A single `<` would also close the JSON-LD script early were it not escaped
        // (components/site/ArticleJsonLd.tsx carries that story); keeping it out of the
        // source is the cheaper half of the same defence.
        expect(field, `${file}: ${name} contains a raw angle bracket`).not.toMatch(/[<>]/)
        expect(field, `${file}: ${name} is not trimmed`).toBe(field.trim())
        expect(field, `${file}: ${name} contains a run of spaces`).not.toMatch(/ {2}/)
      }
    }
  })

  it('makes every article distinguishable from every other', () => {
    // Uniqueness is the property a search engine actually needs from these two fields, and
    // the one a length rule would quietly erode: the shorter every title is forced to be,
    // the more of them collapse onto each other.
    const titles = all.map((a) => a.title)
    const excerpts = all.map((a) => a.excerpt)

    expect(new Set(titles).size, 'two articles share a title').toBe(titles.length)
    expect(new Set(excerpts).size, 'two articles share a description').toBe(excerpts.length)

    // And no description that is merely the title again — a snippet that repeats the
    // headline tells a reader nothing they did not already have.
    for (const { file, title, excerpt } of all) {
      expect(excerpt, `${file}: the description is just the title`).not.toBe(title)
    }
  })

  it('writes descriptions as sentences rather than keyword lists', () => {
    // The one shape check worth making: Google's guidance is that a description should
    // "summarize the page content", and the failure mode it names — boilerplate that varies
    // by a single field, keyword stuffing — looks like a list, not a sentence. Terminal
    // punctuation is the cheapest reliable signal of prose that does not constrain length.
    for (const { file, excerpt } of all) {
      expect(excerpt, `${file}: the description does not end as a sentence`).toMatch(/[.!?]$/)
      expect(excerpt.split(',').length, `${file}: the description reads as a comma list`).toBeLessThan(12)
    }
  })
})
