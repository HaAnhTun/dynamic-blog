/**
 * The layout of every public page: plain class-string constants, no JSX. The site is one bordered 1400px frame (SITE_MAIN is
 * the `main` element of the shell, the header and footer Containers carry the same hairlines through BAR_FRAME), and the
 * pages fill it in one of three shapes: BROWSE (sidebar + fluid column, BROWSE_*), SHOWCASE (full-width bands with the
 * two-column splits SPLIT_*) and CARD (a centred 768px card, CARD / CARD_PAGE). The post page is the reader variant of the
 * browse shape: sidebar + article, the article being a grid of its own (READER_GRID, ARTICLE_SLOT and the slots below).
 * Every reader component (LeftRail, ReadingRail, the hero, the article, the end blocks) takes its placement from here.
 *
 * MIRRORING. Mirroring the FRAME (sidebar on the other side, hairline on the other edge, rail on the left) is an edit of
 * this file only. It does NOT mirror the content of rows: ListRow, SeriesEntry, PostNav, the CommentSection reply indent,
 * TocNav, GalleryLightbox and the Footer columns own their placement and are mirrored separately. This is the only file
 * allowed to contain side-dependent placement (`col-start-N`, `border-e`, which column is "left"); components/site/reader/*.tsx
 * use logical properties and no `left-`/`right-` classes (guarded by reader-layout.test.ts).
 *
 * Post page shape: the outer grid (READER_GRID) is the sidebar plus the article; the article (ARTICLE_SLOT) is a grid of its
 * own: the hero spans both columns, then the body column and the right column. At 1400px the tracks are 260 / 908 / 230
 * (inside 1398px; the 1px side borders take the rest). BROWSE_GRID has the same outer tracks.
 *
 * The wrappers are grids at every width (`grid grid-cols-1`), never plain blocks, so a slot means the same thing at 390px
 * as at 1440px. Below `lg` there are NO placement classes: grid auto-placement in DOM order is the visual order (sidebar
 * summary card, hero, body, actions toolbar, end blocks), which keeps the focus order equal to the visual order (WCAG
 * 2.4.3) without `order-*`. From `lg` the explicit placement applies. There is no centring: the centre track is fluid.
 *
 * Breakpoints: `lg` (1024px) adds the sidebar, `rail:` (`--breakpoint-rail`, 68rem) adds the right column, `xl` (1280px)
 * widens both tracks to 260 / 230, `frame:` (`--breakpoint-frame`, 89rem) draws the side borders once the frame is
 * narrower than the window. The custom ones are declared in app/globals.css.
 *
 * Nothing is laid out in columns on paper: `print:block` turns a grid into a plain block. It has to come AFTER the base
 * `grid` utility in the compiled CSS to win; if a build ever emits it earlier, write `print:!block` here.
 *
 * The 1400px frame is the owner's requirement, so there is no fallback profile here. MIRRORED LAYOUT, post page (sidebar on
 * the other side): in READER_GRID swap the two `lg:` / `xl:` tracks, set LEFT_SLOT to `lg:col-start-2` with `lg:border-s`,
 * and ARTICLE_SLOT, END_SLOT to `lg:col-start-1`; in ARTICLE_SLOT swap the two inner tracks and give RAIL_SLOT
 * `rail:border-e` instead of `rail:border-s`. Browse pages: the same swap in BROWSE_GRID, BROWSE_SIDE, BROWSE_MAIN;
 * CASE_GRID / CASE_RAIL and SPLIT_ASIDE swap their tracks and the rail border the same way.
 */

/** Max width of the frame: 87.5rem = 1400px, border-box. Container reads it for `width="reader"`. */
export const FRAME_MAX = 'max-w-[87.5rem]'

/**
 * The two hairlines of the frame, drawn from `frame:` (the window width from which the frame is narrower than the window;
 * below it they would sit on the screen edge). Never on paper.
 */
export const FRAME_SIDES = 'frame:border-x frame:border-neutral-200 dark:frame:border-neutral-800 print:border-0'

/**
 * The `main` element of every public page: the frame itself. A flex column, so a page's grid (`flex-1`) can fill the height
 * and the sidebar tint reaches the footer. In print it is a plain block without a max width: flex containers fragment
 * across printed pages less reliably than block boxes, and a long post is the case that matters. `outline-none` because
 * `main` is a skip-link target (focus, not a visible control).
 */
export const SITE_MAIN = `mx-auto flex w-full flex-1 flex-col ${FRAME_MAX} ${FRAME_SIDES} outline-none print:block print:max-w-none`

/** The Header and Footer Container: the same hairlines as the frame, so header, main and footer share one x. */
export const BAR_FRAME = FRAME_SIDES

/** Outer grid: sidebar + article. A grid at every width, so a slot means the same thing at 390 and at 1440. */
export const READER_GRID =
  'grid flex-1 grid-cols-1 lg:grid-cols-[14rem_minmax(0,1fr)] xl:grid-cols-[16.25rem_minmax(0,1fr)] print:block'

/** The <article> is a grid item of the outer grid AND a grid of its own: [body | right column]. */
export const ARTICLE_SLOT =
  'grid min-w-0 grid-cols-1 border-b border-neutral-200 lg:col-start-2 lg:row-start-1 ' +
  'rail:grid-cols-[minmax(0,1fr)_13rem] xl:grid-cols-[minmax(0,1fr)_14.375rem] dark:border-neutral-800 print:block print:border-0'

/**
 * Left sidebar: a tinted full-height column with a hairline on its inner edge from `lg`; a closed block above the hero
 * below `lg`. Never printed. The tint and the hairline are on the aside (a grid item stretching over rows 1-2), not on the
 * sticky inner div, so they run to the bottom of the frame whatever the sticky content does.
 */
export const LEFT_SLOT =
  'min-w-0 px-4 pt-4 sm:px-6 lg:col-start-1 lg:row-span-2 lg:row-start-1 lg:border-e lg:border-neutral-200 lg:bg-neutral-50 lg:p-0 ' +
  'dark:lg:border-neutral-800 dark:lg:bg-neutral-900 print:hidden'

/**
 * The sticky scroller inside the sidebar: flush under the VISIBLE part of the header (`--site-header-visible-h` is 0px while
 * the header is slid away), as tall as the window minus that. The inner padding lives INSIDE the scroller, so a focus
 * outline at its edge is not clipped; `overscroll-contain` keeps a wheel scroll from chaining to the page.
 */
export const LEFT_STICKY =
  'lg:sticky lg:top-[var(--site-header-visible-h)] lg:max-h-[calc(100dvh-var(--site-header-visible-h))] lg:overflow-y-auto lg:overscroll-contain ' +
  'lg:scroll-py-6 lg:py-6 lg:ps-6 lg:pe-4'

/** The hero block (title, meta, author row, actions): spans both inner columns from `rail`. */
export const HERO_SLOT =
  'min-w-0 border-b border-neutral-200 px-4 py-8 sm:px-6 lg:px-8 lg:py-12 xl:px-10 rail:col-span-2 dark:border-neutral-800 print:border-0 print:px-0'

/** The body column (cover, inline TOC, post body, translation link, beacon). */
export const BODY_SLOT = 'min-w-0 px-4 py-8 sm:px-6 lg:px-8 lg:py-10 xl:px-10 print:px-0'

/**
 * The right column: the actions toolbar under the body below `rail`, the ruled column from it. Never printed. `rail:border-s`
 * is the hairline on its inner edge and runs exactly the height of the body row.
 */
export const RAIL_SLOT =
  'min-w-0 px-4 pb-8 sm:px-6 lg:px-8 rail:border-s rail:border-neutral-200 rail:px-0 rail:pb-0 rail:ps-4 rail:pe-4 rail:pt-8 xl:ps-5 xl:pe-6 ' +
  'dark:rail:border-neutral-800 print:hidden'

/** The sticky inner div of the right column (sticky from `rail`; below it the actions are in flow). */
export const RAIL_STICKY =
  'rail:sticky rail:top-[calc(var(--site-header-visible-h)+1.5rem)] rail:max-h-[calc(100dvh-var(--site-header-visible-h)-7rem)] rail:flex rail:flex-col'

/**
 * Post navigation, author box, comments, related posts: under the article, in the centre/right area, a readable width.
 * `pt-10` gives the first block air under the article hairline when there is no PostNav (PostNav carries its own `py-10`,
 * hence the `nav:first-child` reset); `pb-10 sm:pb-14` is the space above the discovery band or the footer, because the
 * frame no longer sits in a Container with vertical padding and the footer's top margin is zeroed on post pages.
 */
export const END_SLOT =
  'min-w-0 px-4 pt-8 pb-8 sm:px-6 sm:pt-10 sm:pb-14 lg:col-start-2 lg:row-start-2 lg:max-w-[56rem] lg:px-8 xl:px-10 [&>:first-child]:border-t-0 [&>nav:first-child]:pt-0'

/** BROWSE pages (spec 3.2): the outer grid of the post page without the article grid. `flex-1` stretches the sidebar tint to the footer. */
export const BROWSE_GRID =
  'grid flex-1 grid-cols-1 lg:grid-cols-[14rem_minmax(0,1fr)] xl:grid-cols-[16.25rem_minmax(0,1fr)] print:block'

/** The BROWSE sidebar: LEFT_SLOT with one row instead of two. A closed block above the content below `lg`; never printed. */
export const BROWSE_SIDE =
  'min-w-0 px-4 pt-3 sm:px-6 sm:pt-4 lg:col-start-1 lg:row-start-1 lg:border-e lg:border-neutral-200 lg:bg-neutral-50 lg:p-0 ' +
  'dark:lg:border-neutral-800 dark:lg:bg-neutral-900 print:hidden'

/** The BROWSE main column: air above and below (the footer sits right under it), gutters stepping like BODY_SLOT, none on paper. */
export const BROWSE_MAIN =
  'min-w-0 px-4 pt-6 pb-10 sm:px-6 sm:pt-8 sm:pb-14 lg:col-start-2 lg:row-start-1 lg:px-8 lg:pt-10 xl:px-10 print:px-0'

/**
 * The reading measure (60 to 75 characters a line) is capped in rem, never in `ch` or by a guessed width: `max-w-prose` is 65ch,
 * which is 82 to 85 characters of Vietnamese Inter (about 7.7px a character at 16px, 9px at 18px, 6.8px at 14px). One constant per
 * type size, used by every lead, description and card paragraph, so the measure is tuned in one place.
 *  - MEASURE: 16px running text (35rem = 560px, 69 to 75 characters in Vietnamese)
 *  - MEASURE_LEAD: the `text-lg` lead under a page title (40rem = 640px, about 71 characters)
 *  - MEASURE_SMALL: `text-sm` descriptions (30rem = 480px, about 70 characters)
 *  - MEASURE_CARD: prose inside a bordered card (34rem = 544px, 70 to 74 characters)
 */
export const MEASURE = 'max-w-[35rem]'
export const MEASURE_LEAD = 'max-w-[40rem]'
export const MEASURE_SMALL = 'max-w-[30rem]'
export const MEASURE_CARD = 'max-w-[34rem]'

/** SHOWCASE split with a narrow right cell (20rem, 24rem from xl). Top-aligned: a shorter cell never stretches. One column below `lg`. */
export const SPLIT_ASIDE =
  'grid items-start gap-y-10 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-x-12 xl:grid-cols-[minmax(0,1fr)_24rem] xl:gap-x-16'

/** SHOWCASE split in two equal columns. Top-aligned. One column below `lg`. */
export const SPLIT_EVEN = 'grid items-start gap-y-10 lg:grid-cols-2 lg:gap-x-12 xl:gap-x-16'

/** Case-study detail: the article column plus a right rail from `rail:` (same tracks as the post article). */
export const CASE_GRID =
  'grid min-w-0 grid-cols-1 rail:grid-cols-[minmax(0,1fr)_13rem] rail:gap-x-8 xl:grid-cols-[minmax(0,1fr)_14.375rem] print:block'

/** The case-study rail: only from `rail:`, ruled on its inner edge, never printed. */
export const CASE_RAIL =
  'hidden rail:block rail:border-s rail:border-neutral-200 rail:ps-5 dark:rail:border-neutral-800 print:hidden'

/** The sticky inner div of the case-study rail: the same offset as the post page rail, under the visible header. */
export const CASE_RAIL_STICKY = RAIL_STICKY

/**
 * One band of a page made of bands (the home page): `py-8` above and below on a phone, so two bands are 64px apart plus the
 * hairline of the next heading (a band was `py-10`, 80px, plus the heading's own padding), then `sm:py-14` as before.
 */
export const BAND = 'py-8 sm:py-14'

/** CARD pages (spec 3.4): the Container className of a centred 768px card in the frame. */
export const CARD_PAGE = 'py-8 sm:py-16'

/** The card itself: forms, status and short pages. */
export const CARD = 'rounded-card border border-neutral-200 bg-neutral-50 p-4 sm:p-8 dark:border-neutral-800 dark:bg-neutral-900'
