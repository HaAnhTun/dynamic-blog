'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useEffect, useRef } from 'react'
import { DEFAULT_LOCALE, isLocale } from '@/i18n/config'
import { numberFormat } from '@/lib/format'
import { readingProgress } from '@/lib/reading-progress'

/** The post body (ArticleBody carries the hook), the element whose height is "the article". */
const BODY = '[data-post-body]'

/**
 * The reading progress of the post, in two forms of one island: a 2px bar fixed to the top of the viewport below the
 * `rail:` breakpoint (where there is no rail), and a labelled meter with a percentage at the top of the right rail from it.
 *
 * It follows the scroll directly: one passive `scroll` and `resize` listener, throttled to one update per frame with
 * requestAnimationFrame (the wiring of BackToTop), writing through refs (`transform` of the two fills, `textContent` of the
 * percentage). No state: a React render per frame would be pure cost, and the repo's lint rule blocks `setState` in an effect.
 * No CSS transition, so `prefers-reduced-motion` needs no special case.
 *
 * Decorative: both parts are aria-hidden and nothing is `aria-live` (the value changes constantly). Without a post body in the
 * page (preview, an empty post) the effect returns early and both stay at 0.
 */
export function ReadingProgress() {
  const t = useTranslations('Site.reader')
  const current = useLocale()
  const locale = isLocale(current) ? current : DEFAULT_LOCALE
  const bar = useRef<HTMLDivElement>(null)
  const fill = useRef<HTMLDivElement>(null)
  const value = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const body = document.querySelector(BODY)
    if (body === null) return
    const percent = numberFormat(locale, { style: 'percent', maximumFractionDigits: 0 })

    let frame = 0
    function update() {
      frame = 0
      const { top, height } = body!.getBoundingClientRect()
      const progress = readingProgress({ top, height }, window.innerHeight)
      const transform = `scaleX(${progress})`
      if (bar.current) bar.current.style.transform = transform
      if (fill.current) fill.current.style.transform = transform
      if (value.current) value.current.textContent = percent.format(progress)
    }
    function schedule() {
      if (frame === 0) frame = requestAnimationFrame(update)
    }

    schedule()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
    }
  }, [locale])

  return (
    <>
      <div
        ref={bar}
        aria-hidden="true"
        className="fixed inset-x-0 top-0 z-50 h-0.5 origin-left bg-brand rail:hidden print:hidden"
        style={{ transform: 'scaleX(0)' }}
      />
      <div aria-hidden="true" className="hidden shrink-0 pb-4 rail:block">
        <p className="flex items-baseline justify-between gap-2 pb-2 text-xs font-semibold tracking-wide text-neutral-600 uppercase dark:text-neutral-400">
          {t('progressLabel')}
          <span ref={value} data-progress-value="" className="tabular-nums">
            0%
          </span>
        </p>
        <div className="h-0.5 bg-neutral-200 dark:bg-neutral-800">
          <div ref={fill} className="h-full origin-left bg-brand" style={{ transform: 'scaleX(0)' }} />
        </div>
      </div>
    </>
  )
}
