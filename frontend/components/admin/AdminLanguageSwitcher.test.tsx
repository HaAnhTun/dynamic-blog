import { screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LANGUAGE_NAMES } from '@/components/site/language-names'
import { msg, renderWithIntl } from '@/test/render-intl'

const pathname = vi.hoisted(() => ({ value: '/admin/series' }))
vi.mock('next/navigation', () => ({ usePathname: () => pathname.value }))
vi.mock('@/app/admin/language-action', () => ({ setAdminLocale: vi.fn() }))

import AdminLanguageSwitcher from './AdminLanguageSwitcher'

describe('AdminLanguageSwitcher', () => {
  it('is a form with one submit button per language, the current one pressed', () => {
    const { container } = renderWithIntl(<AdminLanguageSwitcher />, { locale: 'vi' })

    const group = screen.getByRole('group', { name: msg('Admin.language.label') })
    const buttons = within(group).getAllByRole('button')
    expect(buttons.map((b) => [b.textContent, b.getAttribute('name'), b.getAttribute('value'), b.getAttribute('type')])).toEqual([
      [LANGUAGE_NAMES.vi, 'locale', 'vi', 'submit'],
      [LANGUAGE_NAMES.en, 'locale', 'en', 'submit'],
    ])
    expect(screen.getByRole('button', { name: LANGUAGE_NAMES.vi })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: LANGUAGE_NAMES.en })).toHaveAttribute('aria-pressed', 'false')
    expect(container.querySelector('form')).toContainElement(buttons[0]!)
  })

  it('sends the current admin page as returnTo', () => {
    const { container } = renderWithIntl(<AdminLanguageSwitcher />, { locale: 'vi' })

    expect(container.querySelector<HTMLInputElement>('input[name="returnTo"]')).toHaveValue('/admin/series')
  })

  it('keeps the query of the page (the forbidden notice, list filters) once mounted', () => {
    window.history.pushState({}, '', '/admin/series?reason=forbidden')
    const { container } = renderWithIntl(<AdminLanguageSwitcher />, { locale: 'vi' })

    expect(container.querySelector<HTMLInputElement>('input[name="returnTo"]')).toHaveValue('/admin/series?reason=forbidden')
    window.history.pushState({}, '', '/')
  })

  it('in English the group is named in English and English is the pressed one', () => {
    renderWithIntl(<AdminLanguageSwitcher />, { locale: 'en' })

    expect(screen.getByRole('group', { name: msg('Admin.language.label', undefined, 'en') })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: LANGUAGE_NAMES.en })).toHaveAttribute('aria-pressed', 'true')
  })
})
