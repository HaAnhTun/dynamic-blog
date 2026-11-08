import { NotFoundContent } from '@/components/site/NotFoundContent'

/**
 * The 404 of the (site) group: when a page in the group calls notFound() (a post, a series, an archive year or a
 * gallery page that does not exist), Next renders this file INSIDE app/(site)/layout.tsx. That layout already has
 * the header, `<main id="main-content">` and the footer, so only the content part is here.
 *
 * Without this file notFound() falls back to app/not-found.tsx, which carries its own page frame (it serves
 * URLs that match no route, outside the group), and the 404 page gets two layers of frame.
 */
export default function SiteNotFound() {
  return <NotFoundContent />
}
