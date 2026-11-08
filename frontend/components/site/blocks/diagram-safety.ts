/**
 * What the page keeps of a Mermaid drawing. The library draws the labels an author wrote as HTML inside `foreignObject`, so a
 * drawing is author-controlled markup. Everything here is an allowlist: an element, an attribute or a style that is not named is
 * dropped, so a form, a control, a link or a layout style an author smuggles into a label never reaches the page (a live form in
 * the admin origin could reach a same-origin Server Action; `position: fixed` could cover the page with a fake sign-in).
 *
 * Two layers use it: `LABEL_PURIFY_CONFIG` is handed to the library for its own label cleaner, and `toSafeDrawing` cleans the
 * markup the library returns, with no trust in the first layer.
 */

const XHTML = 'http://www.w3.org/1999/xhtml'

/** The formatting tags a label may hold. Nothing interactive, nothing that loads. */
const LABEL_TAGS = [
  'div',
  'span',
  'p',
  'b',
  'i',
  'em',
  'strong',
  'code',
  'br',
  'u',
  's',
  'sub',
  'sup',
  'small',
  'mark',
  'del',
  'ul',
  'ol',
  'li',
  'pre',
] as const

/** The options for the library's own label cleaner (DOMPurify): a few formatting tags and no attribute at all. */
export const LABEL_PURIFY_CONFIG = {
  ALLOWED_TAGS: [...LABEL_TAGS] as string[],
  ALLOWED_ATTR: [] as string[],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
}

const LABEL_TAG_SET = new Set<string>(LABEL_TAGS)

/** Elements of a label that are removed with everything inside them (the others are unwrapped: their text stays). */
const LABEL_DROPPED_WITH_CONTENT = new Set([
  'script',
  'style',
  'svg',
  'math',
  'noscript',
  'template',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'video',
  'audio',
  'canvas',
  'textarea',
  'select',
  'head',
  'title',
  'link',
  'meta',
  'base',
])

/** The drawing elements of an SVG (lower case). No script, animation, `feImage` or embedded document. */
const SVG_ELEMENTS = new Set(
  (
    'svg g defs symbol marker path rect circle ellipse line polyline polygon text tspan textpath title desc style a use image ' +
    'lineargradient radialgradient stop clippath mask pattern switch foreignobject filter fegaussianblur feoffset feblend ' +
    'fecolormatrix fecomposite feflood femerge femergenode fedropshadow femorphology fecomponenttransfer fefunca fefuncb ' +
    'fefuncg fefuncr feturbulence fedisplacementmap feconvolvematrix fediffuselighting fespecularlighting fedistantlight ' +
    'fepointlight fespotlight fetile'
  ).split(' '),
)

const SVG_ATTRIBUTES = new Set(
  (
    'id class xmlns xmlns:xlink xml:space role aria-roledescription aria-label aria-labelledby aria-describedby viewbox ' +
    'width height preserveaspectratio version x y x1 x2 y1 y2 cx cy r rx ry fx fy fr d points transform dx dy rotate textlength ' +
    'lengthadjust startoffset fill fill-opacity fill-rule stroke stroke-width stroke-dasharray stroke-dashoffset stroke-linecap ' +
    'stroke-linejoin stroke-miterlimit stroke-opacity opacity color marker-start marker-mid marker-end markerwidth markerheight ' +
    'markerunits refx refy orient clip-path clip-rule clippathunits mask maskunits maskcontentunits filter filterunits ' +
    'primitiveunits in in2 result stddeviation flood-color flood-opacity mode operator k1 k2 k3 k4 values type tablevalues slope ' +
    'intercept amplitude exponent offset order kernelmatrix edgemode basefrequency numoctaves seed scale xchannelselector ' +
    'ychannelselector color-interpolation-filters font-family font-size font-weight font-style font-variant text-anchor ' +
    'text-decoration dominant-baseline alignment-baseline baseline-shift letter-spacing word-spacing writing-mode visibility ' +
    'display overflow gradientunits gradienttransform spreadmethod stop-color stop-opacity patternunits patterncontentunits ' +
    'patterntransform vector-effect shape-rendering text-rendering pathlength paint-order systemlanguage'
  ).split(' '),
)

/** `data-` attributes the page itself reads or styles by: a drawing must not be able to set them. */
const RESERVED_DATA_ATTRIBUTES = new Set(['data-admin', 'data-theme'])

/** Style properties of a drawing element: paint and text inside the box, never position or loading. */
const DRAWING_PROPERTIES = new Set(
  (
    'fill fill-opacity fill-rule stroke stroke-width stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin ' +
    'stroke-miterlimit stroke-opacity opacity color font-family font-size font-weight font-style text-anchor text-decoration ' +
    'dominant-baseline alignment-baseline letter-spacing line-height white-space text-align stop-color stop-opacity ' +
    'marker-start marker-mid marker-end filter clip-path mask visibility max-width flood-color flood-opacity shape-rendering ' +
    'vector-effect paint-order display'
  ).split(' '),
)

const PIXELS = /^\d{1,4}(?:\.\d+)?px$/i
/** Style properties of a label, with the values each may have (`true`: any acceptable value). */
const LABEL_PROPERTIES: Record<string, RegExp | true> = {
  display: /^(?:table-cell|table|inline-block|inline|block)$/i,
  'white-space': true,
  'line-height': true,
  'max-width': PIXELS,
  width: PIXELS,
  height: PIXELS,
  'text-align': true,
  color: true,
  'font-weight': true,
  'font-style': true,
  'text-decoration': true,
}

/** The class names a label may keep: the library's own (`nodeLabel`, `edgeLabel`, `markdown-node-label`...), never the page's. */
const LABEL_CLASS = /^[A-Za-z-]*[Ll]abel[A-Za-z-]*$/

/** Addresses a link may point at: the web, a path of the site, a place in the drawing. */
const WEB_OR_SITE_ADDRESS = /^(?:https?:\/\/|\/(?!\/)|#)/i
const WEB_ADDRESS = /^(?:https?:\/\/|\/(?!\/))/i
const LOCAL_ADDRESS = /^#/
const ADDRESS_ATTRIBUTES = new Set(['href', 'xlink:href'])
/** A `url(...)` that does not point inside the drawing. */
const EXTERNAL_URL = /url\(\s*(?!['"]?\s*#)/i
const UNSAFE_VALUE = /\\|[<>{}]|\/\*|expression\s*\(|javascript:|vbscript:|@import|-moz-binding|behavior\s*:/i

function acceptableValue(value: string): boolean {
  return !UNSAFE_VALUE.test(value) && !EXTERNAL_URL.test(value)
}

/** The declarations of a `style` attribute that name an allowed property with an acceptable value, as the author wrote them. */
function cleanStyle(style: string, label: boolean): string {
  const kept: string[] = []
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':')
    if (colon < 1) continue
    const property = declaration.slice(0, colon).trim().toLowerCase()
    const value = declaration
      .slice(colon + 1)
      .replace(/!\s*important\s*$/i, '')
      .trim()
    if (!value || !acceptableValue(value)) continue
    if (label) {
      const rule = LABEL_PROPERTIES[property]
      if (!rule || (rule !== true && !rule.test(value))) continue
    } else if (!DRAWING_PROPERTIES.has(property)) continue
    kept.push(declaration.trim())
  }
  return kept.join('; ')
}

/** The text of a style sheet without anything that loads from another address. */
function cleanStyleSheet(css: string): string {
  return css
    .replace(/\\/g, '')
    .replace(/@import[^;{}]*;?/gi, '')
    .replace(/url\(\s*(?!['"]?\s*#)[^)]*\)/gi, 'none')
    .replace(/expression\s*\(|javascript:|vbscript:|-moz-binding|behavior\s*:/gi, '')
}

function cleanDrawingAttributes(element: Element) {
  const name = element.localName.toLowerCase()
  for (const attribute of [...element.attributes]) {
    const attributeName = attribute.name.toLowerCase()
    const value = attribute.value
    let keep: boolean
    if (attributeName === 'style') {
      const style = cleanStyle(value, false)
      if (style) element.setAttribute(attribute.name, style)
      else element.removeAttribute(attribute.name)
      continue
    } else if (ADDRESS_ATTRIBUTES.has(attributeName)) {
      const address = value.trim()
      if (name === 'use') keep = LOCAL_ADDRESS.test(address)
      else if (name === 'image') keep = WEB_ADDRESS.test(address)
      else if (name === 'a') keep = WEB_OR_SITE_ADDRESS.test(address)
      else keep = false
    } else if (attributeName.startsWith('data-')) {
      keep = !RESERVED_DATA_ATTRIBUTES.has(attributeName) && /^data-[a-z0-9-]+$/.test(attributeName) && acceptableValue(value)
    } else {
      keep = SVG_ATTRIBUTES.has(attributeName) && acceptableValue(value)
    }
    if (!keep) element.removeAttribute(attribute.name)
  }
}

function cleanLabelAttributes(element: Element) {
  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase()
    const value = attribute.value
    element.removeAttribute(attribute.name)
    if (name === 'xmlns') {
      // Harmless when it is the HTML namespace the element has anyway; some DOM implementations select by it.
      if (value === XHTML) element.setAttribute('xmlns', XHTML)
    } else if (name === 'class') {
      const classes = value.split(/\s+/).filter((token) => LABEL_CLASS.test(token))
      if (classes.length > 0) element.setAttribute('class', classes.join(' '))
    } else if (name === 'style') {
      const style = cleanStyle(value, true)
      if (style) element.setAttribute('style', style)
    }
  }
}

/** Cleans the children of `parent` in place: `label` is true inside a `foreignObject`, where the content is HTML. */
function cleanChildren(parent: Node, label: boolean) {
  for (const child of [...parent.childNodes]) {
    if (child.nodeType === Node.TEXT_NODE) continue
    if (child.nodeType !== Node.ELEMENT_NODE) {
      child.parentNode?.removeChild(child)
      continue
    }
    const element = child as Element
    const name = element.localName.toLowerCase()
    if (label) {
      if (element.namespaceURI !== XHTML || LABEL_DROPPED_WITH_CONTENT.has(name)) {
        element.remove()
      } else if (!LABEL_TAG_SET.has(name)) {
        cleanChildren(element, true)
        element.replaceWith(...element.childNodes)
      } else {
        cleanLabelAttributes(element)
        cleanChildren(element, true)
      }
      continue
    }
    if (!SVG_ELEMENTS.has(name)) {
      element.remove()
      continue
    }
    cleanDrawingAttributes(element)
    if (name === 'style') element.textContent = cleanStyleSheet(element.textContent ?? '')
    else cleanChildren(element, name === 'foreignobject')
  }
}

/**
 * The drawing of mermaid as a DOM node the page can adopt, or null when the answer is not a drawing.
 *
 * The markup is parsed into an inert document (no script runs there), rebuilt from the allowlists above and only then imported.
 * The text of the article never reaches `innerHTML` and `dangerouslySetInnerHTML` is not used.
 */
export function toSafeDrawing(markup: string): SVGSVGElement | null {
  const parsed = new DOMParser().parseFromString(markup, 'text/html')
  const svg = parsed.body.querySelector('svg')
  if (!svg) return null

  cleanDrawingAttributes(svg)
  cleanChildren(svg, false)
  const drawing = document.importNode(svg, true) as SVGSVGElement
  // A wide diagram keeps a readable size on a narrow screen instead of shrinking with the column: the frame around it scrolls
  // sideways. Mermaid draws its labels at 16px, so a drawing is never shown below 75% of its size (12px labels), and never narrower
  // than 22.5rem, which is what a phone column holds: a 451px flowchart scales to fit a 430px phone and does not scroll at all, a 900px one
  // keeps 675px and scrolls. A narrow diagram is not made wider than it is. (The diagram IMAGES of app/globals.css have 11.5px labels
  // and keep their 34rem.)
  const width = Number(
    drawing
      .getAttribute('viewBox')
      ?.trim()
      .split(/[\s,]+/)[2],
  )
  if (Number.isFinite(width) && width > 0)
    drawing.style.minWidth = `min(${Math.round(width)}px, max(22.5rem, ${Math.round(width * 0.7)}px))`
  return drawing
}
