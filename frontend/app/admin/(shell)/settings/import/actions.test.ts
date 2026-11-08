// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

const { previewFile, applyImport, undoImport, getImportStatus, redirect } = vi.hoisted(() => ({
  previewFile: vi.fn(),
  applyImport: vi.fn(),
  undoImport: vi.fn(),
  getImportStatus: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;push;${url};307;` })
  }),
}))
vi.mock('@/lib/admin-site-import', () => ({ previewFile, applyImport, undoImport, getImportStatus }))
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
import { msg } from '@/test/render-intl'
import { applyProfile, loadImportStatus, previewProfile, undoProfile } from './actions'

const HASH = 'a'.repeat(64)
const markdown = (content = '# Site\n', name = 'profile.md') => new File([content], name, { type: 'text/markdown' })
const previewForm = (file?: File) => {
  const form = new FormData()
  if (file) form.append('file', file)
  return form
}
const applyForm = (
  over: { file?: File; sha256?: string; mode?: string; sections?: string[] } = {},
  keep: { file?: boolean } = {},
) => {
  const form = new FormData()
  if (keep.file !== false) form.append('file', over.file ?? markdown())
  form.append('sha256', over.sha256 ?? HASH)
  form.append('mode', over.mode ?? 'update')
  for (const id of over.sections ?? ['identity']) form.append('sections', id)
  return form
}
const withExtra = (form: FormData, name: string, value: string | File) => {
  form.append(name, value)
  return form
}
const replaced = (form: FormData, name: string, value: string | File) => {
  form.set(name, value)
  return form
}
const errors = (key: string) => ({ error: msg(`Admin.settings.profileImport.errors.${key}`) })

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('previewProfile', () => {
  it('passes the file on and returns the preview without clearing any cache', async () => {
    const preview = { sha256: HASH, sections: [] }
    previewFile.mockResolvedValue(preview)

    await expect(previewProfile(previewForm(markdown()))).resolves.toEqual(preview)

    expect(previewFile).toHaveBeenCalledTimes(1)
    expect((previewFile.mock.calls[0]![0] as File).name).toBe('profile.md')
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('refuses a missing, empty, oversized or non-Markdown file before calling the backend', async () => {
    await expect(previewProfile(previewForm())).resolves.toEqual(errors('noFile'))
    await expect(previewProfile(previewForm(markdown('')))).resolves.toEqual(errors('noFile'))
    await expect(previewProfile(previewForm(markdown('x'.repeat(262_145))))).resolves.toEqual(errors('fileTooLarge'))
    await expect(previewProfile(previewForm(markdown('x', 'profile.txt')))).resolves.toEqual(errors('notMarkdown'))
    await expect(previewProfile(previewForm(markdown('x', 'PROFILE.MD')))).resolves.toBeDefined()
    expect(previewFile).toHaveBeenCalledTimes(1)
  })

  it('passes a ZIP package on like a Markdown file and applies the package limit to it', async () => {
    previewFile.mockResolvedValue({ sha256: HASH, sections: [] })
    const pack = (size: number, name = 'about.zip') => new File([new Uint8Array(size)], name, { type: 'application/zip' })

    await expect(previewProfile(previewForm(pack(300_000)))).resolves.toEqual({ sha256: HASH, sections: [] })
    expect((previewFile.mock.calls[0]![0] as File).name).toBe('about.zip')

    await expect(previewProfile(previewForm(pack(4 * 1024 * 1024 + 1)))).resolves.toEqual(errors('packageTooLarge'))
    await expect(previewProfile(previewForm(pack(0)))).resolves.toEqual(errors('noFile'))
    expect(previewFile).toHaveBeenCalledTimes(1)
  })

  it('shows the reason of a refused file and sends an expired session to login', async () => {
    previewFile.mockRejectedValueOnce(new ApiError(400, 'SITE_IMPORT_INVALID_FILE', 'line 3 is too long'))
    const refused = await previewProfile(previewForm(markdown()))
    expect(refused).toEqual({ error: msg('Errors.admin.refusedDetail', { detail: 'line 3 is too long' }) })

    previewFile.mockRejectedValueOnce(new SessionExpiredError())
    await expect(previewProfile(previewForm(markdown()))).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login')
  })
})

describe('applyProfile', () => {
  it('sends the arguments and clears the site-content tag once after a write', async () => {
    const result = {
      importId: 4,
      locale: 'en',
      mode: 'update',
      sections: [{ id: 'identity', key: 'profile', status: 'updated' }],
    }
    applyImport.mockResolvedValue(result)

    await expect(applyProfile(applyForm({ sections: ['identity', 'skills'] }))).resolves.toEqual(result)

    expect(applyImport).toHaveBeenCalledWith({
      file: expect.any(File),
      sha256: HASH,
      mode: 'update',
      sections: ['identity', 'skills'],
    })
    expect(updateTag).toHaveBeenCalledTimes(1)
    expect(updateTag).toHaveBeenCalledWith('site-content')
  })

  it('applies a ZIP package like a Markdown file and clears the content cache when it wrote something', async () => {
    applyImport.mockResolvedValue({
      importId: 8,
      locale: 'en',
      mode: 'update',
      sections: [{ id: 'about', key: 'about', status: 'updated' }],
    })
    const pack = new File([new Uint8Array(1000)], 'about.zip', { type: 'application/zip' })

    await expect(applyProfile(applyForm({ file: pack, sections: ['about'] }))).resolves.toHaveProperty('importId', 8)

    expect((applyImport.mock.calls[0]![0] as { file: File }).file.name).toBe('about.zip')
    expect(updateTag).toHaveBeenCalledWith('site-content')

    const huge = new File([new Uint8Array(4 * 1024 * 1024 + 1)], 'about.zip')
    await expect(applyProfile(applyForm({ file: huge }))).resolves.toEqual(errors('packageTooLarge'))
    expect(applyImport).toHaveBeenCalledTimes(1)
  })

  it('clears nothing when every section was unchanged or skipped', async () => {
    applyImport.mockResolvedValue({
      importId: null,
      locale: 'en',
      mode: 'create-only',
      sections: [
        { id: 'identity', key: 'profile', status: 'unchanged' },
        { id: 'skills', key: 'skills', status: 'skipped' },
      ],
    })

    await expect(applyProfile(applyForm({ mode: 'create-only' }))).resolves.toHaveProperty('importId', null)

    expect(updateTag).not.toHaveBeenCalled()
  })

  it.each([
    ['a missing file', applyForm({}, { file: false }), 'noFile'],
    ['a file that is not Markdown', applyForm({ file: markdown('x', 'a.json') }), 'notMarkdown'],
    ['a malformed hash', applyForm({ sha256: 'xyz' }), 'badArguments'],
    ['an upper-case hash', applyForm({ sha256: 'A'.repeat(64) }), 'badArguments'],
    ['an unknown mode', applyForm({ mode: 'replace' }), 'badArguments'],
    ['no section', applyForm({ sections: [] }), 'badArguments'],
    ['too many sections', applyForm({ sections: Array.from({ length: 21 }, (_, i) => `s${i}`) }), 'badArguments'],
    ['a malformed section id', applyForm({ sections: ['Identity!'] }), 'badArguments'],
    ['a repeated section id', applyForm({ sections: ['identity', 'identity'] }), 'badArguments'],
    ['a section that is a file, not text', withExtra(applyForm(), 'sections', markdown('identity')), 'badArguments'],
    ['a repeated hash', withExtra(applyForm(), 'sha256', HASH), 'badArguments'],
    ['a repeated mode', withExtra(applyForm(), 'mode', 'update'), 'badArguments'],
    ['a hash that is a file, not text', replaced(applyForm(), 'sha256', markdown(HASH)), 'badArguments'],
  ])('refuses %s before calling the backend', async (_name, form, key) => {
    await expect(applyProfile(form)).resolves.toEqual(errors(key))
    expect(applyImport).not.toHaveBeenCalled()
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('maps the import codes to their own sentence and clears nothing on a failure', async () => {
    applyImport.mockRejectedValueOnce(new ApiError(409, 'SITE_IMPORT_HASH_MISMATCH', 'hash'))
    await expect(applyProfile(applyForm())).resolves.toEqual(errors('codes.SITE_IMPORT_HASH_MISMATCH'))

    applyImport.mockRejectedValueOnce(new ApiError(400, 'SITE_IMPORT_INVALID', 'Skills line 4 level: not allowed'))
    await expect(applyProfile(applyForm())).resolves.toEqual({
      error: msg('Errors.admin.refusedDetail', { detail: 'Skills line 4 level: not allowed' }),
    })

    applyImport.mockRejectedValueOnce(new ApiError(429, 'RATE_LIMITED', 'slow down'))
    await expect(applyProfile(applyForm())).resolves.toEqual({ error: msg('Errors.admin.codes.RATE_LIMITED') })

    applyImport.mockRejectedValueOnce(new TypeError('fetch failed'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(applyProfile(applyForm())).resolves.toEqual({ error: msg('Errors.admin.unreachable') })

    expect(updateTag).not.toHaveBeenCalled()
  })
})

describe('undoProfile', () => {
  it('clears the tag after a successful undo', async () => {
    const result = { importId: 4, locale: 'en', sections: [{ key: 'profile', status: 'restored' }] }
    undoImport.mockResolvedValue(result)

    await expect(undoProfile(4)).resolves.toEqual(result)

    expect(undoImport).toHaveBeenCalledWith(4)
    expect(updateTag).toHaveBeenCalledWith('site-content')
  })

  it('a stale id or nothing to undo comes back as a sentence marked stale and clears nothing', async () => {
    undoImport.mockRejectedValueOnce(new ApiError(409, 'SITE_IMPORT_UNDO_CONFLICT', 'A newer import exists; reload the page'))
    await expect(undoProfile(4)).resolves.toEqual({ ...errors('codes.SITE_IMPORT_UNDO_CONFLICT'), stale: true })

    undoImport.mockRejectedValueOnce(new ApiError(404, 'SITE_IMPORT_NOTHING_TO_UNDO', 'none'))
    await expect(undoProfile(4)).resolves.toEqual({ ...errors('codes.SITE_IMPORT_NOTHING_TO_UNDO'), stale: true })

    expect(updateTag).not.toHaveBeenCalled()
  })

  it('refuses an id that is not a positive safe integer without calling the backend', async () => {
    for (const bad of [0, -3, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '4', null, undefined]) {
      await expect(undoProfile(bad as never)).resolves.toEqual(errors('badArguments'))
    }

    expect(undoImport).not.toHaveBeenCalled()
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('another failure carries no stale mark', async () => {
    undoImport.mockRejectedValueOnce(new ApiError(409, 'SITE_IMPORT_HASH_MISMATCH', 'changed'))
    const outcome = await undoProfile(4)
    expect(outcome).not.toHaveProperty('stale')
  })
})

describe('loadImportStatus', () => {
  it('returns the status, writes nothing and clears no tag', async () => {
    getImportStatus.mockResolvedValue({ lastImport: null })

    await expect(loadImportStatus()).resolves.toEqual({ lastImport: null })

    expect(updateTag).not.toHaveBeenCalled()
  })

  it('an expired session goes to the login page', async () => {
    getImportStatus.mockRejectedValueOnce(new SessionExpiredError())

    await expect(loadImportStatus()).rejects.toThrow('NEXT_REDIRECT')
  })
})
