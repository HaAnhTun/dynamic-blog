import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { defaultSiteContent } from '@/content/defaults'
import type { Contact, Profile } from '@/lib/site-content-types'
import { FEED_PATH } from '@/lib/site'
import type { PostAuthor } from '@/lib/types'
import { AuthorBox } from './AuthorBox'
import { msg } from '@/test/render-intl'
import { currentTestLocale, TEST_LOCALE, translatorFor } from '@/test/intl'

const content = defaultSiteContent(TEST_LOCALE)
const { profile } = content
const positioning = content.site.positioning
/** The packaged contact has no channel; the test fills both so the contact branch is reached. */
const contact: Contact & { email: string; github: string } = {
  ...content.contact,
  email: 'reader@example.test',
  github: 'https://github.com/example-user',
}

/** AuthorBox with the packaged content unless a test passes something else. */
function Box(props: { author?: PostAuthor; data?: Profile; contactData?: Contact }) {
  return <AuthorBox data={profile} contactData={contact} positioning={positioning} {...props} />
}

/** An author other than the site owner. */
const OTHER: PostAuthor = {
  displayName: 'Mary Example',
  githubLogin: 'maryexample',
  avatarUrl: 'https://avatars.githubusercontent.com/u/7?v=4',
  siteOwner: false,
}

/** The accessible name of the first-visit link: the catalog sentence without the decorative (aria-hidden) arrow. */
const START_HERE_NAME = String(
  (translatorFor(currentTestLocale(), 'Site.authorBox') as unknown as { rich: (key: string, values: object) => unknown }).rich(
    'startHere',
    { arrow: () => '' },
  ),
).trim()

/**
 * The author box at the end of a post: a panel like ContactSection, eyebrow [User] Author, name,
 * tagline, "About →", "First visit? Read “Best posts” →", GitHub (rel me), Mail, RSS. The avatar
 * only when the site owner has filled in a real image.
 *
 * The data is a prop (like ContactSection) so both the avatar and the contact branches can be reached
 * without mocking the content module.
 */

describe('AuthorBox', () => {
  it('is an aside named by the author, with the eyebrow "Author" and the tagline', () => {
    render(<Box />)

    const aside = screen.getByRole('complementary', { name: profile.name })
    expect(within(aside).getByText(msg('Site.authorBox.eyebrow'))).toBeInTheDocument()
    expect(within(aside).getByText(positioning)).toBeInTheDocument()
  })

  it.each([
    ['the site owner', undefined],
    ['another author', OTHER],
  ])('%s: the panel is printable and carries no margin of its own (the end slot owns the rhythm)', (_label, author) => {
    const { container } = render(<Box author={author} />)

    const aside = container.querySelector('aside')!
    expect(aside).toHaveClass('rounded-card', 'border', 'bg-neutral-50')
    expect(aside.className).not.toMatch(/mt-/)
    expect(container.innerHTML).not.toContain('print:hidden')
    expect(aside).toHaveAttribute('aria-labelledby', 'tac-gia')
    expect(aside.querySelector('#tac-gia')).not.toBeNull()
  })

  it('links to About and Best posts', () => {
    render(<Box />)

    expect(screen.getByRole('link', { name: msg('Site.footer.links.about') })).toHaveAttribute('href', '/about')
    // The first-visit prompt, not the "new here?" one: the same voice as the "if you are new…" line on the home page.
    expect(screen.getByRole('link', { name: START_HERE_NAME })).toHaveAttribute('href', '/start-here')
  })

  it('GitHub carries rel me, Mail is mailto, RSS is the feed; icons are all aria-hidden', () => {
    render(<Box />)

    const github = screen.getByRole('link', { name: 'GitHub' })
    expect(github).toHaveAttribute('href', contact.github)
    expect(github.getAttribute('rel')?.split(' ')).toContain('me')
    expect(screen.getByRole('link', { name: 'Email' })).toHaveAttribute('href', `mailto:${contact.email}`)
    expect(screen.getByRole('link', { name: 'RSS' })).toHaveAttribute('href', FEED_PATH)
    for (const name of ['GitHub', 'Email', 'RSS']) {
      expect(screen.getByRole('link', { name }).querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    }
  })

  it('with no contact filled in there is no GitHub/Email link, RSS remains', () => {
    render(<Box contactData={{ ...contact, email: null, github: null }} />)

    expect(screen.queryByRole('link', { name: 'GitHub' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Email' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'RSS' })).toBeInTheDocument()
  })

  it('no avatar when profile.avatar is null', () => {
    expect(profile.avatar).toBeNull()

    const { container } = render(<Box />)

    expect(container.querySelector('img')).toBeNull()
  })

  it('has an <img> when the site owner has filled in an avatar', () => {
    const { container } = render(<Box data={{ ...profile, avatar: '/avatar.jpg' }} />)

    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toBe('/avatar.jpg')
    // Decorative: the name right next to it already says who this is.
    expect(img).toHaveAttribute('alt', '')
  })
})

describe('AuthorBox: the site owner avatar (TODO T-004)', () => {
  const OWNER = { ...OTHER, displayName: 'admin', siteOwner: true }

  it('without profile.avatar: uses the GitHub picture of the site owner account', () => {
    const { container } = render(<Box author={OWNER} />)

    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toMatch(/^https:\/\/avatars\.githubusercontent\.com\/u\/7\?/)
    expect(img).toHaveAttribute('alt', '')
  })

  it('profile.avatar wins over the GitHub picture', () => {
    const { container } = render(<Box author={OWNER} data={{ ...profile, avatar: '/avatar.jpg' }} />)

    const imgs = container.querySelectorAll('img')
    expect(imgs).toHaveLength(1)
    expect(imgs[0]?.getAttribute('src')).toBe('/avatar.jpg')
  })

  it('no valid GitHub picture: no image, no initial-letter circle', () => {
    for (const avatarUrl of [null, 'https://evil.example/a.png']) {
      const { container, unmount } = render(<Box author={{ ...OWNER, avatarUrl }} />)
      expect(container.querySelector('img')).toBeNull()
      expect(container.querySelector('[aria-hidden="true"].rounded-full')).toBeNull()
      unmount()
    }
  })
})

describe('AuthorBox by the post author', () => {
  it('a post by the site owner: the full profile with profile.name, not the account display name', () => {
    render(<Box author={{ ...OTHER, displayName: 'admin', siteOwner: true }} />)

    const aside = screen.getByRole('complementary', { name: profile.name })
    expect(within(aside).getByText(positioning)).toBeInTheDocument()
    expect(within(aside).getByRole('link', { name: msg('Site.footer.links.about') })).toHaveAttribute('href', '/about')
    expect(screen.queryByText('admin')).not.toBeInTheDocument()
  })

  it('another author: name, GitHub picture, GitHub link without rel me; nothing of the site owner', () => {
    render(<Box author={OTHER} />)

    const aside = screen.getByRole('complementary', { name: OTHER.displayName })
    expect(within(aside).getByText(msg('Site.authorBox.eyebrow'))).toBeInTheDocument()
    expect(aside.querySelector('img')?.getAttribute('src')).toMatch(/^https:\/\/avatars\.githubusercontent\.com\/u\/7\?/)
    const github = within(aside).getByRole('link', { name: '@maryexample' })
    expect(github).toHaveAttribute('href', 'https://github.com/maryexample')
    // `rel="me"` says two identities are ONE person, the site owner: on someone else's link it is a false claim.
    expect(github.getAttribute('rel')?.split(' ')).not.toContain('me')
    // Only one link; no /about, email, tagline or site owner name.
    expect(within(aside).getAllByRole('link')).toHaveLength(1)
    expect(aside).not.toHaveTextContent(positioning)
    expect(aside).not.toHaveTextContent(profile.name)
    expect(aside.innerHTML).not.toContain(contact.email)
  })

  it('another author without a GitHub login: no link at all, no "@null"', () => {
    render(<Box author={{ ...OTHER, githubLogin: null }} />)

    const aside = screen.getByRole('complementary', { name: OTHER.displayName })
    expect(within(aside).queryAllByRole('link')).toHaveLength(0)
    expect(aside).not.toHaveTextContent('@')
  })
})

describe('AuthorBox: name and avatar lead to the profile (T-003)', () => {
  const WITH_SLUG: PostAuthor = { ...OTHER, profileSlug: 'mary-example' }

  it('another author: the name is the text of the /u/<slug> link, the decorative avatar sits inside the link; the GitHub link stays separate', () => {
    render(<Box author={WITH_SLUG} />)

    const aside = screen.getByRole('complementary', { name: OTHER.displayName })
    const link = within(aside).getByRole('link', { name: OTHER.displayName })
    expect(link).toHaveAttribute('href', '/u/mary-example')
    expect(link).toContainElement(aside.querySelector('img'))
    expect(aside.querySelector('img')).toHaveAttribute('alt', '')
    expect(within(aside).getByRole('heading', { level: 2 })).toContainElement(link)
    expect(within(aside).getByRole('link', { name: '@maryexample' })).toHaveAttribute('href', 'https://github.com/maryexample')
    expect(within(aside).getAllByRole('link')).toHaveLength(2)
  })

  it('a post by the site owner keeps the full profile, no /u/ link even with a profileSlug', () => {
    const { container } = render(<Box author={{ ...WITH_SLUG, siteOwner: true }} />)

    expect(container.querySelector('a[href^="/u/"]')).toBeNull()
    expect(screen.getByRole('link', { name: msg('Site.footer.links.about') })).toHaveAttribute('href', '/about')
  })

  it('a locked author (profileSlug null): name and avatar are plain text, only the GitHub link remains', () => {
    render(<Box author={{ ...OTHER, profileSlug: null }} />)

    const aside = screen.getByRole('complementary', { name: OTHER.displayName })
    expect(within(aside).getAllByRole('link')).toHaveLength(1)
    expect(within(aside).getByRole('link')).toHaveAccessibleName('@maryexample')
    expect(aside.querySelector('img')).toHaveAttribute('alt', '')
  })
})

describe('AuthorBox: on a phone', () => {
  it('the panel is 20px padded below sm and 32px from sm', () => {
    render(<Box />)

    expect(screen.getByRole('complementary', { name: profile.name })).toHaveClass('p-5', 'sm:p-8')
  })

  it('with an avatar the tagline spans the whole box on a phone and is auto-placed beside the avatar from sm', () => {
    render(<Box data={{ ...profile, avatar: '/media/00000000-0000-4000-8000-000000000001.jpg' }} />)

    const tagline = screen.getByText(positioning)
    expect(tagline).toHaveClass('col-span-full', 'sm:col-span-1')
    const grid = tagline.parentElement!
    expect(grid).toHaveClass('grid', 'grid-cols-[auto_minmax(0,1fr)]')
    // The avatar spans the name and the tagline from sm; below it, it sits on the line of the name alone.
    expect(grid.querySelector('img')).toHaveClass('sm:row-span-2')
  })

  it('without an avatar the text is a single column', () => {
    render(<Box />)

    const tagline = screen.getByText(positioning)
    expect(tagline.parentElement).toHaveClass('grid-cols-1')
    expect(tagline.className).not.toContain('col-span')
  })

  it('the links are a two-column grid below sm (the long one takes a row) and the wrapping row of before from sm; each is a 44px row', () => {
    render(<Box />)

    const list = screen.getByRole('link', { name: START_HERE_NAME }).closest('ul')!
    expect(list).toHaveClass('grid', 'grid-cols-2', 'sm:flex', 'sm:flex-wrap')
    expect(screen.getByRole('link', { name: START_HERE_NAME }).closest('li')).toHaveClass('col-span-2', 'sm:col-span-1')
    for (const link of list.querySelectorAll('a')) expect(link, link.outerHTML).toHaveClass('max-sm:py-3')
    // inline-block, not a flex box, for the text links: a flex box drops the space before the arrow.
    expect(screen.getByRole('link', { name: START_HERE_NAME })).toHaveClass('max-sm:inline-block')
  })
})
