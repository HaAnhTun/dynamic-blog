import { absoluteUrl } from './site'
import type { MediaRef } from './types'

/**
 * The single path to an uploaded image, same origin.
 *
 * The browser never calls the backend: `/media/<file>` is served by app/media/[file]/route.ts, and
 * `next/image` optimizes it through `images.localPatterns` in next.config.ts — that pattern
 * forbids a query string (`search: ''`). So every `src` of an uploaded image must go through
 * here, and nobody concatenates `/media/` + something by hand.
 *
 * Not `server-only`: the lightbox (client) and the admin screen call this function too.
 *
 * `encodeURIComponent` is a no-op for valid file names (`<uuid>.jpg`, `<uuid>.png` hold only hex
 * letters, hyphens and dots). It is here for INVALID file names: next/image throws at render time
 * when a local src has a query string, so a name like `x.jpg?v=2` from a faulty backend would
 * make the whole page 500. Encoding turns `?`, `#` and `/` into part of the file name — that image
 * is broken (the /media route returns 404), while the page stays up.
 */
export function mediaPath(m: Pick<MediaRef, 'fileName'>): string {
  return `/media/${encodeURIComponent(m.fileName)}`
}

/** The same image as an absolute URL: for `og:image` and `image` in JSON-LD, where a relative
 *  path means nothing. Built from `mediaPath` so the two spellings cannot drift apart. */
export function mediaUrl(m: Pick<MediaRef, 'fileName'>): string {
  return absoluteUrl(mediaPath(m))
}
