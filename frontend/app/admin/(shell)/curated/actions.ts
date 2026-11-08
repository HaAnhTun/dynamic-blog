'use server'

import { getTranslations } from 'next-intl/server'
import { updateTag } from 'next/cache'
import { adminErrorMessage, runAdminAction } from '@/lib/admin-action'
import { featurePost, setFeaturedOrder, unfeaturePost } from '@/lib/admin-api'
import type { Translator } from '@/i18n/translator'
import type { ApiError } from '@/lib/api'
import { type CuratedPost, toCurated } from './curated'

/*
 * The three actions of the "Best posts" (featured posts) screen. Each only clears the 'posts' cache: the order
 * is read through getPosts({featured}) under that tag (home page, /start-here, the Explore block), and
 * the post page shows no rank so it needs no per-post tag. Cleared only on success.
 */

/**
 * PUT featured-order REPLACES EVERYTHING and accepts any list of posts that still exist, even a list missing
 * posts (an absent post keeps its flag, only loses its rank). It only returns 400 POST_NOT_FOUND when an id is no
 * longer any post, for example a post just deleted in another tab. So do NOT use `reorderErrorMessage` from
 * lib/admin-action.ts: its "the list changed elsewhere" sentence is for the gallery, where the exact
 * permutation of every photo must be sent. Another 400 (VALIDATION_ERROR: duplicate id, over 50 posts) keeps the reason the
 * backend gives, as in the common table.
 */
function orderErrorMessage(missingPost: string) {
  return (error: ApiError, t: Translator): string =>
    error.status === 400 && error.code === 'POST_NOT_FOUND' ? missingPost : adminErrorMessage(error, t)
}

/** New order: the i-th post gets rank i. Returns every picked post in the order the backend stored. */
export async function saveCuratedOrder(postIds: string[]): Promise<CuratedPost[] | { error: string }> {
  const t = await getTranslations('Admin.curated')
  const result = await runAdminAction(() => setFeaturedOrder(postIds), orderErrorMessage(t('missingPost')))
  if ('error' in result) return result
  updateTag('posts')
  return result.map(toCurated)
}

/** Pick a post. Rank is untouched: a newly picked post sits after the ranked ones until the next order save. */
export async function feature(postId: string): Promise<CuratedPost | { error: string }> {
  const result = await runAdminAction(() => featurePost(postId))
  if ('error' in result) return result
  updateTag('posts')
  return toCurated(result)
}

/** Unpick a post: loses both the flag and the rank. */
export async function unfeature(postId: string): Promise<CuratedPost | { error: string }> {
  const result = await runAdminAction(() => unfeaturePost(postId))
  if ('error' in result) return result
  updateTag('posts')
  return toCurated(result)
}
