import { act, fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { msg, renderWithIntl } from '@/test/render-intl'
import { LANGUAGE_NAMES } from './language-names'
import { LanguageSwitcher, SwitcherTargets } from './LanguageSwitcher'

const pathname = vi.hoisted(() => ({ value: '/' }))
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  usePathname: () => pathname.value,
}))

describe('LanguageSwitcher', () => {
  it('is a named navigation with a pill that names the current language and one row per language', () => {
    pathname.value = '/'
    renderWithIntl(<LanguageSwitcher />, { locale: 'vi' })

    const nav = screen.getByRole('navigation', { name: msg('Language.navLabel') })
    expect(nav.querySelector('summary')).toHaveAttribute('aria-label', `${msg('Language.navLabel')}: ${LANGUAGE_NAMES.vi}`)
    expect(
      within(nav)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([LANGUAGE_NAMES.vi, LANGUAGE_NAMES.en])
    expect(nav.querySelector('details')).not.toHaveAttribute('open')
  })

  it('keeps the current page: the Vietnamese page links to its /en counterpart, with lang and hreflang', () => {
    pathname.value = '/posts/bai-viet'
    renderWithIntl(<LanguageSwitcher />, { locale: 'vi' })

    const link = screen.getByRole('link', { name: 'English' })
    expect(link).toHaveAttribute('href', '/en/posts/bai-viet')
    expect(link).toHaveAttribute('lang', 'en')
    expect(link).toHaveAttribute('hreflang', 'en')
    expect(screen.getByText(LANGUAGE_NAMES.vi).closest('[aria-current="true"]')).toHaveAttribute('lang', 'vi')
    expect(screen.getByText(LANGUAGE_NAMES.vi).closest('a')).toBeNull()
  })

  it('the home page of the English site links to the unprefixed home page', () => {
    pathname.value = '/en'
    renderWithIntl(<LanguageSwitcher />, { locale: 'en' })

    const link = screen.getByRole('link', { name: LANGUAGE_NAMES.vi })
    expect(link).toHaveAttribute('href', '/')
    expect(screen.getByText('English').closest('[aria-current="true"]')).not.toBeNull()
    expect(screen.getByRole('navigation', { name: msg('Language.navLabel', undefined, 'en') })).toBeInTheDocument()
  })
})

describe('LanguageSwitcher on an article with a translation', () => {
  it('links the other language to the translation, and goes back to the same path when the article is gone', () => {
    pathname.value = '/posts/bai-viet'
    const { unmount } = renderWithIntl(
      <>
        <SwitcherTargets targets={{ vi: '/posts/bai-viet', en: '/posts/the-article' }} />
        <LanguageSwitcher />
      </>,
      { locale: 'vi' },
    )

    expect(screen.getByRole('link', { name: 'English' })).toHaveAttribute('href', '/en/posts/the-article')
    unmount()

    renderWithIntl(<LanguageSwitcher />, { locale: 'vi' })
    expect(screen.getByRole('link', { name: 'English' })).toHaveAttribute('href', '/en/posts/bai-viet')
  })

  it('from the English translation the Vietnamese link is the unprefixed original', () => {
    pathname.value = '/posts/the-article'
    renderWithIntl(
      <>
        <SwitcherTargets targets={{ vi: '/posts/bai-viet', en: '/posts/the-article' }} />
        <LanguageSwitcher />
      </>,
      { locale: 'en' },
    )

    expect(screen.getByRole('link', { name: LANGUAGE_NAMES.vi })).toHaveAttribute('href', '/posts/bai-viet')
  })
})

describe('LanguageSwitcher dropdown', () => {
  const open = (container: HTMLElement) => {
    const details = container.querySelector('details')!
    act(() => {
      details.open = true
      details.dispatchEvent(new Event('toggle'))
    })
    return details
  }
  const keyListeners = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.filter(([type]) => String(type).startsWith('key')).length

  it('listens for nothing while closed, and for Escape and presses outside only while open', () => {
    pathname.value = '/'
    const onDocument = vi.spyOn(document, 'addEventListener')
    const onWindow = vi.spyOn(window, 'addEventListener')
    const { container } = renderWithIntl(<LanguageSwitcher />, { locale: 'vi' })
    expect(keyListeners(onDocument)).toBe(0)
    expect(keyListeners(onWindow)).toBe(0)

    open(container)
    expect(onDocument.mock.calls.map(([type]) => type).sort()).toEqual(['keydown', 'pointerdown'])
    expect(keyListeners(onWindow)).toBe(0)
    onDocument.mockRestore()
    onWindow.mockRestore()
  })

  it('Escape closes it and gives the focus back to the pill; a press outside closes it too', () => {
    pathname.value = '/'
    const { container } = renderWithIntl(<LanguageSwitcher />, { locale: 'vi' })
    const details = open(container)

    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(details).not.toHaveAttribute('open')
    expect(container.querySelector('summary')).toHaveFocus()

    open(container)
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true })
    expect(details).toHaveAttribute('open')
    fireEvent.pointerDown(document.body)
    expect(details).not.toHaveAttribute('open')
  })
})
