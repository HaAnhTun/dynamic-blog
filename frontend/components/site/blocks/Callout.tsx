import { useTranslations } from 'next-intl'
import type { ReactNode } from 'react'
import { BLOCK_PROSE, BLOCK_WRAP } from './content-prose'
import type { BlockComponentProps } from './types'

type CalloutType = BlockComponentProps<'callout'>['props']['type']

/**
 * One look per kind: the frame (border and tint) and the ink of the label, each with its dark pair. Contrast: the label ink is the
 * 800 shade on the 50 tint, and the 300 shade on the 950 tint in dark mode, which stays above 4.5:1 for text of this size.
 */
const LOOK: Record<CalloutType, { frame: string; ink: string }> = {
  info: {
    frame: 'border-sky-300 bg-sky-50 dark:border-sky-800 dark:bg-sky-950/40',
    ink: 'text-sky-800 dark:text-sky-300',
  },
  note: {
    frame: 'border-neutral-300 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900',
    ink: 'text-neutral-700 dark:text-neutral-300',
  },
  tip: {
    frame: 'border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/40',
    ink: 'text-emerald-800 dark:text-emerald-300',
  },
  warning: {
    frame: 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40',
    ink: 'text-amber-800 dark:text-amber-300',
  },
  danger: {
    frame: 'border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/40',
    ink: 'text-red-800 dark:text-red-300',
  },
}

/** A distinct drawing per kind, so the kind never depends on color. Stroke icons on a 24 grid, decorative: the label says it in words. */
const ICON: Record<CalloutType, ReactNode> = {
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </>
  ),
  note: (
    <>
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M9 12h7" />
      <path d="M9 16h7" />
    </>
  ),
  tip: (
    <>
      <path d="M9 18h6" />
      <path d="M10 21h4" />
      <path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z" />
    </>
  ),
  warning: (
    <>
      <path d="M12 3 2.5 20h19z" />
      <path d="M12 10v4" />
      <path d="M12 17h.01" />
    </>
  ),
  danger: (
    <>
      <path d="M8 3h8l5 5v8l-5 5H8l-5-5V8z" />
      <path d="M9 9l6 6" />
      <path d="M15 9l-6 6" />
    </>
  ),
}

/**
 * An aside set apart from the text. A `note` landmark (never `alert`: nothing here interrupts a screen reader), and the kind is
 * written out as a label next to the icon, so it does not rest on color. Compact is a quiet strip, prominent a larger panel with a
 * heavier title for a warning the reader must not miss. The Markdown inside keeps the article's typography through `BLOCK_PROSE`.
 */
export function Callout({ props, children }: BlockComponentProps<'callout'>) {
  const t = useTranslations('Site.blocks.callout')
  const { type, title, variant } = props
  const look = LOOK[type]
  const prominent = variant === 'prominent'

  return (
    <div
      role="note"
      data-block="callout"
      data-type={type}
      data-variant={variant}
      className={`not-prose my-6 w-full max-w-full min-w-0 rounded-lg border-s-4 border-y border-e ${look.frame} ${
        prominent ? 'p-5 sm:p-6' : 'px-4 py-3'
      }`}
    >
      <p className={`flex items-center gap-2 text-xs font-semibold tracking-wide uppercase ${look.ink}`}>
        <svg
          aria-hidden="true"
          focusable="false"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={prominent ? 'h-6 w-6 shrink-0' : 'h-5 w-5 shrink-0'}
        >
          {ICON[type]}
        </svg>
        <span>{t(`types.${type}`)}</span>
      </p>
      {title ? (
        <p
          className={`mt-1 ${BLOCK_WRAP} font-semibold text-balance text-neutral-900 dark:text-neutral-50 ${
            prominent ? 'text-xl' : 'text-base'
          }`}
        >
          {title}
        </p>
      ) : null}
      <div className={`${BLOCK_PROSE} mt-2 ${prominent ? 'prose-lg' : 'prose-base'}`}>{children}</div>
    </div>
  )
}
