import { ImageResponse } from 'next/og'
import { OG_CONTENT_TYPE, OG_SIZE, ShareCard } from '@/components/og/ShareCard'
import { getDefaultSiteContent } from '@/lib/site-content'

/**
 * The share card every route inherits except the article pages, which draw their own from
 * the same component (app/(site)/posts/[slug]/opengraph-image.tsx).
 *
 * It exists because `app/layout.tsx` declares `twitter: { card: 'summary_large_image' }`, so
 * every share renders a 1200x630 panel — and with no image that panel is blank, which looks
 * more broken than a plain text card and is invisible from the site itself: nothing fails,
 * no page looks wrong, and it only shows up in somebody else's timeline.
 *
 * The layout and every Satori constraint live in components/og/ShareCard.tsx. This file is
 * now only the data: which strings go on the site-wide card. A per-route version used to be
 * a deliberate non-goal here, on the grounds that it would mean a second renderer to keep in
 * step with this one — the shared component is what retired that objection, and
 * app/opengraph-image.test.ts asserts both routes still go through it.
 *
 * There is no `export const alt`: the text now comes from the site content, which is async, and Next only reads a static `alt`.
 * `generateImageMetadata` would add an id to the image URL (`OG_IMAGE` is `/opengraph-image`). Every page states the image
 * with its alt through `siteOgImage` (lib/metadata.ts), so no tag depends on the file's own alt.
 */
export const size = OG_SIZE
export const contentType = OG_CONTENT_TYPE

export default async function OpengraphImage() {
  const { site } = await getDefaultSiteContent()
  return new ImageResponse(
    <ShareCard
      title={site.name}
      // 76, the size this card has always used. The name is short and never wraps, so it
      // can carry the extra weight that an article title cannot.
      titleSize={76}
      subtitle={site.tagline || undefined}
      footer={site.positioning}
    />,
    size,
  )
}
