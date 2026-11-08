import { BackToTop } from '@/components/site/BackToTop'
import { SiteChrome } from '@/components/site/SiteChrome'
import { setPageLocale } from '@/i18n/page-locale'
import { getSiteContent } from '@/lib/site-content'

/**
 * The public site's chrome: header, the document's single `<main>`, footer, all inside the one 1400px frame (SiteChrome).
 *
 * It lives in a route group — `(site)` — so it wraps every public page without appearing
 * in a single URL. The group exists because this markup must NOT reach `/admin`: layouts
 * compose downwards and a nested layout cannot remove an ancestor's output, so holding
 * the header in `app/layout.tsx` gave every admin screen the public header stacked above
 * its own. That was measured on the running site, not reasoned about: `/admin/login`
 * emitted two `<main>` elements and two `<header>` elements.
 *
 * Pages under this group must NOT render their own `<main>`. Two main landmarks in one
 * document is invalid HTML and makes "skip to main content" ambiguous — each page renders
 * a page grid or a `<Container>` instead. `main` is the frame (SITE_MAIN) and is `flex-1` against the body's flex column, which
 * is what keeps the footer at the bottom of a short page without guessing a min-height.
 */
export default async function SiteLayout({ children, params }: LayoutProps<'/[locale]'>) {
  const locale = await setPageLocale(params)
  const { site, profile } = await getSiteContent(locale)
  return (
    <>
      <SiteChrome siteName={site.name} galleryLead={profile.galleryLead}>
        {children}
      </SiteChrome>
      <BackToTop />
    </>
  )
}
