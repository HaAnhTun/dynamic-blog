import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NotFoundError, getPosts, getUserProfile } from '@/lib/api'
import type { PostSummary, UserProfile } from '@/lib/types'
import UserProfilePage, { generateMetadata, revalidate } from './page'
import { msg } from '@/test/render-intl'

// The sidebar frame is tested once (BrowseFrame.test.tsx); here a stand-in records what the page asked for.
vi.mock('@/components/site/BrowseFrame', () => import('@/test/browse-frame-mock'))

/** notFound() and redirect() are the real ones: asserting the digest is what tells 404, 307 and a page that keeps rendering apart. */
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  getPosts: vi.fn(),
  getUserProfile: vi.fn(),
}))

const READER: UserProfile = {
  slug: 'alice-nguyen',
  displayName: 'Alice Nguyen',
  githubLogin: 'alice-gh',
  avatarUrl: 'https://avatars.githubusercontent.com/u/71?v=4',
  siteOwner: false,
  // 20:00Z on 30/9 is already 1/10 in the suite's machine time (Asia/Ho_Chi_Minh): the printed month must follow UTC.
  joinedAt: '2026-09-30T20:00:00Z',
  publishedPosts: 0,
}

const AUTHOR: UserProfile = {
  ...READER,
  slug: 'tran-bich',
  displayName: 'Bich Tran',
  githubLogin: 'tranbich',
  publishedPosts: 12,
}

const summary = (n: number): PostSummary => ({
  id: `p${n}`,
  title: `Post ${n}`,
  slug: `bai-viet-${n}`,
  excerpt: null,
  status: 'PUBLISHED',
  category: null,
  tags: [],
  publishedAt: null,
  featured: false,
  readingMinutes: 1,
})

function stubPosts(totalPages: number, items: PostSummary[]) {
  vi.mocked(getPosts).mockImplementation(async ({ page, size }) => ({
    items,
    meta: { page, size, totalElements: items.length, totalPages },
  }))
}

function props(slug: string, searchParams: Record<string, string | string[] | undefined> = {}): PageProps<'/[locale]/u/[slug]'> {
  return { params: Promise.resolve({ locale: 'vi', slug }), searchParams: Promise.resolve(searchParams) }
}

async function digestOf(run: Promise<unknown>): Promise<string | undefined> {
  const thrown = await run.then(
    () => null,
    (error: unknown) => error,
  )
  expect(thrown, 'rendered instead of throwing').not.toBeNull()
  return (thrown as { digest?: string }).digest
}

const NOT_FOUND = 'NEXT_HTTP_ERROR_FALLBACK;404'

afterEach(() => {
  vi.mocked(getPosts).mockReset()
  vi.mocked(getUserProfile).mockReset()
})

describe('/u/[slug]', () => {
  it('asks for the posts of the page language and offers the other language when this one has none', async () => {
    vi.mocked(getUserProfile).mockResolvedValue(AUTHOR)
    vi.mocked(getPosts).mockImplementation(async ({ page, size, language }) => ({
      items: [],
      meta: { page, size, totalElements: language === 'en' ? 2 : 0, totalPages: 0 },
    }))

    render(await UserProfilePage(props('tran-bich')))

    expect(getPosts).toHaveBeenCalledWith({ page: 0, size: 10, author: 'tran-bich', language: 'vi' })
    expect(screen.getByRole('link', { name: msg('Site.languageFallback.link', { language: 'English' }) })).toHaveAttribute(
      'href',
      '/en/u/tran-bich',
    )
  })

  it('revalidates like the other listing pages', () => {
    expect(revalidate).toBe(300)
  })

  it('reader: avatar, name in <bdi> inside the h1, @login to GitHub, join month in UTC; no posts section', async () => {
    vi.mocked(getUserProfile).mockResolvedValue(READER)

    const { container } = render(await UserProfilePage(props('alice-nguyen')))

    expect(getUserProfile).toHaveBeenCalledWith('alice-nguyen')
    const h1 = screen.getByRole('heading', { level: 1 })
    expect(h1).toHaveTextContent('Alice Nguyen')
    expect(h1.querySelector('bdi')).toHaveTextContent('Alice Nguyen')
    expect(container.querySelector('img')).toHaveAttribute('alt', '')

    const github = screen.getByRole('link', { name: '@alice-gh' })
    expect(github).toHaveAttribute('href', 'https://github.com/alice-gh')
    expect(github.getAttribute('rel')?.split(' ').sort()).toEqual(['noopener', 'noreferrer'])

    const joined = container.querySelector('time')
    expect(joined).toHaveAttribute('dateTime', READER.joinedAt)
    expect(joined?.parentElement).toHaveTextContent(
      msg('Site.userProfile.joined', {
        date: msg('Meta.profile.joinedMonth', { month: '9', year: '2026' }),
        time: (chunks: string) => chunks,
      } as never),
    )

    expect(screen.queryByText(msg('Site.authorBox.eyebrow'))).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: msg('Site.about.readNextLinks.writing') })).not.toBeInTheDocument()
    expect(getPosts).not.toHaveBeenCalled()
    expect(container.querySelector('main')).toBeNull()
  })

  it('no GitHub login: no link, no "@null"', async () => {
    vi.mocked(getUserProfile).mockResolvedValue({ ...READER, githubLogin: null })

    const { container } = render(await UserProfilePage(props('alice-nguyen')))

    expect(screen.queryAllByRole('link')).toHaveLength(0)
    expect(container).not.toHaveTextContent('@')
  })

  it('shows public fields only: a stray field in the payload (email, role, id, status) never reaches the page', async () => {
    const leaky = {
      ...AUTHOR,
      id: '0b8f2f9e-1111-4c4c-9999-123456789abc',
      email: 'bich@example.com',
      role: 'AUTHOR',
      status: 'ACTIVE',
    } as UserProfile
    vi.mocked(getUserProfile).mockResolvedValue(leaky)
    stubPosts(1, [summary(1)])

    const { container } = render(await UserProfilePage(props('tran-bich')))

    const html = container.innerHTML
    for (const secret of ['0b8f2f9e', 'bich@example.com', 'AUTHOR', 'ACTIVE']) expect(html).not.toContain(secret)
  })

  it('author: the "Author" label and a "Posts" section with only that person posts, paginated with ?page=', async () => {
    vi.mocked(getUserProfile).mockResolvedValue(AUTHOR)
    stubPosts(3, [summary(1), summary(2)])

    render(await UserProfilePage(props('tran-bich', { page: '1' })))

    expect(getPosts).toHaveBeenCalledWith({ page: 1, size: 10, author: 'tran-bich', language: 'vi' })
    expect(screen.getByText(msg('Site.authorBox.eyebrow'))).toBeInTheDocument()
    const section = screen.getByRole('region', { name: msg('Site.about.readNextLinks.writing') })
    expect(within(section).getAllByRole('heading', { level: 2 })).toHaveLength(2)
    expect(within(section).getByRole('link', { name: msg('Site.pagination.previous') })).toHaveAttribute(
      'href',
      '/u/tran-bich?page=0',
    )
    expect(within(section).getByRole('link', { name: msg('Site.pagination.next') })).toHaveAttribute(
      'href',
      '/u/tran-bich?page=2',
    )
  })

  it('sits in the frame with no current Explore row: header and, for an author, the posts section', async () => {
    vi.mocked(getUserProfile).mockResolvedValue(AUTHOR)
    stubPosts(1, [summary(1)])

    render(await UserProfilePage(props('tran-bich')))

    const frame = screen.getByTestId('browse-frame')
    expect(frame).not.toHaveAttribute('data-current')
    expect(frame).toContainElement(screen.getByRole('heading', { level: 1 }))
    expect(frame).toContainElement(screen.getByRole('region', { name: msg('Site.about.readNextLinks.writing') }))
  })

  it('site owner: temporary redirect to /about, in the page and in the metadata', async () => {
    vi.mocked(getUserProfile).mockResolvedValue({ ...AUTHOR, siteOwner: true })

    expect(await digestOf(UserProfilePage(props('chu-blog')))).toBe('NEXT_REDIRECT;replace;/about;307;')
    expect(await digestOf(generateMetadata(props('chu-blog')))).toBe('NEXT_REDIRECT;replace;/about;307;')
    expect(getPosts).not.toHaveBeenCalled()
  })

  it('missing or locked (backend 404): notFound()', async () => {
    vi.mocked(getUserProfile).mockRejectedValue(new NotFoundError('USER_NOT_FOUND', 'User not found'))

    expect(await digestOf(UserProfilePage(props('khong-co-ai')))).toBe(NOT_FOUND)
    expect(await generateMetadata(props('khong-co-ai'))).toEqual({ title: msg('Site.userProfile.notFoundTitle') })
  })

  it('malformed slug: notFound() without calling the backend', async () => {
    for (const slug of ['Alice', 'alice_nguyen', '-alice', 'alice--x', '%2E%2E', 'a'.repeat(65)]) {
      expect(await digestOf(UserProfilePage(props(slug))), slug).toBe(NOT_FOUND)
    }
    expect(getUserProfile).not.toHaveBeenCalled()
  })

  it('an error other than 404 passes through to error.tsx, it does not become a 404', async () => {
    vi.mocked(getUserProfile).mockRejectedValue(new Error('backend down'))

    await expect(UserProfilePage(props('alice-nguyen'))).rejects.toThrow('backend down')
  })

  it('out-of-range pages are 404: a reader at ?page=1, an author past the last page, an absurd page number (calls nothing)', async () => {
    vi.mocked(getUserProfile).mockResolvedValue(READER)
    expect(await digestOf(UserProfilePage(props('alice-nguyen', { page: '1' })))).toBe(NOT_FOUND)

    vi.mocked(getUserProfile).mockResolvedValue(AUTHOR)
    stubPosts(2, [])
    expect(await digestOf(UserProfilePage(props('tran-bich', { page: '2' })))).toBe(NOT_FOUND)

    vi.mocked(getUserProfile).mockClear()
    expect(await digestOf(UserProfilePage(props('tran-bich', { page: '10001' })))).toBe(NOT_FOUND)
    expect(getUserProfile).not.toHaveBeenCalled()
  })
})

describe('/u/[slug] metadata', () => {
  it('author: indexable, canonical /u/<slug> (keeps the page number), the general feed is still promoted', async () => {
    vi.mocked(getUserProfile).mockResolvedValue(AUTHOR)

    const first = await generateMetadata(props('tran-bich'))
    expect(first.robots).toBeUndefined()
    expect(first.title).toBe('Bich Tran')
    expect(first.alternates?.canonical).toBe('/u/tran-bich')
    expect(first.openGraph?.url).toBe('/u/tran-bich')
    expect(first.alternates?.types).toEqual({ 'application/rss+xml': '/feed.xml' })

    const second = await generateMetadata(props('tran-bich', { page: '2' }))
    expect(second.alternates?.canonical).toBe('/u/tran-bich?page=2')
  })

  it('reader: noindex but still follow', async () => {
    vi.mocked(getUserProfile).mockResolvedValue(READER)

    const metadata = await generateMetadata(props('alice-nguyen'))

    expect(metadata.robots).toEqual({ index: false, follow: true })
    expect(metadata.alternates?.canonical).toBe('/u/alice-nguyen')
    expect(metadata.description).not.toContain('@')
  })
})
