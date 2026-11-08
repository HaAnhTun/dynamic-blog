import { Fragment, type ReactNode } from 'react'
import { highlightSegments, type HighlightSegment } from '@/lib/highlight'

/**
 * Background of the matched word. Two themes, two backgrounds: amber-100 under neutral-700/900 text in the light theme (about
 * 9:1 and more), amber-300 at 25% on a neutral-950 background in the dark theme (about 7:1 with neutral-300).
 *
 * `text-inherit` is the part that must not be lost. The browser paints `<mark>` with `color: MarkText`, i.e. black
 * text: in the dark theme that is black text on a dark brown background, and the title link's `hover:text-brand` would
 * not reach text inside `<mark>`. Inheriting the color keeps the text the line's own text, only the background changes.
 *
 * `box-decoration-clone`: a matched word broken across lines (long title, `break-words`) still has full rounded corners
 * on both pieces. Exported so a test can pin it, not for other places to copy.
 */
export const MARK_CLASS = 'rounded-sm bg-amber-100 text-inherit box-decoration-clone dark:bg-amber-300/25'

/**
 * `text` with the words matching `query` wrapped in `<mark>` (lib/highlight.ts). With no query it
 * returns the string unchanged: every list outside /search renders exactly as before.
 *
 * Each segment is a React text node, inside `<mark>` or not, so the post's text is never
 * read as HTML. `<mark>` is an inline element that adds no whitespace, so the accessible name
 * of the link containing it is still exactly the post title.
 */
export function Highlight({ text, query }: { text: string; query?: string }): ReactNode {
  if (!query) return text
  return highlightSegments(text, query).map((segment, index) =>
    segment.match ? (
      <mark key={index} className={MARK_CLASS}>
        {segment.text}
      </mark>
    ) : (
      <Fragment key={index}>{segment.text}</Fragment>
    ),
  )
}

/**
 * Like `Highlight`, for segments already split on the server (quick search panel `Segment[]` goes over the wire, not
 * HTML). Same `MARK_CLASS`, same React text node.
 */
export function SegmentText({ segments }: { segments: readonly HighlightSegment[] }): ReactNode {
  return segments.map((segment, index) =>
    segment.match ? (
      <mark key={index} className={MARK_CLASS}>
        {segment.text}
      </mark>
    ) : (
      <Fragment key={index}>{segment.text}</Fragment>
    ),
  )
}
