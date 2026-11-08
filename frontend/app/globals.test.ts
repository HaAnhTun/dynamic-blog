import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HEADING_SCROLL_MARGIN_PX } from '@/lib/toc'

/**
 * The rules of app/globals.css added for the code-copy strip: the strip reserved for the "copy code" button at the top of a code block
 * and the `color-scheme` that follows the site theme.
 *
 * Same approach as components/site/ThemeToggle.test.tsx and CoverArt.test.tsx: jsdom does not run Tailwind and
 * does not compute styles from a stylesheet, but it has a real CSS parser and selector matcher. The question that can be
 * answered is "which rule exists, under which condition, and does its selector match this element".
 */

const css = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8')

type FlatRule = { selector: string; cssText: string; conditions: string[] }

function parseGlobalsCss(): FlatRule[] {
  const style = document.createElement('style')
  style.textContent = css
  document.head.append(style)

  const rules: FlatRule[] = []
  const walk = (list: CSSRuleList, inherited: string[]) => {
    for (const rule of Array.from(list)) {
      const condition = (rule as CSSMediaRule).conditionText
      const scope = condition ? [...inherited, condition] : inherited
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
  return rules
}

/** The declared value of a property in the cssText of a rule, or undefined. */
function declared(rule: FlatRule, property: string): string | undefined {
  const match = new RegExp(`(?:^|[;{\\s])${property}\\s*:\\s*([^;}]+)`).exec(rule.cssText)
  return match?.[1]?.trim()
}

afterEach(() => {
  document.documentElement.removeAttribute('data-theme')
  document.body.innerHTML = ''
})

describe('globals.css: the strip of the "copy code" button at the top of a code block', () => {
  const bandRules = () => parseGlobalsCss().filter((rule) => rule.selector.includes('[data-code-block]'))

  function block(): HTMLPreElement {
    document.body.innerHTML =
      '<article class="prose"><div data-code-block="" class="relative"><pre class="shiki">x</pre></div></article>' +
      '<article class="prose"><pre id="ngoai">y</pre></article>'
    return document.querySelector('[data-code-block] > pre')!
  }

  it('pushes the first code line below the button: 2.75rem (40px button) on phones, 2.25rem (32px button) from 40rem', () => {
    const pre = block()
    const rules = bandRules().filter((rule) => declared(rule, 'padding-top') !== undefined)

    const base = rules.find((rule) => rule.conditions.length === 0)
    // Choose by condition, not by "the first conditional rule": there is also a `print` rule that returns the
    // strip to normal when printing (describe "when printing" below).
    const wide = rules.find((rule) => rule.conditions.length === 1 && /min-width/.test(rule.conditions[0]!))
    expect(base, 'missing padding-top rule for [data-code-block] > pre').toBeDefined()
    expect(wide, 'missing padding-top rule from 40rem').toBeDefined()
    expect(declared(base!, 'padding-top')).toBe('2.75rem')
    expect(declared(wide!, 'padding-top')).toBe('2.25rem')
    // 40rem is Tailwind 4 `sm`: the same breakpoint as the button `sm:h-8` (CopyCodeButton.tsx).
    expect(wide!.conditions[0]).toMatch(/min-width:\s*40rem/)

    // Matches the <pre> inside the frame, and touches no other <pre> in the post (the frame only wraps code blocks).
    expect(pre.matches(base!.selector)).toBe(true)
    expect(document.getElementById('ngoai')!.matches(base!.selector)).toBe(false)
  })

  it('beats `.prose pre { padding: 1rem }` by specificity, not by order', () => {
    // Both are out-of-layer rules, so a Tailwind utility class on <pre> (in @layer utilities)
    // can never beat `.prose pre`. The strip has to live here, with a more specific selector.
    const base = bandRules().find((rule) => rule.conditions.length === 0 && declared(rule, 'padding-top'))!
    expect(base.selector.replace(/\s+/g, ' ')).toBe('.prose [data-code-block] > pre')
  })
})

describe('globals.css: color-scheme follows the site theme', () => {
  /** The rules that declare `color-scheme`, in file order. */
  const schemeRules = () => parseGlobalsCss().filter((rule) => declared(rule, 'color-scheme') !== undefined)

  /**
   * The `color-scheme` of <html> by the rules of the file: the last matching rule wins. Correct for these rules
   * because each later rule is at least as specific as the one before (the last test of this describe guards that).
   */
  function rootScheme(): string | undefined {
    const html = document.documentElement
    return schemeRules()
      .filter((rule) => html.matches(rule.selector))
      .map((rule) => declared(rule, 'color-scheme'))
      .at(-1)
  }

  it('light theme (and a page that has not run JS yet, with no data-theme): light', () => {
    expect(rootScheme()).toBe('light')
    document.documentElement.setAttribute('data-theme', 'light')
    expect(rootScheme()).toBe('light')
  })

  it('dark theme: dark — scrollbars, inputs, checkboxes and the canvas background are drawn dark', () => {
    document.documentElement.setAttribute('data-theme', 'dark')
    expect(rootScheme()).toBe('dark')
  })

  it('an admin page (with the data-admin frame) is always light, even when the site theme is dark', () => {
    // The admin frame carries [color-scheme:light] for its own tree, but the page scrollbar and canvas
    // belong to <html>: without this rule, the admin of someone with a dark theme gets a dark scrollbar on a white background.
    document.documentElement.setAttribute('data-theme', 'dark')
    document.body.innerHTML = '<div data-admin=""><main>Admin</main></div>'
    expect(rootScheme()).toBe('light')

    document.documentElement.setAttribute('data-theme', 'light')
    expect(rootScheme()).toBe('light')
  })

  it('no rule sits in a media query: data-theme is the single source of truth', () => {
    const rules = schemeRules()
    expect(rules.length).toBeGreaterThanOrEqual(3)
    for (const rule of rules) expect(rule.conditions, rule.selector).toEqual([])
    // No `light dark` on the public site: declaring both lets the browser follow the OS, the opposite of the toggle.
    for (const rule of rules) expect(declared(rule, 'color-scheme'), rule.selector).not.toMatch(/\s/)
  })

  it('order in the file goes with specificity: :root, then [data-theme=dark], then the admin rule', () => {
    const selectors = schemeRules().map((rule) => rule.selector)
    expect(selectors).toHaveLength(3)
    expect(selectors[0]).toBe(':root')
    expect(selectors[1]).toMatch(/^\[data-theme=['"]?dark['"]?\]$/)
    // :root:has([data-admin]) = (0,2,0) > (0,1,0): it beats the dark rule even if the order changes.
    expect(selectors[2]).toBe(':root:has([data-admin])')
  })
})

/**
 * The print version of a post. Header, footer, share row, like button, comments, PostNav, related posts,
 * "Read next" and the table of contents carry `print:hidden` on their own component; the light theme when printing is
 * ThemeToggle's job (beforeprint/afterprint), not CSS here — this file has no rule by
 * prefers-color-scheme, and every `color-scheme` sits outside a media query (the describe above). The part of this file
 * is the post body on paper: there is no horizontal scrollbar to drag, so whatever is scrolling must show in full.
 */
describe('globals.css: khi in (V6 P3-1)', () => {
  const all = () => parseGlobalsCss()
  const printRules = () => all().filter((rule) => rule.conditions.includes('print'))

  /** The first print rule that declares `property` (matching `value` if given). */
  function printRule(property: string, value?: RegExp): FlatRule {
    const rule = printRules().find((candidate) => {
      const declaredValue = declared(candidate, property)
      return declaredValue !== undefined && (value === undefined || value.test(declaredValue))
    })
    expect(rule, `missing print rule declaring ${property}`).toBeDefined()
    return rule!
  }

  /** A post body as lib/markdown.tsx builds it: a code block in the copy-button frame, a diagram, a table in a scroll frame. */
  function article() {
    document.body.innerHTML =
      '<article class="prose">' +
      '<h2 id="mot">One<a class="heading-anchor" href="#mot"></a></h2>' +
      '<h3 id="hai">Hai</h3><h4 id="ba">Ba</h4>' +
      '<div data-code-block="" class="relative"><pre class="shiki"><code>x</code></pre></div>' +
      '<pre id="tu-go">y</pre>' +
      '<figure><img src="/images/x.svg" alt=""><figcaption>Caption</figcaption></figure>' +
      '<div class="table-scroll" role="region" tabindex="0"><table><tbody><tr><td>1</td></tr></tbody></table></div>' +
      '</article>' +
      '<pre id="ngoai-bai">z</pre>'
    const $ = (selector: string) => document.querySelector(selector)!
    return {
      codePre: $('[data-code-block] > pre'),
      typedPre: $('#tu-go'),
      outsidePre: $('#ngoai-bai'),
      headings: [$('#mot'), $('#hai'), $('#ba')],
      anchor: $('.heading-anchor'),
      figure: $('figure'),
      image: $('figure img'),
      tableScroll: $('.table-scroll'),
      table: $('table'),
    }
  }

  it('exactly one @media print block, and it does not touch the theme', () => {
    // One block, so everything about printing can be read in one place.
    const style = document.createElement('style')
    style.textContent = css
    document.head.append(style)
    const printBlocks = Array.from(style.sheet!.cssRules).filter((rule) => (rule as CSSMediaRule).conditionText === 'print')
    style.remove()
    expect(printBlocks).toHaveLength(1)

    // The light theme when printing is ThemeToggle's job: a `color-scheme` or a data-theme rule here would be a
    // second source of truth for the theme being painted.
    for (const rule of printRules()) {
      expect(declared(rule, 'color-scheme'), rule.selector).toBeUndefined()
      expect(rule.selector, rule.selector).not.toMatch(/data-theme/)
    }
  })

  it('code blocks wrap instead of scrolling: pre-wrap, and even a long token can break', () => {
    const { codePre, typedPre, outsidePre } = article()
    const wrap = printRule('white-space', /^pre-wrap$/)

    expect(declared(wrap, 'overflow-wrap')).toBe('anywhere')
    // Every <pre> of a post: the Shiki block in the copy-button frame, and a <pre> the author typed by hand.
    expect(codePre.matches(wrap.selector)).toBe(true)
    expect(typedPre.matches(wrap.selector)).toBe(true)
    expect(outsidePre.matches(wrap.selector)).toBe(false)
  })

  it('returns the strip of the "copy code" button to normal padding: the button is not printed (print:hidden)', () => {
    const { codePre } = article()
    // One parse for both sides: order is compared by position in the same list.
    const rules = all()
    const reset = rules.find((rule) => rule.conditions.includes('print') && rule.selector.includes('[data-code-block]'))

    expect(reset, 'missing print rule for [data-code-block] > pre').toBeDefined()
    expect(declared(reset!, 'padding-top')).toBe('1rem')
    expect(codePre.matches(reset!.selector)).toBe(true)
    // Same selector as the two strip rules (2.75rem, then 2.25rem from 40rem — a printed page is wider than 40rem), so it
    // wins by coming AFTER both in the file.
    const bands = rules.filter(
      (rule) =>
        rule.selector.includes('[data-code-block]') && !rule.conditions.includes('print') && declared(rule, 'padding-top'),
    )
    expect(bands).toHaveLength(2)
    for (const band of bands) {
      expect(band.selector.replace(/\s+/g, ' ')).toBe(reset!.selector.replace(/\s+/g, ' '))
      expect(rules.indexOf(band)).toBeLessThan(rules.indexOf(reset!))
    }
  })

  it('diagrams and tables show in full instead of scrolling horizontally; the diagram image shrinks to the page width', () => {
    const { figure, tableScroll, image } = article()
    const visible = printRule('overflow', /^visible$/)

    expect(figure.matches(visible.selector)).toBe(true)
    expect(tableScroll.matches(visible.selector)).toBe(true)
    // min-width 34rem is so the text in a diagram stays readable when scrolling; on paper there is nothing to scroll.
    const shrink = printRule('min-width')
    // The jsdom parser rewrites `0` as `0px`.
    expect(declared(shrink, 'min-width')).toMatch(/^0(px)?$/)
    expect(image.matches(shrink.selector)).toBe(true)
  })

  it('does not split a code block, diagram or table; a heading does not stand alone at the bottom of a page', () => {
    const { codePre, typedPre, figure, table, headings } = article()
    const keep = printRule('break-inside', /^avoid$/)
    for (const element of [codePre, typedPre, figure, table]) {
      expect(element.matches(keep.selector), element.tagName).toBe(true)
    }

    const withNext = printRule('break-after', /^avoid$/)
    for (const heading of headings) expect(heading.matches(withNext.selector), heading.tagName).toBe(true)
  })

  it('the # mark next to a heading is not printed: on paper it leads nowhere', () => {
    const { anchor } = article()
    const hidden = printRule('display', /^none$/)

    expect(anchor.matches(hidden.selector)).toBe(true)
  })
})

/**
 * The # mark next to a heading: it used to show only when hovering the heading, so on a phone — where
 * there is no hover — nobody saw it. It stays aria-hidden and outside the Tab order (lib/markdown.tsx): the table of
 * contents is the path for the keyboard and screen readers; this is the path for fingers and the pointer.
 */
describe('globals.css: the # mark next to a heading', () => {
  const anchorRules = () => parseGlobalsCss().filter((rule) => rule.selector.includes('.heading-anchor'))

  function heading(): { h2: Element; anchor: Element } {
    document.body.innerHTML =
      '<article class="prose"><h2 id="dat-van-de">Problem statement<a class="heading-anchor" href="#dat-van-de"></a></h2></article>'
    return { h2: document.getElementById('dat-van-de')!, anchor: document.querySelector('.heading-anchor')! }
  }

  it('hidden at rest (opacity 0) on hover-capable devices, shown when hovering the heading — as before', () => {
    const { anchor } = heading()
    const rest = anchorRules().find((rule) => rule.conditions.length === 0 && declared(rule, 'opacity') === '0')
    const hover = anchorRules().find((rule) => rule.conditions.length === 0 && rule.selector.includes(':hover'))

    expect(rest, 'missing opacity 0 rule').toBeDefined()
    expect(anchor.matches(rest!.selector)).toBe(true)
    expect(declared(hover!, 'opacity')).toBe('1')
  })

  it('touch devices (hover: none): always shown', () => {
    const { anchor } = heading()
    const touch = anchorRules().find((rule) => rule.conditions.some((c) => /hover:\s*none/.test(c)))

    expect(touch, 'missing @media (hover: none)').toBeDefined()
    expect(touch!.conditions).toEqual(['(hover: none)'])
    expect(declared(touch!, 'opacity')).toBe('1')
    expect(anchor.matches(touch!.selector)).toBe(true)
  })

  it('a heading just jumped to (#id in the URL, :target) shows its own # mark, on every device', () => {
    const { anchor } = heading()
    document.body.insertAdjacentHTML(
      'beforeend',
      '<article class="prose"><h3 id="khac">Another section<a class="heading-anchor" href="#khac"></a></h3></article>',
    )
    const other = document.querySelector('#khac .heading-anchor')!
    const target = anchorRules().find((rule) => rule.selector.includes(':target'))

    expect(target, 'missing :target rule').toBeDefined()
    expect(target!.conditions).toEqual([])
    expect(declared(target!, 'opacity')).toBe('1')

    // jsdom matches :target by location.hash, like a browser after a click on the table of contents.
    try {
      expect(anchor.matches(target!.selector)).toBe(false)
      window.location.hash = 'dat-van-de'
      expect(anchor.matches(target!.selector)).toBe(true)
      // Only the mark of the heading that is the target, not every mark in the post.
      expect(other.matches(target!.selector)).toBe(false)
      window.location.hash = 'khac'
      expect(other.matches(target!.selector)).toBe(true)
    } finally {
      window.location.hash = ''
    }
  })
})

describe('globals.css: sticky header and scroll-padding', () => {
  it('--site-header-h defaults to 0px at :root, outside every media query: admin has no public header', () => {
    const rules = parseGlobalsCss().filter((rule) => declared(rule, '--site-header-h') !== undefined)

    expect(rules).toHaveLength(1)
    expect(rules[0]!.selector).toBe(':root')
    expect(rules[0]!.conditions).toEqual([])
    expect(declared(rules[0]!, '--site-header-h')).toBe('0px')
  })

  it('scroll-padding-top of <html> is the measured header height: anchors, focus and scrollIntoView stop below the header', () => {
    const rules = parseGlobalsCss().filter((rule) => declared(rule, 'scroll-padding-top') !== undefined)

    expect(rules).toHaveLength(1)
    expect(rules[0]!.conditions).toEqual([])
    expect(document.documentElement.matches(rules[0]!.selector)).toBe(true)
    expect(declared(rules[0]!, 'scroll-padding-top')).toBe('var(--site-header-h)')
  })

  it('the scrollbar lane of <html> is always reserved, so a short page and a long page have the same frame width', () => {
    const rules = parseGlobalsCss().filter((rule) => declared(rule, 'scrollbar-gutter') !== undefined)

    expect(rules).toHaveLength(1)
    expect(rules[0]!.conditions).toEqual([])
    expect(document.documentElement.matches(rules[0]!.selector)).toBe(true)
    expect(declared(rules[0]!, 'scrollbar-gutter')).toBe('stable')
  })
})

describe('globals.css: breathing room above a heading when jumping to it (added on top of the sticky-header scroll-padding)', () => {
  it('post h2–h4: scroll-margin-top equals HEADING_SCROLL_MARGIN_PX, which the TocSpy "currently reading" line relies on', () => {
    document.body.innerHTML =
      '<article class="prose"><h2 id="mot">One</h2><h3 id="hai">Hai</h3><h4 id="ba">Ba</h4><h5 id="bon">Four</h5></article>' +
      '<h2 id="ngoai-bai">Outside post</h2>'
    const rules = parseGlobalsCss().filter((rule) => declared(rule, 'scroll-margin-top') !== undefined)

    expect(rules).toHaveLength(1)
    const [rule] = rules
    // At every width, and in px: TocSpy compares against a px number, rem would drift when a reader changes the root font size.
    expect(rule!.conditions).toEqual([])
    expect(declared(rule!, 'scroll-margin-top')).toBe(`${HEADING_SCROLL_MARGIN_PX}px`)
    for (const id of ['mot', 'hai', 'ba']) expect(document.getElementById(id)!.matches(rule!.selector), id).toBe(true)
    expect(document.getElementById('bon')!.matches(rule!.selector)).toBe(false)
    expect(document.getElementById('ngoai-bai')!.matches(rule!.selector)).toBe(false)
  })
})

/**
 * The prose restyle of the three-column post page (spec 4.2): inline code chip, code block border, blockquote, table frame
 * and header, SVG-only diagram frame. Every light rule has its dark twin written with the `:not([data-admin] *)` guard.
 */
describe('globals.css: the prose restyle of the post page', () => {
  const norm = (selector: string) => selector.replace(/\s+/g, ' ').replace(/"/g, "'").trim()
  const darkRules = () => parseGlobalsCss().filter((rule) => /data-theme=['"]dark['"]\]/.test(rule.selector))

  function rule(selector: string): FlatRule {
    const found = parseGlobalsCss().find(
      (candidate) => candidate.conditions.length === 0 && norm(candidate.selector) === selector,
    )
    expect(found, `missing rule ${selector}`).toBeDefined()
    return found!
  }

  /** The dark twin of a light selector: `[data-theme='dark'] <light>:not([data-admin] *)`. */
  function twin(selector: string): FlatRule | undefined {
    const wanted = `[data-theme='dark'] ${selector}:not([data-admin] *)`
    return darkRules().find((candidate) => norm(candidate.selector) === wanted)
  }

  it('--breakpoint-rail: 68rem is declared in @theme (generates the rail: and max-rail: variants)', () => {
    const theme = /@theme\s*\{([^}]*)\}/.exec(css)
    expect(theme, 'missing @theme block').not.toBeNull()
    expect(theme![1]).toMatch(/--breakpoint-rail:\s*68rem\s*;/)
  })

  it('inline code is a chip (no backticks, neutral-100 background, neutral-800 in dark)', () => {
    const chip = rule('.prose :not(pre) > code')
    expect(declared(chip, 'background-color')).toBe('var(--color-neutral-100)')
    expect(declared(chip, 'border-radius')).toBe('0.25rem')
    expect(declared(chip, 'font-size')).toBe('0.875em')
    expect(declared(twin('.prose :not(pre) > code')!, 'background-color')).toBe('var(--color-neutral-800)')
    // The backtick rule stays.
    expect(declared(rule('.prose :not(pre) > code::before, .prose :not(pre) > code::after'), 'content')).toBe('none')
  })

  it('a code block has a 1px border in both themes, and keeps its padding', () => {
    const rules = parseGlobalsCss().filter(
      (candidate) => norm(candidate.selector) === '.prose pre' && candidate.conditions.length === 0,
    )
    const bordered = rules.find((candidate) => declared(candidate, 'border') !== undefined)
    expect(bordered, 'missing .prose pre border rule').toBeDefined()
    expect(declared(bordered!, 'border')).toBe('1px solid var(--color-neutral-200)')
    expect(declared(bordered!, 'border-radius')).toBe('0.5rem')
    expect(declared(twin('.prose pre')!, 'border-color')).toBe('var(--color-neutral-800)')
    expect(rules.some((candidate) => declared(candidate, 'padding') === '1rem')).toBe(true)
  })

  it('a blockquote is a 2px brand rule on the inline-start side, with no italics and no generated curly quotes', () => {
    const quote = rule('.prose blockquote')
    expect(declared(quote, 'border-inline-start')).toBe('2px solid var(--color-brand)')
    expect(declared(quote, 'padding-inline-start')).toBe('1.25rem')
    expect(declared(quote, 'font-style')).toBe('normal')
    expect(declared(quote, 'color')).toBe('var(--color-neutral-700)')
    expect(declared(twin('.prose blockquote')!, 'color')).toBe('var(--color-neutral-300)')

    const marks = rule('.prose blockquote p::before, .prose blockquote p::after')
    expect(declared(marks, 'content')).toBe('none')
    for (const candidate of parseGlobalsCss()) {
      if (/blockquote/.test(candidate.selector))
        expect(declared(candidate, 'content') ?? '', candidate.selector).not.toMatch(/quote/)
    }
  })

  it('a table scroll frame has a border and a rounded edge; the header cells have a tinted background (dark twins too)', () => {
    const frame = rule('.prose .table-scroll')
    expect(declared(frame, 'border')).toBe('1px solid var(--color-neutral-200)')
    expect(declared(frame, 'border-radius')).toBe('0.5rem')
    expect(declared(frame, 'overflow-x')).toBe('auto')
    expect(declared(twin('.prose .table-scroll')!, 'border-color')).toBe('var(--color-neutral-800)')

    expect(declared(rule('.prose .table-scroll thead th'), 'background-color')).toBe('var(--color-neutral-50)')
    expect(declared(twin('.prose .table-scroll thead th')!, 'background-color')).toBe('var(--color-neutral-900)')
  })

  it('the diagram frame (min-width 34rem, padding) is for SVG only; a raster image fits the column and has no padding', () => {
    document.body.innerHTML =
      '<article class="prose"><figure><img id="svg" src="/images/x.svg" alt=""></figure>' +
      '<figure><img id="raster" src="/media/photo.jpg" alt=""></figure></article>'
    const svg = document.getElementById('svg')!
    const raster = document.getElementById('raster')!

    const base = rule('.prose figure img')
    expect(declared(base, 'min-width')).toMatch(/^0(px)?$/)
    expect(declared(base, 'padding')).toMatch(/^0(px)?$/)
    expect(declared(base, 'border')).toBe('1px solid var(--color-neutral-200)')
    expect(declared(base, 'border-radius')).toBe('0.5rem')
    expect(raster.matches(base.selector)).toBe(true)

    const frame = rule(".prose figure img[src$='.svg']")
    expect(declared(frame, 'min-width')).toBe('34rem')
    expect(declared(frame, 'padding')).toBe('0.75rem')
    expect(svg.matches(frame.selector)).toBe(true)
    expect(raster.matches(frame.selector)).toBe(false)
    // The SVG rule comes later and is more specific, so it wins over the base rule for an SVG.
    const rules = parseGlobalsCss()
    expect(rules.findIndex((candidate) => candidate.selector === frame.selector)).toBeGreaterThan(
      rules.findIndex((candidate) => candidate.selector === base.selector),
    )
  })

  it('on paper an SVG diagram shrinks to the page width too (the print rule names the SVG selector, which is more specific)', () => {
    document.body.innerHTML = '<article class="prose"><figure><img id="svg" src="/images/x.svg" alt=""></figure></article>'
    const print = parseGlobalsCss().find(
      (candidate) => candidate.conditions.includes('print') && declared(candidate, 'min-width') !== undefined,
    )!
    expect(document.getElementById('svg')!.matches(print.selector)).toBe(true)
    expect(print.selector).toMatch(/\.svg/)
  })

  it('every new .prose rule that paints a colour has a dark twin with the :not([data-admin] *) guard', () => {
    const paintsColour = (candidate: FlatRule) =>
      ['background-color', 'border-color', 'color', 'border'].some((property) => declared(candidate, property) !== undefined)
    const NEW = [
      '.prose :not(pre) > code',
      '.prose pre',
      '.prose blockquote',
      '.prose .table-scroll',
      '.prose .table-scroll thead th',
    ]
    for (const selector of NEW) {
      const painted = parseGlobalsCss().filter(
        (candidate) => candidate.conditions.length === 0 && norm(candidate.selector) === selector && paintsColour(candidate),
      )
      expect(painted.length, selector).toBeGreaterThan(0)
      expect(twin(selector), `no dark twin for ${selector}`).toBeDefined()
    }
    // No dark .prose rule is missing the admin guard.
    for (const candidate of darkRules()) {
      if (/\.prose/.test(candidate.selector))
        expect(norm(candidate.selector), candidate.selector).toMatch(/:not\(\[data-admin\] \*\)$/)
    }
  })
})

/**
 * The 1400px site frame (site-frame spec 2.5): the frame is the shell of every public page (SITE_MAIN, BAR_FRAME in
 * components/site/reader/reader-layout.ts), so there is no stylesheet rule that widens the header and footer for one page and
 * no marker attribute for it to select on.
 */
describe('globals.css: the 1400px site frame', () => {
  it('--breakpoint-frame: 89rem is declared in @theme (generates the frame: and max-frame: variants), next to the rail breakpoint', () => {
    const theme = /@theme\s*\{([^}]*)\}/.exec(css)
    expect(theme, 'missing @theme block').not.toBeNull()
    expect(theme![1]).toMatch(/--breakpoint-frame:\s*89rem\s*;/)
    expect(theme![1]).toMatch(/--breakpoint-rail:\s*68rem\s*;/)
  })

  it('contains no frame marker and no :has() rule keyed off one: the frame is the shell, not a property of the post page', () => {
    for (const marker of ['data-reader-frame', 'data-site-frame', 'data-site-footer']) {
      expect(css, marker).not.toContain(marker)
    }
    for (const candidate of parseGlobalsCss()) {
      expect(candidate.selector, candidate.selector).not.toMatch(/body:has\(\[data-/)
    }
  })

  it('--site-header-visible-h defaults to 0px at :root, outside every media query, next to --site-header-h', () => {
    const rules = parseGlobalsCss().filter((candidate) => declared(candidate, '--site-header-visible-h') !== undefined)
    expect(rules).toHaveLength(1)
    expect(rules[0]!.selector).toBe(':root')
    expect(rules[0]!.conditions).toEqual([])
    expect(declared(rules[0]!, '--site-header-visible-h')).toBe('0px')
    // The measured height variable is untouched and still the single scroll-padding source.
    expect(declared(rules[0]!, '--site-header-h')).toBe('0px')
  })
})

/**
 * The text of the public post page fills the whole body column: no rule caps the width of a paragraph, list, quote or heading inside
 * [data-post-body], so the text, the code blocks and the tables share one right edge.
 */
describe('globals.css: the text of the post body fills its column', () => {
  it('no rule sets max-width on anything inside [data-post-body] or [data-reader-body]', () => {
    for (const rule of parseGlobalsCss()) {
      if (!/data-post-body|data-reader-body/.test(rule.selector)) continue
      expect(declared(rule, 'max-width'), rule.selector).toBeUndefined()
    }
  })

  it('no rule caps a text block of any `.prose` at 40rem (the old reading measure)', () => {
    const capped = parseGlobalsCss().filter((rule) => declared(rule, 'max-width') === '40rem')
    expect(capped.map((rule) => rule.selector)).toEqual([])
  })
})

describe('globals.css: the article on a phone (17px at 1.7), the same article from sm (18px at 1.8)', () => {
  const rulesOf = (selector: string) => parseGlobalsCss().filter((rule) => rule.selector === selector)
  const underMin = (rule: FlatRule) => rule.conditions.some((condition) => /min-width:\s*40rem/.test(condition))
  const underMax = (rule: FlatRule) => rule.conditions.some((condition) => /max-width:\s*39\.999rem/.test(condition))

  it('the prose line-height is 1.7 below sm and 1.8 from sm: the marks of Vietnamese stay clear, a long post is shorter on a phone', () => {
    const prose = rulesOf('.prose')
    const base = prose.find((rule) => rule.conditions.length === 0 && declared(rule, 'line-height'))
    const wide = prose.find((rule) => underMin(rule) && declared(rule, 'line-height'))
    expect(declared(base!, 'line-height')).toBe('1.7')
    expect(declared(wide!, 'line-height')).toBe('1.8')
  })

  it('the base prose size is 17px (1.0625rem) below sm only, so `sm:prose-lg` still gives 18px from sm', () => {
    const rule = rulesOf('.prose.prose-base').find(underMax)
    expect(declared(rule!, 'font-size')).toBe('1.0625rem')
    expect(rulesOf('.prose.prose-base').filter((candidate) => !underMax(candidate))).toEqual([])
  })

  it('code is 13px below sm everywhere (a fence, a code-tabs panel, a block) and nothing sets it at sm and above', () => {
    const rule = rulesOf('.prose pre').find(underMax)
    expect(declared(rule!, 'font-size')).toBe('0.8125rem')
    for (const candidate of rulesOf('.prose pre').filter((candidate) => !underMax(candidate))) {
      expect(declared(candidate, 'font-size')).toBeUndefined()
    }
  })

  it('a code block that scrolls fades its right edge below sm only, while it has more to the right (data-more)', () => {
    document.body.innerHTML =
      '<article class="prose"><pre id="more" data-more="true">a</pre><pre id="end" data-more="false">b</pre><pre id="plain">c</pre></article>'
    const faded = parseGlobalsCss().filter((candidate) => candidate.selector.includes('data-more'))
    const phone = faded.find(underMax)
    expect(phone).toBeDefined()
    // jsdom drops properties it does not know (mask-image): the declaration is read from the source of the rule.
    expect(css).toMatch(/\.prose pre\[data-more='true'\]\s*\{[^}]*mask-image:\s*linear-gradient\(to right/)
    expect(document.getElementById('more')!.matches(phone!.selector)).toBe(true)
    expect(document.getElementById('end')!.matches(phone!.selector)).toBe(false)
    expect(document.getElementById('plain')!.matches(phone!.selector)).toBe(false)
    // Nothing outside the phone media query fades a code block.
    expect(faded.filter((candidate) => !underMax(candidate))).toEqual([])
  })

  it('a figure is 24px from its neighbours below sm (blocks are my-6) and 32px from sm', () => {
    const figure = rulesOf('.prose figure')
    expect(
      declared(
        figure.find((rule) => rule.conditions.length === 0)!,
        'margin',
      ),
    ).toMatch(/^2rem 0(px)?$/)
    expect(declared(figure.find(underMax)!, 'margin')).toMatch(/^1\.5rem 0(px)?$/)
  })

  it('a table is 15px at 1.5 below sm, the rest of the UI text, not the 17px of the body', () => {
    const rule = rulesOf('.prose .table-scroll > table').find(underMax)
    expect(declared(rule!, 'font-size')).toBe('0.9375rem')
    expect(declared(rule!, 'line-height')).toBe('1.5')
  })
})
