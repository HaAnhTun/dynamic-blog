import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_LOCALE } from '@/i18n/config'
import { rootMetadata } from '@/lib/root-metadata'
import { generateMetadata } from './layout'

// The shell loads next/font, which only exists inside the Next build.
vi.mock('@/components/RootShell', () => ({ RootShell: () => null }))

function props(locale: string) {
  return { params: Promise.resolve({ locale }), children: null } as unknown as Parameters<typeof generateMetadata>[0]
}

describe('the locale layout metadata', () => {
  it('inherits the site metadata and only changes og:locale for the locale of the URL', async () => {
    const english = await generateMetadata(props('en'))
    const root = await rootMetadata('en')

    expect(english.metadataBase).toEqual(root.metadataBase)
    expect(english.title).toEqual(root.title)
    expect(english.description).toBe(root.description)
    expect(english.openGraph).toMatchObject({ locale: 'en_US', siteName: root.openGraph?.siteName })
    expect((await generateMetadata(props('vi'))).openGraph).toMatchObject({ locale: 'vi_VN' })
  })

  it('answers the default locale metadata for a locale the site does not have', async () => {
    expect(await generateMetadata(props('fr'))).toEqual(await rootMetadata(DEFAULT_LOCALE))
  })
})
