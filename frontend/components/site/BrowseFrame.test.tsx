import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowseFrame } from './BrowseFrame'
import { BROWSE_GRID, BROWSE_MAIN } from './reader/reader-layout'

// The sidebar is an async server component with its own test; here it is a marker that records what the frame passes in.
vi.mock('./reader/SiteSidebar', () => ({
  PAGE_CONTENT_ID: 'page-content',
  SiteSidebar: ({ current, extra }: { current?: { key: string; exact: boolean }; extra?: unknown }) => (
    <aside
      data-testid="sidebar"
      data-current={current ? `${current.key}:${current.exact}` : ''}
      data-has-extra={String(Boolean(extra))}
    />
  ),
}))

afterEach(cleanup)

const tokens = (el: Element) => el.className.split(/\s+/)

describe('BrowseFrame', () => {
  it('is the browse grid with the sidebar first and the main column second', () => {
    const { container } = render(
      <BrowseFrame>
        <p>content</p>
      </BrowseFrame>,
    )

    const grid = container.firstElementChild!
    expect(grid.className).toBe(BROWSE_GRID)
    expect(grid.children).toHaveLength(2)
    expect(grid.children[0]).toBe(screen.getByTestId('sidebar'))
    expect(grid.children[1]).toHaveAttribute('id', 'page-content')
  })

  it('puts the children in the main column, the skip-link target: no tabindex, so a click on text does not move the Tab start', () => {
    render(
      <BrowseFrame>
        <h1>Title</h1>
        <p>content</p>
      </BrowseFrame>,
    )

    const main = document.getElementById('page-content')!
    expect(main).not.toHaveAttribute('tabindex')
    expect(main.className).toBe(BROWSE_MAIN)
    for (const token of BROWSE_MAIN.split(' ')) expect(tokens(main)).toContain(token)
    expect(main).toContainElement(screen.getByRole('heading', { name: 'Title' }))
    expect(main).toContainElement(screen.getByText('content'))
    expect(main).not.toContainElement(screen.getByTestId('sidebar'))
  })

  it('hands `current` and `extra` to the sidebar', () => {
    render(
      <BrowseFrame current={{ key: 'topics', exact: false }} extra={<p>group</p>}>
        <p>content</p>
      </BrowseFrame>,
    )

    expect(screen.getByTestId('sidebar')).toHaveAttribute('data-current', 'topics:false')
    expect(screen.getByTestId('sidebar')).toHaveAttribute('data-has-extra', 'true')
  })

  it('works with neither', () => {
    render(
      <BrowseFrame>
        <p>content</p>
      </BrowseFrame>,
    )

    expect(screen.getByTestId('sidebar')).toHaveAttribute('data-current', '')
    expect(screen.getByTestId('sidebar')).toHaveAttribute('data-has-extra', 'false')
  })
})

describe('the shared BrowseFrame mock', () => {
  it('shows the children and records current and extra', async () => {
    const {
      BrowseFrame: Mock,
      browseFrameCalls,
      lastBrowseFrameCall,
      resetBrowseFrameCalls,
    } = await import('@/test/browse-frame-mock')
    resetBrowseFrameCalls()
    const extra = <p>group</p>
    render(
      <Mock current={{ key: 'series', exact: true }} extra={extra}>
        <p>content</p>
      </Mock>,
    )

    const frame = screen.getByTestId('browse-frame')
    expect(frame).toHaveAttribute('data-current', 'series')
    expect(frame).toHaveAttribute('data-exact', 'true')
    expect(frame).toContainElement(screen.getByText('content'))
    expect(screen.queryByText('group')).toBeNull()
    expect(browseFrameCalls).toHaveLength(1)
    expect(lastBrowseFrameCall()).toEqual({ current: { key: 'series', exact: true }, extra })
    resetBrowseFrameCalls()
    expect(lastBrowseFrameCall()).toBeUndefined()
  })

  it('has no data-current when the page marks no section', async () => {
    const { BrowseFrame: Mock } = await import('@/test/browse-frame-mock')
    render(
      <Mock>
        <p>content</p>
      </Mock>,
    )

    expect(screen.getByTestId('browse-frame')).not.toHaveAttribute('data-current')
    expect(screen.getByTestId('browse-frame')).not.toHaveAttribute('data-exact')
  })
})
