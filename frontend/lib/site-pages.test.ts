import { describe, expect, it } from 'vitest'
import { defaultSiteContent } from '@/content/defaults'
import { navItems } from '@/components/site/nav-items'
import { translatorFor } from '@/test/intl'
import { pageDescription, SITE_PAGE_PATHS, sitePages } from './site-pages'

const tNav = translatorFor('vi', 'Site.nav') as never
const tDesc = translatorFor('vi', 'Site.pageDescriptions') as never
const { site, profile } = defaultSiteContent('vi')
const ctx = { siteName: site.name, galleryLead: profile.galleryLead }

describe('sitePages', () => {
  it('the four nav items first (the labels of navItems itself), then the secondary pages; each page a non-empty description', () => {
    const pages = sitePages(tNav, tDesc, ctx)
    expect(pages.slice(0, navItems.length).map((page) => [page.href, page.title])).toEqual(
      navItems.map((item) => [item.href, (tNav as (key: string) => string)(item.labelKey)]),
    )
    expect(pages.slice(navItems.length).map((page) => page.href)).toEqual([
      '/topics',
      '/archive',
      '/series',
      '/gallery',
      '/newsletter',
    ])
    for (const page of pages) {
      expect(page.description).toBe(pageDescription(page.href, tDesc, ctx))
      expect(page.description.trim()).not.toBe('')
    }
  })

  it('every site page path has a description in both locales', () => {
    for (const locale of ['vi', 'en'] as const) {
      const t = translatorFor(locale, 'Site.pageDescriptions') as never
      for (const path of SITE_PAGE_PATHS) expect(pageDescription(path, t, ctx).trim()).not.toBe('')
    }
  })

  it('the gallery uses the owner lead sentence when there is one, and the site name goes into the other descriptions', () => {
    expect(pageDescription('/gallery', tDesc, { siteName: 'Acme', galleryLead: 'A lead sentence.' })).toBe('A lead sentence.')
    expect(pageDescription('/start-here', tDesc, { siteName: 'Acme', galleryLead: null })).toContain('Acme')
  })
})
