import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BrandIcon, type BrandName } from './BrandIcon'

const BRANDS: readonly BrandName[] = ['github', 'facebook', 'x', 'linkedin']

function svgOf(container: HTMLElement): SVGSVGElement {
  const svgs = container.querySelectorAll('svg')
  expect(svgs).toHaveLength(1)
  return svgs[0]!
}

describe('BrandIcon', () => {
  it.each(BRANDS)('%s is a shape filled with the text color, decorative, with no accessible name', (name) => {
    const svg = svgOf(render(<BrandIcon name={name} />).container)

    expect(svg).toHaveAttribute('viewBox', '0 0 24 24')
    expect(svg).toHaveAttribute('fill', 'currentColor')
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg).toHaveAttribute('focusable', 'false')
    expect(svg).not.toHaveAttribute('role')
    // simple-icons bundles a <title> in every SVG; here it must be dropped, because the accessible name
    // (e.g. "GitHub", the Facebook share label) comes from the link text, not from the graphic.
    expect(svg.querySelector('title, desc, text')).toBeNull()
    expect(svg.textContent).toBe('')

    // One path, filled with the inherited color: no path sets its own fill or stroke.
    const paths = svg.querySelectorAll('path')
    expect(paths).toHaveLength(1)
    expect(paths[0]!.getAttribute('d')).toMatch(/^M/)
    expect(paths[0]).not.toHaveAttribute('fill')
    expect(paths[0]).not.toHaveAttribute('stroke')
  })

  it.each(BRANDS)('%s carries no brand color', (name) => {
    // Design rule: no brand colors. A hex value in the markup is the first sign that someone
    // pasted the original SVG together with the vendor's color.
    const { container } = render(<BrandIcon name={name} />)

    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(container.innerHTML).not.toMatch(/rgb|hsl|oklch/i)
  })

  it('each brand has its own graphic (no path copied by mistake)', () => {
    const paths = BRANDS.map((name) =>
      svgOf(render(<BrandIcon name={name} />).container)
        .querySelector('path')!
        .getAttribute('d'),
    )

    expect(new Set(paths).size).toBe(BRANDS.length)
  })

  it.each([
    [undefined, 'h-4', 'w-4', '16'],
    [14, 'h-3.5', 'w-3.5', '14'],
    [20, 'h-5', 'w-5', '20'],
  ] as const)('size %s uses the same size scale as the icon set (%s %s)', (size, h, w, px) => {
    const svg = svgOf(render(<BrandIcon name="github" size={size} className="opacity-80" />).container)
    const classes = (svg.getAttribute('class') ?? '').split(/\s+/)

    expect(classes).toEqual(expect.arrayContaining([h, w, 'shrink-0', 'opacity-80']))
    expect(svg).toHaveAttribute('width', px)
    expect(svg).toHaveAttribute('height', px)
  })

  it('records the source and version of each path, including the old release that still has LinkedIn', () => {
    // LinkedIn was removed from simple-icons in 14.0.0; the path comes from 13.21.0, the last CC0
    // release that still has it. Documented so nobody later "upgrades" to a release without this icon.
    const source = readFileSync(join(process.cwd(), 'components/BrandIcon.tsx'), 'utf8')

    expect(source).toContain('simple-icons 16.34.0')
    expect(source).toContain('simple-icons 13.21.0')
    expect(source).toContain('CC0')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/['"]use client['"]/)
  })
})
