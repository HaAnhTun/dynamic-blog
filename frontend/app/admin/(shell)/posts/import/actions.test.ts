// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

const { previewPostFiles, applyPostFiles, redirect } = vi.hoisted(() => ({
  previewPostFiles: vi.fn(),
  applyPostFiles: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;push;${url};307;` })
  }),
}))
vi.mock('@/lib/admin-post-import', () => ({ previewPostFiles, applyPostFiles }))
vi.mock('@/lib/admin-api', async () => {
  const actual = await import('@/lib/api')
  return {
    SessionExpiredError: class SessionExpiredError extends actual.ApiError {
      constructor() {
        super(401, 'UNAUTHENTICATED', 'expired')
      }
    },
  }
})
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect,
}))
vi.mock('next/cache', () => ({ updateTag: vi.fn(), revalidateTag: vi.fn(), revalidatePath: vi.fn() }))

import { updateTag } from 'next/cache'
import { SessionExpiredError } from '@/lib/admin-api'
import { ApiError } from '@/lib/api'
import { POST_IMPORT_LIMIT_VALUES } from '@/lib/post-import'
import { msg } from '@/test/render-intl'
import { applyPosts, previewPosts } from './actions'

const HASH = 'a'.repeat(64)
const STATE = 'dXBkYXRlfHg'
const markdown = (content = '---\ntitle: One\n---\nBody\n', name = 'one.md') =>
  new File([content], name, { type: 'text/markdown' })
const previewForm = (...files: File[]) => {
  const form = new FormData()
  for (const file of files) form.append('file', file)
  return form
}
const item = (over: Record<string, unknown> = {}) => ({ sha256: HASH, selected: true, state: STATE, ...over })
const applyForm = (files: File[] = [markdown()], manifest: unknown = files.map(() => item())) => {
  const form = previewForm(...files)
  if (manifest !== null) form.append('manifest', typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
  return form
}
const errors = (key: string, values: Record<string, unknown> = {}) => ({
  error: msg(`Admin.posts.import.errors.${key}`, { ...POST_IMPORT_LIMIT_VALUES, position: 0, ...values }),
})
const written = (result: string) => ({
  importId: 7,
  files: [{ position: 1, fileName: 'one.md', result, postId: '1b4e28ba-2fa1-11d2-883f-0016d3cca427', slug: 'one' }],
  created: result === 'created' ? 1 : 0,
  skipped: 0,
})

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('previewPosts', () => {
  it('passes the files on in order and returns the preview without clearing any cache', async () => {
    const preview = { files: [], filesWithProblems: [] }
    previewPostFiles.mockResolvedValue(preview)

    await expect(previewPosts(previewForm(markdown(), markdown('x', 'two.md')))).resolves.toEqual(preview)

    expect((previewPostFiles.mock.calls[0]![0] as File[]).map((file) => file.name)).toEqual(['one.md', 'two.md'])
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('refuses no file, an empty, oversized or non-Markdown file, too many files and a total over the cap before calling the backend', async () => {
    await expect(previewPosts(previewForm())).resolves.toEqual(errors('noFile'))
    await expect(previewPosts(previewForm(markdown('')))).resolves.toEqual(errors('emptyFile', { position: 1 }))
    await expect(previewPosts(previewForm(markdown('x'.repeat(262_145))))).resolves.toEqual(
      errors('fileTooLarge', { position: 1 }),
    )
    await expect(previewPosts(previewForm(markdown(), markdown('x', 'two.txt')))).resolves.toEqual(
      errors('notMarkdown', { position: 2 }),
    )
    await expect(previewPosts(previewForm(...Array.from({ length: 21 }, () => markdown())))).resolves.toEqual(errors('tooMany'))
    await expect(previewPosts(previewForm(...Array.from({ length: 17 }, () => markdown('x'.repeat(262_144)))))).resolves.toEqual(
      errors('totalTooLarge'),
    )
    expect(previewPostFiles).not.toHaveBeenCalled()
  })

  it('a form part that is not a file is a malformed request', async () => {
    const form = new FormData()
    form.append('file', 'not a file')

    await expect(previewPosts(form)).resolves.toEqual(errors('badArguments'))
    expect(previewPostFiles).not.toHaveBeenCalled()
  })

  it('sends a ZIP package on like a Markdown file, and refuses an empty or an oversized one by position', async () => {
    previewPostFiles.mockResolvedValue({ files: [], filesWithProblems: [] })

    await previewPosts(previewForm(markdown(), markdown('PK', 'article.zip')))
    expect((previewPostFiles.mock.calls[0]![0] as File[]).map((file) => file.name)).toEqual(['one.md', 'article.zip'])

    previewPostFiles.mockClear()
    await expect(previewPosts(previewForm(markdown('', 'empty.zip')))).resolves.toEqual(errors('emptyFile', { position: 1 }))
    await expect(previewPosts(previewForm(markdown('x'.repeat(4 * 1024 * 1024 + 1), 'big.zip')))).resolves.toEqual(
      errors('packageTooLarge', { position: 1 }),
    )
    expect(previewPostFiles).not.toHaveBeenCalled()
  })

  it('shows the reason of a refused file, the rate limit sentence, and sends an expired session to login', async () => {
    previewPostFiles.mockRejectedValueOnce(
      new ApiError(400, 'POST_IMPORT_INVALID_FILE', 'File 1: line 3 has a control character'),
    )
    await expect(previewPosts(previewForm(markdown()))).resolves.toEqual({
      error: msg('Errors.admin.refusedDetail', { detail: 'File 1: line 3 has a control character' }),
    })

    previewPostFiles.mockRejectedValueOnce(new ApiError(429, 'RATE_LIMITED', 'Too many requests'))
    await expect(previewPosts(previewForm(markdown()))).resolves.toEqual({ error: msg('Errors.admin.codes.RATE_LIMITED') })

    previewPostFiles.mockRejectedValueOnce(new SessionExpiredError())
    await expect(previewPosts(previewForm(markdown()))).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login')
  })
})

describe('applyPosts', () => {
  it('sends the files and the manifest and clears the five tags once after a write', async () => {
    applyPostFiles.mockResolvedValue(written('created'))

    await expect(applyPosts(applyForm())).resolves.toEqual(written('created'))

    const args = applyPostFiles.mock.calls[0]![0] as { files: File[]; manifest: unknown[] }
    expect(args.files.map((file) => file.name)).toEqual(['one.md'])
    expect(args.manifest).toEqual([item()])
    expect((updateTag as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]).sort()).toEqual([
      'categories',
      'posts',
      'search',
      'series',
      'tags',
    ])
  })

  it('an update clears the tags too; unchanged or skipped files write nothing and clear nothing', async () => {
    applyPostFiles.mockResolvedValueOnce(written('updated'))
    await applyPosts(applyForm())
    expect(updateTag).toHaveBeenCalledTimes(5)

    vi.clearAllMocks()
    applyPostFiles.mockResolvedValueOnce({
      importId: null,
      files: [written('unchanged').files[0], written('skipped').files[0]],
      created: 0,
      skipped: 1,
    })
    await applyPosts(applyForm())
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('clears no cache when the backend refuses, and marks the codes that ask for a new preview as stale', async () => {
    applyPostFiles.mockRejectedValueOnce(new ApiError(409, 'POST_IMPORT_HASH_MISMATCH', '1 file'))
    await expect(applyPosts(applyForm())).resolves.toEqual({
      error: msg('Errors.admin.codes.POST_IMPORT_HASH_MISMATCH'),
      stale: true,
    })

    applyPostFiles.mockRejectedValueOnce(new ApiError(409, 'POST_IMPORT_PREVIEW_OUT_OF_DATE', '2 posts'))
    await expect(applyPosts(applyForm())).resolves.toEqual({
      error: msg('Errors.admin.codes.POST_IMPORT_PREVIEW_OUT_OF_DATE'),
      stale: true,
    })

    applyPostFiles.mockRejectedValueOnce(new ApiError(429, 'RATE_LIMITED', 'Too many requests'))
    await expect(applyPosts(applyForm())).resolves.toEqual({ error: msg('Errors.admin.codes.RATE_LIMITED') })

    applyPostFiles.mockRejectedValueOnce(new ApiError(400, 'POST_IMPORT_INVALID', 'File 2: title is missing'))
    await expect(applyPosts(applyForm())).resolves.toEqual({
      error: msg('Errors.admin.refusedDetail', { detail: 'File 2: title is missing' }),
    })

    expect(updateTag).not.toHaveBeenCalled()
  })

  it('sends an expired session to login without clearing anything', async () => {
    applyPostFiles.mockRejectedValueOnce(new SessionExpiredError())

    await expect(applyPosts(applyForm())).rejects.toThrow('NEXT_REDIRECT')

    expect(redirect).toHaveBeenCalledWith('/admin/login')
    expect(updateTag).not.toHaveBeenCalled()
  })

  it.each([
    ['no manifest', applyForm([markdown()], null)],
    ['a manifest that is not JSON', applyForm([markdown()], '{nope')],
    ['a manifest that is not an array', applyForm([markdown()], { sha256: HASH })],
    ['fewer items than files', applyForm([markdown(), markdown()], [item()])],
    ['a hash that is not 64 hex characters', applyForm([markdown()], [item({ sha256: 'xyz' })])],
    ['an upper case hash', applyForm([markdown()], [item({ sha256: 'A'.repeat(64) })])],
    ['a selection that is not a boolean', applyForm([markdown()], [item({ selected: 'yes' })])],
    ['a state with forbidden characters', applyForm([markdown()], [item({ state: 'a|b' })])],
    ['an extra key in an item', applyForm([markdown()], [item({ name: 'one.md' })])],
    ['nothing selected', applyForm([markdown()], [item({ selected: false })])],
  ])('refuses %s before calling the backend', async (_name, form) => {
    await expect(applyPosts(form)).resolves.toEqual(errors('badArguments'))
    expect(applyPostFiles).not.toHaveBeenCalled()
  })

  it('two manifest parts are a malformed request, and the file checks apply to an apply too', async () => {
    const twice = applyForm()
    twice.append('manifest', JSON.stringify([item()]))
    await expect(applyPosts(twice)).resolves.toEqual(errors('badArguments'))

    await expect(applyPosts(applyForm([markdown('x', 'one.txt')]))).resolves.toEqual(errors('notMarkdown', { position: 1 }))
    expect(applyPostFiles).not.toHaveBeenCalled()
  })

  it('accepts an unselected file with no state next to a selected one', async () => {
    applyPostFiles.mockResolvedValue(written('created'))

    await applyPosts(applyForm([markdown(), markdown('x', 'two.md')], [item(), item({ selected: false, state: null })]))

    expect(applyPostFiles).toHaveBeenCalledTimes(1)
  })
})
