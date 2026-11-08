'use client'

import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { LABEL_PURIFY_CONFIG, toSafeDrawing } from './diagram-safety'
import { SCROLL_CUE, useScrollCue } from './use-scroll-cue'

type Theme = 'light' | 'dark'
type Status = 'loading' | 'ready' | 'failed'

/**
 * The theme the page shows, read from the `data-theme` attribute the boot script of components/RootShell.tsx writes on `<html>`
 * before paint (and the theme toggle changes). The admin is light whatever that attribute says (the `dark:` variant of app/globals.css leaves it out the same way), so a
 * page that holds a `[data-admin]` element is light. Subscribing through `useSyncExternalStore` makes a change of theme draw the
 * diagram again, and the server snapshot (`null`: not known yet) keeps the first client render equal to the server HTML.
 */
function subscribeToTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => observer.disconnect()
}

function currentTheme(): Theme {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark' && document.querySelector('[data-admin]') === null
  return dark ? 'dark' : 'light'
}

const themeOnServer = (): Theme | null => null

/** Bar and line colours of a `xychart-beta`, comma separated as the library wants them: blue, amber, green, violet, red, teal. */
const XY_CHART_PALETTE = '#2563eb,#d97706,#059669,#9333ea,#dc2626,#0891b2'

/**
 * The library, loaded once for the page by the first diagram that asks (the others wait for the same answer). The only
 * `import('mermaid')` of the code base: a page without a diagram never reaches it, so the library is never downloaded for it. A
 * load that fails is forgotten, so a later diagram may try again.
 */
let library: Promise<(typeof import('mermaid'))['default']> | undefined
function loadMermaid() {
  library ??= import('mermaid').then(
    (module) => module.default,
    (error: unknown) => {
      library = undefined
      throw error
    },
  )
  return library
}

/**
 * A scratch element mermaid may leave in the page when it fails to draw: it is made under the id of the render call, prefixed with
 * `d`. Removed so a broken diagram does not leave a stray error drawing at the end of the page.
 */
function removeScratch(id: string) {
  document.getElementById(`d${id}`)?.remove()
  document.getElementById(id)?.remove()
}

type Props = {
  /** The diagram text exactly as the author wrote it. Shown as it is until, and unless, it is drawn. */
  source: string
  /** The accessible name of the drawing. */
  label: string
  /** What the reader is told when the diagram cannot be drawn (the source stays on the page). */
  failedMessage: string
}

/**
 * The browser half of a `diagram` block. The server HTML, and the page without JavaScript, show the source in a `<pre>`; after
 * hydration this loads `mermaid` with a dynamic `import()` (its own chunk, fetched only by a page that holds a diagram), draws the
 * diagram for the current theme and swaps the `<pre>` for the drawing, an `img` named by `label`. When the library cannot be loaded or
 * the diagram cannot be drawn, the `<pre>` stays and a short sentence says so; the library's error message is never shown, since it
 * may quote the author's text. Nothing here throws into React: every failure ends in the `failed` state.
 *
 * `import('mermaid')` appears in this file only (a test holds that): one place decides when the library is loaded.
 */
export function DiagramView({ source, label, failedMessage }: Props) {
  const theme = useSyncExternalStore(subscribeToTheme, currentTheme, themeOnServer)
  const [status, setStatus] = useState<Status>('loading')
  const host = useRef<HTMLDivElement>(null)
  const calls = useRef(0)
  // `useId` makes `_r_0_` or `«r0»`: not safe in a CSS selector, which mermaid builds from the id.
  const prefix = `mermaid-${useId().replace(/[^A-Za-z0-9]/g, '')}`

  useEffect(() => {
    if (theme === null) return
    let cancelled = false
    const id = `${prefix}-${(calls.current += 1)}`

    async function draw() {
      try {
        const mermaid = await loadMermaid()
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          // The labels are HTML: this keeps a few formatting tags in them and no form, control, link or attribute (the page cleans the
          // drawing again with an allowlist, see diagram-safety.ts).
          dompurifyConfig: LABEL_PURIFY_CONFIG,
          // Without this a diagram that does not parse is drawn as a "Syntax error" picture appended to the end of the page.
          suppressErrorRendering: true,
          theme: theme === 'dark' ? 'dark' : 'default',
          // The library paints the first series of a `xychart-beta` lavender (#ECECFF): on a white page the bars all but vanish.
          // This palette keeps at least 3 to 1 against a white page and a dark one (a test computes it), so one list serves both themes.
          themeVariables: { xyChart: { plotColorPalette: XY_CHART_PALETTE } },
        })
        const { svg } = await mermaid.render(id, source)
        const drawing = toSafeDrawing(svg)
        if (cancelled) return
        if (!drawing || !host.current) throw new Error('not a drawing')
        host.current.replaceChildren(drawing)
        setStatus('ready')
      } catch {
        removeScratch(id)
        if (!cancelled) setStatus('failed')
      }
    }

    void draw()
    return () => {
      cancelled = true
    }
  }, [source, theme, prefix])

  const drawn = status === 'ready'
  useScrollCue(host, drawn)
  return (
    <div>
      <div
        ref={host}
        role="img"
        aria-label={label}
        hidden={!drawn}
        // A drawing wider than the column scrolls inside this box, never the page; a scroll box has to be reachable by keyboard.
        tabIndex={drawn ? 0 : undefined}
        className={`overflow-x-auto ${SCROLL_CUE} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand [&_svg]:mx-auto [&_svg]:block [&_svg]:h-auto [&_svg]:max-w-full`}
      />
      {drawn ? null : (
        <pre
          tabIndex={0}
          className="m-0 overflow-x-auto rounded-lg bg-neutral-50 text-sm leading-[1.7] text-neutral-800 dark:bg-neutral-900 dark:text-neutral-200"
        >
          {source}
        </pre>
      )}
      <div role="status" className="mt-2 text-sm text-neutral-600 empty:hidden dark:text-neutral-400">
        {status === 'failed' ? failedMessage : ''}
      </div>
    </div>
  )
}
