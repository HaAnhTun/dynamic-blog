// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { siteOgImage } from '@/lib/metadata'
import { defaultSiteContent } from '@/content/defaults'
import { routeMap } from '@/test/routes'
import { size } from './opengraph-image'

/**
 * Every page must end up with a share image, and the trap is that most of them silently
 * will not.
 *
 * `app/layout.tsx` declares `twitter: { card: 'summary_large_image' }`, so a share renders
 * a 1200×630 panel. With no image that panel is blank — which looks more broken than a
 * plain text card, and is invisible from the site itself: nothing fails, no page looks
 * wrong, and it only shows up in somebody else's timeline.
 *
 * `app/opengraph-image.tsx` supplies one for every route via the file convention — but a
 * segment that exports its own `openGraph` object REPLACES the inherited one, images
 * included. Measured on the running site: /writing, the one public page with no
 * `openGraph` of its own, emitted og:image; /, /about and every article did
 * not. The fix is one `images: [OG_IMAGE]` line per page, and the thing that will go wrong
 * later is a new page that sets `openGraph` and forgets it.
 *
 * The positive half of that rule now lives in lib/metadata.ts, which restates
 * `images: [OG_IMAGE]` for every route that does not own its image, and in
 * lib/metadata.test.ts, which asserts it. What is left here is the half a unit test on the
 * helper cannot see: that NO page goes around the helper and hand-writes an `openGraph`
 * block, because such a page silently drops the image again. A runtime check would mean
 * importing every page module and calling generateMetadata with plausible params; this
 * catches the same regression at the point it is introduced.
 */
describe('share images', () => {
  const appDir = join(process.cwd(), 'app')

  it('is never bypassed by a page that hand-writes its own openGraph block', () => {
    const pages = [...routeMap(appDir).entries()]

    // The base directory is proved first: an empty map would make the loop below pass
    // while checking nothing, which is the exact failure mode this file exists to prevent
    // elsewhere.
    expect(pages.length, `resolved ${appDir}, which does not look like the app directory`).toBeGreaterThan(5)

    const offenders: string[] = []
    for (const [url, file] of pages) {
      // Admin pages are behind a login and are never shared. Excluded deliberately rather
      // than by accident — and they are noindex by declaration now, in app/admin/layout.tsx,
      // rather than by being hard to reach: /admin/login answers 200 to anybody.
      if (url.startsWith('/admin')) continue

      const source = readFileSync(join(process.cwd(), file), 'utf8')
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      // A raw `openGraph: {` in a page, with or without an images line. The earlier
      // version of this check allowed the block as long as it carried
      // `images: [OG_IMAGE]`, which was right while each page built its own metadata and
      // is now the loophole: a hand-written block also loses og:locale and og:site_name,
      // which is exactly how /about and /posts/[slug] came to emit neither.
      //
      // An earlier version used `code.includes('OG_IMAGE')` and was INERT — deleting the
      // `images:` line leaves the import untouched, so the substring was still there and
      // the test passed with the defect present. Caught by running the mutation rather
      // than by reading the assertion, which is why this one matches a syntactic shape.
      if (/openGraph:\s*\{/.test(code)) offenders.push(`${url} (${file})`)
    }

    expect(
      offenders,
      'these pages export their own openGraph block, which REPLACES the inherited one — ' +
        'image, locale and site name included. Build the metadata with pageMetadata() ' +
        'from @/lib/metadata instead; it restates all three in one place.',
    ).toEqual([])
  })

  it('has a root opengraph-image behind the OG_IMAGE every page points at', () => {
    // The other half. The rule above is vacuous if the file convention itself is gone:
    // every page would then pass by exporting no openGraph, and every share would be
    // blank.
    const root = readFileSync(join(appDir, 'opengraph-image.tsx'), 'utf8')

    expect(root).toContain('ImageResponse')
    // `alt` is required by Next for this convention and is what a screen reader announces
    // when the card is shared somewhere accessible.
    expect(root).toMatch(/export const alt\b/)
  })

  it('the og:image:width/height/alt of every page match the image this route draws', async () => {
    // lib/metadata.ts declares the size and alt of the shared tag next to its URL; if one of the two changes
    // without the other, the tag claims a size it does not have.
    const { site } = defaultSiteContent('vi')
    expect(await siteOgImage('vi')).toEqual({
      url: '/opengraph-image',
      width: size.width,
      height: size.height,
      alt: `${site.name} — ${site.tagline}`,
    })
  })

  it('draws both cards with the one shared component', () => {
    // The objection the original version of app/opengraph-image.tsx raised against a
    // per-article card, in its own words: it "is a second renderer to keep in step with
    // this one". components/og/ShareCard.tsx is the answer to that, and this is what keeps
    // the answer true — the day somebody inlines a layout into one of the two routes the
    // cards start drifting, and nothing else in the suite would say so.
    for (const file of ['opengraph-image.tsx', 'api/og/posts/[slug]/route.tsx']) {
      const source = readFileSync(join(appDir, file), 'utf8')
      expect(source, `${file} must draw through the shared card`).toContain("from '@/components/og/ShareCard'")
      // The size comes from the shared module too, so the two routes cannot claim
      // different dimensions.
      expect(source, `${file} must take its size from the shared card`).toMatch(/(export )?const size = OG_SIZE/)
    }

    // 1200x630 is what `summary_large_image` expects; another ratio is letterboxed by
    // every consumer.
    const card = readFileSync(join(process.cwd(), 'components/og/ShareCard.tsx'), 'utf8')
    expect(card).toMatch(/width:\s*1200/)
    expect(card).toMatch(/height:\s*630/)
  })
})

/**
 * The brand color in two places that cannot read CSS: the share image (Satori has no stylesheet to resolve
 * `var(--color-brand)`), which must restate the token as hex, so it can only be kept in sync by a test comparing it with globals.css. Before this change both were
 * `#3b5bdb` with a comment "same colour as the token" — a color that exists nowhere in the CSS.
 */
describe('brand color outside CSS', () => {
  const css = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8')

  /** oklch → sRGB hex, using Björn Ottosson's OKLab formula (also how a browser
   *  computes it). Accurate enough to compare to every 0–255 value for a color inside the sRGB gamut. */
  function oklchToHex(l: number, c: number, h: number): string {
    const a = c * Math.cos((h * Math.PI) / 180)
    const b = c * Math.sin((h * Math.PI) / 180)
    const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
    const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
    const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
    const linear = [
      4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
      -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
      -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
    ]
    return `#${linear
      .map((x) => Math.min(1, Math.max(0, x)))
      .map((x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055))
      .map((x) =>
        Math.round(x * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')}`
  }

  it('the dark share image uses exactly the brand value of the dark theme', () => {
    const dark = /\[data-theme='dark'\]\s*\{\s*--color-brand:\s*(#[0-9a-f]{6})\s*;/i.exec(css)?.[1]
    const card = readFileSync(join(process.cwd(), 'components/og/ShareCard.tsx'), 'utf8')
    const brand = /const BRAND = '(#[0-9a-f]{6})'/i.exec(card)?.[1]

    expect(dark, '--color-brand of the dark theme not found in globals.css').toBeDefined()
    // The image always has a #0a0a0a background, so its color is the brand color on a dark background: 7.54:1, not
    // the light color (4.10:1, fails AA) or #3b5bdb (3.49:1) as before.
    expect(card).toMatch(/backgroundColor: '#0a0a0a'/)
    expect(brand?.toLowerCase()).toBe(dark?.toLowerCase())
    expect(brand?.toLowerCase()).not.toBe('#3b5bdb')
  })

  it('the light-theme brand token is still the #0073cf accent that the post diagrams use', () => {
    const token = /@theme\s*\{[^}]*--color-brand:\s*oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/.exec(css)
    expect(token, 'token --color-brand oklch(...) not found in @theme').not.toBeNull()
    const [, l, c, h] = token!
    // #0073cf: also the accent color the diagrams in posts use in light mode.
    expect(oklchToHex(Number(l), Number(c), Number(h))).toBe('#0073cf')
  })

  /** Width and height from the IHDR chunk of a PNG file (bytes 16 to 23, big endian). */
  function pngSize(file: string): { width: number; height: number } {
    const bytes = readFileSync(join(process.cwd(), file))
    expect(bytes.subarray(1, 4).toString('ascii'), `${file} is not a PNG`).toBe('PNG')
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }

  it('the app icons are square PNG files of the sizes browsers and phones ask for', () => {
    expect(pngSize('app/icon.png')).toEqual({ width: 512, height: 512 })
    expect(pngSize('app/apple-icon.png')).toEqual({ width: 180, height: 180 })
  })

  it('no comment remains claiming a color is "the same as the token" when it is not', () => {
    const card = readFileSync(join(process.cwd(), 'components/og/ShareCard.tsx'), 'utf8')

    expect(card).not.toMatch(/same colou?r as the (token|`--color-brand` token)/i)
  })
})
