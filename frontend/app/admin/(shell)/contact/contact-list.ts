/*
 * Reading and building the URL of the Contact inbox. The only list state is the page: the inbox has no filter or search box,
 * a personal blog gets a handful of messages. The page reader is the post list's, so `?page=2147483648` and the like are
 * already blocked there.
 */
export { parsePage } from '../post-list'

/** The backend's default page size, like the other admin lists. */
export const CONTACT_PAGE_SIZE = 20

/** URL of one page (0-based), dropping the default so the first page is the bare path. */
export function contactListHref(page = 0): string {
  return page > 0 ? `/admin/contact?page=${page}` : '/admin/contact'
}
