'use server'

import { getTranslations } from 'next-intl/server'
import { updateTag } from 'next/cache'
import { adminErrorMessage, runAdminAction } from '@/lib/admin-action'
import {
  createCategory,
  createTag,
  deleteCategory,
  deleteTag,
  mergeCategory,
  mergeTag,
  renameTag,
  updateCategory,
} from '@/lib/admin-api'
import type { ApiError } from '@/lib/api'
import type { Translator } from '@/i18n/translator'
import { LOCALES } from '@/i18n/config'
import type { Category, LocalizedText, Tag } from '@/lib/types'

/*
 * The six actions of the Topics page: create, rename, delete categories and tags. The backend is
 * where permission is checked (edit/delete ADMIN only), duplicate names, and "a category that still has posts cannot be deleted"; here only
 * an empty name is blocked so the error message names the right field, and the cache is cleared on success.
 *
 * One successful write clears three tags:
 * - 'categories' / 'tags': the public list (lib/taxonomy.ts), the /topics page, and the check that
 *   /categories/[slug], /tags/[slug] do for whether the category/tag exists;
 * - 'posts': the category and tag names printed on every post list and post page (getPost carries this tag too);
 * - 'search': the same names on the search result rows.
 * Cleared only on success: updateTag also re-renders the current page, useless for a failure.
 */

/** A category or tag as the screen needs it: a tag has no description. */
export type TopicRecord = {
  id: string
  name: string
  slug: string
  description: string | null
  translations?: Record<string, LocalizedText>
}

export type TopicOutcome = TopicRecord | { error: string }

function invalidate(kind: 'categories' | 'tags') {
  updateTag(kind)
  updateTag('posts')
  updateTag('search')
}

/** The name trimmed, or null when empty: the backend's "must not be blank" message is in English. */
function nameOf(raw: string): string | null {
  const name = raw.trim()
  return name === '' ? null : name
}

/** An empty or whitespace-only description means no description. */
function descriptionOf(raw: string | null): string | null {
  const description = raw?.trim() ?? ''
  return description === '' ? null : description
}

/**
 * The per-language texts to send, or undefined when none were given (the backend then keeps what it has). Only enabled locales
 * and trimmed text pass: an action is an endpoint anyone can POST to, and the backend answers an unknown locale with a 400
 * that names no field.
 */
function translationsOf(raw: Record<string, LocalizedText> | undefined): Record<string, LocalizedText> | undefined {
  if (raw === undefined || raw === null || typeof raw !== 'object') return undefined
  const result: Record<string, LocalizedText> = {}
  for (const locale of LOCALES) {
    const entry = raw[locale]
    const name = typeof entry?.name === 'string' ? entry.name.trim() : ''
    const description = typeof entry?.description === 'string' ? entry.description.trim() : ''
    if (name !== '' || description !== '') {
      result[locale] = { name: name === '' ? null : name, description: description === '' ? null : description }
    }
  }
  return result
}

function fromCategory(category: Category): TopicRecord {
  return {
    id: category.id,
    name: category.name,
    slug: category.slug,
    description: category.description,
    translations: category.translations,
  }
}

function fromTag(tag: Tag): TopicRecord {
  return { id: tag.id, name: tag.name, slug: tag.slug, description: null, translations: tag.translations }
}

export async function newCategory(name: string, description: string | null): Promise<TopicOutcome> {
  const clean = nameOf(name)
  if (clean === null) return { error: (await getTranslations('Admin.topics'))('nameRequired') }
  const result = await runAdminAction(() => createCategory(clean, descriptionOf(description)))
  if ('error' in result) return result
  invalidate('categories')
  return fromCategory(result)
}

/** Rename and describe. The slug stays unchanged at the backend: it is the public URL /categories/{slug}. */
export async function saveCategory(
  id: string,
  name: string,
  description: string | null,
  translations?: Record<string, LocalizedText>,
): Promise<TopicOutcome> {
  const clean = nameOf(name)
  if (clean === null) return { error: (await getTranslations('Admin.topics'))('nameRequired') }
  const result = await runAdminAction(() =>
    updateCategory(id, {
      name: clean,
      description: descriptionOf(description),
      translations: translationsOf(translations),
    }),
  )
  if ('error' in result) return result
  invalidate('categories')
  return fromCategory(result)
}

/** null means deleted. If posts still use it the backend returns 409 CATEGORY_IN_USE, turned into a Vietnamese message in place. */
export async function removeCategory(id: string): Promise<{ error: string } | null> {
  const result = await runAdminAction(() => deleteCategory(id))
  if (result !== null) return result
  invalidate('categories')
  return null
}

export async function newTag(name: string): Promise<TopicOutcome> {
  const clean = nameOf(name)
  if (clean === null) return { error: (await getTranslations('Admin.topics'))('nameRequired') }
  const result = await runAdminAction(() => createTag(clean))
  if ('error' in result) return result
  invalidate('tags')
  return fromTag(result)
}

/** The third parameter is the description TopicManager sends for every kind; a tag has none. */
export async function saveTag(
  id: string,
  name: string,
  _description?: string | null,
  translations?: Record<string, LocalizedText>,
): Promise<TopicOutcome> {
  const clean = nameOf(name)
  if (clean === null) return { error: (await getTranslations('Admin.topics'))('nameRequired') }
  const result = await runAdminAction(() => renameTag(id, clean, translationsOf(translations)))
  if ('error' in result) return result
  invalidate('tags')
  return fromTag(result)
}

/** null means deleted; the tag leaves every post carrying it, the posts remain. */
export async function removeTag(id: string): Promise<{ error: string } | null> {
  const result = await runAdminAction(() => deleteTag(id))
  if (result !== null) return result
  invalidate('tags')
  return null
}

/*
 * Merge: every post of the source goes to the target, then the source is deleted — in one transaction at the
 * backend, touching no post's `updatedAt`. For a tag it is "Merge into…" (a post carrying both ends up with only the target, exactly
 * once); for a category it is "Move posts then delete", the only way to drop a category that still has posts.
 *
 * The same three cache tags as every other write of the page: the topic name printed on every post ('posts', 'search'), and the
 * public topic list of that kind. The page /tags/<source> or /categories/<source> becomes a 404 at once.
 */

/** The target as the backend stored it, and the number of posts that carried the source (any status). */
export type MergeOutcome = { target: TopicRecord; moved: number } | { error: string }

/** An old backend without the merge endpoint returns 404 ENDPOINT_NOT_FOUND: an English "could not be done: …" is useless. */
function mergeErrorMessage(unsupported: string) {
  return (error: ApiError, t: Translator): string =>
    error.code === 'ENDPOINT_NOT_FOUND' ? unsupported : adminErrorMessage(error, t)
}

/** Move every post of category `id` to `targetId`, then delete `id`. */
export async function mergeCategoryInto(id: string, targetId: string): Promise<MergeOutcome> {
  const t = await getTranslations('Admin.topics')
  if (targetId === '' || targetId === id) return { error: t('pickOtherCategory') }
  const result = await runAdminAction(() => mergeCategory(id, targetId), mergeErrorMessage(t('mergeUnsupported')))
  if ('error' in result) return result
  invalidate('categories')
  return { target: fromCategory(result.target), moved: result.moved }
}

/** Merge tag `id` into `targetId`: every post carrying `id` carries `targetId`, then `id` is deleted. */
export async function mergeTagInto(id: string, targetId: string): Promise<MergeOutcome> {
  const t = await getTranslations('Admin.topics')
  if (targetId === '' || targetId === id) return { error: t('pickOtherTag') }
  const result = await runAdminAction(() => mergeTag(id, targetId), mergeErrorMessage(t('mergeUnsupported')))
  if ('error' in result) return result
  invalidate('tags')
  return { target: fromTag(result.target), moved: result.moved }
}
