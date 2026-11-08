import { getLocale } from 'next-intl/server'
import { asLocale } from '@/lib/format'
import { getSiteContent } from '@/lib/site-content'
import { NotFoundContent } from './NotFoundContent'
import { SiteChrome } from './SiteChrome'

/**
 * The 404 for a URL that matches no route, with its own chrome, and it has to have it.
 *
 * It is rendered by `app/global-not-found.tsx`, outside every layout, so the header and footer that
 * `app/[locale]/(site)/layout.tsx` provides are not there. Without the header a reader who mistypes a URL lands on a dead end
 * with one link; with it they get the navigation, which is the whole point of a 404 page.
 *
 * SiteChrome gives it the same framed `main`. `id="main-content"` is not decoration: Header renders a skip link pointing at it, and a skip link whose target does not exist
 * moves focus nowhere.
 *
 * `notFound()` called from a page of the public group uses `app/[locale]/(site)/not-found.tsx`, which already sits inside the
 * group frame (see NotFoundContent).
 */
export async function NotFoundPage() {
  const { site, profile } = await getSiteContent(asLocale(await getLocale()))
  return (
    <SiteChrome siteName={site.name} galleryLead={profile.galleryLead}>
      <NotFoundContent />
    </SiteChrome>
  )
}
