import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BLOCK_COMPONENTS } from '@/components/site/blocks'
import { useBlockDoubles } from '@/test/block-doubles'
import { renderMarkdown } from './markdown'
import { dataUrlsOf } from './preview-images'

const PNG = 'data:image/png;base64,AAAA'
const images = dataUrlsOf([
  { path: 'assets/a.png', contentType: 'image/png', base64: 'AAAA' },
  { path: 'assets/b.webp', contentType: 'image/webp', base64: 'BBBB' },
])
const html = async (markdown: string, imageSource = images) => {
  const { content } = await renderMarkdown(markdown, { imageSource })
  return renderToStaticMarkup(content)
}

describe('renderMarkdown with an image source (the import page preview)', () => {
  it('shows an image of the package from its data URL, however the author wrote the path', async () => {
    const out = await html('![First](assets/a.png)\n\n![Second](./assets/b.webp#10x10)')

    expect(out).toContain(`src="${PNG}"`)
    expect(out).toContain('src="data:image/webp;base64,BBBB"')
    expect(out).not.toContain('assets/a.png')
    // The image rules still apply to the mapped image.
    expect(out).toContain('loading="lazy"')
  })

  it('leaves everything that is not an image of the package as written', async () => {
    const out = await html(
      '![Missing](assets/missing.png)\n\n![Remote](https://example.com/r.png)\n\n![Site](/media/x.png#20x10)',
    )

    expect(out).toContain('src="assets/missing.png"')
    expect(out).toContain('src="https://example.com/r.png"')
    expect(out).toContain('src="/media/x.png"')
    expect(out).not.toContain('data:image')
  })

  it('changes nothing when no image source is given', async () => {
    const { content } = await renderMarkdown('![First](assets/a.png)')

    expect(renderToStaticMarkup(content)).toContain('src="assets/a.png"')
  })

  it('does not let the article smuggle a data URL in: the sanitizer still refuses it', async () => {
    const out = await html('<img src="data:image/png;base64,ZZZZ" alt="x">\n\n[x](javascript:alert(1))')

    expect(out).not.toContain('ZZZZ')
    expect(out).not.toContain('javascript:')
  })
})

describe('renderMarkdown with an image source and blocks', () => {
  useBlockDoubles()
  const seen: string[] = []

  beforeEach(() => {
    seen.length = 0
    vi.spyOn(BLOCK_COMPONENTS, 'figure').mockImplementation((({ props }: { props: { src: string } }) => {
      seen.push(props.src)
      return <span data-block="figure" />
    }) as never)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('gives the figure block the data URL of its image, after the block was checked as written', async () => {
    await html('::figure{src="assets/a.png" alt="The first image"}')

    expect(seen).toEqual([PNG])
  })

  it('leaves the source of a figure that names no image of the package untouched', async () => {
    await html('::figure{src="assets/missing.png" alt="x"}\n\n::figure{src="https://example.com/r.png" alt="y"}')

    expect(seen).toEqual(['assets/missing.png', 'https://example.com/r.png'])
  })

  it('maps the Markdown images inside a gallery', async () => {
    const out = await html(':::gallery{columns=2}\n![One](assets/a.png)\n![Two](assets/b.webp)\n:::')

    expect(out).toContain(PNG)
    expect(out).toContain('data:image/webp;base64,BBBB')
  })

  it('cannot be fooled by a raw ai-block element: a data URL as a source is refused like any other', async () => {
    const out = await html(`<ai-block block="figure" src="${PNG}" alt="forged"></ai-block>`)

    expect(seen).toEqual([])
    expect(out).not.toContain('data-block="figure"')
  })

  it('passes the check of the block syntax through unchanged', async () => {
    const { problems } = await renderMarkdown(':::callout{tone=x}\nText\n:::', { imageSource: images })

    expect(problems).toHaveLength(1)
  })
})
