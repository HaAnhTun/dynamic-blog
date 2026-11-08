import { cleanup, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Locale } from '@/i18n/config'
import type { CaseStudy } from '@/lib/site-content-types'
import { setTestLocale } from '@/test/intl'
import { msg, renderWithIntl } from '@/test/render-intl'
import { CaseStudiesGroup } from './CaseStudiesGroup'
import { ACTIVE, LINK, TEXT } from './rail-parts'

afterEach(cleanup)

/** The studies the mocked content returns; each test sets it. */
const studies = vi.hoisted(() => ({ list: [] as { slug: string; title: string }[] }))
vi.mock('@/lib/site-content', () => ({
  SITE_CONTENT_TAG: 'site-content',
  getSiteContent: async () => ({ caseStudies: studies.list as CaseStudy[] }),
}))

const ONE = [{ slug: 'first-study', title: 'First study with a rather long title that will be cut by the sidebar' }]
const TWO = [...ONE, { slug: 'second-study', title: 'Second study' }]

async function renderGroup(list: typeof ONE, current?: string, locale: Locale = 'vi') {
  studies.list = list
  setTestLocale(locale)
  const element = await CaseStudiesGroup({ locale, current })
  const result = renderWithIntl(element ?? <></>, { locale })
  return { ...result, root: result.container }
}

const classesOf = (el: Element) => el.className.split(/\s+/)

describe.each(['vi', 'en'] as const)('CaseStudiesGroup (%s)', (locale) => {
  const m = (key: string) => msg(key, undefined, locale)
  const prefix = locale === 'vi' ? '' : `/${locale}`

  it('has the eyebrow of the nav key and a list named by it', async () => {
    const { root } = await renderGroup(ONE, undefined, locale)

    expect(root.querySelector('p')?.textContent).toBe(m('Site.nav.caseStudies'))
    expect(within(root).getByRole('list', { name: m('Site.nav.caseStudies') })).toBeInTheDocument()
  })

  it('carries no id, because the sidebar renders it once per copy', async () => {
    const { root } = await renderGroup(TWO, 'second-study', locale)

    expect(root.querySelectorAll('[id]')).toHaveLength(0)
  })

  it('on the list page marks "All case studies" as the page and no study', async () => {
    const { root } = await renderGroup(TWO, undefined, locale)

    const all = within(root).getByRole('link', { name: m('Site.caseStudies.allCaseStudies') })
    expect(all).toHaveAttribute('href', `${prefix}/case-studies`)
    expect(all).toHaveAttribute('aria-current', 'page')
    expect(classesOf(all)).toEqual(expect.arrayContaining(ACTIVE.split(' ')))
    for (const study of TWO) {
      const link = within(root).getByRole('link', { name: study.title })
      expect(link).toHaveAttribute('href', `${prefix}/case-studies/${study.slug}`)
      expect(link).not.toHaveAttribute('aria-current')
      expect(classesOf(link)).toEqual(expect.arrayContaining(LINK.split(' ')))
    }
  })

  it('on a detail page marks the study as the page and the list row as true', async () => {
    const { root } = await renderGroup(TWO, 'second-study', locale)

    const all = within(root).getByRole('link', { name: m('Site.caseStudies.allCaseStudies') })
    expect(all).toHaveAttribute('aria-current', 'true')
    expect(classesOf(all)).toEqual(expect.arrayContaining(LINK.split(' ')))
    const current = within(root).getByRole('link', { name: 'Second study' })
    expect(current).toHaveAttribute('aria-current', 'page')
    expect(classesOf(current)).toEqual(expect.arrayContaining(ACTIVE.split(' ')))
    expect(within(root).getByRole('link', { name: ONE[0]!.title })).not.toHaveAttribute('aria-current')
    expect(root.querySelectorAll('[aria-current="page"]')).toHaveLength(1)
  })

  it('is still rendered with the single shipped study: two rows, the study is the only current one', async () => {
    const { root } = await renderGroup(ONE, 'first-study', locale)

    expect(within(root).getAllByRole('listitem')).toHaveLength(2)
    expect(within(root).getByRole('link', { name: ONE[0]!.title })).toHaveAttribute('aria-current', 'page')
  })

  it('truncates a title to one line and keeps the whole title for the tooltip host', async () => {
    const { root } = await renderGroup(ONE, undefined, locale)

    const link = within(root).getByRole('link', { name: ONE[0]!.title })
    expect(link).toHaveAttribute('data-tip', ONE[0]!.title)
    const text = link.querySelector('[data-tip-text]') as HTMLElement
    expect(text.textContent).toBe(ONE[0]!.title)
    expect(classesOf(text)).toEqual(expect.arrayContaining(TEXT.split(' ')))
  })
})

describe('CaseStudiesGroup without studies', () => {
  it('renders nothing rather than an empty group', async () => {
    studies.list = []
    expect(await CaseStudiesGroup({ locale: 'vi' })).toBeNull()
  })
})
