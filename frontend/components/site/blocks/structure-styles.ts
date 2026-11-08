import { BLOCK_MARKER, BLOCK_PROSE_BASE, BLOCK_WRAP } from './content-prose'

/**
 * Classes shared by the structure blocks (steps, details, takeaways, checklist, pullquote). Tailwind needs the whole class names in
 * the source, so they are written out here and never assembled from parts.
 */

/** Every block root: fills the article column, never wider, and the typography plugin leaves it alone. */
export const BLOCK_ROOT = 'not-prose w-full min-w-0 max-w-full'

/** The same without the list marker color, for a block with a marker color of its own (takeaways). */
export const BLOCK_BODY_BASE = `${BLOCK_PROSE_BASE} [&>:first-child]:mt-0 [&>:last-child]:mb-0`

/** The Markdown inside a block (the shared block typography), without the margin of its first and last child. */
export const BLOCK_BODY = `${BLOCK_BODY_BASE} ${BLOCK_MARKER}`

/** A one-line title of a block: a paragraph, never a heading, so the table of contents of the article stays right. */
export const BLOCK_TITLE = `m-0 ${BLOCK_WRAP} font-semibold text-neutral-900 dark:text-neutral-100`

export const FOCUS_RING = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand'
