'use client'

import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { ICON_SLOT, ICON_TAP_TARGET } from './SectionHeading'

/**
 * The reader's *choice*, which is not the same thing as the theme that is painted.
 * `system` means "no stored preference"; it is represented by the ABSENCE of the
 * localStorage key, never by the string 'system' in storage, so that clearing site
 * data and choosing "system" land in the same state.
 */
export type ThemeChoice = 'light' | 'dark' | 'system'

/** What actually ends up in `data-theme` on <html>. Always one of these two. */
export type ResolvedTheme = 'light' | 'dark'

/** Shared with the inline boot script in app/layout.tsx. If these two ever disagree,
 *  the page paints one theme and the toggle reports another. */
export const THEME_STORAGE_KEY = 'theme'

export const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)'

/** Cycle order. `system` first so that the default state is the start of the cycle. */
const CYCLE: readonly ThemeChoice[] = ['system', 'light', 'dark']

function prefersDark(): boolean {
  // matchMedia is missing in some test environments and in very old browsers; absent
  // it, "system" has to resolve to something, and light is the safer guess because
  // the server-rendered HTML is light.
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(DARK_MEDIA_QUERY).matches
    : false
}

export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  if (choice === 'light' || choice === 'dark') return choice
  return prefersDark() ? 'dark' : 'light'
}

/**
 * Every localStorage access on this page is wrapped. In a Safari private window and
 * under a "block all cookies" setting, merely *reading* `localStorage` throws a
 * SecurityError — not at `getItem`, at the property access — and an uncaught throw
 * here would take the whole component down.
 */
export function readStoredChoice(): ThemeChoice {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY)
    return raw === 'light' || raw === 'dark' ? raw : 'system'
  } catch {
    return 'system'
  }
}

function storeChoice(choice: ThemeChoice): void {
  try {
    if (choice === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY)
    else window.localStorage.setItem(THEME_STORAGE_KEY, choice)
  } catch {
    // Storage denied. The choice still applies for this page view; it just will not
    // survive a reload. Losing persistence is not worth losing the toggle.
  }
}

/** Writes the resolved theme onto <html>, which is what every `dark:` utility and the
 *  Shiki override in globals.css key on. */
export function applyTheme(choice: ThemeChoice): ResolvedTheme {
  const resolved = resolveTheme(choice)
  document.documentElement.setAttribute('data-theme', resolved)
  return resolved
}

/* ------------------------------------------------------------------ *
 * The stored choice as an external store
 * ------------------------------------------------------------------ */

/**
 * localStorage is an external store, so it is read with `useSyncExternalStore` rather
 * than copied into state by an effect.
 *
 * The effect version — `useState('system')` plus `useEffect(() => setChoice(read()))` —
 * is what eslint's `react-hooks/set-state-in-effect` rejects, and the rule is right: a
 * setState in an effect body schedules a second render pass for information that was
 * already available synchronously. `useSyncExternalStore` exists for exactly this shape
 * and gets two things the effect version did not:
 *
 * - **Hydration safety without a hand-written placeholder.** React uses
 *   `getServerSnapshot` for the server render and the hydration pass, then reconciles
 *   with `getSnapshot`. The server cannot know the stored choice, so the server snapshot
 *   is 'system' — the same value the effect version hardcoded, but declared rather than
 *   assumed.
 * - **Cross-tab sync for free.** The `storage` event fires in OTHER tabs, so changing
 *   the theme in one tab now moves the toggle in the rest. The effect version read
 *   storage once at mount and never again.
 *
 * `storage` does NOT fire in the tab that wrote the value, which is why there is a
 * local listener set as well: without it, this tab's own click would update the
 * attribute and not the button's label.
 */
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange)
  window.addEventListener('storage', onStoreChange)
  return () => {
    listeners.delete(onStoreChange)
    window.removeEventListener('storage', onStoreChange)
  }
}

/**
 * Must be referentially stable between calls for the same underlying value, or React
 * re-renders forever. `readStoredChoice` returns a primitive, so that holds.
 */
function getSnapshot(): ThemeChoice {
  return readStoredChoice()
}

function getServerSnapshot(): ThemeChoice {
  return 'system'
}

function nextChoice(current: ThemeChoice): ThemeChoice {
  const i = CYCLE.indexOf(current)
  return CYCLE[(i + 1) % CYCLE.length] ?? 'system'
}

/**
 * One button that cycles system → light → dark, rather than three radio buttons.
 *
 * Three buttons would be ~96px of header at 360px wide, next to four nav links and a
 * search link, and the brief asks for restraint. The cost is that the control's state
 * has to be announced, which is why the accessible name carries it.
 *
 * Hydration: the first client render must produce the same markup as the server did,
 * and the server cannot know the stored choice. So the initial state is `system` on
 * both sides and `useEffect` corrects it after mount. That can change the *icon* one
 * frame after hydration; it does NOT cause a flash of the wrong page theme, because
 * the inline script in app/layout.tsx has already set `data-theme` before first
 * paint. An icon settling is a far smaller defect than a white page going dark.
 */
export function ThemeToggle({ className = '' }: { className?: string }) {
  const t = useTranslations('Site.shell')
  const choice = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  // Writes to an external system (the DOM attribute) from the current state, which is
  // what effects are actually for — no setState here, so no cascading render.
  //
  // It re-asserts the attribute rather than trusting the boot script in app/layout.tsx.
  // If that inline script was blocked — a Content-Security-Policy without
  // 'unsafe-inline' does exactly that — this is the fallback that still produces a
  // correct, if late, theme.
  useEffect(() => {
    applyTheme(choice)
  }, [choice])

  // While the choice is `system`, the OS flipping to dark at sunset has to move the page
  // with it. Without this listener the attribute stays at whatever it resolved to on
  // load, which is the bug "follow the system" promises not to have.
  useEffect(() => {
    if (choice !== 'system') return
    if (typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(DARK_MEDIA_QUERY)
    const onChange = () => applyTheme('system')
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [choice])

  // Print is always light: the dark theme prints light text on white paper. `beforeprint` runs before
  // the browser builds the print page (Ctrl+P, window.print()), so changing the attribute here is enough: every `dark:`, the
  // Shiki rule and the `color-scheme` in globals.css follow it. `afterprint` restores the theme of the current choice —
  // without touching storage, so the reader's choice does not change. Not via CSS: a print rule by
  // prefers-color-scheme or data-theme would be a second source of truth (globals.css explains).
  useEffect(() => {
    const paper = () => document.documentElement.setAttribute('data-theme', 'light')
    const restore = () => applyTheme(choice)
    window.addEventListener('beforeprint', paper)
    window.addEventListener('afterprint', restore)
    return () => {
      window.removeEventListener('beforeprint', paper)
      window.removeEventListener('afterprint', restore)
    }
  }, [choice])

  const cycle = useCallback(() => {
    // Write to storage, then tell the store it moved. The attribute is set by the effect
    // above once the new snapshot renders, so there is exactly one place that touches
    // `data-theme` in response to a choice — rather than one here and one on mount, which
    // is how the two could have disagreed.
    storeChoice(nextChoice(readStoredChoice()))
    emit()
  }, [])

  const upcoming = nextChoice(choice)

  return (
    <button
      type="button"
      onClick={cycle}
      data-theme-choice={choice}
      // The name carries both the state and the action, because a cycling control
      // whose name is only the generic change-theme label leaves a screen reader user unable to tell
      // what they are currently looking at or where one more press will land them.
      aria-label={t('themeToggle.label', { current: choice, next: upcoming })}
      title={t('themeToggle.title', { current: choice })}
      // ICON_SLOT: 44px on a phone, 36px from md like the search slot beside it; ICON_TAP_TARGET widens the hit area.
      className={`inline-flex ${ICON_SLOT} shrink-0 items-center justify-center rounded-md border border-neutral-200 text-neutral-600 transition-colors duration-[120ms] hover:border-brand hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand motion-reduce:transition-none dark:border-neutral-800 dark:text-neutral-400 ${ICON_TAP_TARGET} ${className}`.trim()}
    >
      <ThemeIcon choice={choice} />
    </button>
  )
}

/** Inline SVG, 16px, `currentColor`, aria-hidden — the button carries the name, so the
 *  icon must not contribute a second one. No icon library for three glyphs. */
function ThemeIcon({ choice }: { choice: ThemeChoice }) {
  const common = {
    viewBox: '0 0 16 16',
    width: 16,
    height: 16,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }

  if (choice === 'dark') {
    return (
      <svg {...common} data-icon="dark">
        <path d="M13.5 9.6A5.8 5.8 0 0 1 6.4 2.5a5.8 5.8 0 1 0 7.1 7.1Z" />
      </svg>
    )
  }

  if (choice === 'light') {
    return (
      <svg {...common} data-icon="light">
        <circle cx="8" cy="8" r="3.1" />
        <path d="M8 1.2v1.5M8 13.3v1.5M1.2 8h1.5M13.3 8h1.5M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M12.8 3.2l-1.1 1.1M4.3 11.7l-1.1 1.1" />
      </svg>
    )
  }

  // system: a monitor, i.e. "whatever this machine says".
  return (
    <svg {...common} data-icon="system">
      <rect x="1.8" y="2.6" width="12.4" height="8.4" rx="1.2" />
      <path d="M5.6 13.4h4.8" />
    </svg>
  )
}
