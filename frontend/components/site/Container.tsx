import type { ReactNode } from 'react'
import { FRAME_MAX } from './reader/reader-layout'

/**
 * `prose` is the reading measure (max-w-3xl) for the CARD pages (login, newsletter, errors…) and article bodies. `reader`
 * (1400px, FRAME_MAX) is the width of the site frame: the header and footer Containers, the SHOWCASE bands of the home and
 * about pages and the discovery bands use it, so they share one edge with `main` (SITE_MAIN). `bare` has no max width and no
 * gutter: for a child that supplies its own (a full-bleed band, a page grid).
 *
 * `wide` (max-w-5xl, 1024px) is DEPRECATED: it is the width of the pages that have not moved into the frame yet and is
 * deleted together with SPLIT_ROW once the last of them has.
 */
export type ContainerWidth = 'prose' | 'wide' | 'reader' | 'bare'

/** Deliberately a closed set. Container exists so that the gutter is written once;
 *  letting callers pass an arbitrary tag invites one of them to pass `main`, and
 *  app/layout.tsx already owns the single `<main id="main-content">`. */
export type ContainerElement = 'div' | 'section' | 'article' | 'header' | 'footer' | 'nav' | 'ul'

const MAX_WIDTH: Record<ContainerWidth, string> = {
  prose: 'max-w-3xl',
  wide: 'max-w-5xl', // deprecated
  reader: FRAME_MAX,
  bare: '',
}

/** The horizontal gutter, at least 16px at every width; `bare` has none. */
const GUTTER: Record<ContainerWidth, string> = {
  prose: 'px-4 sm:px-6',
  wide: 'px-4 sm:px-6',
  reader: 'px-4 sm:px-6',
  bare: '',
}

/**
 * @deprecated Only /case-studies still uses it; deleted with the page's move to the frame.
 *
 * A two-column row for text pages built in the `wide` frame (/case-studies): from lg, the section label
 * (h2) takes the left third, the content the right two thirds. The text stays at a readable line length
 * (~620px in a 1024px frame), while the frame fills both edges — instead of a single max-w-prose column pushed to the
 * left with almost a third of the right side empty. Below lg it is one column like every text page: title on top,
 * content below.
 *
 * No alignment included: the user chooses (the text rows of /case-studies align on baseline, `lg:items-baseline`).
 */
export const SPLIT_ROW = 'lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:gap-x-12'

/**
 * The one owner of the horizontal gutter and the max width.
 *
 * It is a component rather than a documented pair of class strings because the brief
 * requires a gutter of at least 16px at every width AND sections that line up with
 * each other. Five pages written by five hands each spelling `px-4 sm:px-6` by hand
 * agree until one of them writes `px-6` or `container mx-auto`, and then two sections
 * on the same page have different left edges — a defect that no test and no type
 * error catches, only an eye on the rendered page.
 *
 * `w-full` matters: inside a flex column (app/layout.tsx) a block child without it
 * shrinks to its content and `mx-auto` then centres a narrow column.
 */
export function Container({
  width = 'wide',
  as: Tag = 'div',
  className = '',
  labelledBy,
  children,
}: {
  width?: ContainerWidth
  as?: ContainerElement
  className?: string
  /**
   * The id of the heading that names this container, for `aria-labelledby`.
   *
   * It matters for `as="section"`. A `<section>` with no accessible name is not exposed
   * as a region landmark at all — it is a generic box — so a reader using landmark
   * navigation on a homepage of eight stacked sections gets one jump target instead of
   * eight. SectionHeading already puts its `id` on the `<h2>`, so the name is sitting
   * there unused; this connects the two.
   *
   * Left optional rather than required on `as="section"`, because a section used purely
   * for grouping with no heading of its own is legitimate and should not be forced to
   * invent one — an `aria-label` made up to satisfy a type is worse than no name.
   */
  labelledBy?: string
  children?: ReactNode
}) {
  return (
    <Tag
      aria-labelledby={labelledBy}
      className={['mx-auto w-full', MAX_WIDTH[width], GUTTER[width], className].filter(Boolean).join(' ')}
    >
      {children}
    </Tag>
  )
}
