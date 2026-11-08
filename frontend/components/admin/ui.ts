import type { Translator } from '@/i18n/translator'

/*
 * The admin visual system: one set of Tailwind classes
 * shared by every admin screen, so buttons, inputs, labels and error boxes look the same everywhere.
 *
 * String constants rather than components: usable in both Server and Client Components, and following the
 * repo's existing habit (FOCUS, TRANSITION in components/site/SectionHeading.tsx). Each class is written
 * out in full so Tailwind can scan it; a class assembled from string fragments would not get CSS generated.
 *
 * The palette is slate (cool gray) as the admin has always had. Main text slate-900, secondary slate-600, faintest
 * slate-500: 4.76:1 on white, 4.55:1 on slate-50. slate-400 is not used for text (2.56:1).
 * The admin has a single, light theme: the frame carries `data-admin`, and globals.css excludes that area from every rule
 * of the dark theme, `dark:` variants included.
 *
 * Three levels of action: primary is the main job of the screen, at most one button per area;
 * secondary for side jobs; danger for delete/unpublish operations, solid red only at the final confirmation step.
 */

/**
 * The site's focus ring (components/site/SectionHeading.tsx) for admin buttons and links.
 *
 * The `outline-brand` color is set permanently, not behind `focus-visible:`: in Tailwind 4, `transition-colors`
 * also transitions `outline-color`, so a color applied only on focus would drift from the text color to blue over 150ms
 * and the focus ring would first appear in the wrong color. When not focused the outline-style is none, so the color does not show;
 * focus only turns on the width and style of the outline, two things with no transition, so the ring appears at once in the right color.
 * Every class with a focus ring below follows the same approach.
 */
export const FOCUS_RING = 'focus-visible:outline-2 focus-visible:outline-offset-2 outline-brand'

const BUTTON_BASE =
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors duration-150 motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 outline-brand'

const BUTTON_SIZE = {
  md: 'h-9 px-3.5 text-sm',
  sm: 'h-8 px-3 text-[13px]',
} as const

const BUTTON_VARIANT = {
  primary: 'bg-slate-900 text-white hover:bg-slate-700',
  secondary: 'border border-slate-300 bg-white text-slate-800 hover:border-slate-400 hover:bg-slate-50',
  ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
  danger: 'border border-red-200 bg-white text-red-700 hover:border-red-300 hover:bg-red-50',
  dangerSolid: 'bg-red-700 text-white hover:bg-red-800',
} as const

export type ButtonVariant = keyof typeof BUTTON_VARIANT
export type ButtonSize = keyof typeof BUTTON_SIZE

/** Classes of a button (or a link that looks like a button). `extra` is appended at the end, e.g. `w-full`. */
export function button(variant: ButtonVariant, size: ButtonSize = 'md', extra?: string): string {
  const classes = `${BUTTON_BASE} ${BUTTON_SIZE[size]} ${BUTTON_VARIANT[variant]}`
  return extra ? `${classes} ${extra}` : classes
}

/**
 * A square button with only an icon (↑ ↓ ✕). The accessible name always comes from an inner `sr-only`. `aria-disabled`
 * at the start/end of a list fades it while it still receives focus (see CuratedManager).
 */
export const ICON_BUTTON =
  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 transition-colors duration-150 motion-reduce:transition-none hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:opacity-40 aria-disabled:hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 outline-brand'

/* --- Inputs ---------------------------------------------------------------------------- */

/** The label above an input. The spacing to the input lives here, so the input works even with no label. */
export const LABEL = 'mb-1.5 block text-sm font-medium text-slate-800'

/** An explanatory sentence under an input, linked to it through `aria-describedby`. */
export const HINT = 'mt-1.5 text-[13px] leading-5 text-slate-500'

/**
 * Text input, select, textarea. A slate-300 border visible on white; focus is a 2px outer outline
 * in the brand color, like everything focusable on the site. Placeholder slate-500: hint text is still text
 * and must be readable (slate-400 is only 2.56:1).
 *
 * `py-[7px]`: 7 + 20 (a text-sm line) + 7 + 2 border = 36px, exactly the height of a md button (h-9), so an input and a
 * button sharing a row (the add-post box plus its add button) line up at the edges. py-2 gives 38px, 2px off.
 */
export const INPUT =
  'block w-full rounded-md border border-slate-300 bg-white px-3 py-[7px] text-sm text-slate-900 placeholder:text-slate-500 transition-colors duration-150 motion-reduce:transition-none hover:border-slate-400 focus-visible:border-slate-400 focus-visible:outline-2 focus-visible:-outline-offset-1 outline-brand disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500'

/** Slug/path input: monospace text, because every character of a URL matters. */
export const INPUT_MONO = `${INPUT} font-mono text-[13px]`

export const CHECKBOX =
  'h-4 w-4 shrink-0 rounded border-slate-300 accent-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 outline-brand disabled:cursor-not-allowed'

/** The browser's native file input, its choose-file button redrawn to match the secondary button. */
export const FILE_INPUT =
  'block w-full text-sm text-slate-600 file:mr-3 file:h-8 file:cursor-pointer file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3 file:text-[13px] file:font-medium file:text-slate-800 hover:file:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 outline-brand'

/* --- Surfaces and text ------------------------------------------------------------------- */

/** Page frame for screens with a sidebar. Wide enough for a data table, not spanning the whole 1440px. */
export const PAGE = 'mx-auto w-full max-w-5xl px-4 pt-6 pb-16 sm:px-6 sm:pt-10 lg:px-10'

export const H1 = 'text-2xl font-semibold tracking-tight text-slate-900 sm:text-[1.75rem] sm:leading-9'

/** The description sentence under the page title: says what this screen is for. */
export const LEAD = 'mt-2 max-w-2xl text-sm leading-6 text-slate-600'

export const H2 = 'text-base font-semibold text-slate-900'

/** The description sentence under a section title. */
export const SECTION_DESC = 'mt-1 max-w-2xl text-sm leading-6 text-slate-600'

/**
 * The frame of a clearly grouped area (the create-series form, the image upload area). Not every area is a card:
 * lists and titles stand directly on the page background.
 */
export const CARD = 'rounded-lg border border-slate-200 bg-white'

/** A list with rows (series, parts, images): one outer border, thin dividers between rows. */
export const LIST = 'divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white'

/** The secondary line under a row title: category, date, post count. */
export const META = 'text-[13px] leading-5 text-slate-500'

/** A text link inside a sentence (explanation, instructions). */
export const TEXT_LINK =
  'rounded-sm font-medium text-slate-900 underline decoration-slate-300 underline-offset-4 transition-colors duration-150 motion-reduce:transition-none hover:decoration-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 outline-brand'

/** Back link (to the all-series list): small, faint, above the page title. */
export const BACK_LINK =
  'inline-flex items-center gap-1 rounded-sm text-sm font-medium text-slate-600 transition-colors duration-150 motion-reduce:transition-none hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 outline-brand'

/* --- Feedback ------------------------------------------------------------------------------ */

/** Status line (`role="status"`) under an operation: "order saved.", image upload progress. */
export const STATUS_TEXT = 'text-sm leading-6 text-slate-600'

/** A reminder of unfinished work, not an error: "order not saved yet.", "not shown on the page yet". */
export const WARN_TEXT = 'text-[13px] leading-5 text-amber-700'

/* --- Post status --------------------------------------------------------------------------- */

/**
 * Label and text color of each post status. A single place replacing three STATUS_LABEL tables scattered across
 * the post list, the featured posts screen and the series parts. An unknown status (the backend adds one later) shows
 * its name verbatim, never an empty cell.
 */
const POST_STATUS: Record<string, { labelKey: string; tone: string }> = {
  PUBLISHED: { labelKey: 'post.PUBLISHED', tone: 'text-emerald-700' },
  DRAFT: { labelKey: 'post.DRAFT', tone: 'text-amber-700' },
  ARCHIVED: { labelKey: 'post.ARCHIVED', tone: 'text-slate-500' },
}

/** `t` is the `Admin.statuses` translator. An unknown status is shown as it is. */
export function postStatusLabel(status: string, t: Translator): string {
  const entry = POST_STATUS[status]
  return entry === undefined ? status : t(entry.labelKey)
}

export function postStatusTone(status: string): string {
  return POST_STATUS[status]?.tone ?? 'text-slate-600'
}
