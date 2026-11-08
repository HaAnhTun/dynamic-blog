import { cleanup, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { ListIcon } from '@/components/icons'
import type { Locale } from '@/i18n/config'
import { setTestLocale } from '@/test/intl'
import { msg, renderWithIntl } from '@/test/render-intl'
import { ACTIVE, LINK } from './rail-parts'
import { BROWSE_SIDE, LEFT_STICKY } from './reader-layout'
import { SiteSidebar, type SidebarCurrent } from './SiteSidebar'

afterEach(cleanup)

const EXPLORE = [
  ['latest', 'Site.listing.sectionNav.latest', '/writing'],
  ['series', 'Site.listing.sectionNav.series', '/series'],
  ['topics', 'Site.listing.sectionNav.topics', '/topics'],
  ['archive', 'Site.listing.sectionNav.archive', '/archive'],
  ['best', 'Site.footer.links.startHere', '/start-here'],
] as const

async function renderSidebar(props: { current?: SidebarCurrent; extra?: ReactNode } = {}, locale: Locale = 'vi') {
  // The server translators read the test locale while the component is awaited, before renderWithIntl sets it.
  setTestLocale(locale)
  const result = renderWithIntl(await SiteSidebar(props), { locale })
  const container = result.container
  const aside = container.querySelector('aside') as HTMLElement
  const phone = aside.querySelector('details[data-rail-phone]') as HTMLElement
  const desktop = aside.querySelector('[data-rail-sticky]') as HTMLElement
  const skip = container.firstElementChild as HTMLElement
  return { ...result, aside, phone, desktop, skip, locale }
}

const hrefs = (root: HTMLElement) =>
  within(root)
    .getAllByRole('link')
    .map((link) => link.getAttribute('href'))
const classesOf = (el: Element) => el.className.split(/\s+/)

describe.each(['vi', 'en'] as const)('SiteSidebar (%s)', (locale) => {
  const m = (key: string, args?: Record<string, string | number>) => msg(key, args, locale)

  it('puts the skip link first, outside the aside, named for what it skips and aimed at the page content', async () => {
    const { aside, skip, container } = await renderSidebar({}, locale)

    expect(skip.tagName).toBe('A')
    expect(skip.getAttribute('href')).toBe('#page-content')
    expect(skip.textContent).toBe(m('Site.frame.skipSidebar'))
    expect(aside.contains(skip)).toBe(false)
    expect(container.children[1]).toBe(aside)
    for (const token of ['sr-only', 'focus:not-sr-only', 'focus:fixed']) expect(classesOf(skip)).toContain(token)
  })

  it('is one aside named Site.frame.sidebarLabel, with the browse placement classes and never printed', async () => {
    const { aside, container } = await renderSidebar({}, locale)

    expect(container.querySelectorAll('aside')).toHaveLength(1)
    expect(aside.getAttribute('aria-label')).toBe(m('Site.frame.sidebarLabel'))
    for (const token of BROWSE_SIDE.split(' ')) expect(classesOf(aside)).toContain(token)
    expect(classesOf(aside)).toContain('print:hidden')
  })

  it('renders the two copies: a closed phone card below lg and a sticky scroller from lg', async () => {
    const { phone, desktop } = await renderSidebar({}, locale)

    expect(phone.hasAttribute('open')).toBe(false)
    expect(classesOf(phone)).toContain('lg:hidden')
    for (const token of ['hidden', 'lg:block', ...LEFT_STICKY.split(' ')]) expect(classesOf(desktop), token).toContain(token)
    expect(desktop.closest('details')).toBeNull()
  })

  it('the phone card has one summary of at least 44px with the list icon, and no nested details anywhere', async () => {
    const { phone, desktop } = await renderSidebar({ current: { key: 'topics', exact: false } }, locale)

    expect(phone.querySelectorAll('details')).toHaveLength(0)
    expect(phone.querySelectorAll('summary')).toHaveLength(1)
    const summary = phone.querySelector('summary')!
    expect(summary.parentElement).toBe(phone)
    expect(classesOf(summary)).toContain('min-h-11')
    expect(desktop.querySelectorAll('details')).toHaveLength(0)

    const { container, unmount } = renderWithIntl(<ListIcon size={14} className="shrink-0" />, { locale })
    const glyph = container.querySelector('svg')!.innerHTML
    unmount()
    expect(summary.querySelector('svg')!.innerHTML).toBe(glyph)
  })

  it('reads just "Explore" in the summary when no section is current, else "Explore · {section}"', async () => {
    const none = await renderSidebar({}, locale)
    expect(none.phone.querySelector('summary')!.textContent).toBe(m('Site.reader.exploreTitle'))
    none.unmount()

    const topics = await renderSidebar({ current: { key: 'topics', exact: false } }, locale)
    expect(topics.phone.querySelector('summary')!.textContent).toBe(
      m('Site.frame.summary', { current: m('Site.listing.sectionNav.topics') }),
    )
    topics.unmount()

    const best = await renderSidebar({ current: { key: 'best', exact: true } }, locale)
    expect(best.phone.querySelector('summary')!.textContent).toBe(
      m('Site.frame.summary', { current: m('Site.footer.links.startHere') }),
    )
  })

  it('has a navigation named Explore in each copy with the five links, and nothing else in the Explore group', async () => {
    const { phone, desktop } = await renderSidebar({}, locale)

    for (const copy of [phone, desktop]) {
      const navs = copy.querySelectorAll('nav')
      expect(navs).toHaveLength(1)
      const nav = within(copy).getByRole('navigation', { hidden: true, name: m('Site.reader.exploreTitle') })
      expect(nav).toBe(navs[0])
      expect(hrefs(nav)).toEqual(EXPLORE.map(([, , href]) => `${locale === 'en' ? '/en' : ''}${href}`))
      expect(
        within(nav)
          .getAllByRole('link')
          .map((a) => a.textContent),
      ).toEqual(EXPLORE.map(([, key]) => m(key)))
    }
  })

  it.each([
    ['latest', true, 'page'],
    ['series', true, 'page'],
    ['series', false, 'true'],
    ['topics', true, 'page'],
    ['topics', false, 'true'],
    ['archive', true, 'page'],
    ['best', true, 'page'],
  ] as const)(
    'current %s (exact %s): that row, and only that row, carries aria-current="%s" and the active fill',
    async (key, exact, value) => {
      const { phone, desktop } = await renderSidebar({ current: { key, exact } }, locale)

      const label = m(EXPLORE.find(([k]) => k === key)![1])
      for (const copy of [phone, desktop]) {
        const marked = copy.querySelectorAll('[aria-current]')
        expect(marked).toHaveLength(1)
        expect(marked[0]!.tagName).toBe('A')
        expect(marked[0]).toHaveAttribute('aria-current', value)
        expect(marked[0]!.textContent).toBe(label)
        for (const token of ACTIVE.split(' ')) expect(classesOf(marked[0]!)).toContain(token)
        for (const link of within(copy).getAllByRole('link')) {
          if (link !== marked[0]) expect(link.className).toBe(LINK)
        }
      }
    },
  )

  it('marks nothing when no section is current (gallery, search, bookmarks, profiles)', async () => {
    const { aside } = await renderSidebar({}, locale)

    expect(aside.querySelectorAll('[aria-current]')).toHaveLength(0)
  })

  it('keeps every id unique (the phone copy has the -m suffix) and every aria-labelledby resolving to one element', async () => {
    const { container, phone, desktop } = await renderSidebar(
      { current: { key: 'series', exact: false }, extra: <p>Group</p> },
      locale,
    )

    const ids = [...container.querySelectorAll('[id]')].map((el) => el.id)
    expect(new Set(ids).size, ids.join()).toBe(ids.length)
    expect(phone.querySelector('nav')!.getAttribute('aria-labelledby')).toBe('rail-explore-m')
    expect(desktop.querySelector('nav')!.getAttribute('aria-labelledby')).toBe('rail-explore')
    for (const el of container.querySelectorAll('[aria-labelledby]')) {
      for (const id of el.getAttribute('aria-labelledby')!.split(' ')) {
        expect(container.querySelectorAll(`[id="${id}"]`), id).toHaveLength(1)
      }
    }
  })

  it('renders the extra group below Explore in each copy, and no wrapper at all without one', async () => {
    const withExtra = await renderSidebar({ extra: <p data-testid="extra">Case studies</p> }, locale)
    for (const copy of [withExtra.phone, withExtra.desktop]) {
      const groups = copy.querySelector('nav')!.closest('div.space-y-6')!
      expect(groups.children).toHaveLength(2)
      expect(groups.children[0]!.querySelector('nav')).not.toBeNull()
      expect(within(groups.children[1] as HTMLElement).getByTestId('extra')).toBeInTheDocument()
    }
    expect(withExtra.container.querySelectorAll('[data-testid="extra"]')).toHaveLength(2)
    withExtra.unmount()

    for (const extra of [undefined, null, false]) {
      const without = await renderSidebar({ extra }, locale)
      for (const copy of [without.phone, without.desktop]) {
        const groups = copy.querySelector('nav')!.closest('div.space-y-6')!
        expect(groups.children).toHaveLength(1)
      }
      without.unmount()
    }
  })
})
