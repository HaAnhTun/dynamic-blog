'use server'

import { getTranslations } from 'next-intl/server'
import { updateTag } from 'next/cache'
import { redirect } from 'next/navigation'
import type { SeriesFormOutcome } from '@/components/admin/SeriesForm'
import type { PartsOutcome } from '@/components/admin/SeriesPartsManager'
import { reorderErrorMessage, runAdminAction } from '@/lib/admin-action'
import { createSeries, deleteSeries, setSeriesPosts, updateSeries, type SeriesInput } from '@/lib/admin-api'
import { toPart } from './series'

/*
 * The four actions of the series screen. Each successful write clears three tags:
 * 'series' (/series, /series/[slug], the Series block in Explore), 'posts' (the
 * "Series · Part n/m" kicker on every list and the series block on the post page — getPost carries the 'posts' tag too) and
 * 'search' (the same kicker on the search result rows).
 * Cleared only on success: updateTag also re-renders the current page in the action's response,
 * useless for a failure.
 */

function invalidate() {
  updateTag('series')
  updateTag('posts')
  updateTag('search')
}

/**
 * Form → `SeriesRequest`. The name is required (backend `@NotBlank`): checked here too because an action is an
 * endpoint anyone can POST to, and the backend's message ("must not be blank") is in English and names no
 * field. An empty slug is not sent: on create the backend generates it from the name, on edit the backend keeps the old slug.
 * The description is sent verbatim: edit replaces everything, and the backend itself treats a blank description as none.
 */
async function inputFrom(form: FormData): Promise<SeriesInput | { error: string }> {
  const title = form.get('title')
  if (typeof title !== 'string' || title.trim() === '') return { error: (await getTranslations('Admin.series'))('titleRequired') }
  const slug = form.get('slug')
  const description = form.get('description')
  return {
    title: title.trim(),
    ...(typeof slug === 'string' && slug.trim() !== '' ? { slug } : {}),
    description: typeof description === 'string' ? description : null,
  }
}

/** After creating, go to the edit page of the new series: an empty series is only useful once parts are added. */
export async function addSeries(form: FormData): Promise<{ error: string }> {
  const input = await inputFrom(form)
  if ('error' in input) return input
  const result = await runAdminAction(() => createSeries(input))
  if ('error' in result) return result
  invalidate()
  // Outside runAdminAction and after updateTag: redirect() throws, so anything placed after it does not run.
  redirect(`/admin/series/${encodeURIComponent(result.id)}`)
}

/** Returns the values the backend SAVED (normalised slug, blank description as null) so the form shows them exactly. */
export async function saveSeries(id: string, form: FormData): Promise<SeriesFormOutcome> {
  const input = await inputFrom(form)
  if ('error' in input) return input
  const result = await runAdminAction(() => updateSeries(id, input))
  if ('error' in result) return result
  invalidate()
  return { title: result.title, slug: result.slug, description: result.description }
}

/**
 * Replace all members: the i-th post at position i, a post in another series is moved over. At this endpoint
 * a 400 means the list sent is stale (a post was just deleted elsewhere: POST_NOT_FOUND) or the screen
 * state is broken (duplicate id); the fix for both is to reload the page, so use
 * `reorderErrorMessage`. The screen blocks the limit of 100 parts beforehand, so a 400 for being too long does not arrive here.
 */
export async function saveSeriesParts(id: string, postIds: string[]): Promise<PartsOutcome> {
  const result = await runAdminAction(() => setSeriesPosts(id, postIds), reorderErrorMessage)
  if ('error' in result) return result
  invalidate()
  return result.posts.map(toPart)
}

/** After deleting, go back to the list: the edit page of a deleted series is a 404. The posts remain. */
export async function removeSeries(id: string): Promise<{ error: string }> {
  const result = await runAdminAction(() => deleteSeries(id))
  if (result !== null) return result
  invalidate()
  redirect('/admin/series')
}
