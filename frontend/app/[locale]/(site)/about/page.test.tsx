import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { githubLabel, githubUrl } from '@/components/site/ContactSection'
import type { Locale } from '@/i18n/config'
import { getSiteContent } from '@/lib/site-content'
import type { SkillGroup, TimelineEntry } from '@/lib/site-content-types'
import { getGallery } from '@/lib/gallery'
import { mediaPath } from '@/lib/media'
import type { GalleryPhoto } from '@/lib/types'
import { MEASURE_CARD, MEASURE_LEAD } from '@/components/site/reader/reader-layout'
import AboutPage, { dynamic, generateMetadata } from './page'
import { pageProps } from '@/test/page-props'
import { msg } from '@/test/render-intl'

/** What a test changes in the site content; reset after each test. */
const state = vi.hoisted(() => ({
  avatar: null as string | null,
  social: [] as { label: string; url: string }[],
  skills: undefined as SkillGroup[] | undefined,
  entries: undefined as TimelineEntry[] | undefined,
  about: {} as Record<string, unknown>,
}))

/** The packaged defaults, with the two contact channels filled in: the packaged contact has none. */
vi.mock('@/lib/site-content', async () => {
  const { defaultSiteContent } = await import('@/content/defaults')
  const filled = async (locale: Locale) => {
    const content = defaultSiteContent(locale)
    return {
      ...content,
      profile: { ...content.profile, avatar: state.avatar },
      about: { ...content.about, ...state.about },
      skills: state.skills ?? content.skills,
      timeline: { ...content.timeline, entries: state.entries ?? content.timeline.entries },
      contact: {
        ...content.contact,
        email: 'reader@example.test',
        github: 'https://github.com/example-user',
        social: state.social,
      },
    }
  }
  return { SITE_CONTENT_TAG: 'site-content', getSiteContent: filled }
})

const { site, about, profile, contact, skills, timeline } = await getSiteContent('vi')
const experienceEntries = timeline.entries.filter((entry) => entry.kind === 'experience')
const educationEntries = timeline.entries.filter((entry) => entry.kind === 'education')

/** The h2 outline of the packaged content: the three data sections, then the legacy section cards (there is no body). */
const OUTLINE = [
  msg('Site.about.skillsTitle'),
  msg('Site.about.experienceTitle'),
  msg('Site.about.educationTitle'),
  ...about.sections.map((section) => section.title),
]

const metadata = await generateMetadata(pageProps())

/**
 * This used to be a synchronous server component built from the site content alone. It is
 * async now because of the "Photos" section: the gallery's first six photos, the same
 * component as on the homepage. An API failure or an empty gallery means no such section and
 * the rest of the page exactly as before — the tests below run with an empty gallery unless
 * they say otherwise, which is what pins that.
 *
 * `AboutPage` returns a promise, so the tests call it and render the tree it returns, as the
 * homepage tests do.
 */
vi.mock('@/lib/gallery', () => ({ getGallery: vi.fn() }))

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const photo = (n: number): GalleryPhoto => ({
  id: uuid(100 + n),
  image: {
    id: uuid(n),
    fileName: `${uuid(n)}.jpg`,
    width: 1600,
    height: 1200,
    altText: `Photo description ${n}`,
    dominantColor: null,
  },
  caption: null,
  takenOn: null,
})

const SIX_PHOTOS = [1, 2, 3, 4, 5, 6].map(photo)

function stubGallery(photos: GalleryPhoto[]) {
  vi.mocked(getGallery).mockImplementation(async ({ page, size }) => ({
    items: photos.slice(0, size),
    meta: { page, size, totalElements: photos.length, totalPages: photos.length > 0 ? 1 : 0 },
  }))
}

async function renderAbout() {
  return render(await AboutPage(pageProps()))
}

beforeEach(() => {
  stubGallery([])
})

afterEach(() => {
  vi.mocked(getGallery).mockReset()
  state.avatar = null
  state.social = []
  state.skills = undefined
  state.entries = undefined
  state.about = {}
})

describe('/about', () => {
  it('has exactly one h1', async () => {
    await renderAbout()

    const h1s = screen.getAllByRole('heading', { level: 1 })
    expect(h1s).toHaveLength(1)
    expect(h1s[0]).toHaveTextContent(msg('Site.footer.links.about'))
  })

  it('opens with about.intro', async () => {
    await renderAbout()

    expect(screen.getByText(about.intro)).toBeInTheDocument()
  })

  it('renders skills, experience and education, then the five legacy sections in the content file order', async () => {
    await renderAbout()

    // Order is the content file's decision, so this compares against the data rather
    // than a hardcoded list — but the brief names the order explicitly, so the ids are
    // pinned separately below. Both assertions are needed: this one catches a page that
    // sorts or filters the sections, the next catches the data drifting from the brief.
    const h2s = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    expect(h2s).toEqual(OUTLINE)
  })

  it('covers who, stack, building, learning and writing, in that order', () => {
    expect(about.sections.map((section) => section.id)).toEqual(['who', 'stack', 'building', 'learning', 'writing'])
  })

  it('descends h1 → h2 → h3 with no skipped level (the timeline and education cards are h3)', async () => {
    stubGallery(SIX_PHOTOS)
    await renderAbout()

    const levels = screen.getAllByRole('heading').map((h) => Number(h.tagName.slice(1)))
    expect(levels[0]).toBe(1)
    expect(levels[1]).toBe(2)
    expect(new Set(levels.slice(1))).toEqual(new Set([2, 3]))
    levels.slice(1).forEach((level, index) => {
      expect(level - (levels[index] ?? 0)).toBeLessThanOrEqual(1)
    })
  })

  it('renders every body element as its own <p>', async () => {
    const { container } = await renderAbout()

    for (const section of about.sections) {
      const wrapper = container.querySelector(`section#${section.id} div.prose`)
      const paragraphs = [...(wrapper?.querySelectorAll(':scope > p') ?? [])]

      // `section.body` is an array of finished paragraphs. Joining them renders the same
      // words — so every text assertion still passes — and turns two paragraphs into one
      // slab. Two of the five sections have two elements, which is what makes this real.
      expect(paragraphs.map((p) => p.textContent)).toEqual([...section.body])
    }

    expect(about.sections.filter((section) => section.body.length > 1).length).toBeGreaterThan(0)
  })

  it('gives each section the content file id, so /about#stack is a stable deep link', async () => {
    const { container } = await renderAbout()

    for (const section of about.sections) {
      expect(container.querySelector(`section#${section.id}`)).not.toBeNull()
    }
  })

  it('links out to /case-studies and /writing, and no longer to the removed portfolio route', async () => {
    await renderAbout()

    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'))
    expect(hrefs).toContain('/writing')
    // This page is deliberately short (the brief forbids turning it into a CV), so the case study lives on its own route
    // and /about links to it. Without this link the site's only project evidence would
    // be reachable from the nav bar alone.
    expect(hrefs).toContain('/case-studies')
    // /projects has no route file any more, so a link to it would 404 from the one page
    // whose whole job is pointing at the rest of the site.
    expect(hrefs).not.toContain('/projects')
  })

  it('names its nav so it is distinguishable from the site navigation', async () => {
    await renderAbout()

    // Two unnamed <nav>s are indistinguishable in a landmark list, and the site header
    // already contributes "Main navigation".
    expect(screen.getByRole('navigation', { name: msg('Site.about.readNext') })).toBeInTheDocument()
  })

  it('"Read next" offers four paths: "Best posts", "Case studies", "Posts", "Photos", in that order', async () => {
    await renderAbout()

    const nav = screen.getByRole('navigation', { name: msg('Site.about.readNext') })
    const links = within(nav).getAllByRole('link')
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      [`${msg('Site.about.readNextLinks.startHere')} →`, '/start-here'],
      ['Case study →', '/case-studies'],
      [`${msg('Site.about.readNextLinks.writing')} →`, '/writing'],
      [msg('Site.gallery.photoName', { number: '→' }), '/gallery'],
    ])
  })

  it('"Read next" is a two-column grid of 44px rows on a phone and the wrapping row of before from sm', async () => {
    await renderAbout()

    const nav = screen.getByRole('navigation', { name: msg('Site.about.readNext') })
    expect(nav).toHaveClass('grid', 'grid-cols-2', 'sm:flex', 'sm:flex-wrap')
    for (const link of within(nav).getAllByRole('link')) expect(link).toHaveClass('py-3', 'sm:py-0')
  })

  it('the arrow "→" of "Read next" is for the eyes only: the link accessible name is the label, like every other "… →" link on the site', async () => {
    await renderAbout()

    const nav = screen.getByRole('navigation', { name: msg('Site.about.readNext') })
    // Yes: the accessible name equals the label, read out without "right arrow".
    for (const name of [
      msg('Site.footer.links.startHere'),
      'Case study',
      msg('Site.about.readNextLinks.writing'),
      msg('Site.footer.links.gallery'),
    ]) {
      expect(within(nav).getByRole('link', { name })).toBeInTheDocument()
    }
    // No: no link carries "→" in its name, even though the visible text still has it (test just above).
    for (const link of within(nav).getAllByRole('link')) {
      expect(link).not.toHaveAccessibleName(/→/)
    }
  })

  describe('skills', () => {
    // The old test here asserted that no level label and no skill name appeared on this page, to keep the home page skills block
    // from being pasted back. The owner now wants the skills on this page, as tabs of tiles, so it is replaced by these.
    it('has a Skills h2 and one underline tab per group, the first selected, in the group order', async () => {
      await renderAbout()

      expect(screen.getByRole('heading', { level: 2, name: msg('Site.about.skillsTitle') })).toBeInTheDocument()
      const tablist = screen.getByRole('tablist', { name: msg('Site.about.skillsTitle') })
      const tabs = within(tablist).getAllByRole('tab')
      expect(tabs.map((tab) => tab.textContent)).toEqual(skills.map((group) => group.title))
      expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(tabs.map((_, index) => String(index === 0)))
    })

    it('shows the items of the selected group as bordered tiles with the name, and the note as a muted second line', async () => {
      await renderAbout()

      const panel = screen.getByRole('tabpanel')
      const tiles = within(panel).getAllByRole('listitem')
      expect(tiles.map((tile) => tile.firstElementChild?.textContent)).toEqual(skills[0]!.items.map((item) => item.name))
      // The hairline is from sm: on a phone the tile is a tint, so the frame, the panel and the tab row are not joined by a fourth box.
      for (const tile of tiles)
        expect(tile).toHaveClass('rounded-lg', 'border', 'bg-neutral-50', 'sm:border-neutral-200', 'sm:bg-transparent')

      // The group with a note: its tile has two lines, the second one muted.
      const noted = skills.findIndex((group) => group.items.some((item) => item.note))
      expect(noted).toBeGreaterThanOrEqual(0)
      const note = skills[noted]!.items.find((item) => item.note)!
      fireEvent.click(screen.getAllByRole('tab')[noted]!)
      const tile = screen.getByText(note.note!).closest('li')!
      expect(tile.firstElementChild).toHaveTextContent(note.name)
      expect(screen.getByText(note.note!)).toHaveClass('sm:text-xs')
      expect(screen.getByText(note.note!)).toHaveClass('text-neutral-600')
    })

    it('arrow keys, Home and End move between the tabs and show the matching panel', async () => {
      await renderAbout()

      const tabs = screen.getAllByRole('tab')
      const last = tabs.length - 1
      expect(last).toBeGreaterThan(1)

      fireEvent.keyDown(tabs[0]!, { key: 'ArrowRight' })
      expect(tabs[1]).toHaveAttribute('aria-selected', 'true')
      expect(tabs[1]).toHaveFocus()
      expect(screen.getByRole('tabpanel')).toHaveTextContent(skills[1]!.items[0]!.name)

      fireEvent.keyDown(tabs[1]!, { key: 'End' })
      expect(tabs[last]).toHaveAttribute('aria-selected', 'true')
      expect(tabs[last]).toHaveFocus()

      fireEvent.keyDown(tabs[last]!, { key: 'ArrowRight' })
      expect(tabs[0]).toHaveAttribute('aria-selected', 'true')

      fireEvent.keyDown(tabs[0]!, { key: 'ArrowLeft' })
      expect(tabs[last]).toHaveAttribute('aria-selected', 'true')

      fireEvent.keyDown(tabs[last]!, { key: 'Home' })
      expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
      expect(tabs[0]).toHaveFocus()
    })

    it('a group with no items has no tab, and no groups at all means no Skills section', async () => {
      state.skills = [
        { id: 'empty', title: 'Empty group', defaultLevel: 'learning', items: [] },
        { id: 'one', title: 'Only group', defaultLevel: 'learning', items: [{ name: 'Rust' }] },
      ]
      const { unmount } = await renderAbout()
      expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Only group'])
      unmount()

      state.skills = []
      await renderAbout()
      expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
      expect(screen.queryByRole('heading', { name: msg('Site.about.skillsTitle') })).not.toBeInTheDocument()
    })
  })

  it('has no link into the home page skills list: the home page carries no skills section any more', async () => {
    const { container } = await renderAbout()

    expect(container.querySelector('a[href="/#ky-nang"]')).toBeNull()
    expect(container.querySelector('a[href$="#ky-nang"]')).toBeNull()
  })

  it('stays short — this page is not the CV, with or without photos', async () => {
    // A number, so that "concise" is checkable rather than a matter of taste. The eight
    // body paragraphs across five sections, the intro and the summary of each timeline and education
    // card (now on this page on purpose) are the whole page today; the threshold leaves room for one
    // more paragraph per section before it complains.
    //
    // Measured with photos too: the "Photos" band adds no <p> (the "See all photos" link sits in its heading row),
    // and no photo captions leak onto the page.
    const without = await renderAbout()
    const base = without.container.querySelectorAll('p').length
    expect(base).toBeLessThanOrEqual(16)
    without.unmount()

    stubGallery(SIX_PHOTOS)
    const withPhotos = await renderAbout()
    const count = withPhotos.container.querySelectorAll('p').length
    expect(count).toBeLessThanOrEqual(16)
    expect(count).toBe(base)
  })

  it('is a stack of frame-width bands, and every text block keeps a readable line length', async () => {
    const { container } = await renderAbout()

    // Every band is a `reader` Container (the 1400px frame width, the same gutter as the header), none is the old 5xl one. But
    // text across the 1350px band would run 150+ characters per line, a defect invisible in screenshots without a ruler:
    // every text block keeps a rem measure cap (MEASURE_LEAD, MEASURE_CARD).
    expect(container.querySelector('.max-w-5xl')).toBeNull()
    const bands = Array.from(container.children).filter((el) => el.className.includes('max-w-[87.5rem]'))
    expect(bands.length).toBeGreaterThanOrEqual(3)
    for (const band of bands) {
      expect(band).toHaveClass('px-4', 'sm:px-6', 'py-8', 'sm:py-14')
    }
    expect(container.querySelector('h1 + p')?.className).toContain(MEASURE_LEAD)
    expect(container.querySelector('.max-w-prose')).toBeNull()
    for (const block of container.querySelectorAll('section div.prose')) {
      expect(block.className).toContain(MEASURE_CARD)
      expect(block.className).not.toContain('max-w-none')
    }
  })

  describe('hero', () => {
    it('two columns: the person on the left, the h1 and the intro on the right, in DOM order, with no card border or aside', async () => {
      const { container } = await renderAbout()

      const grid = container.querySelector('h1')!.parentElement!.parentElement!
      expect(grid).toHaveClass('grid', 'lg:grid-cols-[13rem_minmax(0,1fr)]')
      const [left, right] = Array.from(grid.children)
      expect(within(left as HTMLElement).getByText(profile.name)).toBeInTheDocument()
      expect(right!.querySelector('h1')).toHaveTextContent(msg('Site.footer.links.about'))
      expect(right!.querySelector('h1 + p')).toHaveTextContent(about.intro)
      // No card around the left column, and no aside or table of contents any more.
      expect(left!.className).not.toMatch(/border|rounded|bg-/)
      expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
      expect(screen.queryByRole('navigation', { name: msg('Site.about.onThisPage') })).not.toBeInTheDocument()
    })

    it('left column: name, role and location as text, no heading, and no photo when profile.avatar is null', async () => {
      const { container } = await renderAbout()
      const left = container.querySelector('h1')!.parentElement!.previousElementSibling as HTMLElement

      expect(within(left).getByText(profile.name)).toBeInTheDocument()
      expect(within(left).getByText(profile.role)).toBeInTheDocument()
      expect(within(left).getByText(profile.location)).toBeInTheDocument()
      expect(within(left).queryByRole('heading')).toBeNull()
      // No avatar: no photo, and no initial letter in its place, so the column starts with the name.
      expect(left.querySelector('img')).toBeNull()
      expect(left.firstElementChild).toHaveTextContent(profile.name)
    })

    it('with profile.avatar: a circular photo (80 px beside the name on a phone, 176 px above it from lg), object-cover', async () => {
      state.avatar = '/media/00000000-0000-4000-8000-000000000001.jpg'
      const { container } = await renderAbout()
      const left = container.querySelector('h1')!.parentElement!.previousElementSibling as HTMLElement

      const image = left.querySelector('img')!
      expect(image).toHaveAttribute('src', state.avatar)
      expect(image).toHaveAttribute('width', '176')
      expect(image).toHaveAttribute('height', '176')
      expect(image).toHaveClass('rounded-full', 'object-cover', 'h-20', 'w-20', 'lg:h-44', 'lg:w-44')
      // The photo and the three lines of text are one row below lg (a block from lg).
      expect(left.firstElementChild).toHaveClass('flex', 'items-center', 'lg:block')
      expect(left.firstElementChild!.firstElementChild).toBe(image)
      expect(image.compareDocumentPosition(screen.getByText(profile.name)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it('with about.photo and a profile.avatar: the about photo is shown, not the avatar', async () => {
      state.avatar = '/media/00000000-0000-4000-8000-000000000001.jpg'
      state.about = { photo: '/media/00000000-0000-4000-8000-000000000002.png' }
      const { container } = await renderAbout()
      const left = container.querySelector('h1')!.parentElement!.previousElementSibling as HTMLElement

      const images = left.querySelectorAll('img')
      expect(images).toHaveLength(1)
      expect(images[0]).toHaveAttribute('src', '/media/00000000-0000-4000-8000-000000000002.png')
      expect(images[0]).toHaveAttribute('width', '176')
      expect(images[0]).toHaveClass('rounded-full', 'object-cover')
    })

    it('with about.photo and no profile.avatar: the about photo is shown', async () => {
      state.about = { photo: '/media/00000000-0000-4000-8000-000000000002.webp' }
      const { container } = await renderAbout()
      const left = container.querySelector('h1')!.parentElement!.previousElementSibling as HTMLElement

      expect(left.querySelector('img')).toHaveAttribute('src', '/media/00000000-0000-4000-8000-000000000002.webp')
    })

    it('with a null about.photo the avatar is the fallback, and with neither there is no photo', async () => {
      state.avatar = '/media/00000000-0000-4000-8000-000000000001.jpg'
      state.about = { photo: null }
      const withAvatar = await renderAbout()
      const left = withAvatar.container.querySelector('h1')!.parentElement!.previousElementSibling as HTMLElement
      expect(left.querySelector('img')).toHaveAttribute('src', state.avatar)
      withAvatar.unmount()

      state.avatar = null
      const none = await renderAbout()
      const bare = none.container.querySelector('h1')!.parentElement!.previousElementSibling as HTMLElement
      expect(bare.querySelector('img')).toBeNull()
    })

    it('icon links: email and GitHub built like the contact section, then the contact social links', async () => {
      state.social = [
        { label: 'Example profile', url: 'https://example.test/profile' },
        { label: 'Example on LinkedIn', url: 'https://www.linkedin.com/in/example-person' },
        { label: 'Example mail', url: 'mailto:reader@example.test' },
      ]
      await renderAbout()

      expect(screen.getByRole('link', { name: contact.email! })).toHaveAttribute('href', `mailto:${contact.email}`)
      const github = screen.getByRole('link', { name: githubLabel(contact.github!) })
      expect(github).toHaveAttribute('href', githubUrl(contact.github!))
      expect(github).toHaveAttribute('rel', 'me noreferrer')
      expect(screen.getByRole('link', { name: 'Example profile' })).toHaveAttribute('href', 'https://example.test/profile')
      expect(screen.getByRole('link', { name: 'Example on LinkedIn' })).toHaveAttribute(
        'href',
        'https://www.linkedin.com/in/example-person',
      )
      // The same address as the email channel appears once.
      expect(screen.queryByRole('link', { name: 'Example mail' })).not.toBeInTheDocument()
      // Icon links: a round bordered button whose name is the aria-label, the icon itself is aria-hidden.
      for (const link of [github, screen.getByRole('link', { name: 'Example profile' })]) {
        expect(link).toHaveClass('rounded-full', 'border')
        expect(link.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
      }
    })
  })

  it('section cards: a 2-column grid of bordered cards, in the order of about.sections', async () => {
    const { container } = await renderAbout()

    const first = container.querySelector(`section#${about.sections[0]!.id}`)!
    const grid = first.parentElement!
    expect(grid).toHaveClass('grid', 'items-start', 'gap-6', 'lg:grid-cols-2')
    // An odd last card spans the row, so five cards leave no empty cell.
    expect(grid.className).toContain('lg:[&>:last-child:nth-child(odd)]:col-span-2')
    expect(Array.from(grid.children).map((card) => card.id)).toEqual(about.sections.map((section) => section.id))
    for (const card of Array.from(grid.children)) {
      expect(card).toHaveClass('rounded-card', 'border', 'p-6')
      // Row rules and CSS columns are what the card shape replaced.
      expect(card.className).not.toMatch(/border-t|lg:grid|columns-/)
    }
    expect(grid.className).not.toMatch(/(^|\s)columns-/)
  })

  it('has no frame track of its own: no 18rem column, no sticky aside', async () => {
    const { container } = await renderAbout()

    expect(container.innerHTML).not.toMatch(/18rem|lg:sticky/)
  })

  describe('experience and education', () => {
    const ENTRIES: TimelineEntry[] = [
      { kind: 'experience', title: 'Example role', org: 'Example Org', period: '2020 to 2022', summary: 'What was done.' },
      { kind: 'education', title: 'Example degree', org: null, period: null, summary: 'What was studied.' },
      { kind: 'experience', title: 'Second role', org: null, period: '2023', summary: 'More work.' },
    ]

    it('experience: a vertical timeline (an ordered list on a rail) of bordered cards, the company as the heading, then the role, the period and the summary', async () => {
      state.entries = ENTRIES
      await renderAbout()

      const heading = screen.getByRole('heading', { level: 2, name: msg('Site.about.experienceTitle') })
      const list = heading.closest('section')!.querySelector('ol')!
      // The rail is from sm: on a phone the cards take the whole width.
      expect(list).toHaveClass('sm:border-s', 'sm:ps-6')
      expect(list).not.toHaveClass('border-s')
      const items = Array.from(list.children)
      expect(items).toHaveLength(2)
      // A dot on the rail for each card, drawn for the eyes only and only where the rail is.
      for (const item of items) {
        const dot = item.querySelector('span[aria-hidden="true"].rounded-full')
        expect(dot).not.toBeNull()
        expect(dot).toHaveClass('hidden', 'sm:block')
      }

      const first = within(items[0] as HTMLElement)
      expect(first.getByRole('heading', { level: 3 })).toHaveTextContent('Example Org')
      expect(first.getByText('Example role')).toBeInTheDocument()
      expect(first.getByText('2020 to 2022')).toBeInTheDocument()
      expect(first.getByText('What was done.')).toBeInTheDocument()
      expect(items[0]!.querySelector('.rounded-card')).toHaveClass('border')
      // No company: the role is the heading and there is no second line repeating it; only the period, no bare separator.
      const second = within(items[1] as HTMLElement)
      expect(second.getByRole('heading', { level: 3 })).toHaveTextContent('Second role')
      expect(second.getAllByText('Second role')).toHaveLength(1)
      expect(second.getByText('2023')).toBeInTheDocument()
    })

    describe('details', () => {
      const FULL: TimelineEntry = {
        kind: 'experience',
        title: 'Software engineer',
        org: 'Example Org',
        period: '09/2023 - Present',
        summary: 'A short blurb.',
        url: 'https://example.org',
        location: 'Example City',
        department: 'Platform team',
        highlights: ['Built the first thing.', 'Improved the second thing.'],
        tech: ['Java', 'PostgreSQL'],
        logo: '/media/0b8d6b2e-1d3f-4a52-9a8e-3f7a5b0f2c11.png',
      }

      it('experience card: linked company heading, logo, role, period and location, department, blurb, highlights and pills', async () => {
        state.entries = [FULL]
        const { container } = await renderAbout()

        const card = within(container.querySelector('#about-experience')!.closest('section')!.querySelector('li')!)
        const heading = card.getByRole('heading', { level: 3 })
        expect(within(heading).getByRole('link', { name: 'Example Org' })).toHaveAttribute('href', 'https://example.org')
        expect(card.getByText('Software engineer')).toBeInTheDocument()
        expect(card.getByText('09/2023 - Present · Example City')).toBeInTheDocument()
        expect(card.getByText('Platform team')).toBeInTheDocument()
        expect(card.getByText('A short blurb.')).toBeInTheDocument()
        expect(card.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
          'Built the first thing.',
          'Improved the second thing.',
          'Java',
          'PostgreSQL',
        ])
        expect(card.getByRole('list', { name: msg('Site.entry.techLabel') })).toBeInTheDocument()
        const logo = container.querySelector('#about-experience')!.closest('section')!.querySelector('img')!
        expect(logo.getAttribute('src')).toContain('0b8d6b2e-1d3f-4a52-9a8e-3f7a5b0f2c11.png')
        expect(logo).toHaveAttribute('alt', '')
      })

      it('education card: the school is the heading, then the degree and the years', async () => {
        state.entries = [
          {
            kind: 'education',
            title: 'Degree name',
            org: 'School X',
            period: '2019 - 2021',
            summary: '',
            url: 'https://school.example',
          },
        ]
        const { container } = await renderAbout()

        const card = within(container.querySelector('#about-education')!.closest('section')!.querySelector('li')!)
        expect(card.getByRole('heading', { level: 3 })).toHaveTextContent('School X')
        expect(card.getByRole('link', { name: 'School X' })).toHaveAttribute('href', 'https://school.example')
        expect(card.getByText('Degree name')).toBeInTheDocument()
        expect(card.getByText('2019 - 2021')).toBeInTheDocument()
        // A blank blurb is no empty paragraph.
        expect(container.querySelector('#about-education')!.closest('section')!.querySelectorAll('p')).toHaveLength(0)
      })

      it('an address that is not https is not a link, and an entry without the new fields has no list and no image', async () => {
        state.entries = [
          { ...FULL, url: 'http://example.org', highlights: [], tech: [], logo: null },
          { kind: 'experience', title: 'Old entry', org: null, period: null, summary: 'Stored before the new fields.' },
        ]
        const { container } = await renderAbout()

        const section = container.querySelector('#about-experience')!.closest('section')!
        expect(section.querySelector('a')).toBeNull()
        expect(section.querySelector('img')).toBeNull()
        expect(section.querySelectorAll('li ul')).toHaveLength(0)
      })
    })

    it('education: stacked bordered cards, only the education entries', async () => {
      state.entries = ENTRIES
      await renderAbout()

      const heading = screen.getByRole('heading', { level: 2, name: msg('Site.about.educationTitle') })
      const list = heading.closest('section')!.querySelector('ul')!
      expect(Array.from(list.children)).toHaveLength(1)
      const card = within(list)
      expect(card.getByRole('heading', { level: 3 })).toHaveTextContent('Example degree')
      expect(card.getByText('What was studied.')).toBeInTheDocument()
      expect(list.querySelector('.rounded-card')).toHaveClass('border')
      expect(card.queryByText('Example role')).not.toBeInTheDocument()
    })

    it('the packaged content has one entry of each kind', () => {
      expect(experienceEntries).toHaveLength(1)
      expect(educationEntries).toHaveLength(1)
    })

    it('a section with no entries is not rendered at all, heading included', async () => {
      state.entries = ENTRIES.filter((entry) => entry.kind === 'experience')
      const { unmount } = await renderAbout()
      expect(screen.getByRole('heading', { name: msg('Site.about.experienceTitle') })).toBeInTheDocument()
      expect(screen.queryByRole('heading', { name: msg('Site.about.educationTitle') })).not.toBeInTheDocument()
      unmount()

      state.entries = ENTRIES.filter((entry) => entry.kind === 'education')
      const education = await renderAbout()
      expect(screen.queryByRole('heading', { name: msg('Site.about.experienceTitle') })).not.toBeInTheDocument()
      expect(screen.getByRole('heading', { name: msg('Site.about.educationTitle') })).toBeInTheDocument()
      education.unmount()

      state.entries = []
      await renderAbout()
      expect(screen.queryByRole('heading', { name: msg('Site.about.experienceTitle') })).not.toBeInTheDocument()
      expect(screen.queryByRole('heading', { name: msg('Site.about.educationTitle') })).not.toBeInTheDocument()
    })
  })

  describe('body and legacy sections', () => {
    const BODY = 'Some words from the owner.\n\n## A body heading'

    it('with a body: it is rendered after the data sections, and the legacy section cards are not', async () => {
      state.about = { body: BODY }
      const { container } = await renderAbout()

      const body = container.querySelector('[data-post-body]') as HTMLElement
      expect(body).toHaveTextContent('Some words from the owner.')
      expect(container.querySelectorAll('section[id]')).toHaveLength(0)
      expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
        msg('Site.about.skillsTitle'),
        msg('Site.about.experienceTitle'),
        msg('Site.about.educationTitle'),
        'A body heading',
      ])
      const education = screen.getByRole('heading', { name: msg('Site.about.educationTitle') })
      expect(education.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it('without a body: the legacy section cards render, after the education', async () => {
      const { container } = await renderAbout()

      expect(container.querySelector('[data-post-body]')).toBeNull()
      expect(container.querySelectorAll('section[id]')).toHaveLength(about.sections.length)
      const education = screen.getByRole('heading', { name: msg('Site.about.educationTitle') })
      const first = container.querySelector(`section#${about.sections[0]!.id}`)!
      expect(education.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })
  })

  describe('section "Photos"', () => {
    it('asks for the first six gallery photos', async () => {
      stubGallery(SIX_PHOTOS)
      await renderAbout()

      expect(getGallery).toHaveBeenCalledWith({ page: 0, size: 6 })
    })

    it('with photos: an extra h2 "Photos" after the other sections, before the "Read next" nav, as a frame-width 6-column band', async () => {
      stubGallery(SIX_PHOTOS)
      const { container } = await renderAbout()

      const h2s = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
      expect(h2s).toEqual([...OUTLINE, msg('Site.footer.links.gallery')])

      const gallery = screen.getByRole('region', { name: msg('Site.footer.links.gallery') })
      const nav = screen.getByRole('navigation', { name: msg('Site.about.readNext') })
      expect(gallery.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      // A band of its own: the section is a `reader` Container (same gutter as every other band), after the section cards.
      expect(gallery).toHaveClass('max-w-[87.5rem]', 'px-4', 'sm:px-6')
      const lastCard = container.querySelector(`section#${about.sections.at(-1)!.id}`)!
      expect(lastCard.compareDocumentPosition(gallery) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(gallery.querySelector('ul')).toHaveClass('lg:grid-cols-6')

      const tiles = within(gallery)
        .getAllByRole('link')
        .filter((a) => a.getAttribute('href')?.startsWith('/media/'))
      expect(tiles.map((a) => a.getAttribute('href'))).toEqual(SIX_PHOTOS.map((p) => mediaPath(p.image)))
      expect(within(gallery).getByRole('link', { name: msg('Site.gallery.seeAll') })).toHaveAttribute('href', '/gallery')
    })

    it('empty gallery: no section, the page is exactly as before', async () => {
      await renderAbout()

      expect(screen.queryByRole('heading', { name: msg('Site.footer.links.gallery') })).not.toBeInTheDocument()
      expect(screen.queryByRole('link', { name: msg('Site.gallery.seeAll') })).not.toBeInTheDocument()
    })

    it('failing gallery: no section, the rest still renders', async () => {
      vi.mocked(getGallery).mockRejectedValue(new Error('fetch failed'))

      await renderAbout()

      expect(screen.queryByRole('heading', { name: msg('Site.footer.links.gallery') })).not.toBeInTheDocument()
      expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(OUTLINE)
      expect(screen.getByRole('navigation', { name: msg('Site.about.readNext') })).toBeInTheDocument()
    })
  })

  describe('metadata', () => {
    it('renders per request: a build without the API must not bake in a page that is missing photos', () => {
      expect(dynamic).toBe('force-dynamic')
    })

    it('declares its own canonical path rather than inheriting the homepage one', () => {
      expect(metadata.alternates?.canonical).toBe('/about')
    })

    it('carries a title, a description and a share card describing THIS page', () => {
      expect(metadata.title).toBe(msg('Site.footer.links.about'))
      expect(metadata.description).toBe(about.intro)
      expect(metadata.openGraph?.description).toBe(about.intro)

      // This route and /posts/[slug] were the only two that wrote their own `openGraph`
      // block, and that is exactly why they were the only two measured emitting NO
      // og:locale and NO og:site_name: a segment's openGraph REPLACES the inherited
      // object rather than merging into it, so restating four fields dropped the two
      // that were not restated.
      expect(metadata.openGraph).toMatchObject({
        title: msg('Site.footer.links.about'),
        url: '/about',
        locale: 'vi_VN',
        siteName: site.name,
      })
      expect(metadata.openGraph?.url).toBe(metadata.alternates?.canonical)
      expect(metadata.twitter?.title).toBe(msg('Site.footer.links.about'))
    })
  })
})
