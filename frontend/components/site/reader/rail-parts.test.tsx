import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ArchiveIcon, NewspaperIcon, StarIcon } from '@/components/icons'
import { ACTIVE, ExploreGroup, LINK, type Section } from './rail-parts'

afterEach(cleanup)

const LINKS: Section[] = [
  { key: 'latest', href: '/writing', label: 'Latest', Icon: NewspaperIcon },
  { key: 'archive', href: '/archive', label: 'Archive', Icon: ArchiveIcon },
  { key: 'best', href: '/start-here', label: 'Best', Icon: StarIcon },
]

const classesOf = (el: Element) => el.className.split(/\s+/)

describe('ExploreGroup without current and landmark (the post page)', () => {
  it('is an eyebrow and a list named by it, with no navigation landmark and no row marked', () => {
    render(<ExploreGroup title="Explore" links={LINKS} suffix="" />)

    expect(screen.queryByRole('navigation')).toBeNull()
    expect(screen.getByRole('list', { name: 'Explore' })).toHaveAttribute('aria-labelledby', 'rail-explore')
    expect(screen.getByText('Explore').closest('p')).toHaveAttribute('id', 'rail-explore')
    const links = screen.getAllByRole('link')
    expect(links.map((a) => a.textContent)).toEqual(['Latest', 'Archive', 'Best'])
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/writing', '/archive', '/start-here'])
    for (const link of links) {
      expect(link).not.toHaveAttribute('aria-current')
      for (const token of LINK.split(' ')) expect(classesOf(link)).toContain(token)
    }
  })

  it('appends the suffix to the id', () => {
    render(<ExploreGroup title="Explore" links={LINKS} suffix="-m" />)

    expect(screen.getByRole('list', { name: 'Explore' })).toHaveAttribute('aria-labelledby', 'rail-explore-m')
  })

  it('marks nothing when `current` names a key that is not in the list', () => {
    render(<ExploreGroup title="Explore" links={LINKS} suffix="" current={{ key: 'topics', exact: true }} />)

    expect(document.querySelectorAll('[aria-current]')).toHaveLength(0)
  })
})

describe('ExploreGroup with current', () => {
  it('marks the exact page with aria-current="page" and the active fill, still as a link', () => {
    render(<ExploreGroup title="Explore" links={LINKS} suffix="" current={{ key: 'archive', exact: true }} />)

    const marked = document.querySelectorAll('[aria-current]')
    expect(marked).toHaveLength(1)
    expect(marked[0]).toBe(screen.getByRole('link', { name: 'Archive' }))
    expect(marked[0]).toHaveAttribute('aria-current', 'page')
    expect(marked[0]!.tagName).toBe('A')
    for (const token of ACTIVE.split(' ')) expect(classesOf(marked[0]!)).toContain(token)
    expect(classesOf(marked[0]!)).not.toContain('text-neutral-700')
  })

  it('marks a descendant page with aria-current="true"', () => {
    render(<ExploreGroup title="Explore" links={LINKS} suffix="" current={{ key: 'latest', exact: false }} />)

    expect(screen.getByRole('link', { name: 'Latest' })).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('link', { name: 'Archive' })).not.toHaveAttribute('aria-current')
  })

  it('leaves the other rows exactly as they are without `current`', () => {
    render(<ExploreGroup title="Explore" links={LINKS} suffix="" current={{ key: 'latest', exact: true }} />)

    for (const name of ['Archive', 'Best']) expect(screen.getByRole('link', { name }).className).toBe(LINK)
  })
})

describe('ExploreGroup with landmark', () => {
  it('wraps the list in a navigation named by the eyebrow; the list loses its own name', () => {
    render(<ExploreGroup title="Explore" links={LINKS} suffix="-m" landmark />)

    const nav = screen.getByRole('navigation', { name: 'Explore' })
    expect(nav).toHaveAttribute('aria-labelledby', 'rail-explore-m')
    const list = within(nav).getByRole('list')
    expect(list).not.toHaveAttribute('aria-labelledby')
    expect(within(list).getAllByRole('link')).toHaveLength(3)
  })
})
