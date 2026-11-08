// @vitest-environment node
import { actionAsyncStorage } from 'next/dist/server/app-render/action-async-storage.external'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Next reads globalThis.AsyncLocalStorage exactly once, when its module loads; the real server sets
// this variable at startup, vitest does not, and then redirect() never sees the Server Action context.
// vi.hoisted runs before every import, so the removePost test below can build exactly that context.
vi.hoisted(() => {
  const scope = globalThis as { AsyncLocalStorage?: unknown }
  scope.AsyncLocalStorage ??= process.getBuiltinModule('node:async_hooks').AsyncLocalStorage
})

/**
 * `vi.hoisted`, not three bare `const`s as the plan has it. `vi.mock` is hoisted above
 * every statement in the file, so a factory that closes over a plain `const` reads it
 * while it is still in its temporal dead zone — and the factory runs during the hoisted
 * `import { savePost } from './actions'`, which is before any `const` is initialised.
 * Verbatim, with the plan's three declarations:
 *
 *   Error: [vitest] There was an error when mocking a module. If you are using "vi.mock"
 *   factory, make sure there are no top level variables inside, since this call is
 *   hoisted to top of the file.
 *   Caused by: ReferenceError: Cannot access 'createPost' before initialization
 *     ❯ app/admin/posts/actions.test.ts:10:5
 *
 * `vi.hoisted` lifts the spies with the mock so the factory sees them initialised. No
 * assertion in this file changed.
 */
const { createPost, updatePost, publishPost, unpublishPost, createCategory, createTag, deletePost } = vi.hoisted(() => ({
  createPost: vi.fn(),
  updatePost: vi.fn(),
  publishPost: vi.fn(),
  unpublishPost: vi.fn(),
  createCategory: vi.fn(),
  createTag: vi.fn(),
  deletePost: vi.fn(),
}))
vi.mock('@/lib/admin-api', async () => {
  const actual = await import('@/lib/api')
  return {
    createPost,
    updatePost,
    publishPost,
    createCategory,
    createTag,
    unpublishPost,
    deletePost,
    SessionExpiredError: class SessionExpiredError extends actual.ApiError {
      constructor() {
        super(401, 'UNAUTHENTICATED', 'expired')
      }
    },
  }
})
// `updateTag` is in this mock because the implementation calls it instead of the plan's
// `revalidateTag`: Next 16.3.7 made `revalidateTag`'s cacheLife profile a required second
// argument, and the only profile that compiles cleanly, `'max'`, serves a 300-second
// stale copy to the next reader — which is the failure the call is here to prevent.
// `revalidateTag` is kept in the mock so a regression back to it is a failed assertion
// below rather than an unresolved-export crash.
vi.mock('next/cache', () => ({ updateTag: vi.fn(), revalidateTag: vi.fn(), revalidatePath: vi.fn(), refresh: vi.fn() }))

import { msg } from '@/test/intl'
import { ApiError } from '@/lib/api'
import { addCategory, addTag, bulkSetPublished, deletePosts, removePost, savePost, setPublished } from './actions'

const SESSION_EXPIRED = msg('Errors.admin.sessionExpired')

function formOf(entries: Record<string, string | string[]>): FormData {
  const form = new FormData()
  for (const [key, value] of Object.entries(entries)) {
    for (const one of Array.isArray(value) ? value : [value]) form.append(key, one)
  }
  return form
}

describe('savePost', () => {
  afterEach(() => vi.clearAllMocks())

  it('creates a post and revalidates the public cache', async () => {
    createPost.mockResolvedValue({ id: 'p1', slug: 'bai-moi' })
    const { updateTag, revalidateTag } = await import('next/cache')

    const result = await savePost(null, formOf({ title: msg('Admin.editor.titleNew'), content: 'noi dung', slug: 'bai-moi' }))

    expect(createPost).toHaveBeenCalledWith(expect.objectContaining({ title: msg('Admin.editor.titleNew'), slug: 'bai-moi' }))
    // Without this the public page keeps serving the 300-second cached list and the
    // author concludes publishing is broken.
    expect(updateTag).toHaveBeenCalledWith('posts')
    // Both tags, and the post tag built by lib/api.ts's own `postTag` rather than a
    // second copy of the 256-character truncation: a tag written one way here and
    // another way in the read path would silently fail to invalidate anything.
    expect(updateTag).toHaveBeenCalledWith('post-bai-moi')
    // Search results (tag 'search') show the title and description of the post: editing without clearing it leaves
    // the /search page with the old text for up to 60 seconds.
    expect(updateTag).toHaveBeenCalledWith('search')
    // `revalidateTag` with the only profile that compiles, 'max', is `stale: 300` — it
    // would hand the next reader the cached list and lose the race this test is about.
    expect(revalidateTag).not.toHaveBeenCalled()
    expect(result).toEqual(expect.objectContaining({ id: 'p1' }))
  })

  it('after saving, also clears the "categories" and "tags" cache: a post\'s category and tags decide the public taxonomy', async () => {
    updatePost.mockResolvedValue({ id: 'p1', slug: 'bai-da-dang' })
    const { updateTag } = await import('next/cache')

    await savePost('p1', formOf({ title: 't', content: 'c', categoryId: 'c2', tagIds: ['t9'] }))

    // The public /api/v1/categories and /tags now only list categories and tags with at least one published
    // post. Moving a published post to a new tag must make /tags/<new-tag> stop being a 404 at once, not wait five
    // minutes of cache (lib/taxonomy.ts); an old tag with no post left must leave the page and sitemap at once.
    expect(updateTag).toHaveBeenCalledWith('categories')
    expect(updateTag).toHaveBeenCalledWith('tags')
  })

  it('sends the language of the form; an unknown or missing one is not sent', async () => {
    createPost.mockResolvedValue({ id: 'p1', slug: 's' })

    await savePost(null, formOf({ title: 't', content: 'c', language: 'en' }))
    expect(createPost).toHaveBeenLastCalledWith(expect.objectContaining({ language: 'en' }))

    await savePost(null, formOf({ title: 't', content: 'c', language: 'fr' }))
    expect(createPost).toHaveBeenLastCalledWith(expect.objectContaining({ language: undefined }))

    await savePost(null, formOf({ title: 't', content: 'c' }))
    expect(createPost).toHaveBeenLastCalledWith(expect.objectContaining({ language: undefined }))
  })

  it('collects multiple tagIds from the form', async () => {
    createPost.mockResolvedValue({ id: 'p1', slug: 's' })

    await savePost(null, formOf({ title: 't', content: 'c', tagIds: ['t1', 't2'] }))

    // FormData.get returns only the FIRST value for a repeated field, so a one-tag
    // test would pass against code that silently drops every tag after the first.
    expect(createPost).toHaveBeenCalledWith(expect.objectContaining({ tagIds: ['t1', 't2'] }))
  })

  // Pinned on purpose: it used to return the backend's English verbatim. Now it goes through
  // adminErrorMessage, the specific reason is still there but the message is Vietnamese.
  it('returns a Vietnamese message carrying the API reason rather than throwing, so the form can show it', async () => {
    createPost.mockRejectedValue(new ApiError(400, 'VALIDATION_ERROR', 'size must be between 0 and 255'))
    const { updateTag } = await import('next/cache')

    const result = await savePost(null, formOf({ title: 't', content: 'c' }))

    expect(result).toEqual({ error: msg('Errors.admin.invalidDetail', { detail: 'size must be between 0 and 255' }) })
    expect(updateTag).not.toHaveBeenCalled()
  })

  // Pinned on purpose. The old test here was "rethrows a session expiry so the page redirects":
  // but the page's catch only runs at render time, so in an action that error reaches the client as a
  // rejected promise nobody handles — press Save and see nothing. Redirecting like runAdminAction
  // is not allowed either: leaving the page loses the post being written.
  it('session expired: returns an error with the sessionExpired flag so the editor shows a login link, no throw, no redirect', async () => {
    const { SessionExpiredError } = await import('@/lib/admin-api')
    createPost.mockRejectedValue(new SessionExpiredError())
    const { updateTag } = await import('next/cache')

    const result = await savePost(null, formOf({ title: 't', content: 'c' }))

    expect(result).toEqual({ error: SESSION_EXPIRED, sessionExpired: true })
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('backend unreachable (fetch failed): "cannot reach the server", the original error logged, no throw', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cause = new TypeError('fetch failed')
    updatePost.mockRejectedValue(cause)

    const result = await savePost('p1', formOf({ title: 't', content: 'c' }))

    expect(result).toEqual({ error: msg('Errors.admin.unreachable') })
    // A programming error also falls into this branch: without the log nobody would find it.
    expect(log).toHaveBeenCalledWith(expect.any(String), cause)
    log.mockRestore()
  })
})

/** The digest of the error the real redirect() throws: `NEXT_REDIRECT;<type>;<url>;<code>;`. */
async function redirectTarget(call: Promise<unknown>): Promise<string> {
  const error = await call.then(
    () => {
      throw new Error('action returned instead of redirecting')
    },
    (caught: unknown) => caught,
  )
  const digest = (error as { digest?: string }).digest ?? ''
  expect(digest.startsWith('NEXT_REDIRECT;')).toBe(true)
  return digest.split(';')[2]
}

describe('removePost', () => {
  afterEach(() => vi.clearAllMocks())

  it('after deleting: clears the list and search cache, then goes to the list with a flag only, never the title', async () => {
    deletePost.mockResolvedValue(null)
    const { updateTag } = await import('next/cache')

    // Runs in the Server Action context the way Next runs it: there redirect() with no type written is a push
    // (outside an action it is replace, so run bare this test would tell nothing apart).
    const error = await actionAsyncStorage
      .run({ isAction: true }, () => removePost('p1'))
      .then(
        () => {
          throw new Error('action returned instead of redirecting')
        },
        (caught: unknown) => caught,
      )
    const [marker, kind, target] = ((error as { digest?: string }).digest ?? '').split(';')

    expect(marker).toBe('NEXT_REDIRECT')
    // replace, not push: Back does not reopen the edit page of the just-deleted post, which is now only a 404.
    expect(kind).toBe('replace')
    expect(deletePost).toHaveBeenCalledWith('p1')
    // 'posts' covers every list and every post page (getPost carries this tag too), series, sitemap, feed.
    expect(updateTag).toHaveBeenCalledWith('posts')
    expect(updateTag).toHaveBeenCalledWith('search')
    // The last published post of a category or tag was just deleted, so that topic leaves the public list
    // and its page becomes a 404 at once.
    expect(updateTag).toHaveBeenCalledWith('categories')
    expect(updateTag).toHaveBeenCalledWith('tags')
    // Only a flag: a title in the URL would let any link put its own sentence into a signed-in admin's page.
    expect(target).toBe('/admin?deleted=1')
  })

  it('API error: returns a Vietnamese message in place, no cache clearing, no redirect', async () => {
    deletePost.mockRejectedValue(new ApiError(404, 'POST_NOT_FOUND', 'Post not found'))
    const { updateTag } = await import('next/cache')

    const result = await removePost('p1')

    expect(result).toEqual({ error: msg('Errors.admin.codes.POST_NOT_FOUND') })
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('session expired: to the login page (the post is being deleted, no text left to keep)', async () => {
    const { SessionExpiredError } = await import('@/lib/admin-api')
    deletePost.mockRejectedValue(new SessionExpiredError())

    expect(await redirectTarget(removePost('p1'))).toBe('/admin/login')
  })
})

describe('setPublished', () => {
  afterEach(() => vi.clearAllMocks())

  it.each([
    ['publish', true],
    ['unpublish', false],
  ])('%s done: clears the list cache, the post page, search results and the public taxonomy', async (_label, published) => {
    publishPost.mockResolvedValue({ id: 'p1', slug: 'bai-da-luu' })
    unpublishPost.mockResolvedValue({ id: 'p1', slug: 'bai-da-luu' })
    const { updateTag } = await import('next/cache')

    await setPublished('p1', published)

    expect(updateTag).toHaveBeenCalledWith('posts')
    expect(updateTag).toHaveBeenCalledWith('post-bai-da-luu')
    // Unpublishing without clearing this tag leaves /search listing the post for up to 60 seconds, and clicking it is a 404.
    expect(updateTag).toHaveBeenCalledWith('search')
    // The public taxonomy only has topics with published posts. Publishing the first post of a tag must make
    // /tags/<tag> open at once (not a 404 for five minutes); unpublishing the last one must close it at once.
    expect(updateTag).toHaveBeenCalledWith('categories')
    expect(updateTag).toHaveBeenCalledWith('tags')
  })

  it('a failed publish clears no cache', async () => {
    publishPost.mockRejectedValue(new ApiError(422, 'POST_NOT_PUBLISHABLE', 'Post must have a category before publishing'))
    const { updateTag } = await import('next/cache')

    await setPublished('p1', true)

    expect(updateTag).not.toHaveBeenCalled()
  })

  it('publishing a post without a category (422 POST_NOT_PUBLISHABLE): tells to pick a category and save first', async () => {
    publishPost.mockRejectedValue(new ApiError(422, 'POST_NOT_PUBLISHABLE', 'Post must have a category before publishing'))

    const result = await setPublished('p1', true)

    expect(result).toEqual({ error: msg('Errors.admin.codes.POST_NOT_PUBLISHABLE') })
  })

  it('unpublishing a post that is no longer published (the same 422 code): its own message, says nothing about categories', async () => {
    unpublishPost.mockRejectedValue(
      new ApiError(422, 'POST_NOT_PUBLISHABLE', 'Only a published post can be unpublished; this one is DRAFT'),
    )

    const result = await setPublished('p1', false)

    expect(result).toEqual({ error: msg('Admin.posts.actions.notPublished') })
    expect(result).not.toEqual({ error: msg('Errors.admin.codes.POST_NOT_PUBLISHABLE') })
  })

  it('session expired while publishing: also an in-place error, no throw', async () => {
    const { SessionExpiredError } = await import('@/lib/admin-api')
    publishPost.mockRejectedValue(new SessionExpiredError())

    await expect(setPublished('p1', true)).resolves.toEqual({ error: SESSION_EXPIRED, sessionExpired: true })
  })
})

describe('addCategory / addTag', () => {
  afterEach(() => vi.clearAllMocks())

  it('after creating a category clears the "categories" cache', async () => {
    createCategory.mockResolvedValue({ id: 'c1', name: 'AWS', slug: 'aws', description: null })
    const { updateTag } = await import('next/cache')

    const result = await addCategory('AWS')

    // Bug: lib/taxonomy.ts caches the category list for 300 seconds under the 'categories' tag.
    // Creating a category right in the editor then publishing a post into it makes /categories/<new-slug> return
    // 404 for up to five minutes, because the page checks existence against the old list.
    expect(updateTag).toHaveBeenCalledWith('categories')
    // Exactly that tag: nothing changed on the posts, clearing 'posts' would needlessly cool down the whole site.
    expect(updateTag).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ id: 'c1', name: 'AWS', slug: 'aws', description: null })
  })

  it('after creating a tag clears the "tags" cache', async () => {
    createTag.mockResolvedValue({ id: 't1', name: 'Next.js', slug: 'nextjs' })
    const { updateTag } = await import('next/cache')

    await addTag('Next.js')

    expect(updateTag).toHaveBeenCalledWith('tags')
    expect(updateTag).toHaveBeenCalledTimes(1)
  })

  it('a failed create does not touch the cache, and returns the error for the editor to show', async () => {
    createCategory.mockRejectedValue(new ApiError(409, 'CATEGORY_ALREADY_EXISTS', 'Category already exists'))
    createTag.mockRejectedValue(new ApiError(409, 'TAG_ALREADY_EXISTS', 'Tag already exists'))
    const { updateTag } = await import('next/cache')

    // The "no" counterpart of the two tests above: updateTag also re-renders the current page in the
    // action's response, so calling it for a failed create wastes a render.
    // Pinned on purpose: a Vietnamese message instead of the backend's English verbatim.
    await expect(addCategory('AWS')).resolves.toEqual({ error: msg('Errors.admin.codes.CATEGORY_ALREADY_EXISTS') })
    await expect(addTag('AWS')).resolves.toEqual({ error: msg('Errors.admin.codes.TAG_ALREADY_EXISTS') })
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('session expired while creating a category: an in-place error with the flag, no throw', async () => {
    const { SessionExpiredError } = await import('@/lib/admin-api')
    createCategory.mockRejectedValue(new SessionExpiredError())

    await expect(addCategory('AWS')).resolves.toEqual({ error: SESSION_EXPIRED, sessionExpired: true })
  })
})

/*
 * Bulk and per-row operations of the post list. One Server Action for the whole group:
 * Next sends one client's actions one after another, so parallelism must happen on the server
 * (Promise.allSettled), not in the browser. A single row also goes this way with one id.
 */
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

/** `n` distinct UUIDs, in exactly the form the backend accepts. */
const uuids = (n: number) => Array.from({ length: n }, (_, i) => `${String(i).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`)

/** Each tag is cleared exactly ONCE for the whole group, however many posts changed. */
async function expectInvalidatedOnce() {
  const { updateTag } = await import('next/cache')
  for (const tag of ['posts', 'search', 'categories', 'tags']) {
    expect(
      vi.mocked(updateTag).mock.calls.filter(([called]) => called === tag),
      tag,
    ).toHaveLength(1)
  }
}

describe('bulkSetPublished', () => {
  afterEach(() => vi.clearAllMocks())

  it('publish a group: calls the API for each post, returns the published list; clears the cache once for the whole group', async () => {
    publishPost.mockImplementation(async (id: string) => ({ id, slug: `bai-${id.slice(0, 4)}` }))

    const result = await bulkSetPublished([A, B, C], true)

    expect(publishPost.mock.calls.map(([id]) => id)).toEqual([A, B, C])
    expect(unpublishPost).not.toHaveBeenCalled()
    expect(result).toEqual({ done: [A, B, C], skipped: [], failed: [] })
    await expectInvalidatedOnce()
  })

  it('parallel on the server: every call went out before the first call answered', async () => {
    const pending: Array<() => void> = []
    publishPost.mockImplementation((id: string) => new Promise((resolve) => pending.push(() => resolve({ id, slug: id }))))

    const running = bulkSetPublished([A, B, C], true)
    await vi.waitFor(() => expect(publishPost).toHaveBeenCalledTimes(3))
    pending.forEach((resolve) => resolve())

    expect(await running).toEqual({ done: [A, B, C], skipped: [], failed: [] })
  })

  it('partial failure: the failed post comes with a Vietnamese message, the others are still published; the cache is still cleared since a post changed', async () => {
    publishPost.mockImplementation(async (id: string) => {
      if (id === B) throw new ApiError(422, 'POST_NOT_PUBLISHABLE', 'Post must have a category before publishing')
      return { id, slug: id }
    })

    const result = await bulkSetPublished([A, B, C], true)

    expect(result).toEqual({
      done: [A, C],
      skipped: [],
      failed: [{ id: B, error: msg('Errors.admin.codes.POST_NOT_PUBLISHABLE') }],
    })
    await expectInvalidatedOnce()
  })

  it('no post changed: no cache clearing (updateTag also redraws the page, useless for a failure)', async () => {
    publishPost.mockRejectedValue(new ApiError(404, 'POST_NOT_FOUND', 'Post not found'))
    const { updateTag } = await import('next/cache')

    const result = await bulkSetPublished([A, B], true)

    expect(result).toEqual({
      done: [],
      skipped: [],
      failed: [
        { id: A, error: msg('Errors.admin.codes.POST_NOT_FOUND') },
        { id: B, error: msg('Errors.admin.codes.POST_NOT_FOUND') },
      ],
    })
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('unpublishing a post that is no longer published (422, unpublished in another tab) is skipped, not an error', async () => {
    unpublishPost.mockImplementation(async (id: string) => {
      if (id === B) throw new ApiError(422, 'POST_NOT_PUBLISHABLE', 'Only a published post can be unpublished; this one is DRAFT')
      return { id, slug: id }
    })

    const result = await bulkSetPublished([A, B], false)

    expect(unpublishPost.mock.calls.map(([id]) => id)).toEqual([A, B])
    expect(publishPost).not.toHaveBeenCalled()
    expect(result).toEqual({ done: [A], skipped: [B], failed: [] })
    await expectInvalidatedOnce()
  })

  it('every post already unpublished elsewhere (422): the public cache is cleared anyway (issue 063)', async () => {
    unpublishPost.mockRejectedValue(
      new ApiError(422, 'POST_NOT_PUBLISHABLE', 'Only a published post can be unpublished; this one is DRAFT'),
    )
    const { refresh } = await import('next/cache')

    const result = await bulkSetPublished([A, B], false)

    expect(result).toEqual({ done: [], skipped: [A, B], failed: [] })
    // A post unpublished by a script is still public until its cache entry expires; the admin's own click heals it.
    await expectInvalidatedOnce()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('lost connection on one post: "cannot reach the server" for exactly that post, with the original error logged', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cause = new TypeError('fetch failed')
    publishPost.mockImplementation(async (id: string) => {
      if (id === A) throw cause
      return { id, slug: id }
    })

    const result = await bulkSetPublished([A, B], true)

    expect(result).toEqual({ done: [B], skipped: [], failed: [{ id: A, error: msg('Errors.admin.unreachable') }] })
    expect(log).toHaveBeenCalledWith(expect.any(String), cause)
    log.mockRestore()
  })

  it('session expired: to the login page like every list operation (no text being written to keep)', async () => {
    const { SessionExpiredError } = await import('@/lib/admin-api')
    publishPost.mockRejectedValue(new SessionExpiredError())

    expect(await redirectTarget(bulkSetPublished([A, B], true))).toBe('/admin/login')
  })

  it.each([
    ['empty', [] as unknown],
    ['more than 20', uuids(21)],
    ['an id that is not a UUID', [A, '../../admin/users']],
    ['not an array', 'abc'],
  ])('list %s: an error message, no API call, no cache clearing', async (_label, ids) => {
    const { updateTag } = await import('next/cache')

    const result = await bulkSetPublished(ids as string[], true)

    expect(result).toEqual({ error: msg('Admin.posts.actions.bulkInvalid') })
    expect(publishPost).not.toHaveBeenCalled()
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('exactly 20 posts is fine; a repeated id calls the API only once', async () => {
    publishPost.mockImplementation(async (id: string) => ({ id, slug: id }))
    const twenty = uuids(20)

    const result = await bulkSetPublished([...twenty, twenty[0]], true)

    expect(publishPost).toHaveBeenCalledTimes(20)
    expect(result).toEqual(expect.objectContaining({ done: twenty }))
  })
})

describe('deletePosts', () => {
  afterEach(() => vi.clearAllMocks())

  it('delete a group, no redirect (the list redraws itself); cache cleared once', async () => {
    deletePost.mockResolvedValue(null)

    const result = await deletePosts([A, B])

    expect(deletePost.mock.calls.map(([id]) => id)).toEqual([A, B])
    expect(result).toEqual({ done: [A, B], skipped: [], failed: [] })
    await expectInvalidatedOnce()
  })

  it('a post already deleted elsewhere (404) is skipped; another error comes with a Vietnamese message', async () => {
    deletePost.mockImplementation(async (id: string) => {
      if (id === A) throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found')
      if (id === B) throw new ApiError(403, 'FORBIDDEN', 'Access denied')
      return null
    })

    const result = await deletePosts([A, B, C])

    expect(result).toEqual({
      done: [C],
      skipped: [A],
      failed: [{ id: B, error: msg('Errors.admin.codes.FORBIDDEN') }],
    })
    await expectInvalidatedOnce()
  })

  it('session expired: to the login page', async () => {
    const { SessionExpiredError } = await import('@/lib/admin-api')
    deletePost.mockRejectedValue(new SessionExpiredError())

    expect(await redirectTarget(deletePosts([A]))).toBe('/admin/login')
  })

  it('every post already deleted elsewhere: the public cache is cleared anyway, because it may be the only stale copy (issue 063)', async () => {
    deletePost.mockRejectedValue(new ApiError(404, 'POST_NOT_FOUND', 'Post not found'))
    const { refresh } = await import('next/cache')

    const result = await deletePosts([A, B])

    expect(result).toEqual({ done: [], skipped: [A, B], failed: [] })
    // "Deleted elsewhere" can mean an API call, a script or SQL, none of which clears anything: this click on "delete" is the moment
    // the cache heals, so a post the backend no longer has cannot stay on the public pages until the entry expires. updateTag also
    // redraws the list open here, so no refresh is needed.
    await expectInvalidatedOnce()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('when a post changed updateTag already redrew the page: no extra refresh', async () => {
    deletePost.mockResolvedValue(null)
    const { refresh } = await import('next/cache')

    await deletePosts([A])

    expect(refresh).not.toHaveBeenCalled()
  })

  it('over 20 posts: deletes nothing', async () => {
    const result = await deletePosts(uuids(21))

    expect(result).toEqual({ error: msg('Admin.posts.actions.bulkInvalid') })
    expect(deletePost).not.toHaveBeenCalled()
  })
})
