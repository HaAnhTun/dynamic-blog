import type { CSSProperties } from 'react'
import {
  ART_INKS,
  CROSSES_D,
  HATCH_OPACITY,
  MIRROR_TRANSFORM,
  VIEWBOX,
  composeCover,
  coverElements,
  type CoverElement,
  type CoverInput,
  type Paint,
} from '@/lib/cover-art'

/**
 * The automatically generated cover of a post (or a series), drawn as inline SVG on the server: no request,
 * no JS to the browser, no layout shift. The geometry is in lib/cover-art.ts; this file only
 * decides how to color it.
 *
 * Theme by plain CSS, no second render:
 * - The <svg class="cover-art"> tag carries the six colors of the assigned ink in its inline style:
 *   `--ink-l/--ink-d`, `--tint-l/--tint-d`, `--deep-l/--deep-d`. Two `.cover-art` rules in
 *   app/globals.css choose the light or dark set as `--ink/--tint/--deep`.
 * - Shapes are filled with the literal class `fill-(--ink)`… and not with an attribute `fill="var(...)"`:
 *   var() in an SVG presentation attribute has uneven support, and the ink table then lives in
 *   one place (lib/cover-art.ts), not a block of variables repeated in CSS.
 * - The paper, crosshair and strokes use the existing neutral utilities, so they follow `dark:` like everything else.
 * - Every class is written verbatim here: Tailwind only generates CSS for strings it sees in the source.
 *
 * Strokes are always `stroke-width="1"` + `vector-effect="non-scaling-stroke"`: exactly 1 CSS px at every size, even
 * when the canvas is zoomed or cropped — the very hairline of the site.
 *
 * Purely decorative: `aria-hidden`, `focusable="false"`, no text, no <title>. The title
 * right next to it already says what the post is. No id, because the same post can appear twice on one page.
 *
 * The frame (ratio, `border-neutral-200 dark:border-neutral-800` border, `rounded-md`, overflow) belongs to
 * the caller; the <svg> only fills it and `xMidYMid slice` crops the excess.
 */

/** The class for each color role. The two stroke roles share a class, differing in opacity. */
const PAINT_CLASS: Record<Paint, string> = {
  ink: 'fill-(--ink)',
  tint: 'fill-(--tint)',
  deep: 'fill-(--deep)',
  mark: 'fill-neutral-800 dark:fill-neutral-200',
  hairline: 'stroke-neutral-800 dark:stroke-neutral-200',
  hatching: 'stroke-neutral-800 dark:stroke-neutral-200',
}

const PAPER_CLASS = 'fill-neutral-100 dark:fill-neutral-900'
const CROSSES_CLASS = 'stroke-neutral-300 dark:stroke-neutral-700'

/**
 * `vector-effect` is not inherited so it sits on every stroke. `fill="none"` and `stroke-width="1"`
 * are inherited, so they are set once on the <svg>: filled shapes take their color from a class (a class beats the inherited
 * value), strokes have no fill class so they keep `none`. A cover repeats on every row of every list, and
 * those two attributes on each stroke are ~30 bytes each time.
 */
const NON_SCALING = 'non-scaling-stroke'

type PaintProps = { className: string; vectorEffect?: string; strokeOpacity?: number }

function paintProps(paint: Paint): PaintProps {
  if (paint === 'hairline') return { className: PAINT_CLASS.hairline, vectorEffect: NON_SCALING }
  if (paint === 'hatching') {
    return { className: PAINT_CLASS.hatching, vectorEffect: NON_SCALING, strokeOpacity: HATCH_OPACITY }
  }
  return { className: PAINT_CLASS[paint] }
}

function renderElement(e: CoverElement, key: number) {
  const paint = paintProps(e.paint)
  if (e.tag === 'rect') return <rect key={key} x={e.x} y={e.y} width={e.width} height={e.height} {...paint} />
  if (e.tag === 'circle') return <circle key={key} cx={e.cx} cy={e.cy} r={e.r} {...paint} />
  return <path key={key} d={e.d} {...paint} />
}

export function CoverArt({ input, className }: { input: CoverInput; className?: string }) {
  const spec = composeCover(input)
  const { light, dark } = ART_INKS[spec.ink]
  const inks = {
    '--ink-l': light.ink,
    '--ink-d': dark.ink,
    '--tint-l': light.tint,
    '--tint-d': dark.tint,
    '--deep-l': light.deep,
    '--deep-d': dark.deep,
  } as CSSProperties

  const shapes = coverElements(spec).map(renderElement)

  return (
    <svg
      viewBox={VIEWBOX}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
      fill="none"
      strokeWidth={1}
      className={className ? `cover-art block h-full w-full ${className}` : 'cover-art block h-full w-full'}
      style={inks}
    >
      <rect width={480} height={240} className={PAPER_CLASS} />
      <path d={CROSSES_D} className={CROSSES_CLASS} vectorEffect={NON_SCALING} />
      {spec.mirror ? <g transform={MIRROR_TRANSFORM}>{shapes}</g> : shapes}
    </svg>
  )
}
