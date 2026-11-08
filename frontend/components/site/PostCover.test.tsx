import { render } from '@testing-library/react'
import Image from 'next/image'
import { afterEach, describe, expect, it } from 'vitest'
import { coverInputOf } from '@/lib/cover-art'
import { imageConfigDefault } from 'next/dist/shared/lib/image-config'
import { ImageConfigContext } from 'next/dist/shared/lib/image-config-context.shared-runtime'
import { IMAGE_QUALITY } from '@/lib/image-quality'
import { mediaPath } from '@/lib/media'
import type { MediaRef, PostSummary } from '@/lib/types'
import { CoverArt } from './CoverArt'
import { PostCover } from './PostCover'

/**
 * PostCover is the image frame of a post: the uploaded cover image if there is one, otherwise cover art generated from the
 * slug. Two variants: `thumb` (3:2, list row) and `hero` (top of a post).
 *
 * next/image here is the real one, not mocked: the things to pin (src going through mediaPath, `sizes`,
 * `fetchpriority`, `loading`, whether there is a preload tag) are all produced by it.
 */

type CoverPost = Pick<PostSummary, 'slug' | 'title' | 'category' | 'series' | 'cover'>

const COVER: MediaRef = {
  id: '6f1c2a7e-3b4d-4c5e-8f90-1a2b3c4d5e6f',
  fileName: '6f1c2a7e-3b4d-4c5e-8f90-1a2b3c4d5e6f.jpg',
  width: 1600,
  height: 1067,
  altText: 'Whiteboard with a diagram of three queues',
  dominantColor: '#5a6b7c',
}

const post = (extra: Partial<CoverPost> = {}): CoverPost => ({
  slug: 'when-to-add-a-queue',
  title: 'Sample post 05',
  category: { id: 'c1', name: 'Architecture', slug: 'architecture', description: null },
  series: null,
  cover: null,
  ...extra,
})

const classesOf = (el: Element | null) => (el?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)

/** The `url` value that next/image's default loader writes into src: the original image path. */
const sourceOf = (img: HTMLImageElement) => new URL(img.getAttribute('src') ?? '', 'http://localhost').searchParams.get('url')

afterEach(() => {
  // ReactDOM.preload writes straight into <head>, outside the container that RTL cleans after each test.
  document.head.querySelectorAll('link[rel="preload"]').forEach((link) => link.remove())
})

describe('PostCover thumb', () => {
  it("post without a cover image: draws that post's own cover art in a 3:2 frame, no <img>", () => {
    const p = post({
      series: { id: 's1', slug: 'series-e', title: 'Series B', position: 1, partNumber: 1, partCount: 3 },
    })
    const { container } = render(<PostCover post={p} variant="thumb" />)

    const frame = container.firstElementChild
    expect(frame?.tagName).toBe('SPAN')
    expect(classesOf(frame)).toEqual(
      expect.arrayContaining([
        'relative',
        'block',
        'aspect-[3/2]',
        'overflow-hidden',
        'rounded-md',
        'border',
        'border-neutral-200',
        'dark:border-neutral-800',
      ]),
    )
    const art = frame?.querySelector('svg.cover-art')
    expect(art).not.toBeNull()
    expect(container.querySelector('img')).toBeNull()

    // Exactly this post's cover: ink by series, layout by slug. Compared with CoverArt itself built
    // from coverInputOf, so dropping the series or category from the input yields a different picture.
    const expected = render(<CoverArt input={coverInputOf(p)} />).container.querySelector('svg')
    expect(art?.outerHTML).toBe(expected?.outerHTML)
  })

  it('post with a cover image: <img alt=""> through mediaPath, sizes matching the thumbnail column, dominantColor background', () => {
    const { container } = render(<PostCover post={post({ cover: COVER })} variant="thumb" />)

    const img = container.querySelector('img')!
    expect(img).not.toBeNull()
    // empty alt: in a list, the title right beside it is already the description, and the link wrapping the image is hidden.
    expect(img).toHaveAttribute('alt', '')
    expect(sourceOf(img)).toBe(mediaPath(COVER))
    expect(img).toHaveAttribute('sizes', '(min-width: 640px) 14rem, 7rem')
    // A list image does not compete for bandwidth with the LCP.
    expect(img).toHaveAttribute('loading', 'lazy')
    expect(img).not.toHaveAttribute('fetchpriority')

    const frame = img.parentElement!
    expect(classesOf(frame)).toEqual(expect.arrayContaining(['relative', 'aspect-[3/2]', 'overflow-hidden']))
    // The dominant color is the placeholder while the image loads: jsdom normalizes hex to rgb().
    expect(frame.style.backgroundColor).toBe('rgb(90, 107, 124)')
    expect(container.querySelector('svg.cover-art')).toBeNull()
  })

  it('the caller may change sizes (the compact row has a 6rem thumbnail at every width)', () => {
    const { container } = render(<PostCover post={post({ cover: COVER })} variant="thumb" sizes="6rem" />)

    expect(container.querySelector('img')).toHaveAttribute('sizes', '6rem')
  })

  it('only uses dominantColor when it has the exact #rrggbb form', () => {
    // This value goes straight into the style attribute. The backend already has a CHECK with the same pattern; this is the second
    // layer, so a broken record cannot inject another CSS declaration into the page.
    for (const dominantColor of [null, 'red', '#5a6b7c; position: fixed', 'url(x)', '#5a6b7']) {
      const { container, unmount } = render(<PostCover post={post({ cover: { ...COVER, dominantColor } })} variant="thumb" />)
      const frame = container.querySelector('img')!.parentElement!
      expect(frame.style.backgroundColor, String(dominantColor)).toBe('')
      expect(frame.getAttribute('style') ?? '', String(dominantColor)).not.toContain('position')
      unmount()
    }

    // The "present" pair: same frame, a valid value gets a background.
    const { container } = render(<PostCover post={post({ cover: { ...COVER, dominantColor: '#a1b2c3' } })} variant="thumb" />)
    expect(container.querySelector('img')!.parentElement!.style.backgroundColor).toBe('rgb(161, 178, 195)')
  })

  it("the caller's class is added to the frame, not replacing the frame", () => {
    const { container } = render(<PostCover post={post()} variant="thumb" className="group-hover:border-brand" />)

    expect(classesOf(container.firstElementChild)).toEqual(
      expect.arrayContaining(['group-hover:border-brand', 'aspect-[3/2]', 'rounded-md']),
    )
  })
})

describe('PostCover hero', () => {
  it('the cover image is the LCP image: fetchpriority="high", loads immediately, and has no preload', () => {
    const { container } = render(<PostCover post={post({ cover: COVER })} variant="hero" />)
    const img = container.querySelector('img')!

    expect(img).toHaveAttribute('fetchpriority', 'high')
    // next/image defaults to `loading="lazy"` even with fetchPriority (get-img-props.js only
    // turns lazy off with preload/priority or a `loading` other than 'lazy'). The LCP image sits in the first
    // screen, and with lazy the browser waits for layout before loading: Lighthouse names exactly this error.
    expect(img).toHaveAttribute('loading', 'eager')
    expect(img).not.toHaveAttribute('loading', 'lazy')
    // No preload: Next 16 recommends fetchPriority or loading instead of preload, and forbids
    // combining preload with loading (E803). Checked in <head>, where ReactDOM.preload writes.
    expect(document.head.querySelector('link[rel="preload"][as="image"]')).toBeNull()

    expect(sourceOf(img)).toBe(mediaPath(COVER))
    expect(img).toHaveAttribute('alt', COVER.altText)
    const frame = img.parentElement!
    expect(classesOf(frame)).toEqual(expect.arrayContaining(['relative', 'aspect-[1200/630]', 'overflow-hidden', 'rounded-md']))
    expect(frame.style.backgroundColor).toBe('rgb(90, 107, 124)')
  })

  it('hero sizes follow the centre column of the reader layout: 52rem from 1088px, 45rem from 640px, the viewport below it', () => {
    const { container } = render(<PostCover post={post({ cover: COVER })} variant="hero" />)

    expect(container.querySelector('img')).toHaveAttribute('sizes', '(min-width: 1088px) 52rem, (min-width: 640px) 45rem, 100vw')
  })

  it('the hero cover is encoded at the sharp quality, a thumbnail at the standard one', () => {
    // The image config the site's next.config.ts allows; the default one has no 85 and would coerce it back to 75.
    const config = { ...imageConfigDefault, qualities: [IMAGE_QUALITY.standard, IMAGE_QUALITY.sharp] }
    const show = (variant: 'hero' | 'thumb') =>
      render(
        <ImageConfigContext.Provider value={config}>
          <PostCover post={post({ cover: COVER })} variant={variant} />
        </ImageConfigContext.Provider>,
      ).container.querySelector('img')!
    const hero = show('hero')
    const thumb = show('thumb')

    const quality = (img: HTMLElement) => new URL(img.getAttribute('src') ?? '', 'http://localhost').searchParams.get('q')
    expect(quality(hero)).toBe(String(IMAGE_QUALITY.sharp))
    expect(quality(thumb)).toBe(String(IMAGE_QUALITY.standard))
  })

  it('control that makes the preload check above valid: a real <Image preload> does have a tag in <head>', () => {
    // Without this control, "no preload link" could be green only because jsdom never picks up
    // a preload tag from ReactDOM — in which case the test above would check nothing.
    render(<Image src="/media/x.jpg" alt="" fill sizes="10rem" preload />)

    expect(document.head.querySelector('link[rel="preload"][as="image"]')).not.toBeNull()
  })

  it('a cover image without a description: alt takes the post title', () => {
    const { container } = render(<PostCover post={post({ cover: { ...COVER, altText: null } })} variant="hero" />)

    expect(container.querySelector('img')).toHaveAttribute('alt', 'Sample post 05')
  })

  it('no cover image: cover art in a 2:1 frame, 5:2 from 640px, no <img>', () => {
    const { container } = render(<PostCover post={post()} variant="hero" />)
    const frame = container.firstElementChild

    expect(classesOf(frame)).toEqual(expect.arrayContaining(['aspect-[2/1]', 'sm:aspect-[5/2]', 'rounded-md', 'border']))
    expect(classesOf(frame)).not.toContain('aspect-[1200/630]')
    expect(frame?.querySelector('svg.cover-art')).not.toBeNull()
    expect(container.querySelector('img')).toBeNull()
  })
})
