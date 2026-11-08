// @vitest-environment node
import { ImageResponse } from 'next/og'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { TILE_VIEWBOX, composeCover, coverSvgString } from '@/lib/cover-art'
import { OG_SIZE, ShareCard } from './ShareCard'
import { msg } from '@/test/render-intl'

/**
 * The share card has an extra cover art tile for posts without a cover image. Two separate
 * questions: the layout the card builds (read straight from the element tree, since ShareCard is a pure function), and
 * whether Satori really draws that tile into the PNG (changing the art tile changes the PNG).
 */

type Props = Record<string, unknown> & { style?: Record<string, unknown>; children?: ReactNode }

/** Every element in the tree ShareCard returns, in depth-first order. */
function elements(node: ReactNode): ReactElement<Props>[] {
  const out: ReactElement<Props>[] = []
  const visit = (n: ReactNode) => {
    if (Array.isArray(n)) n.forEach(visit)
    else if (isValidElement<Props>(n)) {
      out.push(n)
      visit(n.props.children)
    }
  }
  visit(node)
  return out
}

/** The title element: the only element with lineClamp. */
const titleOf = (tree: ReactNode) => elements(tree).find((e) => e.props.style?.lineClamp === 3)

const art = (slug: string) => {
  const svg = coverSvgString(composeCover({ slug, inkKey: slug, series: null }), {
    theme: 'dark',
    viewBox: TILE_VIEWBOX,
    hairline: 1.6,
  })
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}

async function png(tree: ReactElement): Promise<Buffer> {
  return Buffer.from(await new ImageResponse(tree, OG_SIZE).arrayBuffer())
}

const dimensions = (bytes: Buffer) => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) })

describe('ShareCard: cover art tile', () => {
  const base = { eyebrow: 'Architecture · Oct 3, 2026', title: 'When should you add a queue', footer: 'Jane Writer' }

  it(
    msg('Admin.postImages.size', {
      width: 'with art: 300',
      height: '300 tile in the top right corner, text column at most 684px, title 56',
    }),
    () => {
      const tree = ShareCard({ ...base, art: art('when-should-you-add-a-queue') })
      const imgs = elements(tree).filter((e) => e.type === 'img')

      expect(imgs).toHaveLength(1)
      const img = imgs[0]!
      expect(img.props.src).toBe(art('when-should-you-add-a-queue'))
      expect([img.props.width, img.props.height]).toEqual([300, 300])
      // Decorative image: the adjacent title says it all.
      expect(img.props.alt).toBe('')

      expect(titleOf(tree)?.props.style?.fontSize).toBe(56)
      // 1200 − 2×80 margins − 300 tile − 56 gap: the text column never touches the art tile.
      const column = elements(tree).find((e) => e.props.style?.maxWidth === 684)
      expect(column, 'no text column with maxWidth 684').toBeDefined()
      expect(elements(column!.props.children)).toContain(titleOf(tree))
    },
  )

  it('without art: text-only card as before (title 64, no image tile, no column limit)', () => {
    const tree = ShareCard(base)

    expect(elements(tree).filter((e) => e.type === 'img')).toHaveLength(0)
    expect(titleOf(tree)?.props.style?.fontSize).toBe(64)
    expect(elements(tree).some((e) => e.props.style?.maxWidth === 684)).toBe(false)
    // A font size passed in still wins over the default (site-wide cards use 76).
    expect(titleOf(ShareCard({ ...base, titleSize: 76 }))?.props.style?.fontSize).toBe(76)
  })

  it('Satori really draws the art tile into the PNG: same text, different art tile gives a different image', async () => {
    const a = await png(<ShareCard {...base} art={art('when-should-you-add-a-queue')} />)
    const b = await png(<ShareCard {...base} art={art('sample-post-04')} />)

    expect(dimensions(a)).toEqual({ width: 1200, height: 630 })
    expect(dimensions(b)).toEqual({ width: 1200, height: 630 })
    // If the art tile is silently skipped (broken data URI, attribute Satori does not support), the two PNGs
    // would be byte-for-byte identical.
    expect(a.equals(b)).toBe(false)
    // And deterministic: same input, same bytes, so caching between here and the reader still means something.
    expect((await png(<ShareCard {...base} art={art('when-should-you-add-a-queue')} />)).equals(a)).toBe(true)
  })
})
