import { render, screen, within } from '@testing-library/react'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { routeDir } from '@/test/routes'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getGallery } from '@/lib/gallery'
import { mediaPath } from '@/lib/media'
import type { GalleryPhoto, Page } from '@/lib/types'
import GalleryPage, { generateMetadata } from './page'
import { msg } from '@/test/render-intl'

// The sidebar frame is tested once (BrowseFrame.test.tsx); here a stand-in records what the page asked for.
vi.mock('@/components/site/BrowseFrame', () => import('@/test/browse-frame-mock'))

/**
 * /gallery "Photos": h1, optional lead sentence (`profile.galleryLead` of the site content), "{n} photos", 3-column grid,
 * 24 photos per page with the same `?page` rule as /writing.
 *
 * Same approach as writing/page.test.tsx: call the async page function directly and render the tree it returns;
 * `notFound()` is the real one, recognized by its `digest`.
 *
 * Photos are the main content of this page, so an API failure is NOT swallowed: "No photos yet." while the
 * backend is down would be a green page that is wrong.
 */
vi.mock('@/lib/gallery', () => ({ getGallery: vi.fn() }))

/** The packaged defaults, with `profile.galleryLead` set by each test: null when the owner has not filled it in. */
const lead = vi.hoisted(() => ({ value: null as string | null }))
vi.mock('@/lib/site-content', async () => {
  const { defaultSiteContent } = await import('@/content/defaults')
  const getSiteContent = async (locale: import('@/i18n/config').Locale) => {
    const content = defaultSiteContent(locale)
    return { ...content, profile: { ...content.profile, galleryLead: lead.value } }
  }
  return { SITE_CONTENT_TAG: 'site-content', getSiteContent }
})

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const photo = (n: number): GalleryPhoto => ({
  id: uuid(1000 + n),
  image: {
    id: uuid(n),
    fileName: `${uuid(n)}.jpg`,
    width: 1600,
    height: 1200,
    altText: `Photo description ${n}`,
    dominantColor: '#2f4858',
  },
  caption: null,
  takenOn: null,
})

/** Returns page `page` of a gallery with `total` photos, 24 per page, like the backend. */
function stubGallery(total: number) {
  vi.mocked(getGallery).mockImplementation(async ({ page, size }): Promise<Page<GalleryPhoto>> => {
    const all = Array.from({ length: total }, (_, i) => photo(i + 1))
    return {
      items: all.slice(page * size, (page + 1) * size),
      meta: { page, size, totalElements: total, totalPages: Math.ceil(total / size) },
    }
  })
}

function props(searchParams: Record<string, string | string[] | undefined> = {}): PageProps<'/[locale]/gallery'> {
  return { params: Promise.resolve({ locale: 'vi' }), searchParams: Promise.resolve(searchParams) }
}

async function expectNotFound(pageProps: PageProps<'/[locale]/gallery'>, why: string) {
  const thrown = await GalleryPage(pageProps).then(
    () => null,
    (error: unknown) => error,
  )
  expect(thrown, `${why}: the page rendered instead of calling notFound()`).not.toBeNull()
  expect((thrown as { digest?: string }).digest, why).toBe('NEXT_HTTP_ERROR_FALLBACK;404')
}

afterEach(() => {
  vi.mocked(getGallery).mockReset()
  lead.value = null
})

describe('/gallery', () => {
  it('h1 "Photos", "{n} photos" counts the whole gallery, the grid has all photos of the page, plus a photo viewer', async () => {
    stubGallery(30)

    const { container } = render(await GalleryPage(props()))

    expect(container.querySelectorAll('h1')).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(msg('Site.footer.links.gallery'))
    // The total of the whole gallery, not the number of photos on this page.
    expect(screen.getByText(msg('Admin.gallery.manager.tally', { count: '30' }))).toBeInTheDocument()

    const tiles = within(container.querySelector('ul')!).getAllByRole('link')
    expect(tiles).toHaveLength(24)
    expect(tiles[0]).toHaveAttribute('href', mediaPath(photo(1).image))
    expect(container.querySelectorAll('dialog')).toHaveLength(1)
    // app/layout.tsx holds the single <main> of the document.
    expect(container.querySelector('main')).toBeNull()
  })

  it('sits in the frame with no current Explore row, and the grid is the justified layout with its sizes hints', async () => {
    stubGallery(30)

    const { container } = render(await GalleryPage(props()))

    const frame = screen.getByTestId('browse-frame')
    expect(frame).not.toHaveAttribute('data-current')
    expect(frame).toContainElement(screen.getByRole('heading', { level: 1 }))
    const grid = container.querySelector('ul')!
    expect(frame).toContainElement(grid)
    // The justified layout: wrapping flex rows of equal height, each photo keeping its own ratio (no fixed column count).
    expect(grid.className).toContain('flex-wrap')
    expect(grid.className).not.toContain('grid-cols-')
    // The justified `sizes` follow the basis width of the cell: the lg row height first, then sm, then the phone clause.
    const sizes = container.querySelector('img')?.getAttribute('sizes') ?? ''
    expect(sizes.indexOf('(min-width: 1024px)')).toBeGreaterThanOrEqual(0)
    expect(sizes.indexOf('(min-width: 1024px)')).toBeLessThan(sizes.indexOf('(min-width: 640px)'))
  })

  it('first row of the grid loads eagerly, the first cell has high priority (the LCP element); the rest is lazy', async () => {
    // Lighthouse measured /gallery at 92 with `lcp-lazy-loaded`: the first cell is on the first screen yet
    // lazy. The later pages too: the grid is the first content of every /gallery page.
    for (const page of [undefined, '1']) {
      stubGallery(30)
      const { container, unmount } = render(await GalleryPage(props(page ? { page } : {})))

      const imgs = Array.from(container.querySelectorAll('ul img'))
      expect(
        imgs.slice(0, 3).map((img) => img.getAttribute('loading')),
        `page ${page}`,
      ).toEqual(['eager', 'eager', 'eager'])
      expect(imgs[0], `page ${page}`).toHaveAttribute('fetchpriority', 'high')
      expect(
        imgs.slice(3).every((img) => img.getAttribute('loading') === 'lazy'),
        `page ${page}`,
      ).toBe(true)
      expect(
        imgs.slice(1).some((img) => img.hasAttribute('fetchpriority')),
        `page ${page}`,
      ).toBe(false)
      unmount()
    }
  })

  it('asks for exactly the 24 photos of the page being viewed', async () => {
    stubGallery(30)

    await GalleryPage(props({ page: '1' }))

    expect(getGallery).toHaveBeenCalledTimes(1)
    expect(getGallery).toHaveBeenCalledWith({ page: 1, size: 24 })
  })

  it('page 2 shows the remainder and has a pagination bar pointing back to /gallery', async () => {
    stubGallery(30)

    const { container } = render(await GalleryPage(props({ page: '1' })))

    const tiles = within(container.querySelector('ul')!).getAllByRole('link')
    expect(tiles).toHaveLength(6)
    expect(tiles[0]).toHaveAttribute('href', mediaPath(photo(25).image))
    const pager = screen.getByRole('navigation', { name: msg('Site.pagination.label') })
    expect(within(pager).getByRole('link', { name: msg('Site.pagination.previous') })).toHaveAttribute('href', '/gallery?page=0')
  })

  it('no lead sentence when galleryLead is null; there is one when the site owner fills it in', async () => {
    stubGallery(3)

    const { container, unmount } = render(await GalleryPage(props()))
    const header = container.querySelector('h1')!.parentElement!
    // Only the h1 and the photo count line: no invented lead sentence stands in.
    expect(Array.from(header.querySelectorAll('p')).map((p) => p.textContent)).toEqual([
      msg('Admin.gallery.manager.tally', { count: '3' }),
    ])
    unmount()

    lead.value = 'What I see on my way to work.'
    render(await GalleryPage(props()))
    expect(screen.getByText('What I see on my way to work.')).toBeInTheDocument()
  })

  it('empty gallery: the page is still 200 with "No photos yet.", no count, no grid, no dialog', async () => {
    stubGallery(0)

    const { container } = render(await GalleryPage(props()))

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(msg('Site.footer.links.gallery'))
    expect(screen.getByText(msg('Site.gallery.empty'))).toBeInTheDocument()
    expect(screen.queryByText(new RegExp(`^${msg('Admin.gallery.manager.tally', { count: '\\d+' })}$`))).not.toBeInTheDocument()
    expect(container.querySelector('ul')).toBeNull()
    expect(container.querySelector('dialog')).toBeNull()
    expect(screen.queryByRole('navigation', { name: msg('Site.pagination.label') })).not.toBeInTheDocument()
  })

  it('?page out of range is 404, even ?page=1 of an empty gallery', async () => {
    stubGallery(30)
    await expectNotFound(props({ page: '2' }), '?page=2 when there are only 2 pages')

    stubGallery(24)
    await expectNotFound(props({ page: '1' }), '?page=1 when 24 photos fit one page')

    stubGallery(0)
    await expectNotFound(props({ page: '1' }), '?page=1 when there are no photos')
  })

  it('an absurdly large ?page is 404 without asking the API', async () => {
    stubGallery(30)

    await expectNotFound(props({ page: '9999999999999999999999' }), 'a 22 digit string')
    await expectNotFound(props({ page: '10001' }), 'beyond MAX_PAGE')
    expect(getGallery).not.toHaveBeenCalled()
  })

  it('?page that is not a run of digits is the first page, like /writing', async () => {
    stubGallery(30)

    for (const page of ['abc', '1.5', '0x1', '-1', '']) {
      await GalleryPage(props({ page }))
    }
    await GalleryPage(props({ page: ['1', '0'] }))

    const pages = vi.mocked(getGallery).mock.calls.map(([args]) => args.page)
    expect(pages).toEqual([0, 0, 0, 0, 0, 1])
  })

  it('API failure throws (500), it does not pretend to be an empty gallery', async () => {
    vi.mocked(getGallery).mockRejectedValue(new Error('fetch failed'))

    await expect(GalleryPage(props())).rejects.toThrow('fetch failed')
  })

  it('there is no loading.tsx: a streamed shell turns the notFound() of ?page into HTTP 200', () => {
    const dir = routeDir(join(process.cwd(), 'app'), '/gallery')
    expect(dir, 'no page serves /gallery').toBeDefined()

    for (const file of ['loading.tsx', 'loading.ts', 'loading.jsx', 'loading.js']) {
      expect(existsSync(join(dir as string, file)), `/gallery/${file} must not exist`).toBe(false)
    }
  })
})

describe('/gallery metadata', () => {
  it('title "Photos", canonical keeps the page number', async () => {
    const first = await generateMetadata(props())
    expect(first.title).toBe(msg('Site.footer.links.gallery'))
    expect(first.alternates?.canonical).toBe('/gallery')
    expect(first.openGraph?.url).toBe('/gallery')

    const second = await generateMetadata(props({ page: '1' }))
    expect(second.alternates?.canonical).toBe('/gallery?page=1')
  })

  it('description is the lead sentence when the site owner fills it in, otherwise a sentence that invents nothing', async () => {
    const plain = await generateMetadata(props())
    expect(typeof plain.description).toBe('string')
    expect(plain.description).toContain(msg('Site.footer.links.gallery'))

    lead.value = 'What I see on my way to work.'
    expect((await generateMetadata(props())).description).toBe('What I see on my way to work.')
  })

  it('does not call the API: metadata does not depend on the gallery', async () => {
    await generateMetadata(props({ page: '3' }))

    expect(getGallery).not.toHaveBeenCalled()
  })
})
