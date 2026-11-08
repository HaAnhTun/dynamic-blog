import { cleanup, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Locale } from '@/i18n/config'
import type { LeftRailModel, RailPost } from '@/lib/reader-rail'
import { seriesRows } from '@/lib/series-rows'
import { setTestLocale } from '@/test/intl'
import { msg, renderWithIntl } from '@/test/render-intl'
import { LeftRail } from './LeftRail'
import { LEFT_SLOT } from './reader-layout'

afterEach(cleanup)

const post = (slug: string, title = `Title ${slug}`, locale?: Locale): RailPost => ({ id: `id-${slug}`, slug, title, locale })

function seriesModel(total: number, current: number, overrides: Partial<LeftRailModel> = {}): LeftRailModel {
  const parts = Array.from({ length: total }, (_, i) => post(`part-${i + 1}`, `Part title ${i + 1}`))
  return {
    primary: {
      kind: 'series',
      slug: 'my-series',
      title: 'My series',
      current,
      total,
      rows: seriesRows(total, current - 1),
      parts,
      windowed: total > 7,
    },
    secondary: null,
    month: null,
    ...overrides,
  }
}

const CATEGORY_MODEL: LeftRailModel = {
  primary: { kind: 'category', name: 'Notes', posts: ['a', 'b', 'c'].map((slug) => post(slug)) },
  secondary: null,
  month: { year: 2026, month: 10, href: '/archive#thang-2026-10' },
}

const LATEST_MODEL: LeftRailModel = {
  primary: { kind: 'latest', posts: [post('x'), post('y')] },
  secondary: null,
  month: null,
}

const EMPTY_MODEL: LeftRailModel = { primary: null, secondary: null, month: null }

const SECONDARY: LeftRailModel['secondary'] = { kind: 'category', name: 'Notes', posts: [post('s1'), post('s2')] }

async function renderRail(model: LeftRailModel, locale: Locale = 'vi') {
  // The server translators read the test locale while the component is awaited, before renderWithIntl sets it.
  setTestLocale(locale)
  const result = renderWithIntl(await LeftRail({ model }), { locale })
  const container = result.container
  const aside = container.querySelector('aside') as HTMLElement
  const details = aside.querySelector('details') as HTMLElement
  const sticky = aside.querySelector('[data-rail-sticky]') as HTMLElement
  const skip = container.firstElementChild as HTMLElement
  const skipBody = container.children[1] as HTMLElement
  return { ...result, aside, details, sticky, skip, skipBody, locale }
}

const hrefs = (root: HTMLElement) =>
  within(root)
    .getAllByRole('link')
    .map((link) => link.getAttribute('href') ?? '')

describe.each(['vi', 'en'] as const)('LeftRail (%s)', (locale) => {
  const m = (key: string, args?: Record<string, string | number>) => msg(key, args, locale)

  it('puts both skip links first, outside the aside, and names the aside', async () => {
    const { aside, skip, skipBody, container } = await renderRail(seriesModel(3, 2), locale)
    expect(skip.tagName).toBe('A')
    expect(skip.getAttribute('href')).toBe('#post-article')
    expect(skip.textContent).toBe(m('Site.reader.skipToArticle'))
    expect(skipBody.tagName).toBe('A')
    expect(skipBody.getAttribute('href')).toBe('#post-body')
    expect(skipBody.textContent).toBe(m('Site.reader.skipToBody'))
    expect(aside.contains(skip)).toBe(false)
    expect(aside.contains(skipBody)).toBe(false)
    expect(container.children[2]).toBe(aside)
    for (const link of [skip, skipBody]) {
      expect(link.className).toContain('sr-only')
      expect(link.className).toContain('focus:not-sr-only')
      expect(link.className).toContain('focus:fixed')
    }
    expect(aside.getAttribute('aria-label')).toBe(m('Site.reader.leftLabel'))
    expect(aside.className).toContain('print:hidden')
    for (const token of LEFT_SLOT.split(' ')) expect(aside.className.split(' ')).toContain(token)
  })

  it('renders the two copies: a closed phone card below lg and a sticky block from lg', async () => {
    const { details, sticky } = await renderRail(seriesModel(3, 2), locale)
    expect(details.hasAttribute('open')).toBe(false)
    expect(details.hasAttribute('data-rail-phone')).toBe(true)
    expect(details.className.split(' ')).toContain('lg:hidden')
    expect(sticky.className.split(' ')).toEqual(expect.arrayContaining(['hidden', 'lg:block', 'lg:sticky']))
    expect(sticky.closest('details')).toBeNull()
  })

  it('the phone copy has only the outer details[data-rail-phone]: no other details, one summary, groups not collapsible', async () => {
    const { details } = await renderRail(seriesModel(4, 2, { secondary: SECONDARY }), locale)
    expect(details.querySelectorAll('details')).toHaveLength(0)
    expect(details.querySelectorAll('summary')).toHaveLength(1)
    const summary = details.querySelector('summary')!
    expect(summary.hasAttribute('data-rail-phone')).toBe(true)
    expect(summary.parentElement).toBe(details)
    // The series title row is a plain paragraph that still names the nav.
    expect(details.querySelector('nav')!.getAttribute('aria-labelledby')).toBe('series-cua-bai-m')
    expect(details.querySelector('p#series-cua-bai-m')).not.toBeNull()
  })

  it('the desktop copy has exactly the series and the category details, and none is the phone toggle', async () => {
    const both = await renderRail(seriesModel(4, 2, { secondary: SECONDARY }), locale)
    const all = both.sticky.querySelectorAll('details')
    expect(all).toHaveLength(2)
    for (const el of all) expect(el.hasAttribute('data-rail-phone')).toBe(false)
    expect(both.sticky.querySelectorAll('[data-rail-phone]')).toHaveLength(0)
    both.unmount()

    const categoryOnly = await renderRail(CATEGORY_MODEL, locale)
    expect(categoryOnly.sticky.querySelectorAll('details')).toHaveLength(1)
    categoryOnly.unmount()

    const latest = await renderRail(LATEST_MODEL, locale)
    expect(latest.sticky.querySelectorAll('details')).toHaveLength(0)
  })

  it('keeps every id unique and every aria-labelledby resolving to exactly one element', async () => {
    for (const model of [
      seriesModel(10, 5, { secondary: CATEGORY_MODEL.primary as never }),
      seriesModel(4, 2, { secondary: SECONDARY }),
      CATEGORY_MODEL,
      LATEST_MODEL,
      EMPTY_MODEL,
    ]) {
      const { container, unmount } = await renderRail(model, locale)
      const ids = [...container.querySelectorAll('[id]')].map((el) => el.id)
      expect(new Set(ids).size, ids.join()).toBe(ids.length)
      for (const el of container.querySelectorAll('[aria-labelledby]')) {
        const target = el.getAttribute('aria-labelledby')!
        expect(container.querySelectorAll(`[id="${target}"]`).length, target).toBe(1)
      }
      unmount()
    }
  })

  it('series: the desktop copy keeps series-cua-bai on the summary, the mobile copy appends -m on a paragraph', async () => {
    const { details, sticky } = await renderRail(seriesModel(3, 2), locale)
    expect(sticky.querySelector('nav')!.getAttribute('aria-labelledby')).toBe('series-cua-bai')
    expect(sticky.querySelector('summary#series-cua-bai')).not.toBeNull()
    expect(details.querySelector('nav')!.getAttribute('aria-labelledby')).toBe('series-cua-bai-m')
    expect(details.querySelector('#series-cua-bai-m')).not.toBeNull()
    expect(details.querySelector('#series-cua-bai')).toBeNull()
  })

  it('series: the nav is outside the open details and the summary names it', async () => {
    const { sticky } = await renderRail(seriesModel(4, 2), locale)
    const nav = sticky.querySelector('nav')!
    const group = nav.querySelector('details')!
    expect(group.parentElement).toBe(nav)
    expect(group.hasAttribute('open')).toBe(true)
    expect(nav.closest('details')).toBeNull()
    const summary = group.querySelector('summary')!
    expect(summary.id).toBe('series-cua-bai')
    expect(summary.textContent).toBe('My series')
    expect(within(sticky).getByRole('navigation', { name: 'My series' })).toBe(nav)
    // Collapsing the group leaves the landmark and its name in place.
    group.removeAttribute('open')
    expect(within(sticky).getByRole('navigation', { name: 'My series' })).toBe(nav)
  })

  it('series: a collapsible group with a chevron, an Overview row and a numbered list in order', async () => {
    const { sticky } = await renderRail(seriesModel(4, 2), locale)
    const summary = sticky.querySelector('summary')!
    expect(summary.querySelector('svg')!.getAttribute('class')).toContain('group-open:rotate-90')
    expect(summary.getAttribute('data-tip')).toBe('My series')
    expect(summary.querySelector('[data-tip-text]')!.textContent).toBe('My series')

    const overview = within(sticky).getByRole('link', { name: m('Site.reader.seriesOverview') })
    expect(overview.getAttribute('href')).toContain('/series/my-series')
    expect(overview.querySelector('[data-part-number]')).toBeNull()

    const list = sticky.querySelector('ol')!
    expect(list.getAttribute('role')).toBe('list')
    expect(list.className).toContain('-mx-2')
    expect(list.className).toContain('list-none')
    const numbers = [...list.querySelectorAll('[data-part-number]')]
    expect(numbers.map((el) => el.textContent)).toEqual(['1', '2', '3', '4'])
    for (const number of numbers) {
      expect(number.className).toContain('tabular-nums')
      expect(number.className).toMatch(/text-neutral-(600|700)/)
    }
    // The accessible name of a part link is the number, a space and the whole title.
    expect(within(list).getByRole('link', { name: '1 Part title 1' })).toBeInTheDocument()
  })

  it('series: one nav named after the series, the current part is not a link and is the only grey, medium row', async () => {
    const { details, sticky } = await renderRail(seriesModel(4, 2), locale)
    for (const copy of [details, sticky]) {
      const navs = within(copy).getAllByRole('navigation')
      expect(navs).toHaveLength(1)
      expect(within(copy).getByRole('navigation', { name: 'My series' })).toBe(navs[0])
      expect(within(copy).queryAllByRole('region')).toHaveLength(0)
      expect(copy.querySelectorAll('h1,h2,h3,h4,h5,h6,section')).toHaveLength(0)

      const current = copy.querySelectorAll('li[aria-current="true"]')
      expect(current).toHaveLength(1)
      expect(current[0]!.querySelector('a')).toBeNull()
      expect(current[0]!.textContent).toContain('Part title 2')
      expect(current[0]!.querySelector('.sr-only')!.textContent).toBe(` ${m('Site.seriesBlock.currentPart')}`)

      const active = current[0]!.firstElementChild as HTMLElement
      expect(active.className).toContain('bg-neutral-200/70')
      expect(active.className).toContain('font-medium')
      expect(active.getAttribute('data-tip')).toBe('Part title 2')
      const others = [...copy.querySelectorAll('ol a')]
      expect(others).toHaveLength(3)
      for (const link of others) {
        expect(link.className).not.toContain('bg-neutral-200/70')
        expect(link.className).not.toContain('font-medium')
        // Hover is lighter than the active fill.
        expect(link.className).toContain('hover:bg-neutral-200/40')
      }

      const links = hrefs(copy)
      expect(links.filter((href) => href.includes('/posts/')).map((href) => href.split('/posts/')[1])).toEqual([
        'part-1',
        'part-3',
        'part-4',
      ])
      expect(links.some((href) => href.endsWith('/series/my-series'))).toBe(true)
      expect(copy.textContent).toContain(m('Site.seriesBlock.partOf', { current: 2, total: 4 }))
    }
  })

  it('series: windowed model shows gaps (aria-hidden) and the view-all link, a short series does not', async () => {
    const windowed = await renderRail(seriesModel(12, 6), locale)
    const gaps = windowed.sticky.querySelectorAll('li[aria-hidden="true"]')
    expect(gaps.length).toBeGreaterThan(0)
    expect(gaps[0]!.textContent).toBe('…')
    const viewAll = within(windowed.sticky)
      .getAllByRole('link')
      .filter((link) => link.getAttribute('href')!.endsWith('/series/my-series') && link.textContent!.includes('→'))
    expect(viewAll).toHaveLength(1)
    windowed.unmount()

    const full = await renderRail(seriesModel(5, 3), locale)
    expect(full.sticky.querySelectorAll('li[aria-hidden="true"]')).toHaveLength(0)
    expect(within(full.sticky).queryByText(/→/)).toBeNull()
  })

  it('category: the group is an open details, its title is plain text, the posts are links, the category has no link', async () => {
    const { details, sticky } = await renderRail(CATEGORY_MODEL, locale)
    const title = m('Site.reader.categoryTitle', { category: 'Notes' })

    const group = sticky.querySelector('details')!
    expect(group.hasAttribute('open')).toBe(true)
    const summary = group.querySelector('summary')!
    expect(summary.id).toBe('rail-category')
    expect(summary.textContent).toBe(title)
    expect(summary.closest('a')).toBeNull()

    for (const copy of [details, sticky]) {
      const list = within(copy).getByRole('list', { name: title })
      const links = within(list).getAllByRole('link')
      expect(links).toHaveLength(3)
      expect(links.length).toBeLessThanOrEqual(6)
      expect(within(copy).queryByRole('link', { name: 'Notes' })).toBeNull()
      expect(hrefs(copy).some((href) => /categor|danh-muc|topics\/notes/i.test(href))).toBe(false)
      expect(within(copy).queryAllByRole('navigation')).toHaveLength(0)
      expect(copy.querySelectorAll('nav, section, [role="region"], h1,h2,h3,h4,h5,h6')).toHaveLength(0)
    }
    // The phone copy has the title as an eyebrow paragraph, not a toggle.
    expect(details.querySelector('p[id^="rail-category"]')!.textContent).toBe(title)
  })

  it('category: the Topics eyebrow comes before the group on the desktop copy', async () => {
    const { sticky } = await renderRail(CATEGORY_MODEL, locale)
    const eyebrows = [...sticky.querySelectorAll('p')].map((p) => p.textContent)
    expect(eyebrows).toContain(m('Site.listing.sectionNav.topics'))
  })

  it('latest: a plain list under its eyebrow, not collapsible', async () => {
    const { sticky } = await renderRail(LATEST_MODEL, locale)
    const list = within(sticky).getByRole('list', { name: m('Site.reader.latestTitle') })
    expect(within(list).getAllByRole('link')).toHaveLength(2)
    expect(sticky.querySelector('details')).toBeNull()
  })

  it('a secondary category group follows a series and is closed', async () => {
    const { sticky } = await renderRail(seriesModel(3, 1, { secondary: SECONDARY }), locale)
    expect(within(sticky).getAllByRole('navigation')).toHaveLength(1)
    const title = m('Site.reader.categoryTitle', { category: 'Notes' })
    expect(within(sticky).getByRole('list', { name: title })).not.toBeNull()
    const details = [...sticky.querySelectorAll('details')]
    expect(details).toHaveLength(2)
    expect(details[0]!.hasAttribute('open')).toBe(true)
    expect(details[1]!.hasAttribute('open')).toBe(false)
    expect(details[1]!.querySelector('summary')!.id).toBe('rail-category-2')
    // Order: Explore, series group, category group.
    const labelled = [...sticky.querySelectorAll('ul[aria-labelledby], nav')].map((el) =>
      el.tagName === 'NAV' ? 'series' : el.getAttribute('aria-labelledby'),
    )
    expect(labelled).toEqual(['rail-explore', 'series', 'rail-category-2'])
  })

  it('post links carry the locale of their language', async () => {
    const other: Locale = locale === 'vi' ? 'en' : 'vi'
    const model: LeftRailModel = {
      primary: { kind: 'latest', posts: [post('same'), post('foreign', 'Foreign post', other)] },
      secondary: null,
      month: null,
    }
    const { sticky } = await renderRail(model, locale)
    const foreign = within(sticky).getByRole('link', { name: 'Foreign post' }).getAttribute('href')!
    const same = within(sticky).getByRole('link', { name: 'Title same' }).getAttribute('href')!
    expect(foreign).toContain(`/${other}/posts/foreign`)
    expect(same).not.toContain(`/${other}/`)
  })

  it('month link renders only when the model has a month, with the formatted month, after the other groups', async () => {
    const withMonth = await renderRail(CATEGORY_MODEL, locale)
    const link = within(withMonth.sticky).getByRole('link', { name: /2026/ })
    expect(link.getAttribute('href')).toContain('/archive#thang-2026-10')
    expect(link.querySelector('.first-letter\\:uppercase')).not.toBeNull()
    expect(link.querySelector('svg')).not.toBeNull()
    expect(link.parentElement!.lastElementChild).toBe(link)
    withMonth.unmount()

    const without = await renderRail(LATEST_MODEL, locale)
    expect(hrefs(without.sticky).some((href) => href.includes('#thang-'))).toBe(false)
  })

  it('Explore: five icon links in order, first group, no aria-current, not a nav, always rendered', async () => {
    for (const model of [EMPTY_MODEL, CATEGORY_MODEL, seriesModel(3, 2)]) {
      const { details, sticky, unmount } = await renderRail(model, locale)
      // The phone card repeats nothing the header and the footer offer: it holds Explore only when it has no series, category or latest list.
      if (model !== EMPTY_MODEL) {
        expect(within(details).queryByRole('list', { name: m('Site.reader.exploreTitle') })).toBeNull()
      }
      for (const copy of model === EMPTY_MODEL ? [details, sticky] : [sticky]) {
        const list = within(copy).getByRole('list', { name: m('Site.reader.exploreTitle') })
        const links = within(list).getAllByRole('link')
        expect(links.map((link) => link.textContent)).toEqual([
          m('Site.listing.sectionNav.latest'),
          m('Site.listing.sectionNav.series'),
          m('Site.listing.sectionNav.topics'),
          m('Site.listing.sectionNav.archive'),
          m('Site.footer.links.startHere'),
        ])
        expect(links.map((link) => link.getAttribute('href')!.replace(/^\/(vi|en)(?=\/)/, ''))).toEqual([
          '/writing',
          '/series',
          '/topics',
          '/archive',
          '/start-here',
        ])
        for (const link of links) {
          expect(link.hasAttribute('aria-current')).toBe(false)
          expect(link.querySelectorAll('svg')).toHaveLength(1)
        }
        expect(list.closest('nav, section')).toBeNull()
        expect(copy.querySelector('ul, ol')).toBe(list)
      }
      unmount()
    }
  })

  it('the series eyebrow is not repeated inside the open phone card (its row says it), and stays in the desktop copy', async () => {
    const { details, sticky } = await renderRail(seriesModel(4, 2), locale)
    const label = m('Site.seriesBlock.partOf', { current: 2, total: 4 })

    const inCard = within(details.lastElementChild as HTMLElement)
      .getByText(label)
      .closest('p')!
    expect(inCard).toHaveClass('hidden')
    const inColumn = within(sticky).getByText(label).closest('p')!
    expect(inColumn).not.toHaveClass('hidden')
    // The summary row of the card still names it.
    expect(within(details.querySelector('summary')!).getByText(label)).toBeInTheDocument()
  })

  it('the phone card rows are 44px and its titles wrap to two lines (no tooltip on a touch screen); the desktop copy is untouched', async () => {
    const { details, sticky } = await renderRail(seriesModel(4, 2, { secondary: SECONDARY }), locale)

    const rows = details.querySelectorAll('ol a, ol [aria-current] > span, ul a')
    expect(rows.length).toBeGreaterThan(4)
    for (const row of rows) expect(row.className, row.outerHTML).toContain('max-lg:min-h-11')
    expect(details.lastElementChild!.className).toContain('max-lg:[&_[data-tip-text]]:line-clamp-2')
    expect(details.lastElementChild!.className).toContain('max-lg:[&_[data-tip-text]]:whitespace-normal')
    // The sticky copy is `hidden lg:block`, so the `max-lg:` classes never reach it; it keeps its one-line ellipsis.
    expect(sticky.className).not.toContain('line-clamp')
  })

  it('the lists carry the bleed and rows share one recipe: hover lighter than active, single line', async () => {
    const { sticky } = await renderRail(seriesModel(4, 2, { secondary: SECONDARY }), locale)
    for (const list of sticky.querySelectorAll('ul, ol')) expect(list.className, list.outerHTML).toContain('-mx-2')
    for (const link of sticky.querySelectorAll('ul a, ol a')) {
      expect(link.className).toContain('hover:bg-neutral-200/40')
      expect(link.className).toContain('pointer-coarse:min-h-11')
      expect(link.className).toContain('pointer-coarse:py-2')
    }
  })

  it('never renders an empty aside: a model of nulls still has the Explore group and a summary', async () => {
    const { aside, details, sticky } = await renderRail(EMPTY_MODEL, locale)
    expect(aside.querySelectorAll('a').length).toBe(10)
    expect(within(sticky).getAllByRole('link')).toHaveLength(5)
    expect(details.querySelector('summary')!.textContent).toContain(m('Site.reader.exploreTitle'))
  })

  it('the summary is one row per kind: series part, category title, latest title, explore', async () => {
    const summaryOf = async (model: LeftRailModel) => {
      const { details, unmount } = await renderRail(model, locale)
      const summary = details.querySelector('summary')!
      const text = summary.textContent
      const label = summary.querySelector('.truncate')
      unmount()
      return { text, label: label?.textContent }
    }
    expect((await summaryOf(seriesModel(5, 2))).label).toBe(m('Site.seriesBlock.partOf', { current: 2, total: 5 }))
    expect((await summaryOf(CATEGORY_MODEL)).label).toBe(m('Site.reader.categoryTitle', { category: 'Notes' }))
    expect((await summaryOf(LATEST_MODEL)).label).toBe(m('Site.reader.latestTitle'))
    expect((await summaryOf(EMPTY_MODEL)).label).toBe(m('Site.reader.exploreTitle'))
  })

  it('an 80-character unbroken title is one line with an ellipsis and keeps its whole text for the tooltip and the name', async () => {
    const long = 'x'.repeat(80)
    const model: LeftRailModel = {
      primary: {
        kind: 'series',
        slug: 's',
        title: long,
        current: 1,
        total: 2,
        rows: seriesRows(2, 0),
        parts: [post('p1', long), post('p2', long)],
        windowed: false,
      },
      secondary: { kind: 'category', name: long, posts: [post('c1', long)] },
      month: null,
    }
    const { aside, details, sticky } = await renderRail(model, locale)
    for (const copy of [details, sticky]) {
      const texts = [...copy.querySelectorAll('[data-tip-text]')]
      expect(texts.length).toBeGreaterThanOrEqual(3)
      for (const text of texts) {
        expect(text.className).toContain('truncate')
        expect(text.className).toContain('min-w-0')
        expect(text.className).not.toContain('line-clamp')
        expect(text.className).not.toContain('break-words')
      }
      // Every element that carries a tooltip text carries the same whole title.
      for (const row of copy.querySelectorAll('[data-tip]')) {
        const tipText = row.querySelector('[data-tip-text]')!
        expect(row.getAttribute('data-tip')).toBe(tipText.textContent)
      }
    }
    const partLink = within(sticky).getByRole('link', { name: `2 ${long}` })
    expect(partLink.getAttribute('data-tip')).toBe(long)
    expect(within(sticky).getByRole('link', { name: long })).toBeInTheDocument()
    expect(aside.className.split(' ')).toContain('min-w-0')
    // Every flex child inside the groups can shrink.
    for (const li of sticky.querySelectorAll('ul > li, ol > li')) expect(li.className).toContain('min-w-0')
  })

  it('wraps each copy in the tooltip host', async () => {
    const { details, sticky } = await renderRail(seriesModel(3, 2), locale)
    for (const copy of [details, sticky]) {
      const host = copy.querySelector('[data-tip]')!.closest('div.min-w-0')
      expect(host).not.toBeNull()
    }
  })
})
