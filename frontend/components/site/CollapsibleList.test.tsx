import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { msg, renderWithIntl } from '@/test/render-intl'
import { CollapsibleList } from './CollapsibleList'
import { COLLAPSED_ITEMS, HighlightList } from './entry-parts'

const ITEMS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven']

describe('CollapsibleList', () => {
  it('keeps the whole list in the page and hides the items after the third below sm only, with one button for the rest', () => {
    const { container } = renderWithIntl(<HighlightList items={ITEMS} collapse />)

    // Every item is in the HTML (the server draws all of them): only a CSS rule hides some, and only below sm.
    expect(container.querySelectorAll('li')).toHaveLength(ITEMS.length)
    const box = container.querySelector('[data-expanded]')!
    expect(box).toHaveAttribute('data-expanded', 'false')
    expect(box.className).toContain('data-[expanded=false]:max-sm:[&_li:nth-child(n+4)]:hidden')
    expect(COLLAPSED_ITEMS).toBe(3)

    const button = screen.getByRole('button', { name: msg('Site.entry.showMore', { count: ITEMS.length - COLLAPSED_ITEMS }) })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(button).toHaveAttribute('aria-controls', box.id)
    // A phone-only control: from sm nothing is collapsed, so there is nothing to press.
    expect(button).toHaveClass('sm:hidden', 'min-h-11')
  })

  it('opens and closes: the state is on the box, the label and aria-expanded follow it', () => {
    const { container } = renderWithIntl(<HighlightList items={ITEMS} collapse />)
    const box = container.querySelector('[data-expanded]')!

    fireEvent.click(screen.getByRole('button'))
    expect(box).toHaveAttribute('data-expanded', 'true')
    expect(screen.getByRole('button', { name: msg('Site.entry.showLess') })).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(screen.getByRole('button'))
    expect(box).toHaveAttribute('data-expanded', 'false')
    expect(screen.getByRole('button', { name: msg('Site.entry.showMore', { count: 4 }) })).toBeInTheDocument()
  })

  it('a list of three or fewer items is a plain list: no wrapper and no button', () => {
    const { container } = renderWithIntl(<HighlightList items={ITEMS.slice(0, COLLAPSED_ITEMS)} collapse />)

    expect(container.querySelector('[data-expanded]')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(container.querySelectorAll('li')).toHaveLength(COLLAPSED_ITEMS)
  })

  it('without `collapse` a long list is never collapsed (the home page keeps all its bullets)', () => {
    const { container } = renderWithIntl(<HighlightList items={ITEMS} />)

    expect(container.querySelector('[data-expanded]')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('counts the hidden items in the language of the page', () => {
    renderWithIntl(
      <CollapsibleList hidden={2}>
        <ul>
          {ITEMS.slice(0, 5).map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </CollapsibleList>,
      { locale: 'en' },
    )

    expect(screen.getByRole('button')).toHaveTextContent(msg('Site.entry.showMore', { count: 2 }, 'en'))
  })

  it('the highlights are 15px on a phone and 14px from sm: the main content of an entry is not metadata', () => {
    const { container } = renderWithIntl(<HighlightList items={ITEMS.slice(0, 2)} />)

    expect(container.querySelector('ul')).toHaveClass('text-[0.9375rem]', 'sm:text-sm')
  })
})
