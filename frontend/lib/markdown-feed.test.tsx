import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderMarkdownToFeedHtml } from './markdown'
import { msg } from '@/test/render-intl'

// String branch for RSS: same sanitize schema as the page, absolute URLs against the post URL.
const POST = 'https://blog.example/posts/bai-mau'
const feed = (markdown: string) => renderMarkdownToFeedHtml(markdown, POST)

// The size of an SVG under /images is read from the file: a throw-away fixture, so the test needs no real image.
const SVG_FIXTURE = '__test-fixture-feed.svg'
const SVG_DIR = join(process.cwd(), 'public', 'images')

beforeAll(() => {
  mkdirSync(SVG_DIR, { recursive: true })
  writeFileSync(join(SVG_DIR, SVG_FIXTURE), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"></svg>', 'utf8')
})

afterAll(() => {
  rmSync(join(SVG_DIR, SVG_FIXTURE), { force: true })
})

describe('renderMarkdownToFeedHtml', () => {
  it('drops script with its content, every on* attribute, and javascript:/data: links and images', async () => {
    const html = await feed(
      [
        'Intro <script>alert(1)</script>',
        '',
        '<img src="x.png" onerror="alert(2)"> <a href="/a" onclick="alert(3)">a</a>',
        '',
        '[press](javascript:alert(4)) ![photo](data:image/png;base64,AAAA) <a href="JaVaScRiPt:alert(5)">b</a>',
        '',
        '<iframe src="https://evil.example"></iframe><style>body{display:none}</style>',
      ].join('\n'),
    )

    expect(html).not.toMatch(/<script|alert\(1\)|onerror|onclick|javascript:|data:image|<iframe|<style|display:none/i)
    expect(html).toContain('press')
  })

  it('code block is a bare <pre><code class="language-…">, no Shiki style, no copy button', async () => {
    const html = await feed('```java\nclass A { String s = "<b>&</b>"; }\n```')

    expect(html).toContain('<pre><code class="language-java">')
    expect(html).toContain('&#x3C;b>&#x26;&#x3C;/b>')
    expect(html).not.toMatch(new RegExp(`style=|shiki|${msg('Site.code.copy')}`))
  })

  it('relative links and images become absolute against the post URL; the #WxH hint becomes width/height and does not leak into the URL', async () => {
    const html = await feed(
      [
        '[other post](/posts/khac) [section](#y-chinh) [external](https://other.example/x) [mail](mailto:a@b.example)',
        '',
        '![diagram](/media/0b5c3f1e-2d4a-4b6c-8d9e-0f1a2b3c4d5e.png#640x480)',
        '',
        '![protocol](//cdn.example/a.png)',
      ].join('\n'),
    )

    expect(html).toContain('href="https://blog.example/posts/khac"')
    expect(html).toContain('href="https://blog.example/posts/bai-mau#y-chinh"')
    expect(html).toContain('href="https://other.example/x"')
    expect(html).toContain('href="mailto:a@b.example"')
    expect(html).toContain('src="https://blog.example/media/0b5c3f1e-2d4a-4b6c-8d9e-0f1a2b3c4d5e.png"')
    expect(html).toMatch(/width="640"[^>]*height="480"|height="480"[^>]*width="640"/)
    expect(html).not.toContain('#640x480')
    expect(html).toContain('src="https://cdn.example/a.png"')
  })

  it('SVG images under /images get the same size as on the page, absolute src', async () => {
    const html = await feed(`![flow](/images/${SVG_FIXTURE} "Caption")`)

    expect(html).toContain(`src="https://blog.example/images/${SVG_FIXTURE}"`)
    expect(html).toMatch(/<img [^>]*width="\d+"[^>]*height="\d+"/)
    expect(html).toContain('<figcaption>Caption</figcaption>')
  })

  it('has no heading # anchor and no table scroll wrapper', async () => {
    const html = await feed('## Heading\n\n| a | b |\n|---|---|\n| 1 | 2 |')

    expect(html).toContain('<h2>Heading</h2>')
    expect(html).toContain('<table>')
    expect(html).not.toMatch(/heading-anchor|table-scroll|role="region"/)
  })
})
