import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The scoped placement guard of the site frame (spec 2.7). reader-layout.ts is the one module that knows which side the
 * FRAME's columns are on, so a page or a shell file must take the sidebar track, the page split and the column rule from its
 * constants (BROWSE_*, SPLIT_*, CASE_*) and never spell them. Mirroring the frame is then a one-file edit.
 *
 * What is scanned: every `app/[locale]/(site)/**` `page.tsx` and `layout.tsx`, plus every source file under `components/site/`
 * (tests excluded), the shell files among them. So a new sidebar, rail or hero component that spells `lg:col-start-1` is reported.
 * What is not: the allow-list below. Those files own their own placement (rows, cover side, reply indent, footer columns), are
 * mirrored separately, and a legitimate `col-start-2` or `border-s` in them is not a frame placement. Adding a file to the
 * allow-list needs a one-line reason; a file that is not in it is scanned.
 *
 * Comments are stripped before the scan, so a comment that explains a rule may name the class.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SITE = join(ROOT, 'app', '[locale]', '(site)')
const COMPONENTS = join(ROOT, 'components', 'site')

/** The shell files of the frame, relative to the frontend folder. They are scanned like every file of components/site; the list checks they exist. */
const SHELL_FILES = [
  'components/site/SiteChrome.tsx',
  'components/site/BrowseFrame.tsx',
  'components/site/reader/SiteSidebar.tsx',
  'components/site/reader/rail-parts.tsx',
]

/** Files that are NOT scanned, with the reason. The path is relative to the frontend folder. */
const ALLOW_LIST: ReadonlyArray<readonly [file: string, reason: string]> = [
  ['components/site/ListRow.tsx', 'a post row: the 3:2 cover sits on its own end of the row and the row mirrors by itself'],
  ['components/site/SeriesEntry.tsx', 'a series row: text and cover columns of the row, not of the page'],
  ['components/site/PostNav.tsx', 'previous / next links: each side is placed by the component'],
  ['components/site/comments/CommentSection.tsx', 'the reply indent of a thread is a rule on the comment, not on the page'],
  ['components/site/TocNav.tsx', 'the table of contents draws its own rule on one side of its list'],
  ['components/site/GalleryLightbox.tsx', 'the lightbox places its arrows and counter over the photo'],
  ['components/site/Footer.tsx', 'the footer columns are a grid of their own inside the Container'],
  ['components/site/Container.tsx', 'the deprecated SPLIT_ROW lives here until the last alias is deleted'],
  ['components/site/reader/reader-layout.ts', 'the one module that is allowed to contain frame placement'],
]

/** A forbidden spelling and what to use instead. */
const FORBIDDEN: ReadonlyArray<{ name: string; pattern: RegExp; use: string }> = [
  { name: 'sidebar track 14rem', pattern: /grid-cols-\[14rem_/, use: 'BROWSE_GRID / READER_GRID' },
  { name: 'sidebar track 16.25rem', pattern: /grid-cols-\[16\.25rem_/, use: 'BROWSE_GRID / READER_GRID' },
  {
    name: 'fixed rem track after the fluid one',
    pattern: /minmax\(0,\s*1fr\)_(?:13rem|14\.375rem|18rem|20rem|24rem)\]/,
    use: 'SPLIT_ASIDE / CASE_GRID / ARTICLE_SLOT',
  },
  { name: 'col-start-1', pattern: /(?<![\w-])(?:[a-z]+:)*col-start-1(?![\w-])/, use: 'BROWSE_SIDE / LEFT_SLOT' },
  { name: 'col-start-2', pattern: /(?<![\w-])(?:[a-z]+:)*col-start-2(?![\w-])/, use: 'BROWSE_MAIN / ARTICLE_SLOT' },
  { name: 'row-start-1', pattern: /(?<![\w-])(?:[a-z]+:)*row-start-1(?![\w-])/, use: 'BROWSE_SIDE / BROWSE_MAIN' },
  {
    name: 'border-s / border-e as a column rule',
    pattern: /(?<![\w-])(?:lg|rail|xl):border-[se](?![a-z])/,
    use: 'BROWSE_SIDE / CASE_RAIL / RAIL_SLOT',
  },
]

const toPosix = (path: string) => path.split(sep).join('/')
const rel = (path: string) => toPosix(relative(ROOT, path))

function pagesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return pagesUnder(path)
    return entry.name === 'page.tsx' || entry.name === 'layout.tsx' ? [path] : []
  })
}

/** Every non-test source file under a folder. */
function sourcesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourcesUnder(path)
    return /\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) ? [path] : []
  })
}

/** Block comments (JSX comments too) and whole-line or trailing line comments; a double slash inside a string such as a URL is kept. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')
}

function findForbidden(source: string): string[] {
  const code = stripComments(source)
  return FORBIDDEN.filter(({ pattern }) => pattern.test(code)).map(({ name }) => name)
}

const allowed = new Set(ALLOW_LIST.map(([file]) => file))
const scanned = [...new Set([...pagesUnder(SITE).map(rel), ...sourcesUnder(COMPONENTS).map(rel), ...SHELL_FILES])].filter(
  (file) => !allowed.has(file),
)

describe('frame placement guard (spec 2.7)', () => {
  it('scans the pages, the shell files and every component of components/site (the scan itself works)', () => {
    expect(scanned.filter((file) => file.endsWith('/page.tsx')).length).toBeGreaterThanOrEqual(20)
    expect(scanned).toContain('app/[locale]/(site)/layout.tsx')
    for (const file of SHELL_FILES) {
      expect(existsSync(join(ROOT, file)), `${file} does not exist: update SHELL_FILES`).toBe(true)
      expect(scanned).toContain(file)
    }
    // The allow-list has an effect: every entry would otherwise be scanned, and none of them is scanned now.
    for (const [file] of ALLOW_LIST) {
      expect([...pagesUnder(SITE).map(rel), ...sourcesUnder(COMPONENTS).map(rel), ...SHELL_FILES]).toContain(file)
      expect(scanned).not.toContain(file)
    }
  })

  it('the allow-list names real files, each with a one-line reason, and none of them is a page', () => {
    const files = ALLOW_LIST.map(([file]) => file)
    expect(new Set(files).size).toBe(files.length)
    for (const [file, reason] of ALLOW_LIST) {
      expect(existsSync(join(ROOT, file)), `${file} does not exist: remove it from the allow-list`).toBe(true)
      expect(reason.trim().length, `${file} needs a reason`).toBeGreaterThan(10)
      expect(reason, `${file}: one line`).not.toContain('\n')
      expect(file.startsWith('app/'), `${file}: a page is never allow-listed`).toBe(false)
    }
  })

  it.each(scanned.map((file) => [file] as const))('%s has no frame placement of its own', (file) => {
    const hits = findForbidden(readFileSync(join(ROOT, file), 'utf8'))
    expect(hits, `${file} spells ${hits.join(', ')}: take it from reader-layout.ts`).toEqual([])
  })

  describe('the patterns catch what they are meant to (so a green scan is not vacuous)', () => {
    it.each([
      ['grid-cols-[14rem_minmax(0,1fr)]', 'sidebar track 14rem'],
      ['xl:grid-cols-[16.25rem_minmax(0,1fr)]', 'sidebar track 16.25rem'],
      ['lg:grid-cols-[minmax(0,1fr)_18rem]', 'fixed rem track after the fluid one'],
      ['xl:grid-cols-[minmax(0, 1fr)_24rem]', 'fixed rem track after the fluid one'],
      ['rail:grid-cols-[minmax(0,1fr)_14.375rem]', 'fixed rem track after the fluid one'],
      ['lg:col-start-1', 'col-start-1'],
      ['col-start-2', 'col-start-2'],
      ['lg:row-start-1', 'row-start-1'],
      ['lg:border-e', 'border-s / border-e as a column rule'],
      ['rail:border-s', 'border-s / border-e as a column rule'],
    ])('%s is reported as "%s"', (snippet, name) => {
      expect(findForbidden(`<div className="${snippet}" />`)).toContain(name)
    })

    it.each([
      'lg:col-start-3',
      'col-start-10',
      'lg:row-start-12',
      'border-s-0',
      'lg:border-solid',
      'dark:lg:border-neutral-800',
      'rail:border-neutral-200',
      'grid-cols-[3rem_minmax(0,1fr)_auto]',
      'lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]',
      'sm:border-e',
    ])('%s is not reported', (snippet) => {
      expect(findForbidden(`<div className="${snippet}" />`)).toEqual([])
    })

    it('a comment may name a forbidden class', () => {
      expect(findForbidden('/** was lg:col-start-1 */\n// lg:border-e\n{/* rail:border-s */}\nconst a = 1')).toEqual([])
      expect(findForbidden('const url = "https://example.com"; const c = "lg:col-start-1"')).toEqual(['col-start-1'])
    })
  })
})
