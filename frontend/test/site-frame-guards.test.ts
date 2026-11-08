import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Usage guards of the site frame (spec 8, tickets T11). They read source files, not rendered output, and keep three things true
 * while the deprecated aliases of Container, GalleryGrid and the writing section nav still exist:
 *
 * - the page-only markers of the first redesign (the `:has()` widening) are gone from every source file and E2E spec;
 * - every BROWSE page renders through `BrowseFrame`, every CARD page through `CARD_PAGE`;
 * - no converted page uses `width="wide"`, `WritingSectionNav` or `SPLIT_ROW`, so the follow-up cleanup can delete them safely.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SITE = 'app/[locale]/(site)'

const toPosix = (path: string) => path.split(sep).join('/')
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8')

/** The code of a file without block comments and whole-line or trailing line comments (a comment may name what it explains). */
const code = (file: string) =>
  read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')

function filesUnder(dir: string, keep: (name: string) => boolean): string[] {
  const absolute = join(ROOT, dir)
  if (!existsSync(absolute)) return []
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const path = toPosix(join(dir, entry.name))
    if (entry.isDirectory()) return filesUnder(path, keep)
    return keep(entry.name) ? [path] : []
  })
}

const isSource = (name: string) => /\.(?:ts|tsx|css)$/.test(name)
const isTest = (name: string) => /\.test\.(?:ts|tsx)$/.test(name)

/** The 14 BROWSE pages (spec 3.2): the sidebar plus fluid column shape. */
const BROWSE_PAGES = [
  'writing',
  'series',
  'series/[slug]',
  'topics',
  'archive',
  'categories/[slug]',
  'tags/[slug]',
  'start-here',
  'case-studies',
  'case-studies/[slug]',
  'gallery',
  'search',
  'bookmarks',
  'u/[slug]',
].map((route) => `${SITE}/${route}/page.tsx`)

/** The CARD pages (spec 3.4): a centred 768px card. The error and not-found cards live in components. */
const CARD_FILES = [
  ...['login', 'newsletter', 'newsletter/confirm', 'newsletter/unsubscribe', 'profile', 'notifications'].map(
    (route) => `${SITE}/${route}/page.tsx`,
  ),
  'components/site/ErrorContent.tsx',
  'components/site/NotFoundContent.tsx',
]

/** SHOWCASE pages (spec 3.3) and the shell. */
const OTHER_CONVERTED = [`${SITE}/page.tsx`, `${SITE}/about/page.tsx`, `${SITE}/layout.tsx`, 'components/site/SiteChrome.tsx']

const CONVERTED = [...BROWSE_PAGES, ...CARD_FILES, ...OTHER_CONVERTED, 'components/site/BrowseFrame.tsx']

describe('the page-only frame markers are gone', () => {
  const markers = ['data-reader-frame', 'data-site-frame', 'data-site-footer']
  // The unit tests that pin the absence of the markers name them on purpose, so they are the one place left out.
  const sources = [
    ...filesUnder('app', (name) => isSource(name) && !isTest(name)),
    ...filesUnder('components', (name) => isSource(name) && !isTest(name)),
    ...filesUnder('e2e', isSource),
  ]

  it('scans the app, the components and the E2E specs (the scan itself works)', () => {
    expect(sources.length).toBeGreaterThan(100)
    expect(sources.some((file) => file.startsWith('e2e/'))).toBe(true)
    expect(sources).toContain('app/globals.css')
  })

  it.each(markers)('no source file mentions %s', (marker) => {
    const hits = sources.filter((file) => read(file).includes(marker))
    expect(hits).toEqual([])
  })

  it('the removed layout constants are not imported any more', () => {
    const hits = sources.filter((file) => /\b(?:READER_FRAME|CONTAINER_READER)\b/.test(read(file)))
    expect(hits).toEqual([])
  })
})

describe('BROWSE pages', () => {
  it('lists the 14 pages and each exists', () => {
    expect(BROWSE_PAGES).toHaveLength(14)
    for (const page of BROWSE_PAGES) expect(existsSync(join(ROOT, page)), page).toBe(true)
  })

  it.each(BROWSE_PAGES.map((page) => [page] as const))('%s renders through BrowseFrame', (page) => {
    const source = read(page)
    expect(source).toMatch(/from\s+['"]@\/components\/site\/BrowseFrame['"]/)
    expect(source).toMatch(/<BrowseFrame[\s>]/)
  })

  it('no other page imports BrowseFrame (a page that should be a BROWSE page is listed above)', () => {
    const importing = filesUnder(SITE, (name) => name === 'page.tsx').filter((file) =>
      /from\s+['"]@\/components\/site\/BrowseFrame['"]/.test(read(file)),
    )
    expect(importing.sort()).toEqual([...BROWSE_PAGES].sort())
  })
})

describe('CARD pages', () => {
  it.each(CARD_FILES.map((file) => [file] as const))('%s uses CARD_PAGE', (file) => {
    expect(existsSync(join(ROOT, file)), file).toBe(true)
    const source = read(file)
    expect(source).toMatch(/\bCARD_PAGE\b/)
    expect(source).toMatch(/from\s+['"](?:@\/components\/site|\.)\/reader\/reader-layout['"]/)
  })

  it.each(CARD_FILES.map((file) => [file] as const))('%s keeps the card inside a prose Container', (file) => {
    expect(read(file)).toMatch(/width=["']prose["']/)
  })
})

/** Opening tags `<Container ...>` of a source text, with the attributes (a `>` inside a `{...}` expression does not end the tag). */
function containerTags(source: string): string[] {
  const tags: string[] = []
  const opener = /<Container(?![A-Za-z0-9])/g
  for (let match = opener.exec(source); match !== null; match = opener.exec(source)) {
    let depth = 0
    let index = match.index + match[0].length
    for (; index < source.length; index += 1) {
      const char = source[index]
      if (char === '{') depth += 1
      else if (char === '}') depth -= 1
      else if (char === '>' && depth === 0) break
    }
    tags.push(source.slice(match.index, index + 1))
  }
  return tags
}

describe('the deprecated aliases are not used by a converted page', () => {
  it.each(CONVERTED.map((file) => [file] as const))('%s', (file) => {
    expect(existsSync(join(ROOT, file)), file).toBe(true)
    const source = read(file)
    expect(source, 'width="wide" is the deprecated 1024px width').not.toMatch(/width=["']wide["']|width:\s*['"]wide['"]/)
    expect(source, 'WritingSectionNav is replaced by the sidebar Explore group').not.toMatch(/\bWritingSectionNav\b/)
    expect(source, 'SPLIT_ROW is replaced by cards').not.toMatch(/\bSPLIT_ROW\b/)
    expect(source, 'the `frame` prop of Container is gone').not.toMatch(/<Container\b[^>]*\sframe[\s/>]/)
  })

  // Container still defaults to the deprecated `wide`, so a converted page that forgets `width` would silently stay 1024px.
  it.each(CONVERTED.map((file) => [file] as const))('%s gives every Container an explicit width', (file) => {
    const missing = containerTags(code(file)).filter((tag) => !/\swidth=/.test(tag))
    expect(missing).toEqual([])
  })

  it('the Container tag scanner reads a tag with an arrow function in a prop', () => {
    const tags = containerTags(
      '<Container as="section" onClick={() => go()} width="reader">x</Container><Container>y</Container>',
    )
    expect(tags).toHaveLength(2)
    expect(tags[0]).toContain('width="reader"')
    expect(tags[1]).toBe('<Container>')
  })
})
