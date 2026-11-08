import { describe, expect, it, vi } from 'vitest'
import type { Locale } from '@/i18n/config'
import { pageProps } from '@/test/page-props'
import { generateMetadata } from './page'

/** The packaged defaults with an empty site tagline and an empty positioning. */
vi.mock('@/lib/site-content', async () => {
  const { defaultSiteContent } = await import('@/content/defaults')
  const getSiteContent = async (locale: Locale) => {
    const content = defaultSiteContent(locale)
    return { ...content, site: { ...content.site, tagline: '', positioning: '' } }
  }
  return { SITE_CONTENT_TAG: 'site-content', getSiteContent }
})

describe('Home metadata without a tagline', () => {
  it('titles the page with the site name alone, and declares no description', async () => {
    const { defaultSiteContent } = await import('@/content/defaults')
    const metadata = await generateMetadata(pageProps())

    expect(metadata.title).toEqual({ absolute: defaultSiteContent('vi').site.name })
    expect(metadata.description ?? null).toBeNull()
  })
})
