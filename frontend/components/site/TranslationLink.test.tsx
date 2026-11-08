import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { msg, renderWithIntl } from '@/test/render-intl'
import { TranslationLink } from './TranslationLink'

const label = () => msg('Site.article.translations.label')

describe('TranslationLink', () => {
  it('renders nothing without a translation', () => {
    const { container, rerender } = renderWithIntl(<TranslationLink translations={undefined} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<TranslationLink translations={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('links the English translation at its /en URL with lang and hreflang, from a Vietnamese page', () => {
    renderWithIntl(<TranslationLink translations={[{ language: 'en', slug: 'hello', title: 'Hello', status: 'PUBLISHED' }]} />, {
      locale: 'vi',
    })

    const link = screen.getByRole('link', { name: 'Hello' })
    expect(link).toHaveAttribute('href', '/en/posts/hello')
    expect(link).toHaveAttribute('lang', 'en')
    expect(link).toHaveAttribute('hreflang', 'en')
    expect(screen.getByRole('navigation', { name: label() })).toBeInTheDocument()
  })

  it('links the Vietnamese translation at the unprefixed URL, from an English page', () => {
    renderWithIntl(
      <TranslationLink translations={[{ language: 'vi', slug: 'xin-chao', title: 'Xin chao', status: 'PUBLISHED' }]} />,
      {
        locale: 'en',
      },
    )

    expect(screen.getByRole('link', { name: 'Xin chao' })).toHaveAttribute('href', '/posts/xin-chao')
  })

  it('ignores a translation in a language the site does not have', () => {
    const { container } = renderWithIntl(
      <TranslationLink translations={[{ language: 'fr', slug: 'salut', title: 'Salut', status: 'PUBLISHED' }]} />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
