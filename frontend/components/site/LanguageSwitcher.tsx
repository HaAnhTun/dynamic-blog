'use client'

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { LOCALES, type Locale } from '@/i18n/config'
import { getPathname, usePathname } from '@/i18n/navigation'
import { CheckIcon, ChevronRightIcon } from '@/components/icons'
import { LanguageFlag } from './language-flags'
import { LANGUAGE_NAMES } from './language-names'
import { FOCUS_INSET, ICON_TAP_TARGET, TRANSITION } from './SectionHeading'

/** Page paths (without a locale prefix) of the same content in other languages; set by an article page, empty elsewhere. */
type Targets = Partial<Record<Locale, string>>

let targets: Targets = {}
const listeners = new Set<() => void>()

function publish(next: Targets) {
  targets = next
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const NO_TARGETS: Targets = {}

/**
 * Rendered by an article that has translations: while it is on screen the switcher links each language to that language's own
 * page. The header sits above the page in the layout, so this is the one way the page can tell it; without JavaScript the
 * switcher keeps the same-path links and the article's own "read in another language" links remain.
 */
export function SwitcherTargets({ targets: next }: { targets: Targets }) {
  const key = JSON.stringify(next)
  useEffect(() => {
    publish(JSON.parse(key) as Targets)
    return () => publish({})
  }, [key])
  return null
}

/**
 * A language dropdown: a pill with the current flag, and under it one row per language (flag, name, a check on the current one).
 * It is a native `<details>`, so it opens without JavaScript, and each other language is a plain `<a href>` to the SAME page in
 * that language. The href comes from `getPathname`, not from the i18n `Link`'s `locale` prop, which forces a `/vi` prefix on the
 * default locale and costs a redirect. A plain `<a>` also fits: another language is another root layout (`<html lang>`), so the
 * navigation is a full page load anyway.
 *
 * While it is open, a press outside or Escape closes it. Those two listeners exist only while it is open (the header owns "/" and
 * Ctrl/Cmd+K, a closed switcher listens for nothing), and Escape is the only key it handles.
 */
export function LanguageSwitcher({ className }: { className?: string }) {
  const t = useTranslations('Language')
  const current = useLocale()
  const pathname = usePathname() ?? '/'
  const own = useSyncExternalStore(
    subscribe,
    () => targets,
    () => NO_TARGETS,
  )
  const [open, setOpen] = useState(false)
  const details = useRef<HTMLDetailsElement>(null)

  useEffect(() => {
    if (!open) return
    function close(returnFocus: boolean) {
      const element = details.current
      if (!element) return
      element.open = false
      if (returnFocus) element.querySelector('summary')?.focus({ preventScroll: true })
    }
    function handleOutside(event: PointerEvent) {
      if (event.target instanceof Node && details.current?.contains(event.target)) return
      close(false)
    }
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.isComposing) return
      close(true)
    }
    document.addEventListener('pointerdown', handleOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('pointerdown', handleOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [open])

  return (
    <nav aria-label={t('navLabel')} className={className}>
      <details
        ref={details}
        className="group relative"
        onToggle={(event) => setOpen(event.currentTarget.open)}
        onBlur={(event) => {
          // Tab out of the pill and the list closes it; a null `relatedTarget` (pressing somewhere unfocusable) does not, the press
          // outside is the pointerdown above.
          const next = event.relatedTarget
          if (open && next instanceof Node && !event.currentTarget.contains(next)) event.currentTarget.open = false
        }}
      >
        <summary
          aria-label={`${t('navLabel')}: ${LANGUAGE_NAMES[current as Locale] ?? current}`}
          lang={current}
          className={`${TRANSITION} ${ICON_TAP_TARGET} inline-flex h-11 w-11 cursor-pointer list-none items-center justify-center gap-1.5 rounded-md border border-neutral-200 text-sm sm:w-auto sm:px-2.5 md:h-9 font-medium text-neutral-600 select-none hover:border-brand hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand dark:border-neutral-800 dark:text-neutral-400 [&::-webkit-details-marker]:hidden`}
        >
          <LanguageFlag locale={current as Locale} />
          <ChevronRightIcon size={14} className="hidden rotate-90 group-open:-rotate-90 sm:block" />
        </summary>
        <ul className="absolute top-full right-0 z-40 mt-2 w-48 rounded-md border border-neutral-200 bg-white py-1 text-sm shadow-lg dark:border-neutral-800 dark:bg-neutral-900">
          {LOCALES.map((locale) => {
            const row = `flex min-h-11 w-full items-center gap-3 px-4 py-2 text-left md:min-h-0 ${FOCUS_INSET}`
            return (
              <li key={locale}>
                {locale === current ? (
                  <span aria-current="true" lang={locale} className={`${row} font-medium text-neutral-900 dark:text-neutral-100`}>
                    <LanguageFlag locale={locale} />
                    <span className="flex-1">{LANGUAGE_NAMES[locale]}</span>
                    <CheckIcon size={16} className="text-brand" />
                  </span>
                ) : (
                  <a
                    href={getPathname({ href: own[locale] ?? pathname, locale })}
                    lang={locale}
                    hrefLang={locale}
                    className={`${row} ${TRANSITION} text-neutral-700 hover:bg-neutral-100 hover:text-brand dark:text-neutral-300 dark:hover:bg-neutral-800`}
                  >
                    <LanguageFlag locale={locale} />
                    <span className="flex-1">{LANGUAGE_NAMES[locale]}</span>
                  </a>
                )}
              </li>
            )
          })}
        </ul>
      </details>
    </nav>
  )
}
