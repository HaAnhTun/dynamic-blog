import { render, screen, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { describe, expect, it } from 'vitest'
import { BrandIcon } from '@/components/BrandIcon'
import { MailIcon } from '@/components/icons'
import type { Contact } from '@/lib/site-content-types'
import { msg } from '@/test/intl'
import { ContactSection, githubLabel, githubUrl } from './ContactSection'

/** The painted part of an icon; see the comment of the same name in Header.test.tsx. */
function glyphOf(icon: ReactElement): string {
  const { container, unmount } = render(icon)
  const markup = container.querySelector('svg')!.innerHTML
  unmount()
  return markup
}

const fixture = (overrides: Partial<Contact> = {}): Contact => ({
  email: null,
  github: null,
  blurb: 'Get in touch.',
  social: [],
  ...overrides,
})

describe('ContactSection', () => {
  it('shows the email and GitHub when both are filled in', () => {
    const filled = fixture({ email: 'reader@example.test', github: 'https://github.com/example-user' })
    const { container } = render(<ContactSection data={filled} />)

    expect(screen.getByText(filled.blurb)).toBeInTheDocument()
    const email = screen.getByRole('link', { name: 'reader@example.test' })
    expect(email).toHaveAttribute('href', 'mailto:reader@example.test')
    const github = screen.getByRole('link', { name: 'example-user' })
    expect(github).toHaveAttribute('href', 'https://github.com/example-user')
    expect(github.getAttribute('rel')).toMatch(/\bme\b/)
    expect(screen.getAllByRole('link')).toHaveLength(2)

    // No placeholder leaks out next to the real data: no empty mailto, no GitHub link
    // pointing at the github.com home page, no "null"/"undefined" text from the template.
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'))
    expect(hrefs).not.toContain('mailto:')
    expect(hrefs).not.toContain('https://github.com/')
    expect(container.textContent).not.toMatch(/\b(null|undefined)\b/)
  })

  it('renders prose and no links at all when both fields are null', () => {
    // The other branch: an invented address is worse than no address, so the owner may clear either field. The section
    // then has to read as finished rather than as a section waiting for data.
    const { container } = render(<ContactSection data={fixture()} />)

    expect(screen.getByText('Get in touch.')).toBeInTheDocument()
    expect(screen.queryAllByRole('link')).toHaveLength(0)
    // The list is absent, not empty. An empty <ul> still takes its top margin, leaving a
    // gap under the blurb that looks like something failed to load.
    expect(container.querySelector('ul')).toBeNull()
  })

  it('renders an email as a mailto link when there is one', () => {
    render(<ContactSection data={fixture({ email: 'a@b.test' })} />)

    expect(screen.getByRole('link', { name: 'a@b.test' })).toHaveAttribute('href', 'mailto:a@b.test')
    // rel="me" is a claim about identity and says nothing on a mailto.
    expect(screen.getByRole('link', { name: 'a@b.test' })).not.toHaveAttribute('rel')
  })

  it('renders a GitHub username as an absolute URL', () => {
    render(<ContactSection data={fixture({ github: 'octocat' })} />)

    const link = screen.getByRole('link', { name: 'octocat' })
    // `href="octocat"` is a relative path on this site: it would 404 with no error anywhere.
    expect(link).toHaveAttribute('href', 'https://github.com/octocat')
    expect(link).toHaveAttribute('rel', 'me noreferrer')
  })

  it('puts the Mail icon next to the email and the GitHub mark next to GitHub, the link name stays the address', () => {
    render(<ContactSection data={fixture({ email: 'a@b.test', github: 'octocat' })} />)

    // getByRole with the exact name: an aria-hidden icon adds nothing to the link name.
    for (const [name, icon] of [
      ['a@b.test', <MailIcon key="mail" />],
      ['octocat', <BrandIcon key="github" name="github" />],
    ] as const) {
      const svgs = screen.getByRole('link', { name }).querySelectorAll('svg')
      expect(svgs, name).toHaveLength(1)
      expect(svgs[0]).toHaveAttribute('aria-hidden', 'true')
      expect(svgs[0]).toHaveAttribute('focusable', 'false')
      expect(svgs[0]!.innerHTML, name).toBe(glyphOf(icon))
    }
    // The icon only goes with its own link: the intro paragraph has no icon.
    expect(screen.getByText('Get in touch.').querySelector('svg')).toBeNull()
  })

  it('lists the email before the GitHub link when both exist', () => {
    render(<ContactSection data={fixture({ email: 'a@b.test', github: 'octocat' })} />)

    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([
      'mailto:a@b.test',
      'https://github.com/octocat',
    ])
  })
})

describe('ContactSection form and info cards', () => {
  it('keeps the blurb and links and adds the form below them, in both modes', () => {
    const filled = fixture({ email: 'reader@example.test', github: 'example-user' })
    for (const bare of [false, true]) {
      const { container, unmount } = render(<ContactSection bare={bare} data={filled} />)

      const form = container.querySelector('form')!
      expect(form).not.toBeNull()
      expect(within(form).getByRole('button', { name: msg('Site.contact.form.submit') })).toBeInTheDocument()
      const blurb = screen.getByText('Get in touch.')
      expect(blurb.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(screen.getAllByRole('link')).toHaveLength(2)
      unmount()
    }
  })

  it('shows the two info cards after the form, in two columns from lg', () => {
    const { container } = render(<ContactSection data={fixture()} />)

    const grid = container.querySelector('form')!.parentElement!
    expect(grid.className).toContain('lg:grid-cols-')
    expect(grid.firstElementChild).toBe(container.querySelector('form'))
    const cards = grid.lastElementChild as HTMLElement
    const titles = within(cards)
      .getAllByRole('heading', { level: 3 })
      .map((heading) => heading.textContent)
    expect(titles).toEqual([msg('Site.contact.info.expectTitle'), msg('Site.contact.info.responseTitle')])
    for (const key of ['expectReply', 'expectWelcome', 'responseBody']) {
      expect(within(cards).getByText(msg(`Site.contact.info.${key}`))).toBeInTheDocument()
    }
  })
})

describe('githubUrl', () => {
  it('leaves an absolute URL alone', () => {
    expect(githubUrl('https://github.com/octocat')).toBe('https://github.com/octocat')
    expect(githubUrl('http://github.com/octocat')).toBe('http://github.com/octocat')
  })

  it('builds a URL from a username, with or without the @', () => {
    expect(githubUrl('octocat')).toBe('https://github.com/octocat')
    expect(githubUrl('@octocat')).toBe('https://github.com/octocat')
  })
})

describe('githubLabel', () => {
  it('shows the username, whichever form the data used', () => {
    expect(githubLabel('octocat')).toBe('octocat')
    expect(githubLabel('https://github.com/octocat')).toBe('octocat')
    expect(githubLabel('https://www.github.com/octocat/')).toBe('octocat')
  })

  it('never returns an empty label', () => {
    // An empty link text is unreachable by a screen reader and invisible to a mouse.
    expect(githubLabel('https://github.com/')).toBe('GitHub')
  })

  describe('bare', () => {
    it('renders the section without a Container and without vertical padding', () => {
      const { container } = render(<ContactSection bare data={fixture({ blurb: 'Hello.' })} />)
      const root = container.firstElementChild as HTMLElement

      expect(root.tagName).toBe('SECTION')
      expect(root.className).not.toContain('mx-auto')
      expect(root.className).not.toContain('px-4')
      expect(root.className).not.toContain('max-w-')
      expect(root.className).not.toMatch(/(^|\s)(sm:)?py-/)
    })

    it('keeps the Container and the padding by default', () => {
      const { container } = render(<ContactSection data={fixture({ blurb: 'Hello.' })} />)
      const root = container.firstElementChild as HTMLElement

      expect(root.className).toContain('mx-auto')
      expect(root.className).toContain('py-')
    })
  })

  it('lays the blurb left and the links right from lg, in both modes', () => {
    const filled = fixture({ email: 'reader@example.test', github: 'example-user' })
    for (const bare of [false, true]) {
      const { container, unmount } = render(<ContactSection bare={bare} data={filled} />)

      const card = container.querySelector('.rounded-card')!
      expect(card.className).toContain('lg:flex')
      expect(card.className).toContain('lg:items-center')
      expect(card.className).toContain('lg:justify-between')
      expect(card.querySelector('p')!.className).toContain('max-w-2xl')
      expect(card.querySelector('ul')).not.toBeNull()
      unmount()
    }
  })
})
