/**
 * The wrapping rule of free text in a block (titles, labels, captions, attributions): a long unbroken word (a URL, an identifier)
 * breaks inside the frame instead of crossing its border. `anywhere`, not `break-word`: only `anywhere` also shrinks the minimum
 * width of the text, so a grid or flex parent (panes, steps) does not grow wider than the column. Written out whole, because
 * Tailwind reads class names from the source.
 */
export const BLOCK_WRAP = '[overflow-wrap:anywhere]'

/**
 * The typography of the Markdown inside a block. A block root carries `not-prose` so the typography plugin leaves the frame alone.
 * The plugin then ALSO leaves every descendant of that root alone: a nested `.prose` does not switch it back on, and neither do the
 * `prose-a:` and `prose-li:` variants. `prose` here only sets the palette (text color and the dark inversion, which sit on the
 * wrapper itself); the elements the plugin would have styled are written out below, with plain utilities. Plain CSS under `.prose`
 * (figures, the table scroll frame, the code strip) does not care about `not-prose` and applies either way.
 *
 * - a code block scrolls sideways inside its frame (without it a long line widens the whole page) and keeps a margin from the text
 *   around it; the first and last child of a body keep none, the body trims them;
 * - lists get their bullets or numbers back (the reset of the base styles removed them); on a phone their items are 12px apart, so a wrapped
 *   item is not mistaken for two (the desktop lists keep the tight rhythm they always had);
 * - a table fills the block, as in an ordinary article (the plugin's `width: 100%` is lost, so a narrow table would stop short in a wide one);
 * - table cells get padding, and a word of a cell is never cut in the middle (a wide table scrolls in its frame instead);
 * - links look like links.
 */
export const BLOCK_PROSE_BASE = [
  'prose prose-neutral max-w-none min-w-0 [overflow-wrap:anywhere] dark:prose-invert',
  '[&_pre]:overflow-x-auto [&_[data-code-block]:not(:first-child)]:mt-6 [&_[data-code-block]:not(:last-child)]:mb-6',
  '[&_ul]:list-disc [&_ol]:list-decimal [&_ul]:ps-6 [&_ol]:ps-6 max-sm:[&_li]:my-1.5',
  '[&_table]:w-full [&_th]:px-3 [&_th]:py-2 [&_th]:text-start [&_td]:px-3 [&_td]:py-2 [&_th]:[overflow-wrap:normal] [&_td]:[overflow-wrap:normal]',
  '[&_a]:text-brand [&_a]:font-medium [&_a]:underline [&_a]:decoration-brand/50 [&_a]:underline-offset-4',
].join(' ')

/** The list marker color of the shared block typography. A block that wants its own marker color builds on `BLOCK_PROSE_BASE` instead, so two marker colors never compete. */
export const BLOCK_MARKER = '[&_li::marker]:text-neutral-400'

export const BLOCK_PROSE = `${BLOCK_PROSE_BASE} ${BLOCK_MARKER}`
