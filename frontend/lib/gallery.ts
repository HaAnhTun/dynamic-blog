import 'server-only'
import { getJson } from './fetch-json'
import type { GalleryPhoto, Page } from './types'

/**
 * The gallery photos being displayed, in the order the site owner arranged them.
 *
 * Only the `gallery` tag: uploading or reordering photos publishes no post, and publishing a post does not change the
 * gallery — sharing the `posts` tag would empty the other side's cache for no reason.
 *
 * Throws when the backend fails. The home page and About treat the gallery as a secondary block: they catch the error and do not
 * render the section (the Docker build has no API). The /gallery page decides in its own way.
 */
export async function getGallery(p: { page: number; size: number }): Promise<Page<GalleryPhoto>> {
  const query = new URLSearchParams({ page: String(p.page), size: String(p.size) })
  const body = await getJson<GalleryPhoto[] | null>(`/api/v1/gallery?${query}`, {
    next: { revalidate: 300, tags: ['gallery'] },
  })

  return {
    items: body.data ?? [],
    meta: body.pagination ?? { page: p.page, size: p.size, totalElements: 0, totalPages: 0 },
  }
}
