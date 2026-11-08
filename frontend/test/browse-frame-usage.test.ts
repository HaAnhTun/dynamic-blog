import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A BROWSE page renders the real `BrowseFrame`, whose sidebar is in the DOM twice under jsdom (the phone copy and the desktop
 * copy), so the page's own test must mock the frame through the one shared helper `test/browse-frame-mock.tsx`. This guard
 * fails the moment a page starts using `BrowseFrame` and its neighbouring `page.test.tsx` does not reference the helper. It
 * passes vacuously while no page has been converted.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SITE = join(ROOT, 'app', '[locale]', '(site)')

function pagesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return pagesUnder(path)
    return entry.name === 'page.tsx' ? [path] : []
  })
}

const rel = (path: string) => relative(ROOT, path).split(sep).join('/')

const importsBrowseFrame = (source: string) => /from\s+['"]@\/components\/site\/BrowseFrame['"]/.test(source)

describe('BrowseFrame usage', () => {
  const browsePages = pagesUnder(SITE).filter((page) => importsBrowseFrame(readFileSync(page, 'utf8')))

  it('finds the pages of the site (the scan itself works)', () => {
    expect(pagesUnder(SITE).length).toBeGreaterThan(5)
  })

  it.each(browsePages.map((page) => [rel(page), page] as const))(
    '%s: its page.test.tsx mocks the frame with the shared helper',
    (_name, page) => {
      const testFile = join(dirname(page), 'page.test.tsx')
      expect(existsSync(testFile), `${rel(testFile)} is missing`).toBe(true)
      const source = readFileSync(testFile, 'utf8')
      expect(source).toContain('browse-frame-mock')
      expect(source).toMatch(/vi\.mock\(\s*['"]@\/components\/site\/BrowseFrame['"]/)
    },
  )

  it('the shell files of the frame exist', () => {
    for (const file of [
      'components/site/SiteChrome.tsx',
      'components/site/BrowseFrame.tsx',
      'components/site/reader/SiteSidebar.tsx',
      'components/site/reader/rail-parts.tsx',
    ]) {
      expect(existsSync(join(ROOT, file)), file).toBe(true)
    }
  })
})
