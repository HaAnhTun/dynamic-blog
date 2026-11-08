import type { Metadata, Viewport } from 'next'
import { ogLocale, type Locale } from '@/i18n/config'
import { siteOgImage } from '@/lib/metadata'
import { siteUrlObject } from '@/lib/site'
import { getSiteContent } from '@/lib/site-content'

/** Root metadata of a locale: the brand, title template and share defaults come from the site content of that locale. */
export async function rootMetadata(locale: Locale): Promise<Metadata> {
  const { site } = await getSiteContent(locale)
  return {
    // Via lib/site.ts, not `process.env.NEXT_PUBLIC_SITE_URL ?? '...'`: `??` falls back only on null and undefined, so an
    // empty `NEXT_PUBLIC_SITE_URL=` made `new URL('')` throw while generating metadata for every route.
    metadataBase: siteUrlObject(),
    title: {
      // title.default is required whenever title.template is set; the template applies to child segments only.
      default: site.name,
      template: `%s — ${site.name}`,
    },
    description: site.positioning,
    openGraph: {
      // With width/height/alt, like every page built through pageMetadata (lib/metadata.ts).
      images: [await siteOgImage(locale)],
      type: 'website',
      locale: ogLocale(locale),
      siteName: site.name,
      title: site.name,
      description: site.positioning,
      url: '/',
    },
    twitter: {
      card: 'summary_large_image',
      title: site.name,
      description: site.positioning,
    },
    // No `alternates.canonical` here: a canonical on the ROOT layout is inherited by every page that does not override it
    // (an article emitted the homepage as its canonical). Each page sets its own; `(site)/page.tsx` sets '/'.
  }
}

/**
 * The browser bar color on mobile (`<meta name="theme-color">`): exactly the background color of the
 * <body> below — `bg-white`, and `dark:bg-neutral-950` is #0a0a0a — so the address bar is one color
 * with the page instead of a gray browser strip.
 *
 * By OS, not by toggle: this meta can only be chosen with a media query, and it is read before any script.
 * A reader whose theme is opposite to the OS sees the bar follow the OS; the page still has the right theme, because `color-scheme` lives
 * in globals.css and follows data-theme. There is deliberately no `colorScheme` here: the color-scheme meta
 * is read before the CSS and boot script, so it would paint the canvas by OS for exactly those readers.
 *
 * Applies to every route, /admin included (admin is always light): at admin, a user on a dark OS sees a dark bar over a
 * white page. If that should differ, admin needs its own `viewport`.
 */
export const rootViewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
}
