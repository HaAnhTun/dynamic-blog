import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render } from '@testing-library/react'
import type { ComponentType } from 'react'
import { describe, expect, it } from 'vitest'
import * as icons from './icons'
import type { IconProps } from './icons'

/**
 * The glyph set from the design spec, exactly that list, no more and no less.
 *
 * The list is retyped here instead of being read from the module: this is an inventory test, so adding or
 * removing an icon must be a deliberate change in both places, like the repo's nav and
 * sitemap inventory tests.
 */
const SPEC_GLYPHS = [
  'CalendarDaysIcon',
  'ClockIcon',
  'FolderIcon',
  'TagIcon',
  'TagsIcon',
  'LayersIcon',
  'EyeIcon',
  'TrendingUpIcon',
  'StarIcon',
  'ArchiveIcon',
  'ShuffleIcon',
  'RssIcon',
  'MailIcon',
  'LinkIcon',
  'ArrowUpRightIcon',
  'ListIcon',
  'Share2Icon',
  'XIcon',
  'ChevronLeftIcon',
  'ChevronRightIcon',
  'GraduationCapIcon',
  'BriefcaseIcon',
  'UserIcon',
  'ImagesIcon',
  'PenLineIcon',
  'UploadIcon',
  'ImagePlusIcon',
  'Trash2Icon',
  'ArrowUpIcon',
  'ArrowDownIcon',
  'NewspaperIcon',
  // Six admin glyphs.
  'CheckIcon',
  'MenuIcon',
  'SearchIcon',
  'PlusIcon',
  'LogOutIcon',
  'CircleAlertIcon',
  // Three glyphs for post likes, comments and users in admin.
  'HeartIcon',
  'MessageSquareIcon',
  'UsersIcon',
  // One glyph for notifications: the bell in the header.
  'BellIcon',
  // One glyph: the copy-code button on code blocks (CheckIcon above is the copied state).
  'CopyIcon',
  // One glyph: the post save button and the /bookmarks page.
  'BookmarkIcon',
  // One glyph: the Settings item of the admin sidebar.
  'SlidersIcon',
  // One glyph: the Security item of the admin sidebar.
  'ShieldIcon',
] as const

const SHAPES = 'path, circle, rect, line, polyline, polygon, ellipse'

function glyph(name: (typeof SPEC_GLYPHS)[number]): ComponentType<IconProps> {
  return (icons as unknown as Record<string, ComponentType<IconProps>>)[name]!
}

function svgOf(container: HTMLElement): SVGSVGElement {
  const svgs = container.querySelectorAll('svg')
  expect(svgs).toHaveLength(1)
  // Nothing wraps the <svg>: the caller puts it into its own flex row.
  expect(container.firstElementChild).toBe(svgs[0])
  return svgs[0]!
}

describe('components/icons', () => {
  it('exports exactly the 45 glyphs of the specs, none missing, none extra', () => {
    const exported = Object.keys(icons)
      .filter((key) => key.endsWith('Icon'))
      .sort()

    expect(exported).toEqual([...SPEC_GLYPHS].sort())
    for (const name of SPEC_GLYPHS) {
      expect(typeof glyph(name), name).toBe('function')
    }
  })

  it.each(SPEC_GLYPHS)('%s is a decorative <svg>, never carrying an accessible name', (name) => {
    const Icon = glyph(name)
    const { container } = render(<Icon />)
    const svg = svgOf(container)

    // The accessible name always comes from adjacent text or sr-only, never from the icon: an icon with a
    // name would be read as the folder name plus the label instead of the label alone.
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg).toHaveAttribute('focusable', 'false')
    expect(svg).not.toHaveAttribute('role')
    expect(svg).not.toHaveAttribute('aria-label')
    expect(svg.querySelector('title, desc, text')).toBeNull()
    expect(svg.textContent).toBe('')

    // Lucide 24 grid, stroke follows the text color, no fill.
    expect(svg).toHaveAttribute('viewBox', '0 0 24 24')
    expect(svg).toHaveAttribute('stroke', 'currentColor')
    expect(svg).toHaveAttribute('fill', 'none')
    expect(svg).toHaveAttribute('stroke-linecap', 'round')
    expect(svg).toHaveAttribute('stroke-linejoin', 'round')

    // There is a real shape to draw: an empty glyph would still pass every assert above.
    expect(svg.querySelectorAll(SHAPES).length, `${name} has no shapes`).toBeGreaterThan(0)

    // No id (duplicate ids when the same icon appears twice on a page), no hard-coded color: every
    // fill/stroke inside may only be currentColor or none.
    expect(svg.querySelector('[id]')).toBeNull()
    for (const el of svg.querySelectorAll('*')) {
      for (const attr of ['fill', 'stroke']) {
        const value = el.getAttribute(attr)
        if (value !== null) expect(['currentColor', 'none'], `${name} ${attr}`).toContain(value)
      }
    }
  })

  it('defaults to 16px: h-4 w-4, stroke 2.25 on the 24 grid, i.e. 1.5px like the hand-drawn glyphs', () => {
    const svg = svgOf(render(<icons.FolderIcon />).container)

    expect(svg.getAttribute('class')).toMatch(/(^|\s)h-4(\s|$)/)
    expect(svg.getAttribute('class')).toMatch(/(^|\s)w-4(\s|$)/)
    expect(svg).toHaveAttribute('width', '16')
    expect(svg).toHaveAttribute('height', '16')
    // Design spec: 2.25 at 16px matches the 1.5 stroke of the existing 16 grid (search, theme).
    expect(svg).toHaveAttribute('stroke-width', '2.25')
  })

  it.each([
    [14, 'h-3.5', 'w-3.5', 1.25],
    [16, 'h-4', 'w-4', 1.5],
    [20, 'h-5', 'w-5', 1.5],
  ] as const)('size %i: classes %s %s and absolute stroke %fpx', (size, h, w, px) => {
    const svg = svgOf(render(<icons.ClockIcon size={size} />).container)
    const classes = (svg.getAttribute('class') ?? '').split(/\s+/)

    expect(classes).toContain(h)
    expect(classes).toContain(w)
    expect(svg).toHaveAttribute('width', String(size))
    expect(svg).toHaveAttribute('height', String(size))
    // The stroke drawn on screen = strokeWidth × size / 24. Keep the absolute thickness instead of letting it
    // grow with the size: a 20px icon in the lightbox must not be bolder than the text next to it.
    const absolute = (Number(svg.getAttribute('stroke-width')) * size) / 24
    expect(absolute).toBeCloseTo(px, 2)
  })

  it('does not shrink in a flex row, and appends the class the caller passes in', () => {
    const svg = svgOf(render(<icons.TagIcon className="text-neutral-400 dark:text-neutral-500" />).container)
    const classes = (svg.getAttribute('class') ?? '').split(/\s+/)

    // shrink-0: next to a truncated series title, the icon is the first thing flex would squeeze.
    expect(classes).toEqual(expect.arrayContaining(['h-4', 'w-4', 'shrink-0', 'text-neutral-400', 'dark:text-neutral-500']))
  })

  it('has no second size class when size changes', () => {
    const classes = (svgOf(render(<icons.XIcon size={20} />).container).getAttribute('class') ?? '').split(/\s+/)

    expect(classes).not.toContain('h-4')
    expect(classes).not.toContain('w-4')
  })

  it('CopyIcon copies lucide `copy` verbatim: a rounded square and the stroke of the sheet behind it', () => {
    // lucide-static 1.52.0 icons/copy.svg. It has no Feather origin (not in the LICENSE list),
    // so only the ISC notice is needed.
    const svg = svgOf(render(<icons.CopyIcon />).container)
    const rect = svg.querySelector('rect')!

    expect([...svg.children].map((child) => child.tagName.toLowerCase())).toEqual(['rect', 'path'])
    expect(rect).toHaveAttribute('width', '14')
    expect(rect).toHaveAttribute('height', '14')
    expect(rect).toHaveAttribute('x', '8')
    expect(rect).toHaveAttribute('y', '8')
    expect(rect).toHaveAttribute('rx', '2')
    expect(rect).toHaveAttribute('ry', '2')
    expect(svg.querySelector('path')).toHaveAttribute('d', 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2')
  })

  it('keeps the filled elements of Lucide (the dot in Tag, Tags, Images)', () => {
    // These three glyphs have a `fill="currentColor"` dot in the original. If that attribute is dropped,
    // the dot becomes an empty circle, almost invisible at 14px.
    for (const Icon of [icons.TagIcon, icons.TagsIcon, icons.ImagesIcon]) {
      const svg = svgOf(render(<Icon />).container)
      expect(svg.querySelector('circle[fill="currentColor"]')).not.toBeNull()
    }
  })

  it.each([
    ['HeartIcon', icons.HeartIcon],
    ['BookmarkIcon', icons.BookmarkIcon],
  ])('%s is solid when `filled`, only with currentColor, the same shape', (_name, Icon) => {
    // The like button uses an empty heart when not liked, a filled one when liked. Filled with
    // currentColor to follow the button's text color, no hard-coded color; the shape must be exactly the outline version's.
    const outline = svgOf(render(<Icon />).container)
    const filled = svgOf(render(<Icon filled />).container)

    expect(outline.querySelector('[fill="currentColor"]')).toBeNull()
    const fillPaths = filled.querySelectorAll('path[fill="currentColor"]')
    expect(fillPaths).toHaveLength(1)
    expect(fillPaths[0]!.getAttribute('d')).toBe(outline.querySelector('path')!.getAttribute('d'))
    // Still a decorative icon like every other glyph.
    expect(filled).toHaveAttribute('aria-hidden', 'true')
    expect(filled).toHaveAttribute('stroke', 'currentColor')
  })

  it('is a server module: no "use client", no hooks', () => {
    // lucide-react was ruled out because its Icon is a "use client" module: every icon becomes a client
    // reference serialized into the RSC payload. This file exists so that does not happen.
    const source = readFileSync(join(process.cwd(), 'components/icons.tsx'), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

    expect(code).not.toMatch(/['"]use client['"]/)
    expect(code).not.toMatch(/\buse[A-Z]\w*\s*\(/)
  })

  it('keeps the license notices of the path sources (Lucide ISC, Feather MIT)', () => {
    // Both licenses require keeping the copyright notice in every copy. The paths of
    // ArrowDown, ArrowUp, ArrowUpRight, ChevronLeft, ChevronRight, Clock, Link, Rss, Trash2,
    // Upload and X come from Feather, so the MIT notice is needed too.
    const source = readFileSync(join(process.cwd(), 'components/icons.tsx'), 'utf8')

    expect(source).toContain('lucide-static 1.52.0')
    expect(source).toContain('ISC License')
    expect(source).toContain('Copyright (c) 2026 Lucide Icons and Contributors')
    expect(source).toContain('The MIT License (MIT)')
    expect(source).toContain('Copyright (c) 2013-present Cole Bemis')
  })
})
