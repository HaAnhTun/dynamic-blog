import { render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Locale } from '@/i18n/config'
import { getGallery } from '@/lib/gallery'
import { getSiteContent } from '@/lib/site-content'
import { pageProps } from '@/test/page-props'
import { msg } from '@/test/render-intl'
import AboutPage, { generateMetadata } from './page'

/** The packaged defaults, with `about` replaced by what each test sets in `state`. */
const state = vi.hoisted(() => ({ about: undefined as Record<string, unknown> | undefined }))

vi.mock('@/lib/site-content', async () => {
  const { defaultSiteContent } = await import('@/content/defaults')
  return {
    SITE_CONTENT_TAG: 'site-content',
    getSiteContent: async (locale: Locale) => {
      const content = defaultSiteContent(locale)
      return { ...content, about: { ...content.about, ...state.about } }
    },
  }
})

vi.mock('@/lib/gallery', () => ({ getGallery: vi.fn() }))

const BODY = [
  '## Working style',
  '',
  'I like small steps.',
  '',
  ':::callout{type=tip title="Note to self"}',
  'Ship early.',
  ':::',
  '',
  '### Tools',
  '',
  '::::metrics',
  '::metric{value="42" label="Posts"}',
  '::metric{value="7" label="Talks"}',
  '::::',
].join('\n')

async function renderAbout() {
  return render(await AboutPage(pageProps()))
}

const { about: defaults } = await getSiteContent('vi')

beforeEach(() => {
  vi.mocked(getGallery).mockResolvedValue({ items: [], meta: { page: 0, size: 6, totalElements: 0, totalPages: 0 } })
})

afterEach(() => {
  state.about = undefined
  vi.mocked(getGallery).mockReset()
})

describe('/about body', () => {
  it('without a body, renders no body band and keeps every section', async () => {
    const { container } = await renderAbout()

    expect(container.querySelector('[data-post-body]')).toBeNull()
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      msg('Site.about.skillsTitle'),
      msg('Site.about.experienceTitle'),
      msg('Site.about.educationTitle'),
      ...defaults.sections.map((s) => s.title),
    ])
    expect(container.querySelectorAll('section[id]')).toHaveLength(defaults.sections.length)
  })

  it('an empty or blank body is the same as no body', async () => {
    state.about = { body: '  \n ' }
    const { container } = await renderAbout()

    expect(container.querySelector('[data-post-body]')).toBeNull()
  })

  it('renders only the body when the content has no sections: hero, body, no empty sections band', async () => {
    state.about = { body: BODY, sections: [] }
    const { container } = await renderAbout()

    expect(container.querySelector('[data-post-body]')).not.toBeNull()
    expect(container.querySelectorAll('section[id]')).toHaveLength(0)
    expect(screen.getByText(defaults.intro)).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: msg('Site.about.readNext') })).toBeInTheDocument()
  })

  it('draws the blocks of the body through the real block components, after the data sections and without the legacy section cards', async () => {
    state.about = { body: BODY }
    const { container } = await renderAbout()

    const body = container.querySelector('[data-post-body]') as HTMLElement
    expect(body).toHaveClass('prose')
    // The band already pads the body: no extra 32px above it on a phone (the margin of a post body is back from sm).
    expect(body).toHaveClass('mt-0', 'sm:mt-8')
    expect(body).not.toHaveClass('mt-8')
    expect(within(body).getByRole('note')).toHaveTextContent('Ship early.')
    expect(body.querySelector('[data-block="callout"]')).not.toBeNull()
    expect(within(body).getByText('Posts')).toBeInTheDocument()
    expect(within(body).getByText('42')).toBeInTheDocument()

    // The legacy section cards are only for a page that has no body: the body replaces them.
    expect(container.querySelectorAll('section[id]')).toHaveLength(0)
    for (const section of defaults.sections)
      expect(screen.queryByRole('heading', { name: section.title })).not.toBeInTheDocument()
    const education = screen.getByRole('heading', { name: msg('Site.about.educationTitle') })
    expect(education.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('has no "On this page" table of contents any more, and the body headings keep the anchors they had', async () => {
    state.about = { body: BODY }
    await renderAbout()

    expect(screen.queryByRole('navigation', { name: msg('Site.about.onThisPage') })).not.toBeInTheDocument()
    for (const name of ['Working style', 'Tools']) {
      expect(screen.getByRole('heading', { name }).id).not.toBe('')
    }
  })

  it('demotes a level-1 heading of the body, so the page keeps exactly one h1', async () => {
    state.about = { body: '# A top heading\n\nText.\n\n## Next' }
    await renderAbout()

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 2, name: 'A top heading' })).toBeInTheDocument()
  })

  it('keeps an invalid block as plain content and sanitizes unsafe HTML', async () => {
    state.about = {
      body: [
        ':::callot',
        'A typo kept as text.',
        ':::',
        '',
        '<script>window.__about_pwned = 1</script>',
        '',
        '<img src="x" onerror="window.__about_pwned = 1">',
        '',
        '[bad](javascript:alert(1))',
      ].join('\n'),
    }
    const { container } = await renderAbout()

    const body = container.querySelector('[data-post-body]') as HTMLElement
    expect(body).toHaveTextContent('A typo kept as text.')
    expect(body.textContent).not.toContain(':::')
    expect(body.querySelector('script')).toBeNull()
    expect(body.querySelector('[onerror]')).toBeNull()
    expect(body.innerHTML).not.toContain('javascript:')
  })

  it('omits an empty intro paragraph and the empty contents list when nothing is left to list', async () => {
    state.about = { intro: '', body: 'Only prose.', sections: [] }
    await renderAbout()

    expect(screen.queryByRole('navigation', { name: msg('Site.about.onThisPage') })).toBeNull()
    expect(screen.getByText('Only prose.')).toBeInTheDocument()
  })
})

describe('/about metadata with a body', () => {
  it('uses the intro as the description', async () => {
    state.about = { body: 'Body sentence. More.' }

    expect((await generateMetadata(pageProps())).description).toBe(defaults.intro)
  })

  it('falls back to the first plain sentence of the body when the intro is empty', async () => {
    state.about = { intro: '', body: '## Heading\n\nI build **small** tools. And more.' }

    expect((await generateMetadata(pageProps())).description).toBe('I build small tools.')
  })
})
