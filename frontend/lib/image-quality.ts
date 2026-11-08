import type { MediaRef } from './types'

/**
 * How sharp the site's pictures are, in one place.
 *
 * `/_next/image` re-encodes every picture once, from the stored master, to AVIF or WebP (`images.formats`). Quality 75 is right for
 * small thumbnails; a picture that is the subject of the page (the cover at the top of a post, a gallery tile, the viewer) uses
 * 85, the value large sites use for hero photography. Both must be listed in `images.qualities` of next.config.ts: Next serves the
 * closest allowed value to anything else.
 */
export const IMAGE_QUALITY = { standard: 75, sharp: 85 } as const

/**
 * A cover shows at up to 832 CSS pixels wide, and a 2x screen needs twice that. 1200 is also the width of the share card, so a cover
 * narrower than this is soft on a normal screen and soft everywhere on a high-density one: the admin says so. Next.js never enlarges
 * an image, so a small file cannot be rescued on the server.
 */
export const COVER_MIN_WIDTH = 1200

/** What the admin recommends uploading: the stored long edge is capped at 2400, which is 2x of the widest frame. */
export const COVER_RECOMMENDED_WIDTH = 2400

/** True when a stored cover is too small to look sharp at the width the post page shows it. */
export function isLowResolutionCover(image: Pick<MediaRef, 'width'>): boolean {
  return image.width > 0 && image.width < COVER_MIN_WIDTH
}
