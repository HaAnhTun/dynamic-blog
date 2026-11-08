import { render, screen, within } from '@testing-library/react'
import { isValidElement, type ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CaseStudiesGroup } from '@/components/site/reader/CaseStudiesGroup'
import {
  CASE_GRID,
  CASE_RAIL,
  CASE_RAIL_STICKY,
  MEASURE,
  MEASURE_LEAD,
  MEASURE_SMALL,
} from '@/components/site/reader/reader-layout'
import type { Locale } from '@/i18n/config'
import { getSiteContent } from '@/lib/site-content'
import type { SiteContent } from '@/lib/site-content-types'
import { lastBrowseFrameCall, resetBrowseFrameCalls } from '@/test/browse-frame-mock'
import { setTestLocale } from '@/test/intl'
import { msg } from '@/test/render-intl'
import CaseStudyDetail from './page'

/**
 * The detail page inside the browse frame: the article, the six parts with their anchors, the "On this page" column, the 40rem
 * prose cap and the Case studies sidebar group. Content tests of the page itself (order of parts, results table, cited posts,
 * 404) live in `../page.test.tsx`.
 *
 * The frame is the shared stand-in (the real one renders the sidebar twice under jsdom); the packaged defaults get citations,
 * because the "read more" part exists only when a study cites a post.
 */
vi.mock('@/components/site/BrowseFrame', () => import('@/test/browse-frame-mock'))
vi.mock('@/lib/published-posts', () => ({ fetchAllPublishedPosts: vi.fn(async () => []) }))

/** Citations of the study; empty for the test of the study with no "read more" part. */
const cited = vi.hoisted(() => ({ list: [{ slug: 'first-cited-post' }] as { slug: string }[] }))
vi.mock('@/lib/site-content', async () => {
  const { defaultSiteContent } = await import('@/content/defaults')
  const withCitations = async (locale: Locale): Promise<SiteContent> => {
    const content = defaultSiteContent(locale)
    return { ...content, caseStudies: content.caseStudies.map((item) => ({ ...item, readMore: cited.list })) }
  }
  return { SITE_CONTENT_TAG: 'site-content', getSiteContent: withCitations }
})

const study = (await getSiteContent('vi')).caseStudies[0]!
const props = (locale: Locale = 'vi') => {
  // The server translators read the test locale while the page is awaited.
  setTestLocale(locale)
  return { params: Promise.resolve({ locale, slug: study.slug }) } as never
}
const classesOf = (el: Element) => el.className.split(/\s+/)

beforeEach(() => {
  cited.list = [{ slug: 'first-cited-post' }]
})
afterEach(resetBrowseFrameCalls)

/** The links of the "On this page" navigation, as `[text, id]` pairs. */
function tocLinks(locale: Locale = 'vi') {
  const toc = screen.getByRole('navigation', { name: msg('Site.about.onThisPage', undefined, locale) })
  return within(toc)
    .getAllByRole('link')
    .map((link) => [link.textContent, link.getAttribute('href')!.replace(/^#/, '')] as const)
}

describe('/case-studies/[slug] in the frame', () => {
  it('is one article named by its h1, inside the browse frame', async () => {
    const { container } = render(await CaseStudyDetail(props()))

    const frame = screen.getByTestId('browse-frame')
    const article = container.querySelector('article') as HTMLElement
    expect(frame).toContainElement(article)
    expect(container.querySelectorAll('article')).toHaveLength(1)
    const h1 = within(article).getByRole('heading', { level: 1, name: study.title })
    expect(article.getAttribute('aria-labelledby')).toBe(h1.id)
    expect(h1.id).not.toBe('')
    expect(screen.getByRole('article', { name: study.title })).toBe(article)
  })

  it('marks no Explore row and hands the frame the Case studies group with the current study', async () => {
    render(await CaseStudyDetail(props()))

    const call = lastBrowseFrameCall()!
    expect(call.current).toBeUndefined()
    expect(isValidElement(call.extra) && call.extra.type).toBe(CaseStudiesGroup)
    expect((call.extra as ReactElement<{ locale: string; current?: string }>).props).toEqual({
      locale: 'vi',
      current: study.slug,
    })
  })

  it('keeps the h1 to 3xl and the summary and the last-run line to a readable measure (MEASURE_LEAD, MEASURE_SMALL)', async () => {
    render(await CaseStudyDetail(props()))

    const h1 = screen.getByRole('heading', { level: 1 })
    expect(classesOf(h1)).toContain('max-w-3xl')
    expect(classesOf(screen.getByText(study.summary))).toContain(MEASURE_LEAD)
    expect(classesOf(screen.getByText(study.summary))).not.toContain('max-w-3xl')
    expect(classesOf(screen.getByText(msg('Site.caseStudies.lastRun', { date: study.lastVerified })))).toContain(MEASURE_SMALL)
  })
})

describe.each(['vi', 'en'] as const)('/case-studies/[slug] "On this page" (%s)', (locale) => {
  it('has one anchor per part, each equal to a rendered section id, in the order of the sections', async () => {
    const { container } = render(await CaseStudyDetail(props(locale)))

    const sections = Array.from(container.querySelectorAll('article section'))
    const ids = sections.map((section) => section.id)
    expect(ids).toEqual(['problem', 'constraints', 'solution', 'results', 'if-redone', 'read-more'])
    expect(new Set(ids).size).toBe(ids.length)
    expect(tocLinks(locale).map(([, id]) => id)).toEqual(ids)
    // The link text is the heading of the section it points to.
    const headings = sections.map((section) => section.querySelector('h2')!.textContent)
    expect(tocLinks(locale).map(([text]) => text)).toEqual(headings)
    for (const [, id] of tocLinks(locale)) expect(document.getElementById(id)).not.toBeNull()
  })

  it('names the navigation by a visible label, with the existing catalog key', async () => {
    render(await CaseStudyDetail(props(locale)))

    const label = msg('Site.about.onThisPage', undefined, locale)
    const toc = screen.getByRole('navigation', { name: label })
    expect(document.getElementById(toc.getAttribute('aria-labelledby')!)?.textContent).toBe(label)
  })
})

describe('/case-studies/[slug] right column', () => {
  it('is the second child of the case grid, hidden below rail, sticky and never printed', async () => {
    const { container } = render(await CaseStudyDetail(props()))

    const grid = container.querySelector('article > div') as HTMLElement
    for (const token of CASE_GRID.split(' ')) expect(classesOf(grid)).toContain(token)
    expect(grid.children).toHaveLength(2)
    const rail = grid.children[1] as HTMLElement
    for (const token of CASE_RAIL.split(' ')) expect(classesOf(rail)).toContain(token)
    expect(classesOf(rail)).toEqual(expect.arrayContaining(['hidden', 'rail:block', 'print:hidden']))
    const sticky = rail.firstElementChild as HTMLElement
    for (const token of CASE_RAIL_STICKY.split(' ')) expect(classesOf(sticky)).toContain(token)
    expect(rail.querySelector('nav')).not.toBeNull()
    // The sections are the first child, so the reading order is the visual order.
    expect(grid.children[0]!.querySelectorAll('section').length).toBeGreaterThan(0)
  })

  it('drops the "read more" part and its anchor when the study cites no post', async () => {
    cited.list = []

    const { container } = render(await CaseStudyDetail(props()))

    const ids = ['problem', 'constraints', 'solution', 'results', 'if-redone']
    expect(Array.from(container.querySelectorAll('article section')).map((section) => section.id)).toEqual(ids)
    expect(tocLinks().map(([, id]) => id)).toEqual(ids)
  })
})

describe('/case-studies/[slug] measure', () => {
  it('caps every paragraph block at the shared MEASURE (35rem, 60 to 75 characters in Vietnamese)', async () => {
    const { container } = render(await CaseStudyDetail(props()))

    const blocks = Array.from(container.querySelectorAll('article section > div')).filter((div) =>
      div.querySelector(':scope > p'),
    )
    // Problem, constraints, solution and "if redone": four blocks of paragraphs.
    expect(blocks).toHaveLength(4)
    for (const block of blocks) expect(classesOf(block)).toContain(MEASURE)
    for (const paragraph of study.problem) expect(screen.getByText(paragraph)).toBeInTheDocument()
  })

  it('lets the results table use the whole column', async () => {
    const { container } = render(await CaseStudyDetail(props()))

    const results = container.querySelector('#results') as HTMLElement
    const table = results.querySelector('table') as HTMLElement
    expect(table.parentElement!.className).not.toMatch(/max-w-/)
    expect(classesOf(table)).toContain('w-full')
  })

  it('adds no scroll margin of its own to the headings: the header offset comes from the document', async () => {
    const { container } = render(await CaseStudyDetail(props()))

    expect(container.innerHTML).not.toMatch(/scroll-mt/)
  })
})
