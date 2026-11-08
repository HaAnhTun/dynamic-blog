/**
 * The share card, drawn once and used by both `opengraph-image` routes.
 *
 * It exists because the alternative is two renderers. app/opengraph-image.tsx carried the
 * site-wide card and said so in its own comment: a per-article version "would be better
 * still and is a deliberate non-goal for now — it is a second renderer to keep in step with
 * this one". That objection is correct and this module is the answer to it rather than a
 * decision to ignore it: there is one layout, one palette, one set of Satori workarounds,
 * and `app/opengraph-image.test.ts` asserts that both routes import from here.
 *
 * ## Satori, not a browser
 *
 * `next/og` renders this through Satori. The constraints are real and the failures are
 * silent or fatal rather than merely ugly:
 *
 *  - Flexbox works. CSS grid, floats and most shorthand properties do not.
 *  - `display` must be set explicitly on anything with more than one child, or Satori
 *    throws rather than guessing — which is a 500 on the image route, so the dimension
 *    assertions in the tests are what catch an edit that breaks this.
 *  - Every colour is a literal. Tailwind classes are not available and neither is
 *    `var(--color-brand)`: Satori has no stylesheet to resolve a custom property against,
 *    so it would paint nothing. The card is always dark, so its brand hex is the token's
 *    DARK-theme value; app/opengraph-image.test.ts compares the two.
 *  - `lineClamp` works, and only in combination with `display: 'block'`. Verified by
 *    rendering a deliberately over-long title and looking at the PNG: it clamps to three
 *    lines and appends an ellipsis, rather than overflowing the frame.
 *
 * ## Vietnamese
 *
 * Nearly every line here carries diacritics, which is the thing most likely to render as
 * tofu boxes. No font file is loaded and none is needed: the Geist face bundled with
 * `next/og` covers the Vietnamese range, verified by rendering the longest real article
 * title plus the author's name and looking at the result — the letters with horn, circumflex, dot-below and tilde marks, and the d-with-stroke letter, all draw. This
 * is worth knowing before anyone "optimises" by passing a `fonts` array: fetching a font at
 * render time would put a network call on the critical path of a crawler's image request.
 */

/** 1200x630 is what `summary_large_image` expects; another ratio is letterboxed by every
 *  consumer. Exported so neither route can state a size the other does not. */
export const OG_SIZE = { width: 1200, height: 630 } as const

export const OG_CONTENT_TYPE = 'image/png'

/**
 * The brand color of the dark theme, written as a literal: exactly the value `[data-theme='dark']` assigns to
 * `--color-brand` in app/globals.css. The card always has a `#0a0a0a` background, so that is the
 * right variant: 7.54:1 on this background, against 4.10:1 for the light theme color — the very measurement that
 * made globals.css change the token in the dark theme. The previous value was `#3b5bdb`, a color that exists nowhere in the
 * CSS, with a comment claiming it matched the token; app/opengraph-image.test.ts now compares the two values
 * so that does not happen again.
 */
const BRAND = '#4da3ff'

export type ShareCardProps = {
  /** A short line above the title — the article's category and date. Omitted on the
   *  site-wide card, which has nothing truthful to put there. */
  eyebrow?: string
  title: string
  /** The site-wide card's second line. The article card has none: its own second line is
   *  the eyebrow, above the title, where a category belongs. */
  subtitle?: string
  /** The line pinned to the bottom. */
  footer: string
  /**
   * 76 for a name that never wraps, 64 for an article title that may wrap to three lines,
   * and 56 beside the cover-art tile, where the column is narrower (the default when `art`
   * is set). A single size for all would either shrink the site-wide card for no reason or
   * let a long title eat the whole frame.
   */
  titleSize?: number
  /**
   * A square 300×300 cover art tile in the top right corner, for posts without a cover image: the same shape
   * the reader already saw as the thumbnail in the list, so a shared link is recognizable.
   * It is a `data:image/svg+xml;base64,…` data URI built with `coverSvgString` with the dark palette —
   * Satori loads nothing over the network and cannot read CSS. With the art tile the text column narrows to
   * 684px and the title defaults to 56 instead of 64, so three lines still fit next to the tile.
   */
  art?: string
}

/** 1200 − 2×80 margins − 300 art tile − 56 gap: the text column never touches the tile. */
const TEXT_WITH_ART = 684
const ART_SIZE = 300

export function ShareCard({ eyebrow, title, subtitle, footer, titleSize, art }: ShareCardProps) {
  const text = (
    <div style={{ display: 'flex', flexDirection: 'column', ...(art ? { maxWidth: TEXT_WITH_ART } : {}) }}>
      {eyebrow ? (
        <div
          style={{
            display: 'flex',
            fontSize: 28,
            color: BRAND,
            letterSpacing: '0.08em',
            marginBottom: 24,
          }}
        >
          {eyebrow}
        </div>
      ) : null}
      <div
        style={{
          // `block`, not `flex`: lineClamp is ignored on a flex container in this Satori
          // build. Measured by rendering both.
          display: 'block',
          fontSize: titleSize ?? (art ? 56 : 64),
          fontWeight: 700,
          color: '#fafafa',
          letterSpacing: '-0.02em',
          lineHeight: 1.25,
          // Three lines and then an ellipsis. The longest real title is 83 characters and
          // fits in three at size 64; the clamp is for the one somebody writes next, and
          // an ellipsis is a better artefact than a title running off the bottom edge.
          lineClamp: 3,
        }}
      >
        {title}
      </div>
      {subtitle ? <div style={{ display: 'flex', fontSize: 34, color: '#a3a3a3', marginTop: 22 }}>{subtitle}</div> : null}
    </div>
  )

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        backgroundColor: '#0a0a0a',
        padding: '72px 80px',
        // A single hairline in the brand colour instead of a gradient or a glow: the design
        // rules both out, and an editorial card is carried by type and space.
        borderTop: `10px solid ${BRAND}`,
      }}
    >
      {art ? (
        // Without art the text column stands alone, exactly like the card before: site-wide cards and
        // post cards with a cover image do not change by a single pixel.
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          {text}
          {/* Satori only draws images through <img>; next/image does not run in ImageResponse. The
              no-img-element rule skips opengraph-image files in app/ for that very reason, but
              does not know this module exists only so those two files draw one shared card. Decorative image:
              empty alt, the adjacent title says it all. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={art} width={ART_SIZE} height={ART_SIZE} alt="" style={{ borderRadius: 12 }} />
        </div>
      ) : (
        text
      )}

      <div
        style={{
          display: 'flex',
          fontSize: 30,
          color: '#d4d4d4',
          lineHeight: 1.4,
          // Keeps a long line from running into the right edge; Satori wraps on width, so
          // the cap is set here rather than by the container.
          maxWidth: 940,
        }}
      >
        {footer}
      </div>
    </div>
  )
}
