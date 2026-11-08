import { Inter } from 'next/font/google'
import '@/app/globals.css'

/**
 * One family, not three. `variable` rather than `className` so that globals.css can
 * feed it to Tailwind's --font-sans token (see the `@theme inline` block there) and
 * Preflight's own html rule picks it up — one declaration instead of a class on <html>
 * competing with Preflight.
 *
 * `subsets` includes 'vietnamese'. Every word on this site carries diacritics; with
 * latin alone the browser falls back for the horn letters, the dot-below letters and the tone marks, so a single
 * paragraph renders in two faces with two different metrics.
 *
 * And 'latin-ext', even though it sounds unnecessary: a-breve, d-stroke, o-horn, u-horn (U+102–103, U+110–111, U+1A0–1A1,
 * U+1AF–1B0) are in the unicode-range of the latin-ext face, not of the vietnamese face (that face
 * only has the tone-marked letters, U+1EA0–1EF9), so every page loads the latin-ext file — the largest Inter
 * file, 83.6 KiB. Without it in `subsets`, next/font does not preload it, and the browser only
 * discovers it after reading the CSS: under slow-network emulation, this very file pushes the text LCP up to 3.0 s
 * (Lighthouse, QA stack). In `subsets` it is preloaded together with the other two files.
 *
 * display: 'swap' is next/font's default, written out because the brief asks for it
 * explicitly. `adjustFontFallback` is left at its default true: it synthesises a
 * metric-matched local fallback, which is the part that actually removes the layout
 * shift — the human-readable `fallback` list below only matters if the woff2 never
 * arrives at all.
 */
const inter = Inter({
  subsets: ['latin', 'latin-ext', 'vietnamese'],
  display: 'swap',
  variable: '--font-inter',
  fallback: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Arial'],
})

/**
 * Runs before first paint, in <head>, synchronously.
 *
 * Without it the server HTML paints with no data-theme (light), React hydrates, the
 * toggle's effect fires, and only then does the attribute appear — a white flash on
 * every navigation for every dark-mode reader.
 *
 * It resolves "system" into an explicit 'light' | 'dark' rather than leaving the
 * attribute off, so the attribute is the single source of truth for the active theme:
 * globals.css then needs one `@custom-variant dark` keyed on it and no parallel
 * prefers-color-scheme branch that could disagree.
 *
 * The try/catch is not defensive padding, and there are TWO of them for a reason.
 * Reading `localStorage` THROWS a SecurityError outright in a Safari private window
 * and under "block all cookies" — the throw is on the property access, before getItem.
 * A single outer catch would swallow that and leave the attribute unset, so a reader
 * with storage locked down and a dark OS would get a light page: the storage failure
 * would have cost them the system default too. The inner catch isolates storage, the
 * outer one covers everything else (an ancient browser with no matchMedia), and an
 * uncaught error in a <head> script would abort the rest of it.
 *
 * Kept to one statement and duplicated from ThemeToggle on purpose: an import here
 * would mean a module, a module means a network round trip, and a round trip in <head>
 * is the flash this exists to prevent. THEME_STORAGE_KEY in ThemeToggle.tsx is the
 * other half of this contract. Guarded by components/site/ThemeToggle.test.tsx, which
 * extracts this exact string and runs it.
 */
export const THEME_BOOT_SCRIPT = `try{var c=null;try{c=localStorage.getItem("theme")}catch(e){}document.documentElement.setAttribute("data-theme",c==="light"||c==="dark"?c:(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"))}catch(e){}`

/**
 * The `<html>` and `<body>` of every document the site serves: the public pages (`app/[locale]/layout.tsx`), the admin
 * (`app/admin/layout.tsx`) and the not-found page (`app/global-not-found.tsx`). There is no shared root layout any more, because
 * `<html lang>` has to follow the locale of the page.
 */
export function RootShell({ lang, children }: { lang: string; children: React.ReactNode }) {
  return (
    // suppressHydrationWarning is scoped to <html> and is required, not a cover-up:
    // the boot script above adds data-theme before React hydrates, so the client DOM
    // legitimately differs from the server HTML on this one element. Without it React
    // logs a hydration mismatch on every page load. It does not extend to children.
    <html lang={lang} className={inter.variable} suppressHydrationWarning>
      {/* eslint-disable-next-line @next/next/no-head-element -- RootShell is what the root layouts render: the one place the document head is written. */}
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      {/*
        Header, <main> and Footer are NOT here. They belong to app/[locale]/(site)/layout.tsx.
        This layout wraps EVERY route, /admin included, and a nested layout cannot remove
        an ancestor's markup — so chrome here meant the admin screens rendered the public
        header above their own, two <header> landmarks, and a nested <main> on the login
        page. Measured on the running site before the split: /admin/login emitted main=2,
        header=2.

        The body keeps the flex column because both groups rely on it to pin a footer to
        the bottom of a short page.
      */}
      <body className="flex min-h-dvh flex-col bg-white text-neutral-900 antialiased dark:bg-neutral-950 dark:text-neutral-100">
        {children}
      </body>
    </html>
  )
}
