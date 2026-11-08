/**
 * Cover art generated from the slug: a thumbnail for every post without a cover image, replacing the
 * "text only" post row.
 *
 * Swiss/Bauhaus print style: flat geometry in a single ink, plus its tint and "deep" (the overprint area),
 * on a gray paper background, with the hairlines of a technical drawing (registration cross marks, hatching,
 * connectors, orbits, square nodes). No text, no gradients, no shadows, no photos.
 *
 * A 1:1 port of the visually approved reference (cover-art.mjs of the "reference" variant):
 * the same hash function, the same PRNG, the same order of consuming random numbers, the same coordinates for each recipe. The four
 * differences are the four required fixes of the spec:
 *   1. Drop the `arch` recipe: at hero size it reads as a tombstone or a keyhole. 7 recipes remain, and the two salts
 *      were searched again for 7 recipes (INK_SALT, LAYOUT_SALT).
 *   2. Drop the `blue` ink: next to the brand color it makes the whole picture look like a link. Replaced by
 *      `plum`, and the chroma of every ink is reduced by 15%.
 *   3. Theming by CSS, no `fill="var(...)"` on SVG attributes: see CoverArt.tsx.
 *   4. A 1px non-scaling hairline (`vector-effect`), also in CoverArt.tsx.
 *
 * A pure module, no imports and no `server-only`: the OG route (Node), CoverArt (a server
 * component) and the tests share one source of geometry.
 *
 * Canvas: an 8×4 grid of cells, each 60 units, viewBox 0 0 480 240 (2:1), `xMidYMid slice`. The user's
 * CSS frame decides what shows:
 *   - the 2:1 hero shows all 8 columns; the 5:2 hero (from 640px) cuts 0.4 cell at the top and bottom;
 *   - the 3:2 thumbnail shows columns 1–6 (x 1..7);
 *   - the square tile of the OG card shows columns 2–5 (x 2..6, TILE_VIEWBOX).
 * So the main shape (ink fill) always lies within x 2.2–5.8, y 0.4–3.6, and every secondary shape within columns
 * 1–6; only the cross-mark grid, the hatching strip and the baseline running the full width reach the edge.
 * lib/cover-art.test.ts checks that on 1,000 slugs.
 */

export const COLS = 8
export const ROWS = 4
export const CELL = 60
const W = COLS * CELL
const H = ROWS * CELL

/** The whole canvas, 2:1. */
export const VIEWBOX = `0 0 ${W} ${H}`

/** The square tile of the OG card: columns 2–5. Written as a viewBox instead of letting `slice` crop, because an image embedded
 *  in Satori takes its natural size from the viewBox. */
export const TILE_VIEWBOX = `${2 * CELL} 0 ${4 * CELL} ${H}`

/** Horizontal flip around the canvas middle axis. */
export const MIRROR_TRANSFORM = `matrix(-1 0 0 1 ${W} 0)`

/** Hatching opacity: enough to read as a filled area, lighter than a solid stroke. */
export const HATCH_OPACITY = 0.55

/* ------------------------------------------------------------ hash and random numbers */

/** FNV-1a 32 bit over the UTF-16 code units of the NFC-normalized string: the same Vietnamese
 *  slug typed precomposed or decomposed gives the same cover. */
export function fnv1a32(str: string): number {
  let h = 0x811c9dc5
  const s = str.normalize('NFC')
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32: 32-bit state, returns a float in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Hashes a string into an index in [0, n). Never `fnv1a32(x) % n`: the low bits of
 * FNV-1a only see the low bits of each input byte, so `% n` of two strings sharing a prefix takes very
 * few values (the reference measured: for every salt, the two series always fall into the same pair of
 * recipes). One mulberry32 step mixes everything evenly.
 */
export function hashIndex(str: string, n: number): number {
  return Math.floor(mulberry32(fnv1a32(str))() * n)
}

type Rnd = () => number

const pick = <T>(rnd: Rnd, list: readonly T[]): T => list[Math.floor(rnd() * list.length)]
const coin = (rnd: Rnd, p = 0.5) => rnd() < p

/* ------------------------------------------------------------------------- ink */

export type InkName = 'plum' | 'indigo' | 'teal' | 'moss' | 'ochre' | 'brick'
export type InkRole = 'ink' | 'tint' | 'deep'
export type InkShades = Readonly<Record<InkRole, string>>

/** This order is part of the algorithm: ink = INK_NAMES[hashIndex(INK_SALT + inkKey, 6)].
 *  `plum` stands where `blue` was in the reference. */
export const INK_NAMES: readonly InkName[] = ['plum', 'indigo', 'teal', 'moss', 'ochre', 'brick']

/**
 * The ink table, the only place it exists: CoverArt puts the values into the CSS variables of each <svg>, the OG card
 * writes hex directly. Each value is OKLCH (L, C × 0.85, h) converted to sRGB, the same formula as the
 * reference; C is the reference chroma before the 15% reduction:
 *
 *   ink     h    light: ink / tint / deep (L C)          dark: ink / tint / deep (L C)
 *   plum    340  .54 .11  / .88 .03  / .40 .085         .72 .10  / .39 .045 / .86 .05
 *   indigo  283  .52 .10  / .88 .028 / .39 .08          .72 .09  / .38 .045 / .86 .05
 *   teal    195  .57 .075 / .89 .026 / .42 .06          .74 .075 / .39 .035 / .87 .045
 *   moss    135  .60 .085 / .90 .03  / .44 .065         .75 .08  / .39 .035 / .88 .05
 *   ochre    78  .70 .11  / .92 .035 / .52 .09          .79 .10  / .41 .04  / .90 .055
 *   brick    35  .58 .12  / .89 .03  / .43 .095         .73 .10  / .39 .04  / .87 .05
 *
 * The dark tint is 0.07 L lighter than the reference. At L .31–.34 the tint is only 1.35–1.52:1 on the dark paper
 * `#171717`, so the inner disc and the backing read as a hole or a stain rather than a shape (seen in the dark
 * theme); now 1.77–2.02:1, still ≥ 3.8:1 from the ink.
 *
 * "deep" is the overprint color: darker than the ink in the light theme, lighter in the dark theme (exactly what multiply
 * and screen produce). The shapes are decoration so outside the scope of WCAG 1.4.11; even so every light ink
 * except ochre reaches ≥ 3.5:1 on the paper (ochre 2.5:1), every dark ink ≥ 6.9:1.
 */
export const ART_INKS: Readonly<Record<InkName, { light: InkShades; dark: InkShades }>> = {
  plum: {
    light: { ink: '#935880', tint: '#e4d1dd', deep: '#613754' },
    dark: { ink: '#c990b5', tint: '#533d4b', deep: '#e5c7da' },
  },
  indigo: {
    light: { ink: '#626298', tint: '#d5d6e7', deep: '#404068' },
    dark: { ink: '#9d9fd4', tint: '#3f4056', deep: '#ccceed' },
  },
  teal: {
    light: { ink: '#468383', tint: '#cbe0df', deep: '#275656' },
    dark: { ink: '#7ab8b7', tint: '#324a4a', deep: '#b8dddc' },
  },
  moss: {
    light: { ink: '#6e8a5e', tint: '#d7e2d1', deep: '#455a3a' },
    dark: { ink: '#9cb88d', tint: '#3e4939', deep: '#ccdec2' },
  },
  ochre: {
    light: { ink: '#be9758', tint: '#f0e3cf', deep: '#816332' },
    dark: { ink: '#d9b47b', tint: '#554835', deep: '#efdbbc' },
  },
  brick: {
    light: { ink: '#ae6350', tint: '#ebd5d0', deep: '#753e30' },
    dark: { ink: '#d79583', tint: '#563f39', deep: '#efcbc2' },
  },
}

/**
 * Paper, cross marks and strokes, written as hex. Only coverSvgString (the OG card, preview image) needs them:
 * CoverArt uses Tailwind's neutral-100/300/800 utilities directly (light) and 900/700/200 (dark),
 * and lib/cover-art.test.ts compares the two sides against tailwindcss/theme.css so they do not drift apart.
 */
export const ART_NEUTRALS = {
  light: { paper: '#f5f5f5', grid: '#d4d4d4', mark: '#262626' },
  dark: { paper: '#171717', grid: '#404040', mark: '#e5e5e5' },
} as const

/* ------------------------------------------------------------------------- salt */

/**
 * Two constants chosen once by a search over a fixed list of 12 posts, in list
 * order, with two series assigned. The candidates are `muc:N:` and `bia:N:`; take the best candidate, on a tie the
 * smallest N.
 *
 * INK_SALT: the six ink groups showing up (2 series + 4 categories with standalone posts) get six different
 * inks, and before the series are assigned the six categories do too. Among the salts passing both,
 * choose the one where two adjacent rows with different inks have hues furthest apart (at least 100°): two light
 * warm inks side by side read as one color.
 *
 * LAYOUT_SALT: in list order no recipe more than 2 times, all 7 present, no two adjacent rows
 * with the same recipe, no repeat even with one row in between on page 1 of /writing; the covers of the two
 * series pages use different recipes. One more hard constraint: no two of the 12 posts have the same layout — the same
 * recipe AND every filled shape, in drawing order, within ≤ 0.6 cell of each other after accounting for horizontal
 * flipping (the wedge of one post identical to another's, one flipped with the wedge direction changed, or the pipe of two
 * posts only half a cell apart, is a duplicate). Defined in code: `nearSameComposition` in lib/cover-art.test.ts.
 *
 * Later posts are just random within the same rules: color is a grouping hint, not a legend,
 * so a repeat later on is acceptable. Changing either constant changes the cover of every post.
 */
export const INK_SALT = 'muc:11115:'
export const LAYOUT_SALT = 'bia:35328:'

/* ------------------------------------------------------------------------- shapes */

/** The color of a filled shape: ink, tint or the overprint area. */
export type FillRole = InkRole

/**
 * The shapes of a recipe, coordinates in cells; only `path.d` is already in SVG units (cell × 60), as in the
 * reference. `ring`, `line`, `hatch` are hairlines; `node` is a small square in the stroke color.
 */
export type Shape =
  | { k: 'rect'; x: number; y: number; w: number; h: number; fill: FillRole }
  | { k: 'disc'; cx: number; cy: number; r: number; fill: FillRole }
  | { k: 'path'; d: string; fill: FillRole }
  | { k: 'ring'; cx: number; cy: number; r: number }
  | { k: 'line'; pts: [number, number][] }
  | { k: 'node'; x: number; y: number; s: number }
  | { k: 'hatch'; x: number; y: number; w: number; h: number; dir: 'h' | 'd'; gap: number }

const rect = (x: number, y: number, w: number, h: number, fill: FillRole): Shape => ({ k: 'rect', x, y, w, h, fill })
const disc = (cx: number, cy: number, r: number, fill: FillRole): Shape => ({ k: 'disc', cx, cy, r, fill })
const ring = (cx: number, cy: number, r: number): Shape => ({ k: 'ring', cx, cy, r })
const line = (pts: [number, number][]): Shape => ({ k: 'line', pts })
const node = (x: number, y: number, s = 0.16): Shape => ({ k: 'node', x, y, s })
const hatch = (x: number, y: number, w: number, h: number, dir: 'h' | 'd', gap = 1 / 6): Shape => ({
  k: 'hatch',
  x,
  y,
  w,
  h,
  dir,
  gap,
})
const path = (d: string, fill: FillRole): Shape => ({ k: 'path', d, fill })

/** Cell → SVG units, rounded to 2 digits to keep the markup compact. */
const f = (n: number) => +(n * CELL).toFixed(2)

function quarterPath(px: number, py: number, r: number, sx: number, sy: number): string {
  const sweep = sx * sy > 0 ? 1 : 0
  return `M${f(px)} ${f(py)}L${f(px + sx * r)} ${f(py)}A${f(r)} ${f(r)} 0 0 ${sweep} ${f(px)} ${f(py + sy * r)}Z`
}

/** The lens where two discs of radius r overlap: two arcs, no clipPath, no blend. */
function lensPathXY([ax, ay]: [number, number], [bx, by]: [number, number], r: number): string {
  const dx = bx - ax
  const dy = by - ay
  const d = Math.hypot(dx, dy)
  const mx = ax + dx / 2
  const my = ay + dy / 2
  const h = Math.sqrt(r * r - (d / 2) * (d / 2))
  const nx = -dy / d
  const ny = dx / d
  const p1 = [mx + nx * h, my + ny * h] as const
  const p2 = [mx - nx * h, my - ny * h] as const
  return `M${f(p1[0])} ${f(p1[1])}A${f(r)} ${f(r)} 0 0 1 ${f(p2[0])} ${f(p2[1])}A${f(r)} ${f(r)} 0 0 1 ${f(p1[0])} ${f(p1[1])}Z`
}

function halfPath(cx: number, cy: number, r: number, facing: 'up' | 'down' | 'left' | 'right'): string {
  if (facing === 'up') return `M${f(cx - r)} ${f(cy)}A${f(r)} ${f(r)} 0 0 1 ${f(cx + r)} ${f(cy)}Z`
  if (facing === 'down') return `M${f(cx - r)} ${f(cy)}A${f(r)} ${f(r)} 0 0 0 ${f(cx + r)} ${f(cy)}Z`
  if (facing === 'left') return `M${f(cx)} ${f(cy - r)}A${f(r)} ${f(r)} 0 0 0 ${f(cx)} ${f(cy + r)}Z`
  return `M${f(cx)} ${f(cy - r)}A${f(r)} ${f(r)} 0 0 1 ${f(cx)} ${f(cy + r)}Z`
}

function wedgePath(px: number, py: number, w: number, h: number, sx: number, sy: number): string {
  return `M${f(px)} ${f(py)}L${f(px + sx * w)} ${f(py)}L${f(px)} ${f(py + sy * h)}Z`
}

function diamondPath(cx: number, cy: number, s: number): string {
  return `M${f(cx)} ${f(cy - s)}L${f(cx + s)} ${f(cy)}L${f(cx)} ${f(cy + s)}L${f(cx - s)} ${f(cy)}Z`
}

/* ---------------------------------------------------------------------- recipe */

// 1. Orbit: a large ink disc with a hairline orbit, plus either a tint slab lying on the back half of the
//    disc, or a small moon on the orbit, or a second concentric orbit.
function orbit(rnd: Rnd): Shape[] {
  const cx = pick(rnd, [3.75, 4, 4.25])
  const R = pick(rnd, [1.25, 1.5])
  const left = coin(rnd)
  const companion = pick(rnd, ['slab', 'moon', 'rings'] as const)
  const out: Shape[] = []
  if (companion !== 'rings' && coin(rnd, 0.5)) out.push(hatch(0, 3.25, 8, 0.75, 'h'))
  if (companion === 'slab') {
    const w = pick(rnd, [2.5, 3])
    out.push(rect(left ? cx - R - 0.5 : cx + R + 0.5 - w, 2.5, w, 1, 'tint'))
  }
  out.push(disc(cx, 2, R, 'ink'))
  const ox = companion === 'rings' ? 0 : left ? 0.5 : -0.5
  const oy = companion === 'rings' ? 0 : -0.25
  out.push(ring(cx + ox, 2 + oy, R + 0.5))
  if (companion === 'rings') out.push(ring(cx, 2, R + 0.25))
  const a = left ? -Math.PI / 4 : (-3 * Math.PI) / 4
  const px = cx + ox + (R + 0.5) * Math.cos(a)
  const py = 2 + oy + (R + 0.5) * Math.sin(a)
  if (companion === 'moon') out.push(disc(px, py, 0.32, pick(rnd, ['deep', 'tint'] as const)))
  else out.push(node(px, py))
  return out
}

// 2. Bloom: a 2×2 block of Bauhaus-style quadrants, a hatching column on one side, a
//    connector ending in a node on the other.
function bloom(rnd: Rnd): Shape[] {
  const x0 = pick(rnd, [2.5, 3, 3.5])
  const y0 = 1
  const mode = pick(rnd, ['pie', 'star', 'wave', 'pinwheel'] as const)
  const colours = pick(rnd, [
    ['ink', 'tint', 'deep', 'ink'],
    ['tint', 'ink', 'ink', 'deep'],
    ['ink', 'deep', 'tint', 'ink'],
  ] as const)
  const cells: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ]
  const out: Shape[] = []
  const toRight = x0 < 3.5 // the connector runs right, the hatching column is on the other side
  out.push(hatch(toRight ? x0 - 1 : x0 + 2, y0, 1, 2, 'd'))
  cells.forEach(([i, j], n) => {
    const cx = x0 + i
    const cy = y0 + j
    let px: number, py: number, sx: number, sy: number
    if (mode === 'pie') {
      px = x0 + 1
      py = y0 + 1
      sx = i ? 1 : -1
      sy = j ? 1 : -1
    } else if (mode === 'star') {
      px = i ? cx + 1 : cx
      py = j ? cy + 1 : cy
      sx = i ? -1 : 1
      sy = j ? -1 : 1
    } else if (mode === 'wave') {
      px = cx
      py = cy + 1
      sx = 1
      sy = -1
    } else {
      const rot = [
        [0, 1, 1, -1],
        [1, 1, -1, -1],
        [1, 0, -1, 1],
        [0, 0, 1, 1],
      ][n]
      px = cx + rot[0]
      py = cy + rot[1]
      sx = rot[2]
      sy = rot[3]
    }
    out.push(path(quarterPath(px, py, 1, sx, sy), colours[n]))
  })
  const yLine = pick(rnd, [1.5, 2.5])
  const xa = toRight ? x0 + 2 : x0
  const xb = toRight ? 6.5 : 1.5
  out.push(
    line([
      [xa, yLine],
      [xb, yLine],
    ]),
  )
  out.push(node(xb, yLine))
  return out
}

// 3. Pipeline: source station, queue, worker joined by a hairline — the blog's own subject
//    drawn with three shapes.
function pipeline(rnd: Rnd): Shape[] {
  const yb = pick(rnd, [1.75, 2, 2.25])
  const ya = yb + pick(rnd, [-0.5, 0.5])
  const out: Shape[] = []
  out.push(
    line([
      [1.75, ya],
      [2.75, ya],
      [2.75, yb],
      [6.25, yb],
    ]),
  )
  out.push(rect(1.3, ya - 0.45, 0.9, 0.9, 'tint'))
  // three messages queuing up
  for (let i = 0; i < 3; i++) out.push(rect(2.9 + i * 0.26, yb - 0.09, 0.18, 0.18, 'deep'))
  out.push(disc(4.25, yb, 1, 'ink'))
  out.push(path(diamondPath(6.25, yb, 0.5), 'deep'))
  if (coin(rnd, 0.5)) out.push(hatch(3.25, 3.25, 2, 0.75, 'd'))
  out.push(node(1.75, ya))
  return out
}

// 4. Wedge: a right triangle, a disc resting on the hypotenuse.
function wedge(rnd: Rnd): Shape[] {
  const x = 2.5
  const sx = coin(rnd) ? 1 : -1
  const sy = coin(rnd) ? 1 : -1
  const px = sx > 0 ? x : x + 3
  const py = sy > 0 ? 0.5 : 3.5
  const out: Shape[] = []
  const hxCol = sx > 0 ? x + 2 : x
  out.push(hatch(hxCol, sy > 0 ? 2.5 : 0.5, 1, 1, 'd'))
  out.push(path(wedgePath(px, py, 3, 3, sx, sy), 'ink'))
  // the disc touches the hypotenuse, on the open side
  const r = 0.7
  const mx = px + (sx * 3) / 2
  const my = py + (sy * 3) / 2
  const nx = sx / Math.SQRT2
  const ny = sy / Math.SQRT2
  out.push(disc(mx + nx * (r + 0.05), my + ny * (r + 0.05), r, 'tint'))
  out.push(ring(mx + nx * (r + 0.05), my + ny * (r + 0.05), r + 0.35))
  out.push(node(px, py))
  return out
}

// 5. Eclipse: two overprinted discs; the lens where they overlap is the "deep". The axis is
//    horizontal or tilted 35° to one side.
function eclipse(rnd: Rnd): Shape[] {
  const d = pick(rnd, [0.9, 1.1])
  const R = pick(rnd, [1.1, 1.25])
  const tilt = pick(rnd, [0, 0, 35, -35]) * (Math.PI / 180)
  const ux = Math.cos(tilt)
  const uy = Math.sin(tilt)
  const a: [number, number] = [4 - (ux * d) / 2, 2 - (uy * d) / 2]
  const b: [number, number] = [4 + (ux * d) / 2, 2 + (uy * d) / 2]
  const swap = coin(rnd)
  const out: Shape[] = []
  if (tilt === 0) {
    out.push(
      line([
        [0.5, 2],
        [7.5, 2],
      ]),
    )
  } else {
    out.push(
      line([
        [4 - ux * 2.6, 2 - uy * 2.6],
        [4 + ux * 2.6, 2 + uy * 2.6],
      ]),
    )
  }
  if (coin(rnd, 0.5)) out.push(hatch(0, 3.25, 8, 0.75, 'h'))
  const [tc, ic] = swap ? [b, a] : [a, b]
  out.push(disc(tc[0], tc[1], R, 'tint'))
  out.push(disc(ic[0], ic[1], R, 'ink'))
  out.push(path(lensPathXY(a, b, R), 'deep'))
  if (tilt === 0) {
    out.push(node(1.25, 2))
    out.push(node(6.75, 2))
  } else {
    out.push(node(4 - ux * 2.6, 2 - uy * 2.6))
    out.push(node(4 + ux * 2.6, 2 + uy * 2.6))
  }
  return out
}

// 6. Steps: one continuous staircase block (not three bars: three bars read as a chart), a tint
//    sun above the low end, a ball waiting at the foot. Flipped horizontally for the downward direction.
function steps(rnd: Rnd): Shape[] {
  const x0 = 2.5
  const out: Shape[] = []
  if (coin(rnd, 0.6)) out.push(hatch(0, 3.5, 8, 0.5, 'h'))
  out.push(disc(x0 + 0.75, 1.15, pick(rnd, [0.5, 0.65]), 'tint'))
  const d = `M${f(x0)} ${f(3.5)}V${f(2.5)}H${f(x0 + 1)}V${f(1.5)}H${f(x0 + 2)}V${f(0.5)}H${f(x0 + 3)}V${f(3.5)}Z`
  out.push(path(d, 'ink'))
  out.push(hatch(x0 + 1, 1.5, 1, 2, 'd'))
  out.push(disc(x0 - 0.5, 3, 0.5, pick(rnd, ['deep', 'tint'] as const)))
  out.push(
    line([
      [0.5, 3.5],
      [7.5, 3.5],
    ]),
  )
  out.push(node(6.5, 3.5))
  return out
}

// 7. Sampler: a 3×2 sample sheet of the shape set itself, Swiss grid style, with paper gaps between cells.
function sampler(rnd: Rnd): Shape[] {
  const x0 = 2.5
  const y0 = 1
  const g = 0.06
  const kinds = ['square', 'quarter', 'disc', 'hatch', 'half', 'square2']
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[kinds[i], kinds[j]] = [kinds[j], kinds[i]]
  }
  const out: Shape[] = []
  kinds.forEach((kind, n) => {
    const x = x0 + (n % 3)
    const y = y0 + Math.floor(n / 3)
    if (kind === 'square') out.push(rect(x + g, y + g, 1 - 2 * g, 1 - 2 * g, 'ink'))
    else if (kind === 'square2') out.push(rect(x + g, y + g, 1 - 2 * g, 1 - 2 * g, 'tint'))
    else if (kind === 'quarter') out.push(path(quarterPath(x + g, y + 1 - g, 1 - 2 * g, 1, -1), 'deep'))
    else if (kind === 'disc') out.push(disc(x + 0.5, y + 0.5, 0.5 - g, 'ink'))
    else if (kind === 'half') out.push(path(halfPath(x + 0.5, y + 1 - g, 0.5 - g, 'up'), 'tint'))
    else out.push(hatch(x + g, y + g, 1 - 2 * g, 1 - 2 * g, 'd'))
  })
  const toRight = coin(rnd)
  out.push(
    line([
      [toRight ? x0 + 3 : x0, 2],
      [toRight ? 6.5 : 1.5, 2],
    ]),
  )
  out.push(node(toRight ? 6.5 : 1.5, 2))
  return out
}

export type RecipeId = 'orbit' | 'bloom' | 'pipeline' | 'wedge' | 'eclipse' | 'steps' | 'sampler'

/** This order is also part of the algorithm (the recipe index). The reference's `arch` sat
 *  between bloom and pipeline; dropping it moves the later recipes up one place. */
const RECIPES: readonly { id: RecipeId; draw: (rnd: Rnd) => Shape[] }[] = [
  { id: 'orbit', draw: orbit },
  { id: 'bloom', draw: bloom },
  { id: 'pipeline', draw: pipeline },
  { id: 'wedge', draw: wedge },
  { id: 'eclipse', draw: eclipse },
  { id: 'steps', draw: steps },
  { id: 'sampler', draw: sampler },
]

export const RECIPE_IDS: readonly RecipeId[] = RECIPES.map((r) => r.id)

/* ------------------------------------------------------------------- layout */

export type CoverInput = {
  slug: string
  /** Key for choosing the ink: the series, otherwise the category, otherwise the slug itself. */
  inkKey: string
  /** `position` is the stored position, not "Part n": the cover does not change when another part of the
   *  series is published or unpublished. */
  series: { slug: string; position: number } | null
}

export type CoverSpec = { recipe: RecipeId; ink: InkName; mirror: boolean; shapes: Shape[] }

/**
 * The input of a post's cover. The parts of a series share an ink (recognizably one family in the
 * list), a standalone post takes the ink of its category; the layout always comes from the slug.
 */
export function coverInputOf(post: {
  slug: string
  category?: { slug: string } | null
  series?: { slug: string; position: number } | null
}): CoverInput {
  return {
    slug: post.slug,
    inkKey: post.series?.slug ?? post.category?.slug ?? post.slug,
    series: post.series ? { slug: post.series.slug, position: post.series.position } : null,
  }
}

/**
 * The cover of a series page: the same ink as its parts. The slug contains a colon so it cannot
 * collide with a post slug (post slugs only have lowercase letters, digits and hyphens). With the recipe calculation below,
 * its recipe is "part 0", different from the recipes of the first six parts.
 */
export function seriesCoverInput(series: { slug: string }): CoverInput {
  return { slug: `series:${series.slug}`, inkKey: series.slug, series: null }
}

/**
 * Order of consuming random numbers (changing it changes every cover):
 *   1. rnd = mulberry32(fnv1a32(LAYOUT_SALT + slug))
 *   2. recipe: in a series it is (hashIndex(LAYOUT_SALT + 'series:' + series slug, 7) + position)
 *      mod 7, then discard one rnd() — consecutive parts get consecutive, different recipes; outside a
 *      series it is floor(rnd() × 7)
 *   3. horizontal flip = rnd() < 0.5
 *   4. the recipe uses the rest
 *   5. ink = INK_NAMES[hashIndex(INK_SALT + inkKey, 6)], does not touch rnd
 */
export function composeCover(input: CoverInput): CoverSpec {
  const rnd = mulberry32(fnv1a32(LAYOUT_SALT + input.slug))
  const n = RECIPES.length
  const series = input.series
  let index: number
  // An odd `position` (not an integer) takes the no-series path instead of throwing: a decorative shape
  // must not bring down the whole page.
  if (series && Number.isSafeInteger(series.position)) {
    const base = hashIndex(LAYOUT_SALT + 'series:' + series.slug, n)
    index = (((base + series.position) % n) + n) % n
    rnd() // keep the random stream aligned with the no-series branch
  } else {
    index = Math.floor(rnd() * n)
  }
  const recipe = RECIPES[index]
  const mirror = coin(rnd)
  const shapes = recipe.draw(rnd)
  const ink = INK_NAMES[hashIndex(INK_SALT + input.inkKey, INK_NAMES.length)]
  return { recipe: recipe.id, ink, mirror, shapes }
}

/* ---------------------------------------------------------- elements to draw */

/** The color role of a drawn element: the three ink colors, or the stroke color (node fill, solid stroke, hatching). */
export type Paint = InkRole | 'mark' | 'hairline' | 'hatching'

/** An SVG element, coordinates already in SVG units. The two renderings (CoverArt and coverSvgString) differ only
 *  in how they color; the geometry lives here, in one place. */
export type CoverElement =
  | { tag: 'rect'; x: number; y: number; width: number; height: number; paint: Paint }
  | { tag: 'circle'; cx: number; cy: number; r: number; paint: Paint }
  | { tag: 'path'; d: string; paint: Paint }

function hatchPath(s: Extract<Shape, { k: 'hatch' }>): string {
  const gap = s.gap
  let d = ''
  if (s.dir === 'h') {
    for (let y = s.y + gap / 2; y < s.y + s.h; y += gap) d += `M${f(s.x)} ${f(y)}H${f(s.x + s.w)}`
  } else {
    // the 45° lines x + y = k, clipped to a rectangle
    const step = gap * Math.SQRT2
    for (let k = s.x + s.y + step / 2; k < s.x + s.w + s.y + s.h; k += step) {
      const x1 = Math.max(s.x, k - (s.y + s.h))
      const x2 = Math.min(s.x + s.w, k - s.y)
      if (x2 - x1 > 0.01) d += `M${f(x1)} ${f(k - x1)}L${f(x2)} ${f(k - x2)}`
    }
  }
  return d
}

/** The shapes of the cover turned into SVG elements, in exactly the recipe's drawing order. */
export function coverElements(spec: CoverSpec): CoverElement[] {
  return spec.shapes.map((s): CoverElement => {
    switch (s.k) {
      case 'rect':
        return { tag: 'rect', x: f(s.x), y: f(s.y), width: f(s.w), height: f(s.h), paint: s.fill }
      case 'disc':
        return { tag: 'circle', cx: f(s.cx), cy: f(s.cy), r: f(s.r), paint: s.fill }
      case 'path':
        return { tag: 'path', d: s.d, paint: s.fill }
      case 'ring':
        return { tag: 'circle', cx: f(s.cx), cy: f(s.cy), r: f(s.r), paint: 'hairline' }
      case 'line':
        return { tag: 'path', d: `M${s.pts.map(([x, y]) => `${f(x)} ${f(y)}`).join('L')}`, paint: 'hairline' }
      case 'hatch':
        return { tag: 'path', d: hatchPath(s), paint: 'hatching' }
      case 'node':
        return { tag: 'rect', x: f(s.x - s.s / 2), y: f(s.y - s.s / 2), width: f(s.s), height: f(s.s), paint: 'mark' }
    }
  })
}

/**
 * Registration cross marks at the 21 inner intersections of the grid, arms ±4 units: one path. Each
 * row opens with an absolute command, later marks move relatively (`m56-4h8m-4-4v8`): the same shape
 * as the reference, a quarter shorter — this path repeats in every row of every list.
 */
export const CROSSES_D = (() => {
  const arm = 4
  const cross = `h${2 * arm}m-${arm}-${arm}v${2 * arm}`
  let d = ''
  for (let j = 1; j < ROWS; j++) {
    d += `M${CELL - arm} ${j * CELL}${cross}`
    for (let i = 2; i < COLS; i++) d += `m${CELL - arm}-${arm}${cross}`
  }
  return d
})()

/**
 * The cover as a standalone SVG string, colors written directly as hex: for the OG card (Satori has no stylesheet
 * to resolve var(), and resvg may not support `vector-effect`, so the stroke width is baked in
 * with `hairline`, a viewBox unit) and for the preview image. On the page use CoverArt.
 */
export function coverSvgString(spec: CoverSpec, opts: { theme: 'light' | 'dark'; viewBox?: string; hairline?: number }): string {
  const inks = ART_INKS[spec.ink][opts.theme]
  const neutral = ART_NEUTRALS[opts.theme]
  const hair = opts.hairline ?? 1
  const paint = (p: Paint): string => {
    if (p === 'hairline') return `fill="none" stroke="${neutral.mark}" stroke-width="${hair}"`
    if (p === 'hatching') {
      return `fill="none" stroke="${neutral.mark}" stroke-opacity="${HATCH_OPACITY}" stroke-width="${hair}"`
    }
    return `fill="${p === 'mark' ? neutral.mark : inks[p]}"`
  }
  let shapes = ''
  for (const e of coverElements(spec)) {
    if (e.tag === 'rect') shapes += `<rect x="${e.x}" y="${e.y}" width="${e.width}" height="${e.height}" ${paint(e.paint)}/>`
    else if (e.tag === 'circle') shapes += `<circle cx="${e.cx}" cy="${e.cy}" r="${e.r}" ${paint(e.paint)}/>`
    else shapes += `<path d="${e.d}" ${paint(e.paint)}/>`
  }
  if (spec.mirror) shapes = `<g transform="${MIRROR_TRANSFORM}">${shapes}</g>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${opts.viewBox ?? VIEWBOX}" preserveAspectRatio="xMidYMid slice">` +
    `<rect width="${W}" height="${H}" fill="${neutral.paper}"/>` +
    `<path d="${CROSSES_D}" fill="none" stroke="${neutral.grid}" stroke-width="${hair}"/>` +
    `${shapes}</svg>`
  )
}
