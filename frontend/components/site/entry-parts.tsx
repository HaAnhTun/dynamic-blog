import Image from 'next/image'
import { useTranslations } from 'next-intl'
import type { ReactNode } from 'react'
import { CollapsibleList } from './CollapsibleList'
import { FOCUS, TRANSITION } from './SectionHeading'

/**
 * The parts shared by the journey on the home page and the experience and education cards of /about: a timeline entry has the
 * same optional details in both places (link, logo, location, department, highlights, technologies), so the rules for "is it
 * set" and the small pieces live once. Every value is plain text drawn as React text, never as HTML.
 */

/** The trimmed text, or an empty string for absent, `null` or blank: all of them mean "not set". */
export const textOf = (value: string | null | undefined): string => (typeof value === 'string' ? value.trim() : '')

/** The `https://` address as given, or `null` for anything else (a missing, blank or non-https value is no link). */
export function httpsUrl(value: string | null | undefined): string | null {
  const text = textOf(value)
  if (text === '') return null
  try {
    return new URL(text).protocol === 'https:' ? text : null
  } catch {
    return null
  }
}

/** The non-blank items of an optional list, trimmed. */
export const itemsOf = (values: readonly string[] | null | undefined): string[] =>
  (values ?? []).map(textOf).filter((value) => value !== '')

/** The facts that exist joined with a separator: a blank part leaves no bare separator behind. */
export const joinFacts = (parts: readonly (string | null | undefined)[], separator = ' · '): string =>
  parts
    .map(textOf)
    .filter((part) => part !== '')
    .join(separator)

// On a phone the name of a company or school is a 44px target without moving the lines around it: padding inside, the same space back as margin.
const LINK = `${FOCUS} ${TRANSITION} max-sm:-my-2 max-sm:inline-block max-sm:py-2 underline decoration-neutral-300 underline-offset-4 hover:text-brand hover:decoration-brand dark:decoration-neutral-700`

/** The name of a company or school: a link when the entry has an `https://` address, plain text otherwise. */
export function OrgName({ name, url }: { name: string; url: string | null | undefined }): ReactNode {
  const href = httpsUrl(url)
  if (href === null) return name
  return (
    <a href={href} rel="noopener noreferrer" className={LINK}>
      {name}
    </a>
  )
}

/** The logo of a company or school. Decorative (the name is next to it), so it has no alternative text. */
export function EntryLogo({ src, className = 'h-10 w-10' }: { src: string | null | undefined; className?: string }) {
  const path = textOf(src)
  if (path === '') return null
  return (
    <Image
      src={path}
      alt=""
      width={96}
      height={96}
      unoptimized
      className={`${className} shrink-0 rounded-md border border-neutral-200 bg-white object-contain p-1 dark:border-neutral-800`}
    />
  )
}

/** How many bullets of a collapsed list show on a phone; keep in step with the `nth-child(n+4)` rule of CollapsibleList. */
export const COLLAPSED_ITEMS = 3

/**
 * The bullet points of what was done; nothing at all for an empty list. 15px on a phone (this is the main content of an entry, not
 * metadata), 14px from `sm`. With `collapse`, a list of more than three shows three on a phone and a button for the rest.
 */
export function HighlightList({
  items,
  className = '',
  collapse = false,
}: {
  items: readonly string[] | undefined
  className?: string
  collapse?: boolean
}) {
  const list = itemsOf(items)
  if (list.length === 0) return null
  const bullets = (
    <ul
      className={`list-disc space-y-1.5 ps-5 text-[0.9375rem] text-neutral-700 marker:text-neutral-400 sm:space-y-1 sm:text-sm dark:text-neutral-300 ${className}`.trim()}
    >
      {list.map((item, index) => (
        <li key={`${index}-${item}`} className="[overflow-wrap:anywhere]">
          {item}
        </li>
      ))}
    </ul>
  )
  return collapse && list.length > COLLAPSED_ITEMS ? (
    <CollapsibleList hidden={list.length - COLLAPSED_ITEMS}>{bullets}</CollapsibleList>
  ) : (
    bullets
  )
}

/** The technologies as small pills; nothing at all for an empty list. */
export function TechPills({ items, className = '' }: { items: readonly string[] | undefined; className?: string }) {
  const t = useTranslations('Site.entry')
  const list = itemsOf(items)
  if (list.length === 0) return null
  return (
    <ul aria-label={t('techLabel')} className={`flex flex-wrap gap-1.5 ${className}`.trim()}>
      {list.map((item, index) => (
        <li
          key={`${index}-${item}`}
          className="rounded-full border border-neutral-200 px-2.5 py-0.5 text-xs text-neutral-700 [overflow-wrap:anywhere] dark:border-neutral-800 dark:text-neutral-300"
        >
          {item}
        </li>
      ))}
    </ul>
  )
}
