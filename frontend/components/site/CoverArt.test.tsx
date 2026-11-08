import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { ART_INKS, composeCover, coverInputOf, seriesCoverInput, type CoverInput } from '@/lib/cover-art'
import { CoverArt } from './CoverArt'

/**
 * CoverArt is the on-page drawing of lib/cover-art: inline SVG rendered on the server, the theme switched
 * by plain CSS. The ink colors live in variables of the <svg> tag itself, the two
 * `.cover-art` rules in globals.css choose the light or dark set, shapes are filled with literal classes — no
 * `fill="var(...)"` on an attribute and no id.
 */

const PIPE = { slug: 'series-e', position: 1 }
/** eclipse, teal, flipped (golden in lib/cover-art.test.ts). */
const QUEUE: CoverInput = coverInputOf({ slug: 'sample-post-05-cedar', category: { slug: 'kien-truc' }, series: PIPE })
/** sampler, teal, not flipped. */
const HOPS: CoverInput = coverInputOf({
  slug: 'sample-post-12-amber',
  category: { slug: 'kien-truc' },
  series: { ...PIPE, position: 3 },
})

function svgOf(input: CoverInput, className?: string): SVGSVGElement {
  const { container } = render(<CoverArt input={input} className={className} />)
  const svgs = container.querySelectorAll('svg')
  expect(svgs).toHaveLength(1)
  // Nothing wraps the <svg>: the frame (border, rounded corners, ratio) belongs to the caller.
  expect(container.firstElementChild).toBe(svgs[0])
  return svgs[0]!
}

/** `style="--ink-l:#…;--ink-d:#…"` → { '--ink-l': '#…', … } */
function styleVars(svg: SVGSVGElement): Record<string, string> {
  const out: Record<string, string> = {}
  for (const decl of (svg.getAttribute('style') ?? '').split(';')) {
    const i = decl.indexOf(':')
    if (i > 0) out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim()
  }
  return out
}

const classesOf = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)

describe('CoverArt', () => {
  it('is a decorative <svg>: aria-hidden, focusable="false", no text, no id', () => {
    const svg = svgOf(QUEUE)

    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg).toHaveAttribute('focusable', 'false')
    expect(svg).not.toHaveAttribute('role')
    expect(svg).not.toHaveAttribute('aria-label')
    // The title right next to it already says what the post is; text inside the drawing is not translated and cannot reflow.
    expect(svg.querySelector('text, title, desc, p, foreignObject')).toBeNull()
    expect(svg.textContent).toBe('')
    // No id: the same post can appear twice on one page (list + related).
    expect(svg).not.toHaveAttribute('id')
    expect(svg.querySelector('[id]')).toBeNull()
    // A real drawing: an empty <svg> would still pass every assert above.
    expect(svg.querySelectorAll('rect, circle, path').length).toBeGreaterThan(4)
  })

  it('2:1 canvas cropped with slice, so the CSS frame of the caller decides the visible part', () => {
    const svg = svgOf(QUEUE)
    expect(svg).toHaveAttribute('viewBox', '0 0 480 240')
    expect(svg).toHaveAttribute('preserveAspectRatio', 'xMidYMid slice')
    expect(classesOf(svg)).toEqual(expect.arrayContaining(['cover-art', 'block', 'h-full', 'w-full']))
  })

  it('carries all six light/dark ink variables of exactly the ink the cover was assigned', () => {
    const svg = svgOf(QUEUE)
    const spec = composeCover(QUEUE)
    const shades = ART_INKS[spec.ink]

    expect(classesOf(svg)).toContain('cover-art')
    expect(styleVars(svg)).toEqual({
      '--ink-l': shades.light.ink,
      '--ink-d': shades.dark.ink,
      '--tint-l': shades.light.tint,
      '--tint-d': shades.dark.tint,
      '--deep-l': shades.light.deep,
      '--deep-d': shades.dark.deep,
    })
  })

  it('no fill/stroke="var(...)": ink shapes are filled with the literal class fill-(--ink|--tint|--deep)', () => {
    const html = renderToStaticMarkup(<CoverArt input={QUEUE} />)
    expect(html).not.toMatch(/(fill|stroke)="var\(/)
    expect(html).not.toContain('var(--art-')

    const svg = svgOf(QUEUE)
    const spec = composeCover(QUEUE)
    for (const role of ['ink', 'tint', 'deep'] as const) {
      const expected = spec.shapes.filter((s) => 'fill' in s && s.fill === role).length
      expect(svg.querySelectorAll(`[class~="fill-(--${role})"]`), role).toHaveLength(expected)
    }
    // eclipse has an ink disc: at least one shape is filled with a variable.
    expect(svg.querySelectorAll('[class~="fill-(--ink)"]').length).toBeGreaterThan(0)
    // `fill="none"` is set once, on the <svg>, and inherited down to the strokes; no child element
    // writes a color straight into a fill or stroke attribute — color only comes from classes.
    expect(svg).toHaveAttribute('fill', 'none')
    expect(svg.querySelectorAll('[fill], [stroke]')).toHaveLength(0)
  })

  it('paper, crosshair, strokes and nodes use the existing neutral utilities, strokes always 1px non-scaling', () => {
    const svg = svgOf(HOPS)
    const [paper, crosses] = Array.from(svg.children)

    expect(paper!.tagName).toBe('rect')
    expect(classesOf(paper!)).toEqual(['fill-neutral-100', 'dark:fill-neutral-900'])
    expect(crosses!.tagName).toBe('path')
    expect(classesOf(crosses!)).toEqual(['stroke-neutral-300', 'dark:stroke-neutral-700'])

    // fill and stroke-width are inherited properties: set once on the <svg>. vector-effect is
    // not inherited, so it must be on every stroke.
    expect(svg).toHaveAttribute('fill', 'none')
    expect(svg).toHaveAttribute('stroke-width', '1')
    const stroked = Array.from(svg.querySelectorAll('[class~="stroke-neutral-800"]'))
    expect(stroked.length).toBeGreaterThan(0)
    for (const el of [crosses!, ...stroked]) {
      // Exactly 1 CSS px at every size, like the site hairline, even when the canvas is zoomed or cropped.
      expect(el).toHaveAttribute('vector-effect', 'non-scaling-stroke')
      expect(el, 'a stroke that sets its own width is no longer a hairline').not.toHaveAttribute('stroke-width')
    }
    for (const el of stroked) expect(classesOf(el)).toContain('dark:stroke-neutral-200')

    // The hatching is the fainter stroke: exactly the number of 'hatching' elements in the spec carry stroke-opacity.
    const hatching = composeCover(HOPS).shapes.filter((s) => s.k === 'hatch').length
    expect(svg.querySelectorAll('[stroke-opacity="0.55"]')).toHaveLength(hatching)

    const nodes = Array.from(svg.querySelectorAll('[class~="fill-neutral-800"]'))
    expect(nodes.length).toBeGreaterThan(0)
    for (const el of nodes) expect(classesOf(el)).toEqual(['fill-neutral-800', 'dark:fill-neutral-200'])
  })

  it('every class in the markup appears verbatim in the source (Tailwind only generates CSS for strings it sees)', () => {
    const source = readFileSync(join(process.cwd(), 'components/site/CoverArt.tsx'), 'utf8')
    const tokens = new Set<string>()
    for (const input of [QUEUE, HOPS, seriesCoverInput({ slug: 'series-f' })]) {
      const html = renderToStaticMarkup(<CoverArt input={input} />)
      for (const [, value] of html.matchAll(/class="([^"]*)"/g)) for (const t of value!.split(/\s+/)) if (t) tokens.add(t)
    }
    expect(tokens.size).toBeGreaterThan(8)
    for (const t of tokens) expect(source, `"${t}" does not appear verbatim in CoverArt.tsx`).toContain(t)
  })

  it('flips horizontally with exactly one group, and only when the cover is flipped', () => {
    expect(composeCover(QUEUE).mirror).toBe(true)
    expect(composeCover(HOPS).mirror).toBe(false)

    const mirrored = svgOf(QUEUE)
    expect(mirrored.querySelectorAll('g')).toHaveLength(1)
    expect(mirrored.querySelector('g')).toHaveAttribute('transform', 'matrix(-1 0 0 1 480 0)')
    // The whole recipe drawing sits in the flip group; the paper and crosshair do not (the grid is symmetric).
    expect(mirrored.querySelector('g')!.children).toHaveLength(composeCover(QUEUE).shapes.length)

    // A cover that is not flipped: no empty group.
    expect(svgOf(HOPS).querySelectorAll('g')).toHaveLength(0)
  })

  it('adds the class of the caller', () => {
    const svg = svgOf(QUEUE, 'opacity-90')
    expect(classesOf(svg)).toEqual(expect.arrayContaining(['cover-art', 'opacity-90']))
  })

  it('compact: each cover of the 12 sample posts under 2 KB of markup, average under 1.7 KB', () => {
    // Sizes are 1.05-1.84 KB, average 1.53 KB; ten covers are about 15 KB raw, 1.8 KB gzip. This budget catches a change that
    // bloats the markup (for example putting fill/stroke-width back on every stroke), it is not meant to force a number.
    const slugs = [
      ['sample-post-12-amber', 'kien-truc'],
      ['sample-post-11', 'kien-truc'],
      ['sample-post-10-amber', 'go-loi'],
      ['sample-post-07-ember', 'kiem-thu'],
      ['sample-post-06', 'cach-toi-lam-viec'],
      ['sample-post-05-cedar', 'kien-truc'],
      ['sample-post-04', 'kien-truc'],
      ['sample-post-03', 'cach-toi-lam-viec'],
      ['sample-post-01-harbor', 'cach-toi-lam-viec'],
      ['sample-post-09', 'ky-thuat-frontend'],
      ['sample-post-08', 'ky-thuat-backend'],
      ['sample-post-02', 'cach-toi-lam-viec'],
    ] as const
    const sizes = slugs.map(([slug, category]) =>
      Buffer.byteLength(renderToStaticMarkup(<CoverArt input={coverInputOf({ slug, category: { slug: category } })} />)),
    )
    // Not a request at all, but HTML repeated on every row of every list.
    expect(Math.max(...sizes)).toBeLessThan(2048)
    const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length
    expect(mean).toBeLessThan(1700)
  })

  it('is a server component: no "use client", no hooks, no JS to the browser', () => {
    const source = readFileSync(join(process.cwd(), 'components/site/CoverArt.tsx'), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/['"]use client['"]/)
    expect(code).not.toMatch(/\buse[A-Z]\w*\s*\(/)
  })
})

/*
 * The two `.cover-art` rules in globals.css are the other half of the theme: CoverArt only sets the -l/-d
 * variables, these two rules choose which set becomes --ink/--tint/--deep. jsdom does not run Tailwind and does not
 * compute styles (see ThemeToggle.test.tsx), but it has a CSS parser and a real selector matcher,
 * so it can answer two questions correctly: which rules exist, under what condition, and whether the selector matches the <svg>
 * under that theme.
 */
describe('globals.css: exactly two .cover-art rules, by data-theme', () => {
  const css = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8')

  type Found = { selector: string; conditions: string[]; text: string }

  function coverArtRules(): Found[] {
    const style = document.createElement('style')
    style.textContent = css
    document.head.append(style)
    const found: Found[] = []
    const walk = (list: CSSRuleList, inherited: string[]) => {
      for (const rule of Array.from(list)) {
        const condition = (rule as CSSMediaRule).conditionText
        const scope = condition ? [...inherited, condition] : inherited
        const selector = (rule as CSSStyleRule).selectorText
        if (typeof selector === 'string' && selector.includes('cover-art')) {
          found.push({ selector, conditions: scope, text: rule.cssText.replace(/\s+/g, '') })
        }
        const nested = (rule as CSSGroupingRule).cssRules
        if (nested) walk(nested, scope)
      }
    }
    walk(style.sheet!.cssRules, [])
    style.remove()
    return found
  }

  afterEach(() => document.documentElement.removeAttribute('data-theme'))

  it('exactly two rules, not inside any media query', () => {
    const rules = coverArtRules()
    expect(rules.map((r) => r.selector)).toHaveLength(2)
    for (const r of rules) expect(r.conditions).toEqual([])
    // No prefers-color-scheme anywhere: data-theme is the single source of truth.
    expect(css.replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain('prefers-color-scheme')
  })

  it('the base rule chooses the light set, the [data-theme=dark] rule chooses the dark set', () => {
    const rules = coverArtRules()
    const base = rules.find((r) => r.selector === '.cover-art')
    const dark = rules.find((r) => /\[data-theme=['"]?dark['"]?\]\s*\.cover-art/.test(r.selector))

    expect(base, 'missing .cover-art rule').toBeDefined()
    expect(dark, "missing [data-theme='dark'] .cover-art rule").toBeDefined()
    for (const role of ['ink', 'tint', 'deep']) {
      expect(base!.text).toContain(`--${role}:var(--${role}-l)`)
      expect(dark!.text).toContain(`--${role}:var(--${role}-d)`)
      expect(base!.text).not.toContain(`var(--${role}-d)`)
    }
  })

  it('the dark selector matches a real cover only when <html data-theme="dark">', () => {
    const rules = coverArtRules()
    const base = rules.find((r) => r.selector === '.cover-art')!
    const dark = rules.find((r) => r.selector !== '.cover-art')!
    document.body.innerHTML = renderToStaticMarkup(<CoverArt input={QUEUE} />)
    const svg = document.querySelector('svg')!

    document.documentElement.setAttribute('data-theme', 'dark')
    expect(svg.matches(dark.selector)).toBe(true)
    expect(svg.matches(base.selector)).toBe(true)

    document.documentElement.setAttribute('data-theme', 'light')
    expect(svg.matches(dark.selector)).toBe(false)
    expect(svg.matches(base.selector)).toBe(true)
  })

  it('inside the admin frame (data-admin) the cover always uses the light ink set, even when the site is in the dark theme', () => {
    const rules = coverArtRules()
    const base = rules.find((r) => r.selector === '.cover-art')!
    const dark = rules.find((r) => r.selector !== '.cover-art')!
    document.body.innerHTML = `<div data-admin="">${renderToStaticMarkup(<CoverArt input={QUEUE} />)}</div>`
    const svg = document.querySelector('svg')!

    document.documentElement.setAttribute('data-theme', 'dark')
    expect(svg.matches(dark.selector)).toBe(false)
    expect(svg.matches(base.selector)).toBe(true)
  })
})
