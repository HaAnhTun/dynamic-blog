'use server'

import { getTranslations } from 'next-intl/server'
import { updateTag } from 'next/cache'
import { runAdminAction } from '@/lib/admin-action'
import {
  applyImport,
  getImportStatus,
  previewFile,
  undoImport,
  type ApplyResult,
  type ImportMode,
  type ImportPreview,
  type ImportStatus,
  type UndoResult,
} from '@/lib/admin-site-import'
import { ApiError } from '@/lib/api'
import { checkProfileFile } from '@/lib/site-import'

/*
 * The writes of the profile import. An action is an endpoint anyone can POST to: the arguments are checked here again, and the
 * backend checks the file and the hash anyway. The public pages read the content through the 'site-content' tag, so only a
 * successful write clears it.
 */

const MAX_SECTIONS = 20
const SECTION_ID = /^[a-z0-9_-]{1,40}$/
const SHA256 = /^[0-9a-f]{64}$/
const MODES: readonly string[] = ['create-only', 'update']
/** Backend codes with a sentence of their own in `Admin.settings.profileImport.errors`. */
const OWN_CODES: readonly string[] = ['SITE_IMPORT_HASH_MISMATCH', 'SITE_IMPORT_NOTHING_TO_UNDO', 'SITE_IMPORT_UNDO_CONFLICT']
/** The codes of an undo that was aimed at an import which is not the undoable one any more. */
const STALE_CODES: readonly string[] = ['SITE_IMPORT_NOTHING_TO_UNDO', 'SITE_IMPORT_UNDO_CONFLICT']

/** `stale`: the import shown on the page is no longer the one the backend would undo, so the page should reload its status. */
export type ImportError = { error: string; stale?: true }
type ErrorKey = 'noFile' | 'fileTooLarge' | 'packageTooLarge' | 'notMarkdown' | 'badArguments'

async function failure(key: string): Promise<ImportError> {
  return { error: (await getTranslations('Admin.settings.profileImport.errors'))(key) }
}

/** A Markdown file or a ZIP package (the file and its images); the limits are the backend's, the check only saves a round trip. */
function fileOf(form: FormData): File | ErrorKey {
  const file = form.get('file')
  if (!(file instanceof File)) return 'noFile'
  return checkProfileFile(file) ?? file
}

/**
 * The refusal of a file (`SITE_IMPORT_INVALID`, `SITE_IMPORT_INVALID_FILE`) carries line numbers and field names, never values,
 * so the shared sentence with the backend reason is right for it; the codes of the import itself get their own sentence.
 */
async function guard<T>(fn: () => Promise<T>): Promise<T | ImportError> {
  return runAdminAction(async () => {
    try {
      return await fn()
    } catch (error) {
      if (error instanceof ApiError && error.code !== undefined && OWN_CODES.includes(error.code)) {
        const refusal = await failure(`codes.${error.code}`)
        return STALE_CODES.includes(error.code) ? { ...refusal, stale: true } : refusal
      }
      throw error
    }
  })
}

export async function previewProfile(form: FormData): Promise<ImportPreview | ImportError> {
  const file = fileOf(form)
  if (typeof file === 'string') return failure(file)
  return guard(() => previewFile(file))
}

export async function applyProfile(form: FormData): Promise<ApplyResult | ImportError> {
  const file = fileOf(form)
  if (typeof file === 'string') return failure(file)
  // One value each: a repeated field is a malformed request, not a choice between two values.
  const [sha256, ...extraHashes] = form.getAll('sha256')
  const [mode, ...extraModes] = form.getAll('mode')
  const sections = form.getAll('sections')
  if (typeof sha256 !== 'string' || extraHashes.length > 0 || !SHA256.test(sha256)) return failure('badArguments')
  if (typeof mode !== 'string' || extraModes.length > 0 || !MODES.includes(mode)) return failure('badArguments')
  if (sections.length === 0 || sections.length > MAX_SECTIONS) return failure('badArguments')
  const ids: string[] = []
  for (const id of sections) {
    if (typeof id !== 'string' || !SECTION_ID.test(id) || ids.includes(id)) return failure('badArguments')
    ids.push(id)
  }
  const result = await guard(() => applyImport({ file, sha256, mode: mode as ImportMode, sections: ids }))
  if ('error' in result) return result
  if (result.sections.some((s) => s.status === 'created' || s.status === 'updated')) updateTag('site-content')
  return result
}

/** The import the admin sees is the one undone: an id that is not a positive safe integer is a malformed request. */
export async function undoProfile(importId: number): Promise<UndoResult | ImportError> {
  if (typeof importId !== 'number' || !Number.isSafeInteger(importId) || importId <= 0) return failure('badArguments')
  const result = await guard(() => undoImport(importId))
  if ('error' in result) return result
  updateTag('site-content')
  return result
}

/** The page reloads the last import after an undo or a refused one, to offer only what the backend would still undo. */
export async function loadImportStatus(): Promise<ImportStatus | ImportError> {
  return guard(() => getImportStatus())
}
