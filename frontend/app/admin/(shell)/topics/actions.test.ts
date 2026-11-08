// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

// Spies via vi.hoisted (same mould as posts/actions.test.ts): the vi.mock factory runs before every const.
const api = vi.hoisted(() => ({
  createCategory: vi.fn(),
  updateCategory: vi.fn(),
  deleteCategory: vi.fn(),
  createTag: vi.fn(),
  renameTag: vi.fn(),
  deleteTag: vi.fn(),
  mergeCategory: vi.fn(),
  mergeTag: vi.fn(),
}))
vi.mock('@/lib/admin-api', async () => {
  const actual = await import('@/lib/api')
  return {
    ...api,
    SessionExpiredError: class SessionExpiredError extends actual.ApiError {
      constructor() {
        super(401, 'UNAUTHENTICATED', 'expired')
      }
    },
  }
})
vi.mock('next/cache', () => ({ updateTag: vi.fn(), revalidateTag: vi.fn(), revalidatePath: vi.fn() }))

import { updateTag } from 'next/cache'
import { ApiError } from '@/lib/api'
import { mergeCategoryInto, mergeTagInto, newCategory, newTag, removeCategory, removeTag, saveCategory, saveTag } from './actions'
import { msg } from '@/test/render-intl'

const category = { id: 'c1', name: 'Engineering', slug: 'engineering', description: 'System design' }
const tag = { id: 't1', name: 'AWS', slug: 'aws' }

afterEach(() => vi.clearAllMocks())

/** Three tags for every write: the public list of that kind, every post (prints the name), search results. */
function expectInvalidated(kind: 'categories' | 'tags') {
  expect(updateTag).toHaveBeenCalledWith(kind)
  expect(updateTag).toHaveBeenCalledWith('posts')
  expect(updateTag).toHaveBeenCalledWith('search')
  expect(updateTag).toHaveBeenCalledTimes(3)
}

describe('categories', () => {
  it('create: the name trimmed, an empty description becomes null, clears the cache, returns the record', async () => {
    api.createCategory.mockResolvedValue({ ...category, description: null })

    const result = await newCategory('  Engineering  ', '   ')

    expect(api.createCategory).toHaveBeenCalledWith('Engineering', null)
    expectInvalidated('categories')
    expect(result).toEqual({ id: 'c1', name: 'Engineering', slug: 'engineering', description: null })
  })

  it('empty name: a Vietnamese message, no API call, no cache clearing', async () => {
    expect(await newCategory('   ', null)).toEqual({ error: msg('Admin.topics.nameRequired') })
    expect(await saveCategory('c1', '', 'x')).toEqual({ error: msg('Admin.topics.nameRequired') })
    expect(api.createCategory).not.toHaveBeenCalled()
    expect(api.updateCategory).not.toHaveBeenCalled()
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('rename: sends name and description, returns exactly what the backend stored', async () => {
    api.updateCategory.mockResolvedValue({ ...category, name: 'Systems engineering' })

    const result = await saveCategory('c1', 'Systems engineering', ' System design ')

    expect(api.updateCategory).toHaveBeenCalledWith('c1', { name: 'Systems engineering', description: 'System design' })
    expectInvalidated('categories')
    expect(result).toEqual(expect.objectContaining({ name: 'Systems engineering', slug: 'engineering' }))
  })

  it('save with translations sends the cleaned map; an empty map clears every translation', async () => {
    api.updateCategory.mockResolvedValue(category)

    await saveCategory('c1', 'Backend', null, { en: { name: ' Server side ', description: ' Notes ' } })
    expect(api.updateCategory).toHaveBeenLastCalledWith('c1', {
      name: 'Backend',
      description: null,
      translations: { en: { name: 'Server side', description: 'Notes' } },
    })

    await saveCategory('c1', 'Backend', null, {})
    expect(api.updateCategory).toHaveBeenLastCalledWith('c1', { name: 'Backend', description: null, translations: {} })
  })

  it('duplicate name (409): a Vietnamese message in place, no cache clearing', async () => {
    api.updateCategory.mockRejectedValue(new ApiError(409, 'CATEGORY_ALREADY_EXISTS', 'exists'))

    expect(await saveCategory('c1', 'Backend', null)).toEqual({ error: msg('Errors.admin.codes.CATEGORY_ALREADY_EXISTS') })
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('delete: null means deleted; still used by posts (409 CATEGORY_IN_USE) says to move the posts first', async () => {
    api.deleteCategory.mockResolvedValueOnce(null)
    expect(await removeCategory('c1')).toBeNull()
    expectInvalidated('categories')

    vi.clearAllMocks()
    api.deleteCategory.mockRejectedValueOnce(new ApiError(409, 'CATEGORY_IN_USE', 'Category is used by 3 posts'))
    expect(await removeCategory('c1')).toEqual({
      error: msg('Errors.admin.codes.CATEGORY_IN_USE'),
    })
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('AUTHOR (403): the "no permission" message, no redirect to the login page', async () => {
    api.deleteCategory.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'Access denied'))

    expect(await removeCategory('c1')).toEqual({ error: msg('Errors.admin.codes.FORBIDDEN') })
  })
})

describe('tags', () => {
  it('create and rename: the name trimmed, the description always null', async () => {
    api.createTag.mockResolvedValue(tag)
    api.renameTag.mockResolvedValue({ ...tag, name: 'Amazon Web Services' })

    expect(await newTag(' AWS ')).toEqual({ id: 't1', name: 'AWS', slug: 'aws', description: null })
    expect(api.createTag).toHaveBeenCalledWith('AWS')
    expect(await saveTag('t1', 'Amazon Web Services')).toEqual(expect.objectContaining({ name: 'Amazon Web Services' }))
    expect(api.renameTag).toHaveBeenCalledWith('t1', 'Amazon Web Services', undefined)
  })

  it('rename with translations: only enabled locales pass, text trimmed, blank entries dropped; none given keeps the stored map', async () => {
    api.renameTag.mockResolvedValue(tag)

    await saveTag('t1', 'AWS', null, {
      en: { name: ' Amazon Web Services ', description: '  ' },
      fr: { name: 'Nope' },
      vi: { name: '   ' },
    })

    expect(api.renameTag).toHaveBeenCalledWith('t1', 'AWS', { en: { name: 'Amazon Web Services', description: null } })
  })

  it('after deleting: clears the tag, post (loses that tag) and search cache', async () => {
    api.deleteTag.mockResolvedValue(null)

    expect(await removeTag('t1')).toBeNull()
    expectInvalidated('tags')
  })
})

describe('merge', () => {
  it('merge a tag: calls the API with source and target, clears the tag, post and search cache; returns the target and the number of posts moved', async () => {
    api.mergeTag.mockResolvedValue({ target: { id: 't2', name: 'Amazon', slug: 'amazon' }, moved: 3 })

    const result = await mergeTagInto('t1', 't2')

    expect(api.mergeTag).toHaveBeenCalledExactlyOnceWith('t1', 't2')
    expectInvalidated('tags')
    expect(result).toEqual({ target: { id: 't2', name: 'Amazon', slug: 'amazon', description: null }, moved: 3 })
  })

  it('move posts then delete a category: the same path, with the category cache', async () => {
    api.mergeCategory.mockResolvedValue({ target: { ...category, id: 'c2', name: 'Backend', slug: 'backend' }, moved: 2 })

    const result = await mergeCategoryInto('c1', 'c2')

    expect(api.mergeCategory).toHaveBeenCalledExactlyOnceWith('c1', 'c2')
    expectInvalidated('categories')
    expect(result).toEqual({
      target: { id: 'c2', name: 'Backend', slug: 'backend', description: 'System design' },
      moved: 2,
    })
  })

  it('merge into itself or no target chosen: a Vietnamese message, no API call, no cache clearing', async () => {
    expect(await mergeTagInto('t1', 't1')).toEqual({ error: msg('Admin.topics.pickOtherTag') })
    expect(await mergeCategoryInto('c1', '')).toEqual({ error: msg('Admin.topics.pickOtherCategory') })
    expect(api.mergeTag).not.toHaveBeenCalled()
    expect(api.mergeCategory).not.toHaveBeenCalled()
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('target just deleted elsewhere (400 TAG_NOT_FOUND): a Vietnamese message, no cache clearing', async () => {
    api.mergeTag.mockRejectedValue(new ApiError(400, 'TAG_NOT_FOUND', 'Tag not found'))

    expect(await mergeTagInto('t1', 't2')).toEqual({ error: msg('Errors.admin.codes.TAG_NOT_FOUND') })
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('backend without the endpoint (404 ENDPOINT_NOT_FOUND): says the server does not support it yet, not "not found"', async () => {
    api.mergeCategory.mockRejectedValue(new ApiError(404, 'ENDPOINT_NOT_FOUND', 'The requested endpoint does not exist'))

    expect(await mergeCategoryInto('c1', 'c2')).toEqual({
      error: msg('Admin.topics.mergeUnsupported'),
    })
  })

  it('AUTHOR (403): the "no permission" message', async () => {
    api.mergeTag.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'Access denied'))

    expect(await mergeTagInto('t1', 't2')).toEqual({ error: msg('Errors.admin.codes.FORBIDDEN') })
  })
})
