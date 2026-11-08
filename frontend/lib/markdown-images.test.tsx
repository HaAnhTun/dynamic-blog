import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

/**
 * Images in articles, which are diagrams in practice.
 *
 * Everything here was measured against the real pipeline before it was written. The
 * baseline, from a throwaway probe: markdown `![alt](/images/x.svg)` already rendered an
 * `<img>` with a relative src, `javascript:` was already stripped, `width`/`height`/`alt`
 * already survived sanitize — and `loading="lazy"` was DELETED while `<figure>` and
 * `<figcaption>` were UNWRAPPED, which left an author's caption sitting in the article as
 * bare prose. So the gap was narrow and specific, and these tests pin exactly it.
 */

/**
 * A fixture under public/images, written and removed by this file.
 *
 * Deliberately a real file rather than a mock of `node:fs`: what has to be proven is that
 * the plugin resolves a URL path to the right place ON DISK, and a mocked read would pass
 * whether or not that resolution is correct. The numbers are odd on purpose — 321x123 is
 * nothing a default or a rounding error could produce by accident.
 */
const FIXTURE = '__test-fixture-size.svg'
const FIXTURE_DIR = join(process.cwd(), 'public', 'images')
/**
 * A readable .svg one level ABOVE public/images, which the plugin must refuse to read.
 *
 * It has to be a real file with a real viewBox, and that is the whole point. The first
 * version of the traversal test pointed at package.json — a file with no viewBox, so it
 * yielded no dimensions whether the guard worked or not. It passed, proved nothing, and
 * claimed in its own comment to be proving something. 987x654 appears nowhere else.
 */
const FIXTURE_OUTSIDE = '__test-fixture-outside.svg'
/** The prefix the plugin keys on, spelled once so a test cannot drift from it. */
const IMAGES = '/images/'

beforeAll(() => {
  mkdirSync(FIXTURE_DIR, { recursive: true })
  writeFileSync(
    join(FIXTURE_DIR, FIXTURE),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 321 123"><rect width="10" height="10"/></svg>',
    'utf8',
  )
  writeFileSync(
    join(process.cwd(), 'public', FIXTURE_OUTSIDE),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 987 654"></svg>',
    'utf8',
  )
})

afterAll(() => {
  rmSync(join(FIXTURE_DIR, FIXTURE), { force: true })
  rmSync(join(process.cwd(), 'public', FIXTURE_OUTSIDE), { force: true })
})

async function html(markdown: string): Promise<string> {
  const { content } = await renderMarkdown(markdown)
  return renderToStaticMarkup(content)
}

describe('an image alone in a paragraph becomes a figure', () => {
  it('uses the markdown title as the caption and drops the tooltip', async () => {
    const out = await html(`![Pipeline diagram](/images/${FIXTURE} "Each hop and what breaks without it")`)

    expect(out).toContain('<figure')
    expect(out).toContain('<figcaption>Each hop and what breaks without it</figcaption>')
    // The caption is now visible text, so a title attribute would be a tooltip that
    // repeats what is already on screen — and a tooltip is not reachable by keyboard.
    expect(out).not.toContain('title=')
    // alt is NOT the caption: it describes the image for someone who cannot see it,
    // while the caption is read by everyone. Both have to survive.
    expect(out).toContain('alt="Pipeline diagram"')
  })

  it('emits a figure with no caption when there is no title', async () => {
    const out = await html(`![Diagram](/images/${FIXTURE})`)

    expect(out).toContain('<figure')
    expect(out).not.toContain('<figcaption')
  })

  it('does not wrap the paragraph when the image sits inside a sentence', async () => {
    // A badge or an inline icon belongs in the flow of the text. Promoting it to a block
    // figure would break the sentence it is part of.
    const out = await html(`See ![diagram](/images/${FIXTURE}) here.`)

    expect(out).not.toContain('<figure')
    expect(out).toContain('<p>')
  })
})

describe('attributes the browser needs', () => {
  it('adds loading=lazy and decoding=async, which sanitize used to delete', async () => {
    const out = await html(`![Diagram](/images/${FIXTURE})`)

    expect(out).toContain('loading="lazy"')
    expect(out).toContain('decoding="async"')
  })

  it('takes width and height from the file on disk, so the page does not jump', async () => {
    const out = await html(`![Diagram](/images/${FIXTURE})`)

    // From the fixture's viewBox. Without these the browser learns the aspect ratio only
    // after the download and reflows the article under the reader's cursor.
    expect(out).toContain('width="321"')
    expect(out).toContain('height="123"')
  })

  it('leaves an author-supplied size alone', async () => {
    const out = await html(`<p><img src="/images/${FIXTURE}" alt="Diagram" width="640" height="200" /></p>`)

    expect(out).toContain('width="640"')
    expect(out).toContain('height="200"')
  })
})

describe('an uploaded image (/media) carries its size in a #WxH hint', () => {
  // The editor inserts `![alt](/media/<file>#WxH)` (lib/post-markdown.ts imageMarkdown): the
  // bytes live in Postgres, so unlike /images/*.svg there is no file on disk to read a size from.
  it('turns the hint into width and height, and drops it from the src', async () => {
    const out = await html('![Screenshot](/media/0b9d6f3a-5c1e-4f7a-9d2b-3e4f5a6b7c8d.png#1280x720)')

    expect(out).toContain('src="/media/0b9d6f3a-5c1e-4f7a-9d2b-3e4f5a6b7c8d.png"')
    expect(out).toContain('width="1280"')
    expect(out).toContain('height="720"')
    expect(out).toContain('<figure')
    expect(out).not.toContain('#1280x720')
  })

  it('ignores a malformed or zero hint and leaves the src as written', async () => {
    for (const hint of ['#0x720', '#1280x', '#axb', '#1280x720x3', '#99999999x1']) {
      const out = await html(`![a](/media/x.png${hint})`)
      expect(out).not.toContain('width=')
      expect(out).not.toContain('height=')
    }
  })

  it('reads the hint only on /media paths: an external URL keeps its fragment and gets no size', async () => {
    const out = await html('![a](https://example.com/x.png#1280x720)')

    expect(out).toContain('src="https://example.com/x.png#1280x720"')
    expect(out).not.toContain('width=')
  })

  it('leaves an author-supplied size alone even with a hint', async () => {
    const out = await html('<p><img src="/media/x.png#1280x720" alt="a" width="640" height="360" /></p>')

    expect(out).toContain('width="640"')
    expect(out).toContain('height="360"')
    expect(out).toContain('src="/media/x.png"')
  })
})

describe('what it refuses to read', () => {
  it('does not fail the page when the file does not exist', async () => {
    // The real failure mode of a broken image is a 404 in the browser, not a 500 on the
    // server. A missing file must cost the dimensions and nothing else.
    const out = await html('![Diagram](/images/khong-ton-tai.svg)')

    expect(out).toContain('<img')
    expect(out).not.toContain('width=')
  })

  it('does not climb out of public/images with ..', async () => {
    const out = await html(`![x](${IMAGES}../${FIXTURE_OUTSIDE})`)

    // 987 is the escaped file's width. Asserting on that number, not only on the absence
    // of any width, is what makes a failure legible: it names the file that was read.
    expect(out).not.toContain('width="987"')
    expect(out).not.toContain('width=')
  })

  it('does not climb out with an absolute path either, which no .. check would catch', async () => {
    // This case earns its place by having been missing. The plugin used to carry an
    // `src.includes('..')` check in front of the resolved-path guard, so mutating the
    // real guard away left the whole suite green — measured. An absolute path carries no
    // '..' at all, so the check on the resolved path is the only thing that can refuse it.
    const src = `${IMAGES}${process.cwd().replace(/\\/g, '/')}/public/${FIXTURE_OUTSIDE}`
    const out = await html(`![x](${src})`)

    expect(out).not.toContain('width="987"')
    expect(out).not.toContain('width=')
  })

  it('does not touch a remote image', async () => {
    const out = await html('![x](https://example.com/a.svg)')

    expect(out).toContain('src="https://example.com/a.svg"')
    expect(out).not.toContain('width=')
  })

  it('still strips a javascript: src', async () => {
    // The sanitize guarantee that was already there. This file widens the schema, so the
    // guarantee is re-asserted here rather than assumed to have survived.
    const out = await html('![x](javascript:alert(1))')

    expect(out).not.toContain('javascript:')
  })
})

describe('a figure typed as raw HTML', () => {
  it('survives with its caption instead of being unwrapped into prose', async () => {
    const out = await html(`<figure><img src="/images/${FIXTURE}" alt="Diagram" /><figcaption>Caption</figcaption></figure>`)

    expect(out).toContain('<figure')
    expect(out).toContain('<figcaption>Caption</figcaption>')
  })

  it('still strips a script inside one', async () => {
    const out = await html(`<figure><img src="/images/${FIXTURE}" alt="x" /><script>alert(1)</script></figure>`)

    expect(out).not.toContain('alert(1)')
  })
})
