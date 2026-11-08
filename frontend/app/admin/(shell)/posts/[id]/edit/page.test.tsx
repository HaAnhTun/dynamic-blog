import { render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Post } from '@/lib/types'

const {
  getAdminPost,
  listCategories,
  listTags,
  listPostImages,
  listPostRevisions,
  listPostTranslations,
  everyAdminPost,
  redirect,
  notFound,
  adminRole,
} = vi.hoisted(() => ({
  getAdminPost: vi.fn(),
  listCategories: vi.fn(),
  listTags: vi.fn(),
  // Two side lists of the editor. Empty by default, like a post with no image or old revision yet.
  listPostImages: vi.fn(),
  listPostRevisions: vi.fn(),
  // The translation panel: the linked posts, and the admin's whole list for the "link existing" choice.
  listPostTranslations: vi.fn(),
  everyAdminPost: vi.fn(),
  redirect: vi.fn(() => {
    throw new Error('NEXT_REDIRECT')
  }),
  notFound: vi.fn(() => {
    throw new Error('NEXT_HTTP_ERROR_FALLBACK;404')
  }),
  adminRole: vi.fn(async (): Promise<string | null> => 'ADMIN'),
}))
vi.mock('@/lib/admin-api', () => ({
  getAdminPost,
  listCategories,
  listTags,
  listPostImages,
  listPostRevisions,
  listPostTranslations,
  SessionExpiredError: class SessionExpiredError extends Error {},
}))
vi.mock('@/lib/admin-role', () => ({ adminRole }))
vi.mock('../../../every-admin-post', () => ({ everyAdminPost }))
vi.mock('next/navigation', () => ({ redirect, notFound }))
// The two action files are 'use server' and pull in next/cache, admin-api; the page only forwards
// to them, so here they are empty functions.
vi.mock('../../actions', () => ({
  addCategory: vi.fn(),
  addTag: vi.fn(),
  removePost: vi.fn(),
  savePost: vi.fn(),
  setPublished: vi.fn(),
}))
vi.mock('../../cover-actions', () => ({ uploadCover: vi.fn(), saveCoverAlt: vi.fn(), removeCover: vi.fn() }))
vi.mock('../../editor-actions', () => ({
  createTranslationAction: vi.fn(),
  linkTranslationAction: vi.fn(),
  unlinkTranslationAction: vi.fn(),
  duplicatePost: vi.fn(),
  loadRevision: vi.fn(),
  removeBodyImage: vi.fn(),
  restoreRevision: vi.fn(),
  uploadBodyImage: vi.fn(),
}))
// MarkdownPreview is an async server component (Shiki); the test render is client side.
vi.mock('@/components/admin/MarkdownPreview', () => ({ default: () => null }))

import { ApiError } from '@/lib/api'
import EditPostPage from './page'
import { msg } from '@/test/render-intl'
import viCatalog from '@/messages/vi.json'

const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// The in-series line keeps its <name> tag in the raw message: build the plain text from it.
const inSeriesText = (title: string, position: number) =>
  viCatalog.Admin.posts.inSeries
    .replace('<name>', '')
    .replace('</name>', '')
    .replace('{title}', title)
    .replace('{position}', String(position))
const inSeriesWord = new RegExp(esc(viCatalog.Admin.posts.inSeries.split('<')[0].trim()), 'i')

const post = (over: Partial<Post> = {}): Post => ({
  id: 'p1',
  title: 'From API Gateway to SQS',
  slug: 'from-api-gateway-to-sqs',
  excerpt: null,
  status: 'PUBLISHED',
  category: null,
  tags: [],
  featured: false,
  readingMinutes: 4,
  publishedAt: '2026-10-03T02:00:00Z',
  content: 'noi dung',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-03T02:00:00Z',
  cover: null,
  series: null,
  ...over,
})

async function renderPage(p: Post, searchParams: Record<string, string> = {}) {
  getAdminPost.mockResolvedValue(p)
  listCategories.mockResolvedValue([])
  listTags.mockResolvedValue([])
  return render(await EditPostPage({ params: Promise.resolve({ id: p.id }), searchParams: Promise.resolve(searchParams) }))
}

beforeEach(() => {
  listPostImages.mockResolvedValue([])
  listPostRevisions.mockResolvedValue([])
  listPostTranslations.mockResolvedValue([])
  everyAdminPost.mockResolvedValue([])
})

afterEach(() => vi.clearAllMocks())

describe('EditPostPage', () => {
  it('a saved post has a Translations area outside the form: the linked posts, and only ungrouped posts of another language to link', async () => {
    listPostTranslations.mockResolvedValue([{ id: 'p-en', language: 'en', slug: 'hello', title: 'Hello world', status: 'DRAFT' }])
    everyAdminPost.mockResolvedValue([
      post({ id: 'p1', language: 'vi' }),
      post({ id: 'p-free', title: 'Free post', language: 'en' }),
      post({
        id: 'p-grouped',
        title: 'Grouped post',
        language: 'en',
        translations: [{ language: 'vi', slug: 'x', title: 'X', status: 'PUBLISHED' }],
      }),
    ])

    await renderPage(post({ language: 'vi' }))

    const region = screen.getByRole('region', { name: msg('Admin.posts.translations.heading') })
    expect(region.closest('form')).toBeNull()
    expect(within(region).getByRole('link', { name: /Hello world/ })).toHaveAttribute('href', '/admin/posts/p-en/edit')
    // English is already linked, so nothing is offered to link or create.
    expect(within(region).queryByLabelText(msg('Admin.posts.translations.linkLabel'))).toBeNull()
  })

  it('without a linked English post, the ungrouped English posts are offered; the post itself and grouped ones are not', async () => {
    everyAdminPost.mockResolvedValue([
      post({ id: 'p1', title: 'Self', language: 'vi' }),
      post({ id: 'p-free', title: 'Free post', language: 'en' }),
      post({
        id: 'p-grouped',
        title: 'Grouped post',
        language: 'en',
        translations: [{ language: 'vi', slug: 'x', title: 'X', status: 'PUBLISHED' }],
      }),
    ])

    await renderPage(post({ language: 'vi' }))

    const select = screen.getByLabelText(msg('Admin.posts.translations.linkLabel'))
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.getAttribute('value')),
    ).toEqual(['', 'p-free'])
  })

  it('the translations or the post list failing does not stop the editor: the area says it could not load', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    listPostTranslations.mockRejectedValue(new ApiError(500, 'INTERNAL_ERROR', 'boom'))
    everyAdminPost.mockRejectedValue(new ApiError(500, 'INTERNAL_ERROR', 'boom'))

    await renderPage(post())

    expect(screen.getByRole('button', { name: msg('Site.comments.item.editSave') })).toBeInTheDocument()
    expect(screen.getByText(msg('Admin.posts.translations.loadFailed'))).toBeInTheDocument()
    log.mockRestore()
  })

  it('has a cover image area for the post being edited, outside the editor form', async () => {
    await renderPage(post())

    const region = screen.getByRole('region', { name: msg('Admin.editor.cover.heading') })
    // Outside the <form>: if the "Upload image" button were inside the form, Enter in the title field could press it
    // by mistake, and every button of the image area would be a submit button of the post form.
    expect(region.closest('form')).toBeNull()
    // The "present" counterpart: the editor is still there.
    expect(screen.getByRole('button', { name: msg('Site.comments.item.editSave') })).toBeInTheDocument()
  })

  it('a post in a series: one read-only line "In series X · position n" and a link to the series management page', async () => {
    await renderPage(
      post({
        series: {
          id: 's-42',
          slug: 'async-pipeline-on-aws',
          title: 'Async pipeline on AWS',
          position: 2,
          partNumber: 2,
          partCount: 3,
        },
      }),
    )

    const line = screen.getByText(inSeriesWord).closest('p') as HTMLElement
    expect(line).toHaveTextContent(inSeriesText('Async pipeline on AWS', 2))
    // Series membership is only written on the series screen (one endpoint replaces the whole list), so
    // there is no input here, only the path to where it can be edited.
    expect(within(line).getByRole('link', { name: new RegExp(esc(msg('Admin.posts.manageSeries')), 'i') })).toHaveAttribute(
      'href',
      '/admin/series/s-42',
    )
    expect(within(line).queryByRole('textbox')).toBeNull()
  })

  it('has a "Delete post" area in the settings column, outside the post form: its button never submits the post', async () => {
    await renderPage(post())

    const region = screen.getByRole('region', { name: msg('Admin.posts.delete.heading') })
    expect(region.closest('form')).toBeNull()
    expect(within(region).getByRole('button', { name: msg('Admin.posts.delete.heading') })).toHaveAttribute('type', 'button')
  })

  it('a post in no series: no series line', async () => {
    await renderPage(post({ series: null }))

    expect(screen.queryByText(inSeriesWord)).toBeNull()
    expect(screen.getByRole('region', { name: msg('Admin.editor.cover.heading') })).toBeInTheDocument()
  })

  it('session expired while loading the page → to the login page', async () => {
    const { SessionExpiredError } = await import('@/lib/admin-api')
    getAdminPost.mockRejectedValue(new SessionExpiredError())
    listCategories.mockResolvedValue([])
    listTags.mockResolvedValue([])

    await expect(EditPostPage({ params: Promise.resolve({ id: 'p1' }) })).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login')
  })

  it('post no longer exists (ADMIN gets 404 POST_NOT_FOUND) → the 404 page, not an error page', async () => {
    // admin-api throws ApiError(404), never NotFoundError (that class belongs to the public lib/api):
    // checking by subclass would turn a post just deleted in another tab into a 500 error page.
    getAdminPost.mockRejectedValue(new ApiError(404, 'POST_NOT_FOUND', 'Post not found: p1'))
    listCategories.mockResolvedValue([])
    listTags.mockResolvedValue([])

    await expect(EditPostPage({ params: Promise.resolve({ id: 'p1' }) })).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404')
    expect(notFound).toHaveBeenCalledTimes(1)
    expect(redirect).not.toHaveBeenCalled()
  })

  describe('side lists: in-body images, history, restore', () => {
    const IMAGE = {
      id: '0b9d6f3a-5c1e-4f7a-9d2b-3e4f5a6b7c8d',
      fileName: '0b9d6f3a-5c1e-4f7a-9d2b-3e4f5a6b7c8d.png',
      width: 1200,
      height: 800,
      altText: 'Three tier diagram',
      dominantColor: null,
    }

    it('the in-body images and history of the post reach the editor', async () => {
      listPostImages.mockResolvedValue([IMAGE])
      listPostRevisions.mockResolvedValue([{ id: 'r1', title: 'Title from yesterday', createdAt: '2026-10-08T03:00:00Z' }])

      await renderPage(post())

      expect(listPostImages).toHaveBeenCalledWith('p1')
      expect(listPostRevisions).toHaveBeenCalledWith('p1')
      expect(
        within(screen.getByRole('region', { name: msg('Admin.postImages.heading') })).getByText('Three tier diagram'),
      ).toBeInTheDocument()
      expect(
        within(screen.getByRole('region', { name: msg('Admin.revisions.heading') })).getByText('Title from yesterday'),
      ).toBeInTheDocument()
      // The editor's buttons only exist for a saved post, and this is a saved post.
      expect(screen.getByRole('link', { name: msg('Admin.posts.row.download') })).toHaveAttribute(
        'href',
        '/admin/posts/p1/export',
      )
      expect(screen.getByRole('button', { name: msg('Admin.editor.duplicate') })).toBeInTheDocument()
    })

    it('old backend without the two endpoints (404 ENDPOINT_NOT_FOUND): the page still opens, both areas say they could not load, no log', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      const missing = new ApiError(404, 'ENDPOINT_NOT_FOUND', 'The requested endpoint does not exist')
      listPostImages.mockRejectedValue(missing)
      listPostRevisions.mockRejectedValue(missing)

      await renderPage(post())

      expect(screen.getByRole('button', { name: msg('Site.comments.item.editSave') })).toBeInTheDocument()
      expect(screen.getByText(new RegExp(esc(msg('Admin.postImages.loadFailed'))))).toBeInTheDocument()
      expect(screen.getByText(new RegExp(esc(msg('Admin.revisions.loadFailed'))))).toBeInTheDocument()
      // Paired with the 404 test below: only a missing post is a 404 page, a side list is not.
      expect(notFound).not.toHaveBeenCalled()
      expect(log).not.toHaveBeenCalled()
      log.mockRestore()
    })

    it('another error of a side list: the page still opens, the original error is in the log', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      const cause = new ApiError(500, 'INTERNAL_ERROR', 'boom')
      listPostRevisions.mockRejectedValue(cause)

      await renderPage(post())

      expect(screen.getByText(new RegExp(esc(msg('Admin.revisions.loadFailed'))))).toBeInTheDocument()
      expect(log).toHaveBeenCalledWith(expect.any(String), cause)
      log.mockRestore()
    })

    it('session expired on a side list → to the login page, as when reading the post', async () => {
      const { SessionExpiredError } = await import('@/lib/admin-api')
      getAdminPost.mockResolvedValue(post())
      listCategories.mockResolvedValue([])
      listTags.mockResolvedValue([])
      listPostImages.mockRejectedValue(new SessionExpiredError())

      await expect(EditPostPage({ params: Promise.resolve({ id: 'p1' }) })).rejects.toThrow('NEXT_REDIRECT')
      expect(redirect).toHaveBeenCalledWith('/admin/login')
    })

    it('just restored an old revision (?restored=): the status line says so', async () => {
      await renderPage(post(), { restored: 'abc123' })

      expect(screen.getAllByRole('status')[0]).toHaveTextContent(msg('Admin.editor.restoredNotice'))
    })

    it('"Delete post" is the last item of the settings column, after history and download', async () => {
      await renderPage(post())

      const remove = screen.getByRole('region', { name: msg('Admin.posts.delete.heading') })
      for (const name of [
        msg('Admin.editor.cover.heading'),
        msg('Admin.postImages.heading'),
        msg('Admin.revisions.heading'),
        msg('Admin.editor.toolsHeading'),
      ]) {
        const region = screen.getByRole('region', { name })
        expect(region.compareDocumentPosition(remove) & Node.DOCUMENT_POSITION_FOLLOWING, name).toBeTruthy()
      }
    })
  })

  // Pinned on purpose: a 403 is no longer thrown to error.tsx. Still not a 404 or the login page.
  it('403 (AUTHOR opens another person\'s post, or a token still carrying an old role): "Cannot open this post" inside the frame, no log', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const forbidden = new ApiError(403, 'FORBIDDEN', 'Access denied')
    getAdminPost.mockRejectedValue(forbidden)
    listCategories.mockResolvedValue([])
    listTags.mockResolvedValue([])
    listPostImages.mockRejectedValue(forbidden)
    listPostRevisions.mockRejectedValue(forbidden)

    render(await EditPostPage({ params: Promise.resolve({ id: 'p1' }) }))

    expect(screen.getByRole('heading', { level: 1, name: msg('Admin.posts.preview.edit') })).toBeInTheDocument()
    expect(screen.getByText(msg('Admin.common.noAccess.post.title'))).toBeInTheDocument()
    // The page has no sidebar: the way back to the post list sits right above the heading.
    expect(screen.getByRole('link', { name: msg('Site.about.readNextLinks.writing') })).toHaveAttribute('href', '/admin')
    expect(screen.queryByRole('button', { name: msg('Site.comments.item.editSave') })).toBeNull()
    expect(notFound).not.toHaveBeenCalled()
    expect(redirect).not.toHaveBeenCalled()
    // A 403 of the two side lists belongs to the whole page, not a line "Editor side list failed" in the log.
    expect(log).not.toHaveBeenCalled()
    log.mockRestore()
  })
})

describe('EditPostPage: AUTHOR', () => {
  const inSeries = post({
    series: { id: 's-42', slug: 'pipeline', title: 'Async pipeline', position: 2, partNumber: 2, partCount: 3 },
  })

  it('own post: cover image, ZIP download, duplicate like ADMIN; no series line, no path to comments (ADMIN has it)', async () => {
    const admin = await renderPage(inSeries)
    expect(screen.getByText(inSeriesWord)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: msg('Admin.editor.commentsLink') })).toBeInTheDocument()
    admin.unmount()

    adminRole.mockResolvedValueOnce('AUTHOR')
    await renderPage(inSeries)

    expect(screen.getByRole('region', { name: msg('Admin.editor.cover.heading') })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: msg('Admin.posts.row.download') })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: msg('Admin.editor.duplicate') })).toBeInTheDocument()
    expect(screen.queryByText(inSeriesWord)).toBeNull()
    expect(screen.queryByRole('link', { name: msg('Admin.editor.commentsLink') })).toBeNull()
  })

  it('the delete area tells an author that the post only leaves their list, and an administrator that it goes for good', async () => {
    const admin = await renderPage(inSeries)
    expect(screen.getByText(msg('Admin.posts.delete.hintPublished'))).toBeInTheDocument()
    admin.unmount()

    adminRole.mockResolvedValueOnce('AUTHOR')
    await renderPage(inSeries)

    expect(screen.getByText(msg('Admin.posts.delete.author.hintPublished'))).toBeInTheDocument()
    expect(screen.queryByText(msg('Admin.posts.delete.hintPublished'))).toBeNull()
  })

  it('404 (the post was just deleted): also "Cannot open this post", not the public 404 page', async () => {
    adminRole.mockResolvedValueOnce('AUTHOR')
    getAdminPost.mockRejectedValue(new ApiError(404, 'POST_NOT_FOUND', 'Post not found: p1'))
    listCategories.mockResolvedValue([])
    listTags.mockResolvedValue([])

    render(await EditPostPage({ params: Promise.resolve({ id: 'p1' }) }))

    expect(screen.getByText(msg('Admin.common.noAccess.post.title'))).toBeInTheDocument()
    expect(notFound).not.toHaveBeenCalled()
  })
})
