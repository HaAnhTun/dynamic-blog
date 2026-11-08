import { screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LANGUAGE_NAMES } from '@/components/site/language-names'
import { setTestLocale } from '@/test/intl'
import { msg, renderWithIntl } from '@/test/render-intl'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND')
  },
}))
const isSetupRequired = vi.fn()
vi.mock('@/lib/setup-api', () => ({ isSetupRequired: () => isSetupRequired() }))

import SetupPage from './page'

type Search = Record<string, string | string[] | undefined>
const props = (searchParams: Search = {}) => ({ searchParams: Promise.resolve(searchParams) })

async function renderSetup(searchParams: Search = {}, locale: 'vi' | 'en' = 'vi') {
  setTestLocale(locale)
  return renderWithIntl(await SetupPage(props(searchParams)), { locale })
}

beforeEach(() => isSetupRequired.mockResolvedValue(true))
afterEach(() => isSetupRequired.mockReset())

describe('Setup page', () => {
  it('is a 404 when the setup is not required (completed, backend down or unreadable)', async () => {
    isSetupRequired.mockResolvedValue(false)

    await expect(SetupPage(props())).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('renders the heading and the form while the setup is required', async () => {
    await renderSetup()

    expect(screen.getByRole('heading', { level: 1, name: msg('Setup.title') })).toBeInTheDocument()
    expect(screen.getByLabelText(msg('Setup.code.label'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: msg('Setup.submit') })).toBeInTheDocument()
    expect(screen.getAllByRole('main')).toHaveLength(1)
  })

  it('follows the language of the request when no ?lang= is given', async () => {
    await renderSetup({}, 'en')

    expect(screen.getByRole('heading', { level: 1, name: msg('Setup.title', undefined, 'en') })).toBeInTheDocument()
  })

  it('?lang=en shows English while the cookie language is Vietnamese; the form follows', async () => {
    await renderSetup({ lang: 'en' }, 'vi')

    expect(screen.getByRole('heading', { level: 1, name: msg('Setup.title', undefined, 'en') })).toBeInTheDocument()
    expect(screen.getByLabelText(msg('Setup.password.label', undefined, 'en'))).toBeInTheDocument()
  })

  it.each([['fr'], ['EN'], ['<script>'], ['']])('ignores an invalid ?lang=%j', async (lang) => {
    await renderSetup({ lang }, 'vi')

    expect(screen.getByRole('heading', { level: 1, name: msg('Setup.title', undefined, 'vi') })).toBeInTheDocument()
  })

  it('offers two plain links to switch language, the current one marked', async () => {
    await renderSetup({ lang: 'en' })

    const nav = screen.getByRole('navigation', { name: msg('Language.navLabel', undefined, 'en') })
    const en = within(nav).getByRole('link', { name: LANGUAGE_NAMES.en })
    const vi = within(nav).getByRole('link', { name: LANGUAGE_NAMES.vi })
    expect(en).toHaveAttribute('href', '/setup?lang=en')
    expect(en).toHaveAttribute('aria-current', 'true')
    expect(vi).toHaveAttribute('href', '/setup?lang=vi')
    expect(vi).not.toHaveAttribute('aria-current')
  })
})
