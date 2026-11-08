import { IntlWrapper } from '@/test/intl'
import { msg } from '@/test/render-intl'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen } from '@testing-library/react'
import { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderMarkdown } from '@/lib/markdown'
import { DARK_MEDIA_QUERY, THEME_STORAGE_KEY, ThemeToggle } from './ThemeToggle'

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const THEME_NAME = new RegExp(`^${escapeRe(msg('Site.shell.themeToggle.title', { current: 'system' }).split(':')[0] + ':')}`)

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

/**
 * jsdom's own matchMedia answers `matches: false` for every query and never changes,
 * so "follow the system" cannot be observed through it at all. This replaces it with
 * something whose answer the test chooses and can change afterwards.
 */
function stubSystem(dark: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const mql = {
    media: DARK_MEDIA_QUERY,
    matches: dark,
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener)
    },
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener)
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }
  const matchMedia = vi.fn(() => mql)
  vi.stubGlobal('matchMedia', matchMedia)
  return {
    matchMedia,
    /** The OS flipping to dark at sunset, with the page already open. */
    flip(next: boolean) {
      mql.matches = next
      act(() => {
        for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent)
      })
    },
    get listenerCount() {
      return listeners.size
    },
  }
}

function theme(): string | null {
  return document.documentElement.getAttribute('data-theme')
}

function stored(): string | null {
  return window.localStorage.getItem(THEME_STORAGE_KEY)
}

function toggle(): HTMLElement {
  return screen.getByRole('button', { name: THEME_NAME })
}

beforeEach(() => {
  document.documentElement.removeAttribute('data-theme')
  window.localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/* ------------------------------------------------------------------ *
 * The toggle
 * ------------------------------------------------------------------ */

describe('ThemeToggle', () => {
  it('starts at "system" and resolves it from the OS', () => {
    stubSystem(true)
    render(<ThemeToggle />)

    // The resolved value, not the choice: the attribute is always explicit so that
    // globals.css needs exactly one source of truth.
    expect(theme()).toBe('dark')
    expect(toggle()).toHaveAccessibleName(msg('Site.shell.themeToggle.label', { current: 'system', next: 'light' }))
    // "system" is the absence of the key, never the literal string.
    expect(stored()).toBeNull()
  })

  it('resolves system to light on a light OS', () => {
    stubSystem(false)
    render(<ThemeToggle />)

    expect(theme()).toBe('light')
  })

  it('cycles system → light → dark → system, moving data-theme each press', () => {
    stubSystem(true)
    render(<ThemeToggle />)
    const button = toggle()

    expect(theme()).toBe('dark') // system, on a dark OS

    act(() => button.click())
    expect(button).toHaveAccessibleName(msg('Site.shell.themeToggle.label', { current: 'light', next: 'dark' }))
    // The point of an explicit choice: it overrides the dark OS underneath.
    expect(theme()).toBe('light')
    expect(stored()).toBe('light')

    act(() => button.click())
    expect(button).toHaveAccessibleName(msg('Site.shell.themeToggle.label', { current: 'dark', next: 'system' }))
    expect(theme()).toBe('dark')
    expect(stored()).toBe('dark')

    act(() => button.click())
    expect(button).toHaveAccessibleName(msg('Site.shell.themeToggle.label', { current: 'system', next: 'light' }))
    // Back to the OS, and the key is removed rather than set to 'system'. Storing the
    // string would mean a reader who clears site data and a reader who picked
    // "system" are in different states for no reason.
    expect(stored()).toBeNull()
    expect(theme()).toBe('dark')
  })

  it('restores a stored choice on mount, over a disagreeing OS', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light')
    stubSystem(true)

    render(<ThemeToggle />)

    // This is the persistence assertion. The component's initial state is 'system'
    // for hydration safety, so without the mount effect reading storage this would be
    // 'dark' and the reader's saved choice would be lost on every page load.
    expect(theme()).toBe('light')
    expect(toggle()).toHaveAccessibleName(msg('Site.shell.themeToggle.label', { current: 'light', next: 'dark' }))
  })

  it('ignores a junk value in storage instead of writing it to the attribute', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'sepia')
    stubSystem(true)

    render(<ThemeToggle />)

    // data-theme must only ever be light or dark; anything else silently disables
    // every dark: utility and the Shiki override at once.
    expect(theme()).toBe('dark')
    expect(toggle()).toHaveAccessibleName(msg('Site.shell.themeToggle.label', { current: 'system', next: 'light' }))
  })

  it('follows the OS while the choice is system, and stops once a choice is made', () => {
    const system = stubSystem(false)
    render(<ThemeToggle />)

    expect(theme()).toBe('light')

    system.flip(true)
    // Without the matchMedia listener the attribute would stay at whatever it
    // resolved to on load, which is precisely what "follow the system" promises not
    // to do.
    expect(theme()).toBe('dark')

    act(() => toggle().click()) // → light, an explicit choice
    expect(theme()).toBe('light')

    system.flip(false)
    system.flip(true)
    // The OS no longer gets a vote, and the listener has been torn down.
    expect(theme()).toBe('light')
    expect(system.listenerCount).toBe(0)
  })

  it('survives localStorage throwing on read', () => {
    stubSystem(true)
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError: storage denied')
      },
      setItem: () => {},
      removeItem: () => {},
    })

    // A Safari private window. Unwrapped, this throws inside the mount effect and
    // React unmounts the tree — the header loses its toggle, on the readers least
    // able to report why.
    expect(() => render(<ThemeToggle />)).not.toThrow()
    expect(theme()).toBe('dark')
  })

  it('survives localStorage throwing on write, and still applies the choice', () => {
    stubSystem(false)
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => {},
    })

    render(<ThemeToggle />)
    expect(() => act(() => toggle().click())).not.toThrow()
    // Persistence is lost; the choice still applies for this page view. Losing the
    // toggle entirely would be the worse trade.
    expect(theme()).toBe('light')
  })

  it('a 44px cell below md and the 36px cell from md, with a hit area of its own: the same mold as the search slot beside it', () => {
    stubSystem(false)
    render(<ThemeToggle />)

    // 44px on a phone (four slots and the gaps use 188 of the 288px of a 320px phone), 36px from md where the header is one row.
    expect(toggle()).toHaveClass('h-11', 'w-11', 'md:h-9', 'md:w-9')
    // A transparent ::after extending 4px on each side, taking no room (absolute).
    expect(toggle()).toHaveClass('relative', 'after:absolute', 'after:-inset-1')
  })

  it('is an icon-only control with a name that carries its state', () => {
    stubSystem(false)
    render(<ThemeToggle />)
    const button = toggle()

    expect(button.tagName).toBe('BUTTON')
    // type="button" and not the default "submit": dropped into a form (the search
    // box, later) a submit button would navigate on click instead of toggling.
    expect(button).toHaveAttribute('type', 'button')
    // The svg must not contribute a second name.
    expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(button.textContent).toBe('')
    expect(button).toHaveAccessibleName(new RegExp(escapeRe(msg('Site.shell.themeToggle.title', { current: 'system' }))))
  })
})

/* ------------------------------------------------------------------ *
 * In
 * ------------------------------------------------------------------ *
 * Print is always light: light text on white paper is the only thing the dark theme can print. Not via CSS —
 * globals.css has no rule by prefers-color-scheme and no `color-scheme` in a media query
 * (the describe below, app/globals.test.ts) — but via the theme's own source of truth: the
 * data-theme attribute, changed at `beforeprint` and restored at `afterprint`.
 */

function firePrint(event: 'beforeprint' | 'afterprint') {
  act(() => {
    window.dispatchEvent(new Event(event))
  })
}

describe('ThemeToggle: in', () => {
  it('"dark": prints light, back to dark after printing; the saved choice and the button name do not change', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    stubSystem(false)
    render(<ThemeToggle />)
    expect(theme()).toBe('dark')

    firePrint('beforeprint')
    expect(theme()).toBe('light')
    // Only what is drawn changes: no storage write, the button still says the reader's choice.
    expect(stored()).toBe('dark')
    expect(toggle()).toHaveAccessibleName(msg('Site.shell.themeToggle.label', { current: 'dark', next: 'system' }))

    firePrint('afterprint')
    expect(theme()).toBe('dark')
  })

  it('"system" on a dark machine: prints light, follows the OS again after printing', () => {
    stubSystem(true)
    render(<ThemeToggle />)
    expect(theme()).toBe('dark')

    firePrint('beforeprint')
    expect(theme()).toBe('light')
    firePrint('afterprint')
    expect(theme()).toBe('dark')
    expect(stored()).toBeNull()
  })

  it('"light": stays light during printing and after', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light')
    stubSystem(true)
    render(<ThemeToggle />)

    firePrint('beforeprint')
    expect(theme()).toBe('light')
    firePrint('afterprint')
    expect(theme()).toBe('light')
  })

  it('change the choice and then print: after printing returns to the NEW choice, not the choice at mount', () => {
    stubSystem(false)
    render(<ThemeToggle />)
    act(() => toggle().click()) // → light
    act(() => toggle().click()) // → dark
    expect(theme()).toBe('dark')

    firePrint('beforeprint')
    expect(theme()).toBe('light')
    firePrint('afterprint')
    expect(theme()).toBe('dark')
  })

  it('removes the listener on unmount: a later print does not touch data-theme', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    stubSystem(false)
    const { unmount } = render(<ThemeToggle />)
    unmount()

    firePrint('beforeprint')
    expect(theme()).toBe('dark')
  })
})

/* ------------------------------------------------------------------ *
 * The inline boot script in components/RootShell.tsx
 * ------------------------------------------------------------------ *
 * This is the piece that prevents the flash of the wrong theme, and it is a string
 * inside a dangerouslySetInnerHTML — invisible to the type checker, to lint and to
 * every component test. It is extracted from the real file and executed, because a
 * typo in it is a visible defect on every page load and nothing else would catch it.
 */

const layoutSource = readFileSync(resolve(process.cwd(), 'components/RootShell.tsx'), 'utf8')

function bootScript(): string {
  const match = /const THEME_BOOT_SCRIPT = `([^`]*)`/.exec(layoutSource)
  if (!match?.[1]) throw new Error('THEME_BOOT_SCRIPT not found in components/RootShell.tsx')
  return match[1]
}

function runBootScript(): void {
  new Function(bootScript())()
}

describe('the inline theme boot script', () => {
  it('is wired into the document head as an inline script', () => {
    expect(layoutSource).toMatch(/<script\s+dangerouslySetInnerHTML=\{\{\s*__html:\s*THEME_BOOT_SCRIPT/)
    // In <head>, not at the end of <body>: after the body has started parsing, the
    // first paint may already have happened and the flash is back.
    const head = /<head>([\s\S]*?)<\/head>/.exec(layoutSource)?.[1] ?? ''
    expect(head).toContain('THEME_BOOT_SCRIPT')
  })

  it('reads the same storage key the toggle writes', () => {
    // The two halves of the contract live in different files. If they drift, the page
    // paints one theme and the toggle reports another, with no error anywhere.
    expect(bootScript()).toContain(`"${THEME_STORAGE_KEY}"`)
  })

  it('resolves an absent choice from the OS before anything renders', () => {
    stubSystem(true)
    runBootScript()

    expect(theme()).toBe('dark')
  })

  it('prefers a stored choice over the OS', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light')
    stubSystem(true)
    runBootScript()

    expect(theme()).toBe('light')
  })

  it('only ever writes light or dark, never the junk it read', () => {
    for (const junk of ['system', 'sepia', '', 'DARK']) {
      window.localStorage.setItem(THEME_STORAGE_KEY, junk)
      stubSystem(false)
      runBootScript()
      expect(theme(), `stored ${JSON.stringify(junk)}`).toBe('light')
      vi.unstubAllGlobals()
    }
  })

  it('still resolves from the OS when localStorage throws', () => {
    stubSystem(true)
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError: storage denied')
      },
    })

    // The nested try/catch is what this pins. With a single outer catch the storage
    // throw aborts the whole statement, the attribute is never set, and a private
    // window on a dark machine gets a white page — the storage failure would have
    // cost the reader the system default too.
    expect(() => runBootScript()).not.toThrow()
    expect(theme()).toBe('dark')
  })

  it('does not throw in an environment with no matchMedia at all', () => {
    vi.stubGlobal('matchMedia', undefined)

    // An uncaught error in a <head> script aborts the rest of it. Here there is
    // nothing after, but the outer catch is why a future second statement would still
    // run.
    expect(() => runBootScript()).not.toThrow()
  })
})

/* ------------------------------------------------------------------ *
 * The CSS contract
 * ------------------------------------------------------------------ *
 * jsdom does not run Tailwind, so there is no way to assert a computed colour here —
 * and it does not even apply author stylesheets to getComputedStyle (measured: an
 * `!important` rule from a <style> tag loses to an inline style). What it DOES have is
 * a real CSS parser and a real selector engine, so the questions that can be answered
 * honestly are "which rule exists, under which condition" and "does that rule's
 * selector match this element" — which together are the regression that matters.
 */

const globalsCss = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8')

/** Comments in this file talk ABOUT prefers-color-scheme at length; a raw-text search
 *  would hit the prose. Strip them so the text assertions see only declarations. */
const globalsCssCode = globalsCss.replace(/\/\*[\s\S]*?\*\//g, '')

type FlatRule = { selector: string; cssText: string; conditions: string[] }

function parseGlobalsCss(): { rules: FlatRule[]; conditions: string[] } {
  const style = document.createElement('style')
  style.textContent = globalsCss
  document.head.append(style)

  const rules: FlatRule[] = []
  const conditions: string[] = []

  const walk = (list: CSSRuleList, inherited: string[]) => {
    for (const rule of Array.from(list)) {
      const condition = (rule as CSSMediaRule).conditionText
      const scope = condition ? [...inherited, condition] : inherited
      if (condition) conditions.push(condition)

      const selector = (rule as CSSStyleRule).selectorText
      if (typeof selector === 'string' && 'style' in rule) {
        rules.push({ selector, cssText: rule.cssText, conditions: scope })
      }

      const nested = (rule as CSSGroupingRule).cssRules
      if (nested) walk(nested, scope)
    }
  }
  walk(style.sheet!.cssRules, [])

  style.remove()
  return { rules, conditions }
}

async function shikiFence(): Promise<string> {
  const { content } = await renderMarkdown('```java\npublic class A {\n  int x = 1;\n}\n```\n')
  return renderToStaticMarkup(<IntlWrapper>{content as never}</IntlWrapper>)
}

describe('globals.css: dark mode is driven by data-theme, not the media query', () => {
  it('redefines the dark variant so every dark: utility follows the attribute', () => {
    // Without this line Tailwind 4's `dark:` compiles to
    // @media (prefers-color-scheme: dark) and every dark: utility already in the tree
    // ignores the toggle — a reader on a dark OS who picks "light" gets light chrome
    // with dark cards. There is no way to observe the compiled output from jsdom, so
    // the declaration itself is what is pinned.
    // The selector is the part between the first `(` and the final `);` of the line: it contains nested parentheses
    // (`:not(:where(...))`), so `[^)]*` cannot capture it.
    const variant = /@custom-variant\s+dark\s*\((.*)\)\s*;/.exec(globalsCssCode)
    expect(variant, '@custom-variant dark is missing from app/globals.css').not.toBeNull()
    expect(variant![1]).toContain('[data-theme="dark"]')
    // :where() keeps the variant at zero specificity. A bare `[data-theme="dark"] &`
    // adds 0,1,0 to every dark: utility and they start winning cascade fights the
    // plain utilities used to lose.
    expect(variant![1]).toContain(':where(')
  })

  it('dark variant: not applied inside the admin frame (data-admin), and still specificity 0', () => {
    // The admin has a single theme, light. Components shared with the site (cover art, PostCover) carry
    // `dark:` classes; the exclusion lives in the variant so every such class stays out of the admin together.
    const variant = /@custom-variant\s+dark\s*\((.*)\)\s*;/.exec(globalsCssCode)!
    const selector = variant[1]!.replaceAll('&', '.probe')
    document.body.innerHTML =
      '<div id="site"><span class="probe"></span></div>' +
      '<div data-admin=""><div id="admin"><span class="probe"></span></div></div>'
    document.documentElement.setAttribute('data-theme', 'dark')

    expect(document.querySelector('#site .probe')!.matches(selector)).toBe(true)
    expect(document.querySelector('#admin .probe')!.matches(selector)).toBe(false)
    // Adds no specificity: the exclusion sits inside :where().
    expect(variant[1]).toMatch(/:not\(:where\(/)

    document.documentElement.setAttribute('data-theme', 'light')
    expect(document.querySelector('#site .probe')!.matches(selector)).toBe(false)

    document.documentElement.removeAttribute('data-theme')
    document.body.innerHTML = ''
  })

  it('leaves no rule in the file keyed on prefers-color-scheme', () => {
    const { conditions } = parseGlobalsCss()

    // Two rules disagreeing is worse than one wrong rule: the same selector with the
    // same !important under both a media query and the attribute is resolved by
    // source order, so the loser is ignored unconditionally and the bug only shows
    // for half the readers.
    expect(
      conditions.filter((c) => c.includes('prefers-color-scheme')),
      'the attribute is the single source of truth for the active theme',
    ).toEqual([])
  })

  it('has exactly one Shiki dark override, outside any media query', () => {
    const { rules } = parseGlobalsCss()
    const overrides = rules.filter((r) => r.selector.includes('.shiki') && r.cssText.includes('--shiki-dark'))

    expect(overrides).toHaveLength(1)
    expect(overrides[0]!.conditions).toEqual([])
    // Quote-agnostic: the CSS parser normalises [data-theme="dark"] to single quotes
    // on the way back out, so an exact-string match here would be asserting a jsdom
    // implementation detail rather than the selector.
    expect(overrides[0]!.selector).toMatch(/\[data-theme=['"]?dark['"]?\]/)
    expect(overrides[0]!.cssText).toContain('--shiki-dark-bg')
  })

  it('keeps !important on the override, which is the only reason it wins', () => {
    // Shiki puts the light colours in an INLINE style attribute on every token. An
    // author rule without !important cannot beat an inline style, so dropping it
    // leaves every code block light in dark mode while the selector still looks right.
    expect(globalsCssCode).toContain('color: var(--shiki-dark) !important')
    expect(globalsCssCode).toContain('background-color: var(--shiki-dark-bg) !important')
  })

  it('applies the dark override to a real highlighted fence under data-theme="dark"', async () => {
    const { rules } = parseGlobalsCss()
    const override = rules.find((r) => r.selector.includes('.shiki') && r.cssText.includes('--shiki-dark'))!

    document.body.innerHTML = await shikiFence()
    const pre = document.querySelector('pre.shiki')!
    const tokens = Array.from(document.querySelectorAll('.shiki span'))

    // Sanity: this really is dual-theme Shiki output, with light colours inline and
    // the dark ones parked in custom properties for the swap below to pick up.
    expect(tokens.length).toBeGreaterThan(2)
    expect(pre.getAttribute('style')).toContain('--shiki-dark-bg')
    expect(tokens.some((t) => t.getAttribute('style')?.includes('--shiki-dark'))).toBe(true)

    document.documentElement.setAttribute('data-theme', 'dark')
    expect(pre.matches(override.selector)).toBe(true)
    expect(tokens.every((t) => t.matches(override.selector))).toBe(true)

    // And the other direction, which is the half that a prefers-color-scheme rule
    // gets wrong: an explicit "light" on a dark machine must leave the code light.
    document.documentElement.setAttribute('data-theme', 'light')
    expect(pre.matches(override.selector)).toBe(false)
    expect(tokens.some((t) => t.matches(override.selector))).toBe(false)

    document.documentElement.removeAttribute('data-theme')
    expect(tokens.some((t) => t.matches(override.selector))).toBe(false)
  })

  it('does not apply dark-theme-only rules inside the admin frame (data-admin), always light', async () => {
    // The admin frame is always light. Before, the admin "Preview" (preview) still matched the three rules below when the
    // site theme was dark: a dark code block, a near-black image border, a neutral-400 caption on a white background
    // (2.58:1). The same markup matches outside the admin frame and must not match inside it.
    const { rules } = parseGlobalsCss()
    const darkOnly = (needle: string) =>
      rules.find((r) => r.selector.includes(needle) && /\[data-theme=['"]?dark['"]?\]/.test(r.selector))!
    const shiki = darkOnly('.shiki')
    const figureImg = darkOnly('figure img')
    const caption = darkOnly('figcaption')

    const fence = await shikiFence()
    const figure = '<figure><img src="/images/x.svg" alt=""><figcaption>Caption</figcaption></figure>'
    document.body.innerHTML =
      `<div id="site" class="prose">${fence}${figure}</div>` +
      `<div data-admin=""><div id="admin" class="prose">${fence}${figure}</div></div>`
    document.documentElement.setAttribute('data-theme', 'dark')

    for (const [id, expected] of [
      ['site', true],
      ['admin', false],
    ] as const) {
      const scope = document.getElementById(id)!
      expect(scope.querySelector('pre.shiki')!.matches(shiki.selector), `${id} pre`).toBe(expected)
      expect(scope.querySelector('pre.shiki span')!.matches(shiki.selector), `${id} span`).toBe(expected)
      expect(scope.querySelector('figure img')!.matches(figureImg.selector), `${id} img`).toBe(expected)
      expect(scope.querySelector('figcaption')!.matches(caption.selector), `${id} figcaption`).toBe(expected)
    }

    document.documentElement.removeAttribute('data-theme')
    document.body.innerHTML = ''
  })
})
