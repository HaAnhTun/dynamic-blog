'use client'

import { useTranslations } from 'next-intl'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUpIcon } from '@/components/icons'
import { isTextEntry, shouldShowBackToTop } from '@/lib/scroll-ui'
import { FOCUS_RING, TAP_TARGET, TRANSITION } from './SectionHeading'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION_QUERY).matches
}

/**
 * Focus `<main>` without scrolling. tabindex="-1" is attached only when needed and removed at the first blur (the GOV.UK way): if attached permanently,
 * a mouse press on the text would also focus <main>, and the next Tab would jump back to the first link of the page.
 */
function focusMain(): void {
  const main = document.getElementById('main-content')
  if (main === null) return
  if (!main.hasAttribute('tabindex')) {
    main.setAttribute('tabindex', '-1')
    main.addEventListener('blur', () => main.removeAttribute('tabindex'), { once: true })
  }
  main.focus({ preventScroll: true })
}

/**
 * The "Back to top" button: one island for every public page, mounted in app/(site)/layout.tsx. Shown when
 * the page is longer than 4 screens and has scrolled past 1.5 screens (lib/scroll-ui.ts), independent of the header.
 */
export function BackToTop() {
  const t = useTranslations('Site.shell')
  const [past, setPast] = useState(false)
  const [typing, setTyping] = useState(false)
  const shell = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let frame = 0
    function update() {
      frame = 0
      setPast(
        shouldShowBackToTop({
          scrollY: window.scrollY,
          viewportHeight: window.innerHeight,
          documentHeight: document.documentElement.scrollHeight,
        }),
      )
      setTyping(isTextEntry(document.activeElement))
    }
    function schedule() {
      if (frame === 0) frame = requestAnimationFrame(update)
    }
    // An input that is receiving text (comment form): on a phone the button would cover it, right above the virtual keyboard. focusout reads
    // where focus is going next (relatedTarget): at that moment activeElement may not have changed yet.
    function onFocusIn(event: FocusEvent) {
      setTyping(isTextEntry(event.target))
    }
    function onFocusOut(event: FocusEvent) {
      setTyping(isTextEntry(event.relatedTarget))
    }

    schedule()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
    }
  }, [])

  const visible = past && !typing

  // The button holds focus and hides (inert): do not let focus fall to <body>. A layout effect: before the browser removes
  // focus from the inert region itself at the next frame.
  useLayoutEffect(() => {
    if (!visible && shell.current?.contains(document.activeElement)) focusMain()
  }, [visible])

  function toTop() {
    window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'instant' : 'smooth' })
    // A keyboard user continues from the start of the content, without tabbing through the whole header again.
    focusMain()
  }

  return (
    // When hidden: `inert` removes the button from the Tab order, the accessibility tree and presses immediately, even during the 200ms fade;
    // `invisible` (visibility is in the transition) keeps it unpainted afterwards. With a modal dialog (the quick-search panel,
    // the zoomed image) it is hidden outright: it is inert but would still be painted through the dimmed backdrop.
    <div
      ref={shell}
      inert={!visible}
      className={`fixed right-[calc(1rem+env(safe-area-inset-right))] bottom-[calc(1rem+env(safe-area-inset-bottom))] z-30 [html:has(dialog[open]:modal)_&]:hidden transition-[opacity,translate,visibility] duration-200 motion-reduce:transition-none sm:right-[calc(1.5rem+env(safe-area-inset-right))] sm:bottom-[calc(1.5rem+env(safe-area-inset-bottom))] print:hidden ${
        visible ? 'visible opacity-100' : 'invisible translate-y-2 opacity-0'
      }`}
    >
      <button
        type="button"
        onClick={toTop}
        className={`inline-flex h-10 w-10 items-center justify-center gap-2 rounded-full border border-neutral-200 bg-white text-sm font-medium text-neutral-700 shadow-sm hover:border-brand hover:text-brand focus-visible:border-brand focus-visible:text-brand sm:w-auto sm:px-4 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300 ${TAP_TARGET} ${FOCUS_RING} ${TRANSITION}`}
      >
        <ArrowUpIcon size={16} />
        {/* Below sm only the icon remains; the text is still the button's accessible name. */}
        <span className="max-sm:sr-only">{t('backToTop')}</span>
      </button>
    </div>
  )
}
