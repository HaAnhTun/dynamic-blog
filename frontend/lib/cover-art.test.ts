// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ART_INKS,
  ART_NEUTRALS,
  CELL,
  COLS,
  INK_NAMES,
  INK_SALT,
  LAYOUT_SALT,
  RECIPE_IDS,
  ROWS,
  TILE_VIEWBOX,
  composeCover,
  coverElements,
  coverInputOf,
  coverSvgString,
  fnv1a32,
  hashIndex,
  seriesCoverInput,
  type CoverInput,
  type CoverSpec,
  type InkName,
  type RecipeId,
  type Shape,
} from './cover-art'
import type { SeriesRef } from './types'
import { msg } from '@/test/render-intl'
import { SLUG_BE_TAC } from '@/test/fixtures/vi/accented-text'

/**
 * Cover art generated from the slug. The visually approved reference is `cover-art.mjs` of the
 * "reference" variant; this file pins what the port must keep and the four things the spec required fixing: drop
 * the `arch` recipe, drop the `blue` ink, lower the chroma, no `fill="var(...)"` (that part is in CoverArt.test).
 */

const XAY = 'series-f'
const PIPE = 'series-e'

type Fixture = { slug: string; category: string; series: { slug: string; position: number } | null }

/**
 * 12 neutral sample posts in a fixed list order (the order the API returns them: publishedAt descending), with two
 * series assigned — the state the salt was chosen against.
 */
const POSTS: Fixture[] = [
  {
    slug: 'sample-post-12-amber',
    category: 'kien-truc',
    series: { slug: PIPE, position: 3 },
  },
  { slug: 'sample-post-11', category: 'kien-truc', series: { slug: PIPE, position: 2 } },
  { slug: 'sample-post-10-amber', category: 'go-loi', series: null },
  { slug: 'sample-post-07-ember', category: 'kiem-thu', series: null },
  {
    slug: 'sample-post-06',
    category: 'cach-toi-lam-viec',
    series: { slug: XAY, position: 4 },
  },
  { slug: 'sample-post-05-cedar', category: 'kien-truc', series: { slug: PIPE, position: 1 } },
  { slug: 'sample-post-04', category: 'kien-truc', series: null },
  { slug: 'sample-post-03', category: 'cach-toi-lam-viec', series: null },
  { slug: 'sample-post-01-harbor', category: 'cach-toi-lam-viec', series: null },
  {
    slug: 'sample-post-09',
    category: 'ky-thuat-frontend',
    series: { slug: XAY, position: 2 },
  },
  {
    slug: 'sample-post-08',
    category: 'ky-thuat-backend',
    series: { slug: XAY, position: 3 },
  },
  {
    slug: 'sample-post-02',
    category: 'cach-toi-lam-viec',
    series: { slug: XAY, position: 1 },
  },
]

/** Post shape as the API returns it (only the fields coverInputOf reads). */
const asPost = (p: Fixture) => ({ slug: p.slug, category: { slug: p.category }, series: p.series })

const specOf = (p: Fixture) => composeCover(coverInputOf(asPost(p)))

/**
 * Centroid of the vertices of a path (SVG units → cells): M/L/H/V and the end point of A. The vertex centroid, not
 * the center of the bounding box: a right triangle pointing left and one pointing right have the same bounding box.
 */
function pathCentre(d: string): [number, number] {
  const pts: [number, number][] = []
  let x = 0
  let y = 0
  for (const [, cmd, args] of d.matchAll(/([MLAHVZ])([^MLAHVZ]*)/g)) {
    const n = args!.trim()
      ? args!
          .trim()
          .split(/[\s,]+/)
          .map(Number)
      : []
    if (cmd === 'M' || cmd === 'L') for (let i = 0; i + 1 < n.length; i += 2) pts.push([(x = n[i]!), (y = n[i + 1]!)])
    else if (cmd === 'H') for (const v of n) pts.push([(x = v), y])
    else if (cmd === 'V') for (const v of n) pts.push([x, (y = v)])
    else if (cmd === 'A') for (let i = 0; i + 6 < n.length; i += 7) pts.push([(x = n[i + 5]!), (y = n[i + 6]!)])
  }
  const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length / CELL
  return [mean(pts.map((p) => p[0])), mean(pts.map((p) => p[1]))]
}

/**
 * Two covers with "the same layout": the same recipe, the same sequence of filled shapes (kind and color role, in drawing order), and
 * the center of each shape differing by ≤ 0.6 cell after accounting for horizontal flipping (x → 8 − x). Thin strokes, hatching and
 * ink color do not count: the same shape in another color is still the same cover. This is the hard constraint of the search for
 * LAYOUT_SALT (lib/cover-art.ts).
 */
function nearSameComposition(a: CoverSpec, b: CoverSpec): boolean {
  if (a.recipe !== b.recipe) return false
  const filled = (spec: CoverSpec) =>
    spec.shapes.flatMap((s) => {
      let c: [number, number]
      if (s.k === 'rect') c = [s.x + s.w / 2, s.y + s.h / 2]
      else if (s.k === 'disc') c = [s.cx, s.cy]
      else if (s.k === 'path') c = pathCentre(s.d)
      else return []
      return [{ k: s.k, fill: s.fill, x: spec.mirror ? COLS - c[0] : c[0], y: c[1] }]
    })
  const fa = filled(a)
  const fb = filled(b)
  return (
    fa.length === fb.length &&
    fa.every((s, i) => s.k === fb[i]!.k && s.fill === fb[i]!.fill && Math.hypot(s.x - fb[i]!.x, s.y - fb[i]!.y) <= 0.6)
  )
}

describe('lib/cover-art: input', () => {
  it('ink by series first, then category, then the slug itself', () => {
    expect(coverInputOf({ slug: 'a', category: { slug: 'kien-truc' }, series: { slug: XAY, position: 2 } })).toEqual({
      slug: 'a',
      inkKey: XAY,
      series: { slug: XAY, position: 2 },
    })
    expect(coverInputOf({ slug: 'a', category: { slug: 'kien-truc' }, series: null })).toEqual({
      slug: 'a',
      inkKey: 'kien-truc',
      series: null,
    })
    // A post missing both (old fixture, broken data) still gets a cover, without throwing.
    expect(coverInputOf({ slug: 'a' })).toEqual({ slug: 'a', inkKey: 'a', series: null })
  })

  it('takes only the slug and position of the series, not the rest of SeriesRef', () => {
    const ref: SeriesRef = { id: 'x', slug: XAY, title: 'Series A', position: 3, partNumber: 2, partCount: 4 }
    const input = coverInputOf({ slug: 'a', category: null, series: ref })
    // `position` (the stored position) rather than `partNumber`: the cover does not change when another part
    // of the series is published or unpublished.
    expect(input.series).toEqual({ slug: XAY, position: 3 })
  })

  it('series page cover: its own slug, the same ink as its parts, not going down the series path', () => {
    expect(seriesCoverInput({ slug: XAY })).toEqual({ slug: `series:${XAY}`, inkKey: XAY, series: null })
    const part = specOf(POSTS[4]!)
    expect(composeCover(seriesCoverInput({ slug: XAY })).ink).toBe(part.ink)
  })
})

describe('lib/cover-art: deterministic', () => {
  it('the same input gives exactly the same cover, a different slug gives a different cover', () => {
    const input: CoverInput = { slug: 'sample-post-05-cedar', inkKey: 'kien-truc', series: null }
    expect(composeCover(input)).toEqual(composeCover({ ...input }))
    expect(JSON.stringify(composeCover({ ...input, slug: 'sample-post-13' }))).not.toBe(JSON.stringify(composeCover(input)))
  })

  it('NFC hashing: a precomposed slug and a decomposed slug give the same cover', () => {
    const nfc = SLUG_BE_TAC.normalize('NFC')
    const nfd = SLUG_BE_TAC.normalize('NFD')
    expect(nfd).not.toBe(nfc)
    expect(composeCover({ slug: nfd, inkKey: nfd, series: null })).toEqual(composeCover({ slug: nfc, inkKey: nfc, series: null }))
  })

  it('FNV-1a 32 bit matches the standard vectors, and hashIndex always lies in [0, n)', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5)
    expect(fnv1a32('a')).toBe(0xe40c292c)
    expect(fnv1a32('foobar')).toBe(0xbf9cf968)
    for (let i = 0; i < 200; i++) {
      const v = hashIndex(`k-${i}`, 7)
      expect(Number.isInteger(v) && v >= 0 && v < 7).toBe(true)
    }
  })
})

describe('lib/cover-art: 12 sample posts (golden, pins the salt)', () => {
  it('the salt is two constants chosen by search', () => {
    // Changing either one changes the cover of every post. The search must be rerun and the table below fixed.
    expect(INK_SALT).toBe('muc:11115:')
    expect(LAYOUT_SALT).toBe('bia:35328:')
  })

  const GOLDEN: [string, RecipeId, InkName, boolean][] = [
    ['sample-post-12-amber', 'sampler', 'teal', false],
    ['sample-post-11', 'steps', 'teal', false],
    ['sample-post-10-amber', 'orbit', 'plum', true],
    ['sample-post-07-ember', 'pipeline', 'moss', true],
    ['sample-post-06', 'wedge', 'brick', true],
    ['sample-post-05-cedar', 'eclipse', 'teal', true],
    ['sample-post-04', 'bloom', 'ochre', true],
    ['sample-post-03', 'steps', 'indigo', true],
    ['sample-post-01-harbor', 'sampler', 'indigo', true],
    ['sample-post-09', 'bloom', 'brick', true],
    ['sample-post-08', 'pipeline', 'brick', false],
    ['sample-post-02', 'orbit', 'brick', false],
  ]

  it('each post gets exactly the approved recipe, ink and flip direction', () => {
    expect(GOLDEN.map((g) => g[0])).toEqual(POSTS.map((p) => p.slug))
    const actual = POSTS.map((p) => {
      const s = specOf(p)
      return [p.slug, s.recipe, s.ink, s.mirror]
    })
    expect(actual).toEqual(GOLDEN)
  })

  it('covers of the two series pages', () => {
    const xay = composeCover(seriesCoverInput({ slug: XAY }))
    const pipe = composeCover(seriesCoverInput({ slug: PIPE }))
    expect([xay.recipe, xay.ink, xay.mirror]).toEqual(['sampler', 'brick', false])
    expect([pipe.recipe, pipe.ink, pipe.mirror]).toEqual(['wedge', 'teal', true])
  })

  it('no two posts share a layout: with the same recipe the filled shapes must differ by more than 0.6 cell after accounting for flipping', () => {
    // An earlier salt produced pairs that looked identical on the page: the same wedge once flipped with its direction
    // changed, or the same pipe only half a cell apart. A different color does not save it: the same shape is the same cover.
    const specs = POSTS.map(specOf)
    const pairs: string[] = []
    for (let i = 0; i < specs.length; i++) {
      for (let j = i + 1; j < specs.length; j++) {
        if (nearSameComposition(specs[i]!, specs[j]!)) pairs.push(`${POSTS[i]!.slug} + ${POSTS[j]!.slug}`)
      }
    }
    expect(pairs).toEqual([])
  })

  it('the layout comparer catches duplicate covers (negative control): itself, half a cell apart, flipped together with a direction change', () => {
    const spec = specOf(POSTS[0]!)
    expect(nearSameComposition(spec, spec)).toBe(true)
    // Flipping the whole picture is a different layout (the shape runs toward the other side).
    expect(nearSameComposition(spec, { ...spec, mirror: !spec.mirror })).toBe(false)
    // A right-pointing wedge unflipped ≡ a left-pointing wedge flipped: the same shape, the comparer must see it.
    const wedge = (sx: 1 | -1, mirror: boolean): CoverSpec => ({
      recipe: 'wedge',
      ink: 'teal',
      mirror,
      shapes: [{ k: 'path', d: sx > 0 ? 'M150 30L330 30L150 210Z' : 'M330 30L150 30L330 210Z', fill: 'ink' }],
    })
    expect(nearSameComposition(wedge(1, false), wedge(-1, true))).toBe(true)
    expect(nearSameComposition(wedge(1, false), wedge(-1, false))).toBe(false)
    // Half a cell vertically is still the same layout; one cell is not.
    const disc = (cy: number): CoverSpec => ({
      recipe: 'orbit',
      ink: 'teal',
      mirror: false,
      shapes: [{ k: 'disc', cx: 4, cy, r: 1, fill: 'ink' }],
    })
    expect(nearSameComposition(disc(1.75), disc(2.25))).toBe(true)
    expect(nearSameComposition(disc(1.5), disc(2.5))).toBe(false)
  })

  it('in API order: no recipe more than 2 times, all 7 recipes present, no two adjacent rows with the same recipe', () => {
    const recipes = POSTS.map((p) => specOf(p).recipe)
    const counts = new Map<RecipeId, number>()
    for (const r of recipes) counts.set(r, (counts.get(r) ?? 0) + 1)

    expect(Math.max(...counts.values())).toBeLessThanOrEqual(2)
    expect([...counts.keys()].sort()).toEqual([...RECIPE_IDS].sort())
    for (let i = 1; i < recipes.length; i++) {
      expect(recipes[i], `rows ${i} and ${i + 1}`).not.toBe(recipes[i - 1])
    }
    // Page 1 of /writing (10 posts): skipping one row does not repeat either.
    for (let i = 2; i < 10; i++) expect(recipes[i], `rows ${i - 1} and ${i + 1}`).not.toBe(recipes[i - 2])
  })

  it('the six ink groups showing up (2 series + 4 categories with standalone posts) get six different inks', () => {
    const groups = new Map<string, InkName>()
    for (const p of POSTS) groups.set(p.series?.slug ?? p.category, specOf(p).ink)

    expect([...groups.keys()].sort()).toEqual([XAY, PIPE, 'kien-truc', 'go-loi', 'kiem-thu', 'cach-toi-lam-viec'].sort())
    expect(new Set(groups.values()).size).toBe(6)
  })

  it('before the seed assigns series, the six categories also get six different inks', () => {
    const inks = new Map<string, InkName>()
    for (const p of POSTS) inks.set(p.category, composeCover(coverInputOf({ ...asPost(p), series: null })).ink)
    expect(inks.size).toBe(6)
    expect(new Set(inks.values()).size).toBe(6)
  })

  it('parts of a series share ink despite different categories, and consecutive parts have different recipes', () => {
    const parts = POSTS.filter((p) => p.series?.slug === XAY).sort((a, b) => a.series!.position - b.series!.position)
    expect(new Set(parts.map((p) => p.category)).size).toBeGreaterThan(1)
    expect(new Set(parts.map((p) => specOf(p).ink)).size).toBe(1)

    // Seven consecutive positions of any series: seven different recipes.
    const seven = [1, 2, 3, 4, 5, 6, 7].map(
      (position) => composeCover({ slug: `phan-${position}`, inkKey: 's', series: { slug: 'mot-series', position } }).recipe,
    )
    expect(new Set(seven).size).toBe(7)
  })
})

describe('lib/cover-art: the four required fixes of the spec', () => {
  it('exactly 7 recipes remain: no more arch', () => {
    expect([...RECIPE_IDS]).toEqual(['orbit', 'bloom', 'pipeline', 'wedge', 'eclipse', 'steps', 'sampler'])
    expect(RECIPE_IDS).not.toContain('arch')
    // No input slips out to a recipe outside the list.
    for (let i = 0; i < 300; i++) {
      expect(RECIPE_IDS).toContain(composeCover({ slug: `x-${i}`, inkKey: `k-${i}`, series: null }).recipe)
    }
  })

  it('exactly 6 inks remain, no more blue, plum present', () => {
    expect([...INK_NAMES].sort()).toEqual(['brick', 'indigo', 'moss', 'ochre', 'plum', 'teal'])
    expect(Object.keys(ART_INKS).sort()).toEqual([...INK_NAMES].sort())
    expect(Object.keys(ART_INKS)).not.toContain('blue')
  })

  /*
   * sRGB hex → OKLCH (Björn Ottosson), to check colors in exactly the space the ink table was
   * built in: the name "plum" proves nothing if the value below is a blue.
   */
  function oklchOf(hex: string): { l: number; c: number; h: number } {
    const lin = [1, 3, 5].map((i) => {
      const v = parseInt(hex.slice(i, i + 2), 16) / 255
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    })
    const [r, g, b] = lin as [number, number, number]
    const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
    const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
    const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
    const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_
    const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_
    const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_
    return { l: L, c: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 }
  }

  const css = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8')
  const brand = /@theme\s*\{[^}]*--color-brand:\s*oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/.exec(css)

  it('no ink shares a color family with the link: hue at least 30° from brand', () => {
    expect(brand, '--color-brand not found in globals.css').not.toBeNull()
    const brandHue = Number(brand![3])
    for (const name of INK_NAMES) {
      for (const theme of ['light', 'dark'] as const) {
        const { h } = oklchOf(ART_INKS[name][theme].ink)
        const gap = Math.min(Math.abs(h - brandHue), 360 - Math.abs(h - brandHue))
        expect(gap, `${name} ${theme} hue ${h.toFixed(1)}`).toBeGreaterThanOrEqual(30)
      }
    }
    // The old blue of the reference version fails exactly this check.
    const old = oklchOf('#3675b2').h
    expect(Math.min(Math.abs(old - brandHue), 360 - Math.abs(old - brandHue))).toBeLessThan(30)
  })

  it('inks are lighter than brand: each ink chroma is under 65% of the brand chroma', () => {
    const brandChroma = Number(brand![2])
    for (const name of INK_NAMES) {
      for (const theme of ['light', 'dark'] as const) {
        expect(oklchOf(ART_INKS[name][theme].ink).c, `${name} ${theme}`).toBeLessThan(0.65 * brandChroma)
      }
    }
  })

  it('tint and deep mean overprint properly: in light, tint is lighter than the ink and deep darker; in dark the reverse', () => {
    for (const name of INK_NAMES) {
      const light = ART_INKS[name].light
      const dark = ART_INKS[name].dark
      expect(oklchOf(light.tint).l).toBeGreaterThan(oklchOf(light.ink).l)
      expect(oklchOf(light.deep).l).toBeLessThan(oklchOf(light.ink).l)
      expect(oklchOf(dark.tint).l).toBeLessThan(oklchOf(dark.ink).l)
      expect(oklchOf(dark.deep).l).toBeGreaterThan(oklchOf(dark.ink).l)
      for (const hex of [...Object.values(light), ...Object.values(dark)]) expect(hex).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('the dark tint reads as a shape on dark paper: ≥ 1.75:1 against the paper, still ≥ 3.5:1 from the ink', () => {
    // At L .31–.34 the tint is only 1.35–1.52:1 on #171717: the inner disc and the backing read as a hole or
    // a stain (seen in the dark theme). 0.07 L brighter gives 1.77–2.02:1, while still being a backing layer and not competing
    // with the ink.
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => {
        const v = parseInt(hex.slice(i, i + 2), 16) / 255
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      }) as [number, number, number]
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
      return (hi + 0.05) / (lo + 0.05)
    }
    for (const name of INK_NAMES) {
      const { ink, tint } = ART_INKS[name].dark
      expect(contrast(tint, ART_NEUTRALS.dark.paper), `${name} tint/paper`).toBeGreaterThanOrEqual(1.75)
      expect(contrast(ink, tint), `${name} ink/tint`).toBeGreaterThanOrEqual(3.5)
    }
  })

  /** Tailwind's oklch(...) (may be `97%`, the hue may be `none`) → sRGB hex. */
  function tailwindHex(token: string): string {
    const theme = readFileSync(join(process.cwd(), 'node_modules/tailwindcss/theme.css'), 'utf8')
    const m = new RegExp(`--color-${token}:\\s*oklch\\(([\\d.]+)(%?)\\s+([\\d.]+)\\s+([\\d.]+|none)\\)`).exec(theme)
    expect(m, `--color-${token} not found in tailwindcss/theme.css`).not.toBeNull()
    const l = Number(m![1]) / (m![2] === '%' ? 100 : 1)
    const c = Number(m![3])
    const h = m![4] === 'none' ? 0 : Number(m![4])
    const a = c * Math.cos((h * Math.PI) / 180)
    const b = c * Math.sin((h * Math.PI) / 180)
    const L = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
    const M = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
    const S = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
    return `#${[
      4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
      -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
      -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
    ]
      .map((x) => Math.min(1, Math.max(0, x)))
      .map((x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055))
      .map((x) =>
        Math.round(x * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')}`
  }

  it('neutral colors written as hex (for the OG card) match exactly the neutral utilities CoverArt uses', () => {
    // CoverArt paints paper/cross/strokes with Tailwind utilities; the OG card cannot read CSS so
    // it must be written as hex. The two places only stay in agreement if a test compares them — like the brand color of ShareCard.
    expect(ART_NEUTRALS.light).toEqual({
      paper: tailwindHex('neutral-100'),
      grid: tailwindHex('neutral-300'),
      mark: tailwindHex('neutral-800'),
    })
    expect(ART_NEUTRALS.dark).toEqual({
      paper: tailwindHex('neutral-900'),
      grid: tailwindHex('neutral-700'),
      mark: tailwindHex('neutral-200'),
    })
  })
})

/* ------------------------------------------------------------------ bounds */

type Box = { x0: number; x1: number; y0: number; y1: number }

/** The extreme points of an SVG arc (rx = ry, no rotation): both endpoints plus every
 *  0°/90°/180°/270° point lying within the swept angle. Per the SVG implementation notes F.6.5. */
function arcPoints(x1: number, y1: number, r: number, large: number, sweep: number, x2: number, y2: number) {
  const dx = (x1 - x2) / 2
  const dy = (y1 - y2) / 2
  const d2 = dx * dx + dy * dy
  const rr = Math.max(r, Math.sqrt(d2))
  const sign = large === sweep ? -1 : 1
  const k = sign * Math.sqrt(Math.max(0, (rr * rr - d2) / d2))
  const cxp = k * dy
  const cyp = -k * dx
  const cx = cxp + (x1 + x2) / 2
  const cy = cyp + (y1 + y2) / 2
  const a1 = Math.atan2((dy - cyp) / rr, (dx - cxp) / rr)
  let delta = Math.atan2((-dy - cyp) / rr, (-dx - cxp) / rr) - a1
  if (sweep && delta < 0) delta += 2 * Math.PI
  if (!sweep && delta > 0) delta -= 2 * Math.PI
  const pts: [number, number][] = [
    [x1, y1],
    [x2, y2],
  ]
  for (const t of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
    const u = delta >= 0 ? t - a1 : a1 - t
    const along = ((u % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
    if (along <= Math.abs(delta) + 1e-12) pts.push([cx + rr * Math.cos(t), cy + rr * Math.sin(t)])
  }
  return pts
}

/** Bounding box of a path using only absolute commands M/L/H/V/A/Z (SVG units). */
function pathBox(d: string): Box {
  const xs: number[] = []
  const ys: number[] = []
  let cx = 0
  let cy = 0
  for (const [, cmd, args] of d.matchAll(/([MLHVAZ])([^MLHVAZ]*)/g)) {
    const n = args!
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number)
    if (cmd === 'M' || cmd === 'L') [cx, cy] = [n[0]!, n[1]!]
    else if (cmd === 'H') cx = n[0]!
    else if (cmd === 'V') cy = n[0]!
    else if (cmd === 'A') {
      for (const [x, y] of arcPoints(cx, cy, n[0]!, n[3]!, n[4]!, n[5]!, n[6]!)) {
        xs.push(x)
        ys.push(y)
      }
      ;[cx, cy] = [n[5]!, n[6]!]
    } else continue
    xs.push(cx)
    ys.push(cy)
  }
  return { x0: Math.min(...xs) / CELL, x1: Math.max(...xs) / CELL, y0: Math.min(...ys) / CELL, y1: Math.max(...ys) / CELL }
}

function boxOf(s: Shape): Box {
  switch (s.k) {
    case 'rect':
    case 'hatch':
      return { x0: s.x, x1: s.x + s.w, y0: s.y, y1: s.y + s.h }
    case 'disc':
    case 'ring':
      return { x0: s.cx - s.r, x1: s.cx + s.r, y0: s.cy - s.r, y1: s.cy + s.r }
    case 'node':
      return { x0: s.x - s.s / 2, x1: s.x + s.s / 2, y0: s.y - s.s / 2, y1: s.y + s.s / 2 }
    case 'line': {
      const xs = s.pts.map((p) => p[0])
      const ys = s.pts.map((p) => p[1])
      return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }
    }
    case 'path':
      return pathBox(s.d)
  }
}

describe('lib/cover-art: shapes stay inside the clip frame (1,000 slugs)', () => {
  // Paths are rounded to 0.01 unit (1/6000 cell) on output.
  const EPS = 1e-4

  it('ink shapes lie within x 2.2–5.8, y 0.4–3.6; secondary parts within columns 1–7', () => {
    let checkedInk = 0
    let checkedOther = 0
    for (let i = 0; i < 1000; i++) {
      const slug = `bai-${i}-${((i * 2654435761) >>> 0).toString(36)}`
      const series = i % 3 === 0 ? { slug: `series-${i % 7}`, position: 1 + (i % 5) } : null
      const spec = composeCover({ slug, inkKey: series?.slug ?? slug, series })

      for (const s of spec.shapes) {
        let { x0, x1 } = boxOf(s)
        const { y0, y1 } = boxOf(s)
        // Horizontal flip around the canvas middle axis.
        if (spec.mirror) [x0, x1] = [COLS - x1, COLS - x0]
        const where = `${slug} ${spec.recipe} ${s.k}`

        if ('fill' in s && s.fill === 'ink') {
          checkedInk++
          // The OG card's square frame is columns 2–6; the hero's 5:2 frame cuts 0.4 cell above and below.
          expect(x0, where).toBeGreaterThanOrEqual(2.2 - EPS)
          expect(x1, where).toBeLessThanOrEqual(5.8 + EPS)
          expect(y0, where).toBeGreaterThanOrEqual(0.4 - EPS)
          expect(y1, where).toBeLessThanOrEqual(3.6 + EPS)
        } else {
          // Only the hatching strip and the baseline running the full width may go outside columns 1–7.
          const fullWidth = (s.k === 'hatch' && s.w >= COLS) || (s.k === 'line' && x1 - x0 >= COLS - 1)
          if (fullWidth) continue
          checkedOther++
          // The 3:2 thumbnail only shows columns 1–7.
          expect(x0, where).toBeGreaterThanOrEqual(1 - EPS)
          expect(x1, where).toBeLessThanOrEqual(7 + EPS)
        }
      }
    }
    // The loop really checks: an empty data set would pass every assert above.
    expect(checkedInk).toBeGreaterThan(1000)
    expect(checkedOther).toBeGreaterThan(3000)
  })

  it(msg('Admin.postImages.size', { width: 'the canvas is an 8', height: '4 grid of 60-unit cells' }), () => {
    expect([COLS, ROWS, CELL]).toEqual([8, 4, 60])
    expect(TILE_VIEWBOX).toBe('120 0 240 240')
  })
})

describe('lib/cover-art: coverSvgString (OG card, preview)', () => {
  const input = coverInputOf(asPost(POSTS[0]!))
  const spec = composeCover(input)

  it('dark version: baked-in hex, no var(), no vector-effect, no class', () => {
    const svg = coverSvgString(spec, { theme: 'dark', viewBox: TILE_VIEWBOX, hairline: 1.6 })
    const shades = ART_INKS[spec.ink].dark

    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg).toContain(`viewBox="${TILE_VIEWBOX}"`)
    expect(svg).toContain(`fill="${ART_NEUTRALS.dark.paper}"`)
    expect(svg).toContain(`stroke="${ART_NEUTRALS.dark.grid}"`)
    expect(svg).toContain(`stroke="${ART_NEUTRALS.dark.mark}"`)
    expect(svg).toContain(`fill="${shades.ink}"`)
    expect(svg).toContain('stroke-width="1.6"')
    // Satori has no stylesheet to resolve var(); resvg may not support vector-effect.
    expect(svg).not.toContain('var(')
    expect(svg).not.toContain('vector-effect')
    expect(svg).not.toContain('class=')
    // No text, no id.
    expect(svg).not.toMatch(/<text|<title|<desc|\sid=/)
    // The light color does not leak into the dark version.
    expect(svg).not.toContain(ART_INKS[spec.ink].light.ink)
  })

  it('light version uses the light palette; default is the whole 2:1 canvas', () => {
    const svg = coverSvgString(spec, { theme: 'light' })
    expect(svg).toContain('viewBox="0 0 480 240"')
    expect(svg).toContain('preserveAspectRatio="xMidYMid slice"')
    expect(svg).toContain(`fill="${ART_NEUTRALS.light.paper}"`)
    expect(svg).toContain(`fill="${ART_INKS[spec.ink].light.ink}"`)
    expect(svg).toContain('stroke-width="1"')
    expect(svg).not.toContain(ART_INKS[spec.ink].dark.ink)
  })

  it('a flipped cover is wrapped in a horizontal-flip group, an unflipped one is not', () => {
    const mirrored = composeCover(coverInputOf(asPost(POSTS[2]!)))
    const plain = composeCover(coverInputOf(asPost(POSTS[0]!)))
    expect(mirrored.mirror).toBe(true)
    expect(plain.mirror).toBe(false)
    expect(coverSvgString(mirrored, { theme: 'dark' })).toContain('transform="matrix(-1 0 0 1 480 0)"')
    expect(coverSvgString(plain, { theme: 'dark' })).not.toContain('transform=')
  })

  it('draws exactly the spec elements, in order', () => {
    const elements = coverElements(spec)
    expect(elements.length).toBe(spec.shapes.length)
    const tags = [...coverSvgString(spec, { theme: 'dark' }).matchAll(/<(rect|circle|path)\b/g)].map((m) => m[1])
    // Two background elements (paper, cross) then exactly the shapes of the recipe.
    expect(tags).toEqual(['rect', 'path', ...elements.map((e) => e.tag)])
  })
})
