'use server'

import type { ReactNode } from 'react'
import { getTranslations } from 'next-intl/server'
import { updateTag } from 'next/cache'
import { runAdminAction } from '@/lib/admin-action'
import { applyPostFiles, previewPostArticle, previewPostFiles } from '@/lib/admin-post-import'
import { ApiError } from '@/lib/api'
import { articlePreviewNode } from '@/lib/article-preview'
import { countBlocks } from '@/lib/blocks/summary'
import { validateBlocks } from '@/lib/blocks/validate'
import {
  POST_IMPORT_LIMIT_VALUES,
  POST_IMPORT_MAX_BLOCK_PROBLEMS,
  POST_IMPORT_SHA256,
  POST_IMPORT_STALE_CODES,
  POST_IMPORT_STATE,
  checkPostFiles,
  type PostApplyResult,
  type PostArticleCheck,
  type PostManifestItem,
  type PostPreview,
} from '@/lib/post-import'

/*
 * The calls of the post import. An action is an endpoint anyone can POST to: the arguments are checked here again (the files, and
 * for an apply the manifest), and the backend checks them anyway, so these checks only save a round trip. The public pages read
 * posts, search, categories, tags and series through cache tags, so a successful write clears the five of them, and nothing else does.
 */

/** `stale`: the files or the posts are not what the preview showed, so the page asks for a new preview. */
export type PostImportError = { error: string; stale?: true }

async function failure(key: string, position?: number): Promise<PostImportError> {
  return {
    error: (await getTranslations('Admin.posts.import.errors'))(key, { ...POST_IMPORT_LIMIT_VALUES, position: position ?? 0 }),
  }
}

/** The files of the form in upload order, or the refusal that stops the request before the backend is called. */
async function filesOf(form: FormData): Promise<File[] | PostImportError> {
  const parts = form.getAll('file')
  if (!parts.every((part): part is File => part instanceof File)) return failure('badArguments')
  const refusal = checkPostFiles(parts)
  return refusal === null ? parts : failure(refusal.key, refusal.position)
}

/** The ONE file of an article request, or the refusal that stops it before the backend is called. */
async function fileOf(form: FormData): Promise<File | PostImportError> {
  const files = await filesOf(form)
  if ('error' in files) return files
  return files.length === 1 ? files[0]! : failure('badArguments')
}

/** One text field holding a JSON array with one item per file; anything else is a malformed request. */
function manifestOf(form: FormData, count: number): PostManifestItem[] | null {
  const parts = form.getAll('manifest')
  if (parts.length !== 1 || typeof parts[0] !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(parts[0])
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length !== count) return null
  const items: PostManifestItem[] = []
  for (const item of parsed as unknown[]) {
    if (typeof item !== 'object' || item === null) return null
    const { sha256, selected, state, ...extra } = item as Record<string, unknown>
    if (Object.keys(extra).length > 0) return null
    if (typeof sha256 !== 'string' || !POST_IMPORT_SHA256.test(sha256) || typeof selected !== 'boolean') return null
    if (state !== null && (typeof state !== 'string' || !POST_IMPORT_STATE.test(state))) return null
    items.push({ sha256, selected, state })
  }
  return items
}

/** The codes that ask for a new preview carry the flag; every other error is the shared sentence of the admin actions. */
async function guard<T>(fn: () => Promise<T>): Promise<T | PostImportError> {
  return runAdminAction(async () => {
    try {
      return await fn()
    } catch (error) {
      if (error instanceof ApiError && error.code !== undefined && POST_IMPORT_STALE_CODES.includes(error.code)) {
        const t = await getTranslations('Errors.admin')
        return { error: t(`codes.${error.code}`), stale: true as const }
      }
      throw error
    }
  })
}

export async function previewPosts(form: FormData): Promise<PostPreview | PostImportError> {
  const files = await filesOf(form)
  if ('error' in files) return files
  return guard(() => previewPostFiles(files))
}

export async function applyPosts(form: FormData): Promise<PostApplyResult | PostImportError> {
  const files = await filesOf(form)
  if ('error' in files) return files
  const manifest = manifestOf(form, files.length)
  if (manifest === null || !manifest.some((item) => item.selected)) return failure('badArguments')
  const result = await guard(() => applyPostFiles({ files, manifest }))
  if ('error' in result) return result
  // Only a write changes what the public pages show; "unchanged" and "skipped" files write nothing.
  if (result.files.some((file) => file.result === 'created' || file.result === 'updated')) {
    updateTag('posts')
    updateTag('search')
    updateTag('categories')
    updateTag('tags')
    updateTag('series')
  }
  return result
}

/**
 * The check of the block syntax of ONE file's article, for the preview: the backend returns the body (it unpacks a package, which only
 * it can), `validateBlocks` and `countBlocks` read it here. A mistake is reported with the line of the FILE (the body starts at
 * `bodyLine`). Plain data only; the article itself is `renderArticle`. A file the backend could not read has no body and so nothing to say:
 * the preview lists why it cannot be imported.
 */
export async function checkArticle(form: FormData): Promise<PostArticleCheck | PostImportError> {
  const file = await fileOf(form)
  if ('error' in file) return file
  return guard(async () => {
    const article = await previewPostArticle(file)
    const body = article.body ?? ''
    const problems = validateBlocks(body)
    const offset = Math.max(article.bodyLine, 1) - 1
    return {
      problems: problems.slice(0, POST_IMPORT_MAX_BLOCK_PROBLEMS).map((problem) => ({
        line: problem.line + offset,
        code: problem.code,
        block: problem.block ?? null,
        message: problem.message,
      })),
      problemsTotal: problems.length,
      blocks: countBlocks(body),
    }
  })
}

/**
 * The article of ONE file drawn as the post page draws it (the real article template and the real Markdown pipeline, the images of a
 * package from their bytes), returned as React elements: a Server Action can return them, the page shows them where they arrive. It reads
 * the file again from the backend instead of taking the body from the page, so the page never sends text it could have altered.
 */
export async function renderArticle(form: FormData): Promise<{ article: ReactNode } | PostImportError> {
  const file = await fileOf(form)
  if ('error' in file) return file
  return guard(async () => {
    const article = await previewPostArticle(file)
    if (article.body === null) return failure('articleUnavailable')
    return { article: await articlePreviewNode(article) }
  })
}
