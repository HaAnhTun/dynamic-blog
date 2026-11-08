import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { HeroAuthor, HeroSeries } from '@/lib/reader-hero'
import type { Post, PostSummary } from '@/lib/types'
import { currentTestLocale, translatorFor } from '@/test/intl'
import { msg } from '@/test/render-intl'
import { ArticleHero, type ArticleHeroProps } from './ArticleHero'
import { HERO_BUTTON } from './hero-button'

const locale = currentTestLocale()
const t = translatorFor(locale, 'Site.article')
const tReader = translatorFor(locale, 'Site.reader')

const POST: Post = {
  id: 'p1',
  title: 'Measuring the cost of a cache miss',
  slug: 'measuring-cache-miss',
  excerpt: 'A short dek that says what the post is about.',
  status: 'PUBLISHED',
  category: { id: 'c1', name: 'Architecture', slug: 'architecture', description: null },
  tags: [{ id: 't1', name: 'Lessons Learned', slug: 'lessons-learned' }],
  publishedAt: '2026-09-28T17:30:00Z',
  featured: false,
  readingMinutes: 7,
  content: 'body',
  createdAt: '2026-09-28T17:30:00Z',
  updatedAt: '2026-10-02T09:00:00Z',
}

const AUTHOR: HeroAuthor = { name: 'Site Owner', avatar: null, href: '/about' }
const SERIES: HeroSeries = { title: 'AI Engineer Roadmap', slug: 'ai-roadmap', badge: { current: 3, total: 7 } }
const TARGET: PostSummary = {
  id: 'p4',
  title: 'Part four',
  slug: 'part-four',
  excerpt: null,
  status: 'PUBLISHED',
  category: null,
  tags: [],
  publishedAt: null,
  featured: false,
  readingMinutes: 3,
}

function hero(props: Partial<ArticleHeroProps> = {}) {
  return render(
    <ArticleHero
      post={POST}
      locale={locale}
      language={locale}
      t={t}
      tReader={tReader}
      author={AUTHOR}
      series={SERIES}
      next={{ kind: 'part', post: TARGET }}
      published
      {...props}
    />,
  )
}

const header = (container: HTMLElement) => container.querySelector('header[data-reader-hero]') as HTMLElement
const actions = () => screen.queryByRole('group', { name: msg('Site.reader.actionsLabel') })
const nextLink = (label: string) =>
  screen.queryByRole('link', { name: (name) => name.startsWith(label) && name.endsWith(TARGET.title) })

describe('ArticleHero', () => {
  it('is one <header data-reader-hero> with exactly one h1 holding the title', () => {
    const { container } = hero()

    expect(container.querySelectorAll('header')).toHaveLength(1)
    expect(header(container)).toBeInTheDocument()
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(POST.title)
  })

  it('keeps the DOM order: breadcrumb, meta row, h1, dek, tags, author row', () => {
    const { container } = hero()
    const root = header(container)

    const breadcrumb = within(root).getByRole('navigation', { name: msg('Site.breadcrumb.label') })
    const meta = root.querySelector('time')!
    const h1 = within(root).getByRole('heading', { level: 1 })
    const dek = within(root).getByText(POST.excerpt!)
    const tags = within(root).getByRole('list', { name: msg('Site.article.tagsLabel') })
    const subscribe = within(root).getByRole('link', { name: msg('Site.reader.subscribe') })

    const order = [breadcrumb, meta, h1, dek, tags, subscribe]
    for (let i = 0; i < order.length - 1; i++) {
      expect(order[i]!.compareDocumentPosition(order[i + 1]!) & Node.DOCUMENT_POSITION_FOLLOWING, `step ${i}`).toBeTruthy()
    }
  })

  it('h1 is 30 / 36 / 44px', () => {
    hero()

    expect(screen.getByRole('heading', { level: 1 })).toHaveClass('text-3xl', 'sm:text-4xl', 'xl:text-[2.75rem]')
  })

  it('a series post: badge 03 / 07 (decorative) with a text equivalent, and the series title as a link, before the date', () => {
    const { container } = hero()
    const root = header(container)

    expect(within(root).getByText('03 / 07')).toHaveAttribute('aria-hidden', 'true')
    expect(within(root).getByText(msg('Site.reader.partBadge', { current: 3, total: 7 }))).toHaveClass('sr-only')
    const link = within(root).getByRole('link', { name: SERIES.title })
    expect(link).toHaveAttribute('href', '/series/ai-roadmap')
    expect(link.compareDocumentPosition(root.querySelector('time')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('the series badge and title are on the meta row from lg only: below it the series card above the hero names the series', () => {
    const { container } = hero()

    const link = within(header(container)).getByRole('link', { name: SERIES.title })
    const wrapper = link.parentElement!
    // `contents`: the badge and the link stay direct flex items of the meta row; `max-lg:hidden` takes both off the phone.
    expect(wrapper).toHaveClass('contents', 'max-lg:hidden')
    expect(wrapper).toContainElement(screen.getByText('03 / 07'))
  })

  it('the title leads at 1.2 on a phone (stacked Vietnamese marks) and at 1.1 from sm; the dek is 17px on a phone', () => {
    hero()

    expect(screen.getByRole('heading', { level: 1 })).toHaveClass('leading-[1.2]', 'sm:leading-[1.1]')
    expect(screen.getByText(POST.excerpt!)).toHaveClass('text-[1.0625rem]', 'leading-[1.6]', 'sm:text-lg')
  })

  it('a series whose model failed to load: the title without the badge', () => {
    hero({ series: { ...SERIES, badge: null } })

    expect(screen.getByRole('link', { name: SERIES.title })).toBeInTheDocument()
    expect(screen.queryByText('03 / 07')).toBeNull()
  })

  it('a post in no series has neither badge nor series title', () => {
    hero({ series: null })

    expect(screen.queryByText('03 / 07')).toBeNull()
    expect(screen.queryByRole('link', { name: SERIES.title })).toBeNull()
    expect(screen.queryByText(msg('Site.reader.partBadge', { current: 3, total: 7 }))).toBeNull()
  })

  it('shows the dates and the reading time, and the views when worth showing', () => {
    const { container } = hero({ post: { ...POST, viewCount: 1500 } })

    expect(header(container).querySelectorAll('time')).toHaveLength(2)
    expect(screen.getByText(msg('Site.article.readingTime', { minutes: 7 }))).toBeInTheDocument()
    expect(header(container)).toHaveTextContent(/1[.,]5/)
  })

  it('omits the dek and the tag list when the post has none', () => {
    hero({ post: { ...POST, excerpt: '  ', tags: [] } })

    expect(screen.queryByText(POST.excerpt!)).toBeNull()
    expect(screen.queryByRole('list', { name: msg('Site.article.tagsLabel') })).toBeNull()
  })

  describe('author row', () => {
    it('the name links to the profile, with a 44px hit area on a phone', () => {
      hero()

      const name = screen.getByRole('link', { name: 'Site Owner' })
      expect(name).toHaveAttribute('href', '/about')
      expect(name).toHaveClass('relative', 'after:absolute', 'after:-inset-y-2.5', 'max-sm:h-11', 'max-sm:items-center')
    })

    it('another author with a slug links to /u/<slug>', () => {
      hero({ author: { name: 'Mary Example', avatar: null, href: '/u/mary-example' } })

      expect(screen.getByRole('link', { name: 'Mary Example' })).toHaveAttribute('href', '/u/mary-example')
    })

    it('an author without a slug is plain text, not a link', () => {
      hero({ author: { name: 'Mary Example', avatar: null, href: null } })

      expect(screen.getByText('Mary Example')).toBeInTheDocument()
      expect(screen.queryByRole('link', { name: 'Mary Example' })).toBeNull()
    })

    it('no avatar: no image and no initial-letter circle', () => {
      const { container } = hero()

      expect(container.querySelector('img')).toBeNull()
      expect(screen.queryByText('S')).toBeNull()
    })

    it('a profile avatar is a decorative 32px image', () => {
      const { container } = hero({
        author: { name: 'Site Owner', avatar: { kind: 'image', src: '/media/me.jpg' }, href: '/about' },
      })

      const img = container.querySelector('img')!
      expect(img).toHaveAttribute('alt', '')
      expect(img).toHaveAttribute('width', '32')
      expect(img).toHaveClass('rounded-full')
    })

    it('a GitHub picture goes through Avatar (decorative, 32px)', () => {
      const { container } = hero({
        author: { name: 'Mary', avatar: { kind: 'github', src: 'https://avatars.githubusercontent.com/u/7?v=4' }, href: null },
      })

      const img = container.querySelector('img')!
      expect(img).toHaveAttribute('alt', '')
      expect(img).toHaveClass('h-8', 'w-8', 'rounded-full')
    })

    it('an author without a picture gets the initial-letter circle of Avatar (empty src)', () => {
      hero({ author: { name: 'Mary', avatar: { kind: 'github', src: '' }, href: null } })

      expect(screen.getByText('M')).toHaveAttribute('aria-hidden', 'true')
    })

    it('Subscribe links to /newsletter, is a hero button (44px on a phone, 40px from sm) and is not printed', () => {
      hero()

      const subscribe = screen.getByRole('link', { name: msg('Site.reader.subscribe') })
      expect(subscribe).toHaveAttribute('href', '/newsletter')
      expect(subscribe.className).toContain(HERO_BUTTON)
      expect(subscribe).toHaveClass('print:hidden', 'h-11', 'sm:h-10')
    })
  })

  describe('actions', () => {
    it('a published post has one group, not printed, with Copy link, Share and Next in that order', () => {
      hero()

      const group = actions()!
      expect(group).toHaveClass('print:hidden')
      expect(group.children).toHaveLength(3)
      const [copy, share, next] = Array.from(group.children)
      expect(copy!.querySelector('button')).toHaveTextContent(msg('Site.share.copyLink'))
      expect(share!.tagName).toBe('DETAILS')
      expect(next).toHaveAttribute('href', '/posts/part-four')
    })

    it('has only one Copy link button and it sits inside the hero', () => {
      const { container } = hero()

      const buttons = screen.getAllByRole('button', { name: msg('Site.share.copyLink') })
      expect(buttons).toHaveLength(1)
      expect(header(container).contains(buttons[0]!)).toBe(true)
    })

    it('the Share menu is a details disclosure with an unnamed list of the three networks', () => {
      const { container } = hero()

      const details = header(container).querySelector('details')!
      expect(details.querySelector('summary')).toHaveTextContent(msg('Site.share.label'))
      expect(details.querySelectorAll('li a')).toHaveLength(3)
      expect(screen.queryByRole('list', { name: msg('Site.share.label') })).toBeNull()
    })

    it('Next of a series part says "Next part" and names the target for assistive technology', () => {
      hero()

      const next = nextLink(msg('Site.reader.nextPart'))!
      expect(next).toHaveAttribute('href', '/posts/part-four')
      expect(next).toHaveAccessibleName(`${msg('Site.reader.nextPart')} : ${TARGET.title}`)
      expect(next.className).toContain(HERO_BUTTON)
      expect(next.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    })

    it('Next of a plain post says "Next post"', () => {
      hero({ next: { kind: 'post', post: TARGET } })

      expect(nextLink(msg('Site.postNav.next'))).toHaveAttribute('href', '/posts/part-four')
      expect(nextLink(msg('Site.reader.nextPart'))).toBeNull()
    })

    it('Next carries the language of its target when it differs from the page', () => {
      hero({ next: { kind: 'post', post: { ...TARGET, language: 'en' } }, locale: 'vi' })

      expect(nextLink(msg('Site.postNav.next'))).toHaveAttribute('href', '/en/posts/part-four')
    })

    it('no Next when there is nothing to lead to; Copy link and Share stay', () => {
      hero({ next: null })

      expect(nextLink(msg('Site.postNav.next'))).toBeNull()
      expect(nextLink(msg('Site.reader.nextPart'))).toBeNull()
      expect(actions()!.children).toHaveLength(2)
      expect(within(actions()!).getByRole('button', { name: msg('Site.share.copyLink') })).toBeInTheDocument()
    })

    it('an unpublished post has no Copy link, Share or Next, and no empty group', () => {
      const { container } = hero({ published: false })

      expect(actions()).toBeNull()
      expect(screen.queryByRole('button', { name: msg('Site.share.copyLink') })).toBeNull()
      expect(container.querySelector('details')).toBeNull()
      expect(nextLink(msg('Site.reader.nextPart'))).toBeNull()
      // The author and Subscribe stay in a draft preview.
      expect(screen.getByRole('link', { name: msg('Site.reader.subscribe') })).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Site Owner' })).toBeInTheDocument()
    })

    it('every hero button is 44px high on a phone and 40px from sm', () => {
      const { container } = hero()

      const controls = header(container).querySelectorAll('a[href="/newsletter"], summary, button, a[href^="/posts/"]')
      // Subscribe, Copy link, Share, Next
      expect(controls).toHaveLength(4)
      for (const control of controls) expect(control).toHaveClass('h-11', 'sm:h-10')
    })

    it('on a phone the actions are one line: Copy link and Share are icon-only squares, Next takes the rest of the row', () => {
      hero()

      const group = actions()!
      expect(group).toHaveClass('flex', 'w-full', 'items-start', 'sm:w-auto', 'sm:flex-wrap')
      expect(group).not.toHaveClass('flex-wrap')
      expect(screen.getByRole('button', { name: msg('Site.share.copyLink') })).toHaveClass('max-sm:w-11', 'max-sm:px-0')
      expect(screen.getByText(msg('Site.share.label')).closest('summary')).toHaveClass('max-sm:w-11', 'max-sm:px-0')
      const next = screen.getByRole('link', { name: new RegExp(msg('Site.reader.nextPart')) })
      expect(next).toHaveClass('max-sm:flex-1', 'max-sm:justify-center', 'max-sm:min-w-0')
    })
  })
})
