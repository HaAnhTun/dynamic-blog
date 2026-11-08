import type { Translator } from '@/i18n/translator'
import { ChevronRightIcon, ListIcon } from '@/components/icons'
import type { TocEntry } from '@/lib/markdown'
import { nestToc, tocHref, type TocNode } from '@/lib/toc'
import { FOCUS, FOCUS_INSET, TRANSITION } from './SectionHeading'
import { TocSpy } from './TocSpy'

/**
 * The table of contents only when the post has at least this many h2–h4 entries. A post with one or two entries is read in a few screens;
 * a "Table of contents" box there only takes the place of the first paragraph. Headings still have an id and a # mark, so a link to
 * a section can still be shared.
 */
export const MIN_TOC_ENTRIES = 3

/** The section being read (TocSpy sets `aria-current`) only changes color and underline: weight stays, the text does not shift. */
const INLINE_LINK = `${FOCUS} ${TRANSITION} underline-offset-4 hover:underline aria-[current=location]:text-brand aria-[current=location]:underline max-sm:flex max-sm:min-h-11 max-sm:items-center max-sm:text-[0.9375rem]`

/**
 * A link of the rail list. The timeline is the 1px start border of the links themselves (every link is a block with no gap
 * between two of them, so the line is continuous and sits at the same x at every level); the active entry draws its stretch in
 * brand color. Only color and border color change when active: weight stays, the text does not shift.
 * One static padding class per nesting level (Tailwind cannot build class names), a 12px step per level.
 */
const RAIL_LINK = `${FOCUS} ${TRANSITION} block border-s border-neutral-200 py-1 text-[13px] leading-snug break-words text-neutral-600 hover:text-brand aria-[current=location]:border-brand aria-[current=location]:text-brand dark:border-neutral-800 dark:text-neutral-400`
const RAIL_INDENT = ['ps-3', 'ps-6', 'ps-9', 'ps-12'] as const

type ItemsProps = { nodes: TocNode[]; variant: 'inline' | 'rail'; depth?: number }

/** The entries of one level; an entry with children carries their nested list. */
function TocItems({ nodes, variant, depth = 0 }: ItemsProps) {
  return nodes.map((node) => (
    <li key={node.id}>
      <a className={variant === 'rail' ? `${RAIL_LINK} ${RAIL_INDENT[Math.min(depth, 3)]}` : INLINE_LINK} href={tocHref(node.id)}>
        {node.text}
      </a>
      {node.children.length > 0 ? (
        // In the rail the indent is on the links (so every active border sits on the same line); inline it is on the nested list.
        <ul className={variant === 'rail' ? undefined : 'mt-1 space-y-1 ps-4'}>
          <TocItems nodes={node.children} variant={variant} depth={depth + 1} />
        </ul>
      ) : null}
    </li>
  ))
}

export type TocNavProps = {
  /** `inline`: a closed <details> inside the article (below the reading-rail breakpoint). `rail`: the plain list of the right rail. */
  variant: 'inline' | 'rail'
  /** The table of contents returned by `renderMarkdown`, so each link points to an id that exists in the body. */
  toc: TocEntry[]
  /** Translator of the `Site.article` namespace. */
  t: Translator
  /**
   * Render TocSpy inside this nav. Only for pages without a reading rail (the admin preview): the public page renders it once in the
   * rail. It also keeps the inline nav visible at every width (the `rail:hidden` class is only right where a rail shows the list).
   */
  spy?: boolean
}

/**
 * The table of contents of a post, extracted from ArticleView so the public page can draw it twice: closed inline (`inline`,
 * below the rail breakpoint) and as the scrolling list of the right rail (`rail`, from the breakpoint up). Renders nothing under
 * MIN_TOC_ENTRIES entries. Server component: TocSpy is the only island.
 *
 * Both navs carry `data-toc` (the selector of TocSpy, which marks the matching link in both) and are not printed: on paper a
 * #section link leads nowhere. The landmark's name is the visible eyebrow itself (aria-labelledby), not a parallel aria-label
 * that could drift from it. The two eyebrow ids differ so they never collide, as ids must be unique on the page.
 */
export function TocNav({ variant, toc, t, spy = false }: TocNavProps) {
  if (toc.length < MIN_TOC_ENTRIES) return null
  const nodes = nestToc(toc)

  if (variant === 'rail') {
    return (
      <nav aria-labelledby="muc-luc-rail" data-toc="" className="hidden min-h-0 flex-1 flex-col text-sm rail:flex print:hidden">
        <p
          id="muc-luc-rail"
          className="flex shrink-0 items-center gap-1.5 pb-3 text-xs font-semibold tracking-wide text-neutral-600 uppercase dark:text-neutral-400"
        >
          <ListIcon size={14} />
          {t('toc')}
        </p>
        {/* The only scroller of the rail. px-1 py-1 with the negative margins keeps the focus ring of a link from being clipped by overflow. */}
        <ul data-toc-list="" className="-mx-1 -my-1 min-h-0 flex-1 overflow-y-auto px-1 py-1">
          <TocItems nodes={nodes} variant="rail" />
        </ul>
        {spy ? <TocSpy /> : null}
      </nav>
    )
  }

  return (
    <nav
      aria-labelledby="muc-luc"
      data-toc=""
      className={`my-8 rounded-card border border-neutral-200 text-sm max-sm:my-6 ${spy ? '' : 'rail:hidden '}dark:border-neutral-800 print:hidden`}
    >
      {/*
        A <details> that is CLOSED in the server HTML at every width: on a phone, and on a tablet, five to eight open entries
        push the first paragraph of the post below the first screen; folded, it is one "Table of contents" row to press open.
        From the rail breakpoint the same list is drawn in the right rail instead, so there is no always-open variant here.
      */}
      <details className="group">
        {/* The padding is inside <summary>, not on <nav>: the whole row is the click area (48px tall), and the focus ring
            is drawn inward because <summary> fills the whole bordered box. The default triangle is not used: `flex`
            (and `list-none`) remove ::marker, Safari needs ::-webkit-details-marker hidden separately. */}
        <summary
          className={`flex cursor-pointer list-none items-center justify-between gap-3 rounded-card p-4 [&::-webkit-details-marker]:hidden ${FOCUS_INSET}`}
        >
          <span
            id="muc-luc"
            className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-neutral-600 uppercase dark:text-neutral-400"
          >
            <ListIcon size={14} />
            {t('toc')}
          </span>
          {/* Down arrow when folded, up when open (like the account button); no animation. */}
          <ChevronRightIcon
            size={14}
            className="shrink-0 rotate-90 text-neutral-500 group-open:-rotate-90 dark:text-neutral-400"
          />
        </summary>
        {/* -mt-1: about 12px below the label as before, offsetting the 16px bottom padding of <summary>. */}
        <ul className="-mt-1 max-h-[60dvh] space-y-1 overflow-y-auto px-4 pb-4 break-words max-sm:space-y-0">
          <TocItems nodes={nodes} variant="inline" />
        </ul>
      </details>
      {spy ? <TocSpy /> : null}
    </nav>
  )
}
