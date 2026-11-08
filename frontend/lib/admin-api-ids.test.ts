import { afterEach, describe, expect, it, vi } from 'vitest'

const cookieStore = { get: vi.fn() }
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve(cookieStore) }))

import { ApiError } from './api'
import {
  approveAuthorApplication,
  deleteAdminComment,
  deleteCategory,
  deleteContactMessage,
  deleteGalleryPhoto,
  deletePost,
  deletePostCover,
  deletePostImage,
  deleteSeries,
  deleteTag,
  featurePost,
  fetchAdminPostExport,
  getAdminPost,
  getAdminSeries,
  getPostRevision,
  linkPostTranslation,
  listPostImages,
  listPostRevisions,
  listPostTranslations,
  markContactMessageRead,
  mergeCategory,
  mergeTag,
  publishPost,
  rejectAuthorApplication,
  renameTag,
  resetAuthorMfa,
  restorePostRevision,
  setCommentStatus,
  setSeriesPosts,
  setUserRole,
  setUserStatus,
  unfeaturePost,
  unlinkPostTranslation,
  unpublishPost,
  updateCategory,
  updateGalleryPhoto,
  updatePost,
  updatePostCoverAlt,
  updateSeries,
  uploadPostCover,
  uploadPostImage,
} from './admin-api'

/*
 * Every admin id is a UUID in the backend (a `@PathVariable UUID`). encodeURIComponent leaves `.` and `..` alone and fetch collapses
 * dot segments, so an id of `..` would send the caller's own Bearer token to a parent or sibling endpoint. The client refuses anything
 * that is not a UUID BEFORE any request: a 400 VALIDATION_ERROR, and fetch is never called.
 */

const ID = '11111111-1111-1111-1111-111111111111'
const OTHER = '22222222-2222-2222-2222-222222222222'
const UPPER = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE'

const BAD_IDS = ['..', '.', 'a/b', 'a%2Fb', 'a?b', '', ' ', ID + '/..', `${ID}\n`, 'not-a-uuid', '../../auth/me'] as const

type Call = readonly [name: string, run: (bad: string) => Promise<unknown>]

const file = () => new File([new Uint8Array([1])], 'a.png', { type: 'image/png' })
const POST_INPUT = { title: 't', content: 'c' }
const GALLERY_INPUT = { caption: null, altText: null, takenOn: null, published: true }

/** One entry per exported function that puts an id into a backend path: the id under test is always the bad one. */
const PATH_CALLS: readonly Call[] = [
  ['getAdminPost', (bad) => getAdminPost(bad)],
  ['fetchAdminPostExport', (bad) => fetchAdminPostExport(bad)],
  ['updatePost', (bad) => updatePost(bad, POST_INPUT)],
  ['deletePost', (bad) => deletePost(bad)],
  ['publishPost', (bad) => publishPost(bad)],
  ['unpublishPost', (bad) => unpublishPost(bad)],
  ['featurePost', (bad) => featurePost(bad)],
  ['unfeaturePost', (bad) => unfeaturePost(bad)],
  ['uploadPostCover', (bad) => uploadPostCover(bad, file())],
  ['updatePostCoverAlt', (bad) => updatePostCoverAlt(bad, 'alt')],
  ['deletePostCover', (bad) => deletePostCover(bad)],
  ['listPostTranslations', (bad) => listPostTranslations(bad)],
  ['unlinkPostTranslation', (bad) => unlinkPostTranslation(bad)],
  ['linkPostTranslation (id)', (bad) => linkPostTranslation(bad, OTHER)],
  ['linkPostTranslation (otherId)', (bad) => linkPostTranslation(ID, bad)],
  ['uploadPostImage', (bad) => uploadPostImage(bad, file())],
  ['listPostImages', (bad) => listPostImages(bad)],
  ['deletePostImage (id)', (bad) => deletePostImage(bad, OTHER)],
  ['deletePostImage (mediaId)', (bad) => deletePostImage(ID, bad)],
  ['listPostRevisions', (bad) => listPostRevisions(bad)],
  ['getPostRevision (id)', (bad) => getPostRevision(bad, OTHER)],
  ['getPostRevision (revisionId)', (bad) => getPostRevision(ID, bad)],
  ['restorePostRevision (id)', (bad) => restorePostRevision(bad, OTHER)],
  ['restorePostRevision (revisionId)', (bad) => restorePostRevision(ID, bad)],
  ['updateCategory', (bad) => updateCategory(bad, { name: 'n', description: null })],
  ['deleteCategory', (bad) => deleteCategory(bad)],
  ['mergeCategory', (bad) => mergeCategory(bad, OTHER)],
  ['renameTag', (bad) => renameTag(bad, 'n')],
  ['deleteTag', (bad) => deleteTag(bad)],
  ['mergeTag', (bad) => mergeTag(bad, OTHER)],
  ['getAdminSeries', (bad) => getAdminSeries(bad)],
  ['updateSeries', (bad) => updateSeries(bad, { title: 't' })],
  ['setSeriesPosts', (bad) => setSeriesPosts(bad, [])],
  ['deleteSeries', (bad) => deleteSeries(bad)],
  ['updateGalleryPhoto', (bad) => updateGalleryPhoto(bad, GALLERY_INPUT)],
  ['deleteGalleryPhoto', (bad) => deleteGalleryPhoto(bad)],
  ['setCommentStatus', (bad) => setCommentStatus(bad, 'HIDDEN')],
  ['deleteAdminComment', (bad) => deleteAdminComment(bad)],
  ['setUserStatus', (bad) => setUserStatus(bad, 'ACTIVE')],
  ['setUserRole', (bad) => setUserRole(bad, 'AUTHOR')],
  ['resetAuthorMfa', (bad) => resetAuthorMfa(bad, '123456')],
  ['approveAuthorApplication', (bad) => approveAuthorApplication(bad)],
  ['rejectAuthorApplication', (bad) => rejectAuthorApplication(bad)],
  ['markContactMessageRead', (bad) => markContactMessageRead(bad)],
  ['deleteContactMessage', (bad) => deleteContactMessage(bad)],
]

/** A fetch that fails loudly: the tests below prove it is never reached. */
function unreachableFetch() {
  return vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fetch must not be called'))
}

afterEach(() => {
  vi.restoreAllMocks()
  cookieStore.get.mockReset()
})

describe('admin-api: an id that is not a UUID never reaches a backend path', () => {
  it.each(PATH_CALLS)('%s rejects every bad id with a 400 before any request', async (_name, run) => {
    cookieStore.get.mockReturnValue({ value: 'tok' })
    const fetchSpy = unreachableFetch()

    for (const bad of BAD_IDS) {
      await expect(run(bad)).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' })
      await expect(run(bad)).rejects.toBeInstanceOf(ApiError)
    }

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does not echo the rejected value in the error message', async () => {
    cookieStore.get.mockReturnValue({ value: 'tok' })
    unreachableFetch()

    const error = await getAdminPost('../../secret-looking-value').catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).message).not.toContain('secret-looking-value')
  })

  it('a UUID, in either case, calls fetch with exactly the expected path', async () => {
    cookieStore.get.mockReturnValue({ value: 'tok' })
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ data: { id: ID } }), { status: 200, headers: { 'content-type': 'application/json' } }),
      )

    await getAdminPost(ID)
    await getAdminPost(UPPER)
    await deletePostImage(ID, OTHER)
    await getPostRevision(ID, OTHER)

    const paths = fetchSpy.mock.calls.map(([url]) => new URL(url as string).pathname)
    expect(paths).toEqual([
      `/api/v1/admin/posts/${ID}`,
      `/api/v1/admin/posts/${UPPER}`,
      `/api/v1/admin/posts/${ID}/images/${OTHER}`,
      `/api/v1/admin/posts/${ID}/revisions/${OTHER}`,
    ])
  })
})
