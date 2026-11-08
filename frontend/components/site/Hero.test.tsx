import { render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { describe, expect, it } from 'vitest'
import { BrandIcon } from '@/components/BrandIcon'
import { defaultSiteContent } from '@/content/defaults'
import { TEST_LOCALE } from '@/test/intl'
import { Hero } from './Hero'
import { msg } from '@/test/render-intl'

const { profile } = defaultSiteContent(TEST_LOCALE)

/** The packaged profile with a GitHub address the test chooses; the packaged contact has none. */
function renderHero(overrides: { github?: string | null; seeking?: string | null } = {}) {
  return render(
    <Hero
      hero={profile.hero}
      github={'github' in overrides ? overrides.github! : 'https://github.com/example-user'}
      seeking={'seeking' in overrides ? overrides.seeking! : profile.seeking}
      location={profile.location}
    />,
  )
}

/** The drawn part of an icon; see the comment of the same name in Header.test.tsx. */
function glyphOf(icon: ReactElement): string {
  const { container, unmount } = render(icon)
  const markup = container.querySelector('svg')!.innerHTML
  unmount()
  return markup
}

describe('Hero', () => {
  it('renders the greeting, the headline as the only h1, and the subline', () => {
    const { container } = renderHero()

    expect(screen.getByText(profile.hero.greeting)).toBeInTheDocument()
    expect(screen.getByText(profile.hero.subline)).toBeInTheDocument()

    const h1s = container.querySelectorAll('h1')
    expect(h1s).toHaveLength(1)
    // The headline, not the greeting and not the name. The name is already in the site
    // header and the document title; an h1 that repeats it says nothing about the site.
    expect(h1s[0]?.textContent).toBe(profile.hero.headline)
  })

  it('shows the GitHub link when the content has one', () => {
    renderHero()

    const github = screen.getByRole('link', { name: 'GitHub' })
    expect(github).toHaveAttribute('href', 'https://github.com/example-user')
    expect(github.getAttribute('rel')).toMatch(/\bme\b/)
    expect(screen.getByRole('link', { name: msg('Site.hero.readPosts') })).toHaveAttribute('href', '/writing')
    expect(screen.getByRole('link', { name: msg('Site.footer.links.about') })).toHaveAttribute('href', '/about')
    expect(screen.getAllByRole('link')).toHaveLength(3)
    // No placeholder: no link points to the github.com home page of nobody.
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).not.toContain('https://github.com/')
  })

  it('puts the GitHub mark beside the GitHub text, hidden from screen readers', () => {
    renderHero()

    // Exact name "GitHub": the aria-hidden mark contributes nothing to the link's name.
    const marks = screen.getByRole('link', { name: 'GitHub' }).querySelectorAll('svg')
    expect(marks).toHaveLength(1)
    expect(marks[0]).toHaveAttribute('aria-hidden', 'true')
    expect(marks[0]).toHaveAttribute('focusable', 'false')
    expect(marks[0]!.innerHTML).toBe(glyphOf(<BrandIcon name="github" />))

    // The "absent" pair: the two invitations to read stay plain text. The brand mark says "this link leaves the site,
    // to GitHub"; on an internal link it says nothing.
    expect(screen.getByRole('link', { name: msg('Site.hero.readPosts') }).querySelector('svg')).toBeNull()
    expect(screen.getByRole('link', { name: msg('Site.footer.links.about') }).querySelector('svg')).toBeNull()
  })

  it('looks finished with no GitHub link when the field is null', () => {
    // The other branch, still reachable: the content file's rule is that an invented
    // identity is worse than none, so the owner may clear the field. The two calls to
    // action then have to carry the hero by themselves.
    renderHero({ github: null })

    expect(screen.queryByRole('link', { name: /github/i })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: msg('Site.hero.readPosts') })).toHaveAttribute('href', '/writing')
    expect(screen.getByRole('link', { name: msg('Site.footer.links.about') })).toHaveAttribute('href', '/about')
    expect(screen.getAllByRole('link')).toHaveLength(2)
  })

  it('names the calls to action by their label alone, with the arrow hidden', () => {
    renderHero()

    const link = screen.getByRole('link', { name: msg('Site.hero.readPosts') })
    // Exact name: without aria-hidden on the arrow this announces as
    // "<link text> right arrow" and the query above fails.
    expect(link.querySelector('[aria-hidden="true"]')?.textContent).toBe('→')
  })

  it('adds a GitHub link when the field is filled in, normalising a bare username', () => {
    renderHero({ github: 'octocat' })

    const link = screen.getByRole('link', { name: 'GitHub' })
    // `href="octocat"` would be a relative path on this site and 404 with no error
    // anywhere — the field is documented as "a URL or a username".
    expect(link).toHaveAttribute('href', 'https://github.com/octocat')
    expect(link).toHaveAttribute('rel', expect.stringContaining('me'))
    expect(screen.getAllByRole('link')).toHaveLength(3)
  })

  it('leaves a full GitHub URL alone', () => {
    renderHero({ github: 'https://github.com/octocat' })

    expect(screen.getByRole('link', { name: 'GitHub' })).toHaveAttribute('href', 'https://github.com/octocat')
  })

  it('treats an empty string as no GitHub at all', () => {
    // An empty string is absence wearing a different type. Rendering it would produce a
    // link to https://github.com/ labelled GitHub, which points at nobody.
    renderHero({ github: '' })

    expect(screen.queryByRole('link', { name: 'GitHub' })).not.toBeInTheDocument()
  })

  it('invents no GitHub statistics', () => {
    // Scoped to the links row rather than the whole hero, so an author editing the
    // headline cannot fail this test by writing a number in their own prose. What it
    // guards is the thing that would be fabricated: a follower or star count badge
    // beside the GitHub link. There is no such data anywhere in this repository.
    const { container } = renderHero({ github: 'octocat' })

    const actions = container.querySelector('ul')
    expect(actions).not.toBeNull()
    expect(actions!.textContent).not.toMatch(/\d/)
  })

  it('renders a header that is not the banner, and no <main>', () => {
    const { container } = renderHero()

    // <header> inside app/layout.tsx's <main> is a generic, not a second banner; and the
    // page must never emit its own <main>.
    expect(container.querySelector('header')).not.toBeNull()
    expect(container.querySelector('main')).toBeNull()
  })
})

describe('Hero — the job direction being sought', () => {
  it('prints nothing when seeking is null', () => {
    renderHero({ seeking: null })

    expect(screen.queryByText(new RegExp(profile.location))).not.toBeInTheDocument()
  })

  it('prints the location with the job direction once there is a value', () => {
    renderHero({ seeking: 'focus on backend and automation' })

    expect(screen.getByText(`${profile.location} · focus on backend and automation`)).toBeInTheDocument()
  })

  it('treats an empty string as not filled in', () => {
    // A line that only has a city and a dot is worse than no line at all.
    renderHero({ seeking: '' })

    expect(screen.queryByText(new RegExp(profile.location))).not.toBeInTheDocument()
  })

  describe('bare', () => {
    it('renders the header without a Container and without vertical padding', () => {
      const { container } = render(
        <Hero bare hero={profile.hero} github={null} seeking={profile.seeking} location={profile.location} />,
      )
      const root = container.firstElementChild as HTMLElement

      expect(root.tagName).toBe('HEADER')
      expect(root.className).toBe('')
      expect(container.querySelectorAll('h1')).toHaveLength(1)
      // The headline keeps its own measure: the cell decides the width, the h1 never goes wider than max-w-3xl.
      expect(container.querySelector('h1')!.className).toContain('max-w-3xl')
    })

    it('keeps the Container and its padding by default', () => {
      const { container } = renderHero()
      const root = container.firstElementChild as HTMLElement

      expect(root.className).toContain('mx-auto')
      expect(root.className).toContain('pt-12')
    })
  })
})
