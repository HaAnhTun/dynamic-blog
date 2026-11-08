import type { ReactNode } from 'react'
import { Footer } from './Footer'
import { Header } from './Header'
import { SITE_MAIN } from './reader/reader-layout'

/**
 * The shell of every public page: header, the document's single `<main>`, footer. `main` IS the 1400px frame (SITE_MAIN: max
 * width, centring, the two side hairlines from `frame:`), and the header and footer Containers carry the same width and
 * hairlines, so the three share one x at every window width.
 *
 * Presentational: no data loading and no locale handling. The two callers, `app/[locale]/(site)/layout.tsx` and the global 404
 * (NotFoundPage), each load what Header needs and pass it down. `BackToTop` stays in the layout, outside this component.
 *
 * `id="main-content"` is the target of the skip link that Header renders. No fixed tabIndex: the "Back to top" button attaches
 * `tabindex="-1"` when moving focus in (BackToTop.tsx); SITE_MAIN has `outline-none` so no ring is drawn around the whole page.
 */
export function SiteChrome({
  siteName,
  galleryLead,
  children,
}: {
  siteName: string
  galleryLead: string | null
  children: ReactNode
}) {
  return (
    <>
      <Header siteName={siteName} galleryLead={galleryLead} />
      <main id="main-content" className={SITE_MAIN}>
        {children}
      </main>
      <Footer />
    </>
  )
}
