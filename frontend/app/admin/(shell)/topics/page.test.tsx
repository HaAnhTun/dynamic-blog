import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { listCategories, listTags, listAdminPosts, redirect, adminRole } = vi.hoisted(() => ({
  listCategories: vi.fn(),
  listTags: vi.fn(),
  listAdminPosts: vi.fn(),
  redirect: vi.fn(() => {
    throw new Error('NEXT_REDIRECT')
  }),
  adminRole: vi.fn(async (): Promise<string | null> => 'ADMIN'),
}))
vi.mock('@/lib/admin-api', () => ({
  listCategories,
  listTags,
  listAdminPosts,
  SessionExpiredError: class SessionExpiredError extends Error {},
}))
vi.mock('@/lib/admin-role', () => ({ adminRole }))
vi.mock('next/navigation', () => ({ redirect }))
// The action file is 'use server' and pulls in next/cache; the page only forwards to them.
vi.mock('./actions', () => ({
  newCategory: vi.fn(),
  saveCategory: vi.fn(),
  removeCategory: vi.fn(),
  newTag: vi.fn(),
  saveTag: vi.fn(),
  removeTag: vi.fn(),
  mergeCategoryInto: vi.fn(),
  mergeTagInto: vi.fn(),
}))

import { ApiError } from '@/lib/api'
import { mergeCategoryInto, mergeTagInto } from './actions'
import TopicsPage from './page'
import { msg } from '@/test/render-intl'

const arch = { id: 'c1', name: 'Engineering', slug: 'engineering', description: null }
const life = { id: 'c2', name: 'Daily life', slug: 'daily-life', description: null }
const aws = { id: 't1', name: 'AWS', slug: 'aws' }

const post = (over: Record<string, unknown>) => ({
  id: 'p',
  title: 'Post',
  slug: 'post',
  excerpt: null,
  status: 'PUBLISHED',
  category: null,
  tags: [],
  featured: false,
  readingMinutes: 1,
  publishedAt: '2026-10-01T00:00:00Z',
  ...over,
})

afterEach(() => vi.clearAllMocks())

describe('Topics page', () => {
  it('counts the posts using each category and tag over every post (any status)', async () => {
    listCategories.mockResolvedValue([arch, life])
    listTags.mockResolvedValue([aws])
    listAdminPosts.mockResolvedValue({
      items: [
        post({ id: 'a', category: arch, tags: [aws] }),
        post({ id: 'b', category: arch, tags: [aws], status: 'DRAFT', publishedAt: null }),
      ],
      meta: { page: 0, size: 100, totalElements: 2, totalPages: 1 },
    })

    render(await TopicsPage())

    expect(screen.getByRole('heading', { level: 1, name: msg('Site.footer.links.topics') })).toBeInTheDocument()
    const categories = within(screen.getByRole('list', { name: msg('Admin.topics.manager.category.listLabel') })).getAllByRole(
      'listitem',
    )
    expect(categories.map((row) => row.querySelector('p')!.textContent)).toEqual(['Daily life', 'Engineering'])
    expect(categories[1]).toHaveTextContent(msg('Admin.topics.manager.usagePartly', { count: '2', published: '1' }))
    expect(categories[0]).toHaveTextContent(msg('Admin.topics.manager.usageNone'))
    expect(
      within(screen.getByRole('list', { name: msg('Admin.topics.manager.tag.listLabel') })).getByRole('listitem'),
    ).toHaveTextContent(msg('Admin.topics.manager.usagePartly', { count: '2', published: '1' }))
  })

  it('merge: "Move posts, then delete" calls the category action, "Merge…" calls the tag action — not swapped', async () => {
    const java = { id: 't2', name: 'Java', slug: 'java' }
    listCategories.mockResolvedValue([arch, life])
    listTags.mockResolvedValue([aws, java])
    listAdminPosts.mockResolvedValue({
      items: [post({ id: 'a', category: arch, tags: [aws] })],
      meta: { page: 0, size: 100, totalElements: 1, totalPages: 1 },
    })
    vi.mocked(mergeCategoryInto).mockResolvedValue({ target: { ...life }, moved: 1 })
    vi.mocked(mergeTagInto).mockResolvedValue({ target: { ...java, description: null }, moved: 1 })
    render(await TopicsPage())

    await act(async () =>
      fireEvent.click(
        screen.getByRole('button', { name: msg('Admin.topics.manager.category.mergeTitle', { name: 'Engineering' }) }),
      ),
    )
    fireEvent.change(
      screen.getByLabelText(msg('Admin.topics.manager.category.mergeLabel', { count: '1', name: 'Engineering' })),
      {
        target: { value: 'c2' },
      },
    )
    await act(async () =>
      fireEvent.click(
        screen.getByRole('button', { name: msg('Admin.topics.manager.category.mergeSubmit', { name: 'Engineering' }) }),
      ),
    )

    await act(async () =>
      fireEvent.click(
        screen.getByRole('button', {
          name: `${msg('Admin.topics.manager.merge')} ${msg('Admin.topics.manager.tag.mergeSr', { name: 'AWS' })}`,
        }),
      ),
    )
    fireEvent.change(screen.getByLabelText(msg('Admin.topics.manager.tag.mergeLabel', { name: 'AWS' })), {
      target: { value: 't2' },
    })
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: msg('Admin.topics.manager.tag.mergeSubmitInto', { target: 'Java' }) })),
    )

    expect(mergeCategoryInto).toHaveBeenCalledExactlyOnceWith('c1', 'c2')
    expect(mergeTagInto).toHaveBeenCalledExactlyOnceWith('t1', 't2')
  })

  it('session expired while loading → to the login page', async () => {
    const { SessionExpiredError } = await import('@/lib/admin-api')
    listCategories.mockRejectedValue(new SessionExpiredError())
    listTags.mockResolvedValue([])
    listAdminPosts.mockResolvedValue({ items: [], meta: { page: 0, size: 100, totalElements: 0, totalPages: 0 } })

    await expect(TopicsPage()).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login')
  })

  it('not ADMIN: AUTHOR calls no backend; a 403 from a stale token is also the admin-only page', async () => {
    adminRole.mockResolvedValueOnce('AUTHOR')
    const author = render(await TopicsPage())
    expect(screen.getByRole('heading', { level: 1, name: msg('Site.footer.links.topics') })).toBeInTheDocument()
    expect(screen.getByText(msg('Admin.common.adminOnly.title'))).toBeInTheDocument()
    // Categories, tags and one's own posts stay open to AUTHOR: calling would draw rename, delete and merge buttons.
    expect(listCategories).not.toHaveBeenCalled()
    expect(listAdminPosts).not.toHaveBeenCalled()
    author.unmount()

    listCategories.mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', 'Access denied'))
    listTags.mockResolvedValue([])
    listAdminPosts.mockResolvedValue({ items: [], meta: { page: 0, size: 100, totalElements: 0, totalPages: 0 } })
    render(await TopicsPage())
    expect(screen.getByText(msg('Admin.common.adminOnly.title'))).toBeInTheDocument()
    expect(redirect).not.toHaveBeenCalled()
  })
})
