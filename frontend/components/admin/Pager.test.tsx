import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Pager } from './Pager'
import { msg } from '@/test/render-intl'

const href = (page: number) => (page === 0 ? '/admin/comments' : `/admin/comments?page=${page}`)

describe('Pager', () => {
  it('one page draws nothing', () => {
    const { container } = render(<Pager page={0} totalPages={1} total={12} pageSize={20} unit="comment" href={href} />)

    expect(container).toBeEmptyDOMElement()
  })

  it('middle page: the range being viewed out of the total, with the unit; both directions are links that keep the filter', () => {
    render(<Pager page={1} totalPages={3} total={45} pageSize={20} unit="comment" href={href} />)

    const nav = screen.getByRole('navigation', { name: msg('Site.pagination.label') })
    expect(nav).toHaveTextContent(
      msg('Admin.common.pager.summary', { from: 21, to: 40, total: 45, unit: 'comment', page: 2, totalPages: 3 }),
    )
    expect(within(nav).getByRole('link', { name: msg('Admin.common.pager.previous') })).toHaveAttribute('href', '/admin/comments')
    expect(within(nav).getByRole('link', { name: msg('Admin.common.pager.next') })).toHaveAttribute(
      'href',
      '/admin/comments?page=2',
    )
  })

  it('the first page has no "Previous page", the last page has no "Next page"; large numbers follow vi-VN', () => {
    const { rerender } = render(<Pager page={0} totalPages={60} total={1200} pageSize={20} unit="post" href={href} />)
    expect(screen.queryByRole('link', { name: msg('Admin.common.pager.previous') })).toBeNull()
    expect(screen.getByRole('navigation')).toHaveTextContent(
      msg('Admin.common.pager.summary', { from: 1, to: 20, total: 1200, unit: 'post', page: 1, totalPages: 60 }),
    )

    rerender(<Pager page={59} totalPages={60} total={1200} pageSize={20} unit="post" href={href} />)
    expect(screen.queryByRole('link', { name: msg('Admin.common.pager.next') })).toBeNull()
    expect(screen.getByRole('navigation')).toHaveTextContent(
      msg('Admin.common.pager.summary', { from: 1181, to: 1200, total: 1200, unit: 'post', page: 60, totalPages: 60 }),
    )
  })
})
