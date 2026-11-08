import type { ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as icons from '@/components/icons'
import type { IconProps } from '@/components/icons'

/**
 * Recognizes an icon of components/icons.tsx from a rendered <svg>.
 *
 * Recognition is by the body (the paths), not by class or size: two glyphs differ only there.
 * A test that only counts "an <svg aria-hidden> next to the date" stays green when the clock sits next to the date
 * and the calendar next to the reading time — exactly the kind of swap nobody sees in review.
 *
 * The table is built by rendering those very components, so an icon that changes its path in
 * icons.tsx is still recognized, while two tests that wrongly record the same path cannot both be green.
 * The markup string is parsed again through <template> so both sides pass through the DOM serializer.
 */
const BY_BODY: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>()
  for (const [name, value] of Object.entries(icons)) {
    if (!name.endsWith('Icon') || typeof value !== 'function') continue
    const Icon = value as ComponentType<IconProps>
    const template = document.createElement('template')
    template.innerHTML = renderToStaticMarkup(<Icon />)
    const body = template.content.firstElementChild?.innerHTML
    if (!body) throw new Error(`${name} did not render an <svg>`)
    if (map.has(body)) throw new Error(`${name} has the same body as ${map.get(body)}`)
    map.set(body, name)
  }
  return map
})()

/** The export name of the glyph (for example `'CalendarDaysIcon'`), or null when it is not an icon of the set. */
export function glyphName(svg: Element | null | undefined): string | null {
  if (!svg || svg.tagName.toLowerCase() !== 'svg') return null
  return BY_BODY.get(svg.innerHTML) ?? null
}

/** The names of the glyphs in `root`, in document order. Skips an svg that is not an icon (for example cover art). */
export function glyphNames(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll('svg'))
    .map((svg) => glyphName(svg))
    .filter((name): name is string => name !== null)
}
