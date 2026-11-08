import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { hydrateRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderMarkdown } from '@/lib/markdown'
import { IntlWrapper } from '@/test/intl'
import { msg, renderWithIntl } from '@/test/render-intl'
import { Diagram } from './Diagram'

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }))
vi.mock('mermaid', () => ({ default: mermaid }))

const SOURCE = 'flowchart LR\n  A[Client] --> B[Queue]'
const DRAWN = '<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><text>drawn</text></svg>'
const props = { type: 'mermaid' as const }

const drawing = (svg = DRAWN) => mermaid.render.mockImplementation(async () => ({ svg }))
const setTheme = (theme: string | null) =>
  theme === null
    ? document.documentElement.removeAttribute('data-theme')
    : document.documentElement.setAttribute('data-theme', theme)

beforeEach(() => {
  mermaid.initialize.mockReset()
  mermaid.render.mockReset()
  drawing()
})

afterEach(() => {
  setTheme(null)
  vi.restoreAllMocks()
})

describe('Diagram: before and without the drawing', () => {
  it('shows the source in a preformatted block while mermaid has not answered, and no image yet', async () => {
    mermaid.render.mockImplementation(() => new Promise(() => {}))
    const { container } = renderWithIntl(<Diagram props={props} source={SOURCE} />)

    await waitFor(() => expect(mermaid.render).toHaveBeenCalled())
    expect(container.querySelector('pre')).toHaveTextContent('flowchart LR A[Client] --> B[Queue]')
    expect(container.querySelector('pre')!.textContent).toBe(SOURCE)
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('puts the same markup in the server HTML and hydrates without a recoverable error', async () => {
    const host = document.createElement('div')
    host.innerHTML = renderToStaticMarkup(
      <IntlWrapper>
        <Diagram props={props} source={SOURCE} />
      </IntlWrapper>,
    )
    document.body.append(host)
    expect(host.querySelector('pre')!.textContent).toBe(SOURCE)

    const errors: unknown[] = []
    const root = hydrateRoot(
      host,
      <IntlWrapper>
        <Diagram props={props} source={SOURCE} />
      </IntlWrapper>,
      { onRecoverableError: (error) => errors.push(error) },
    )
    await act(async () => {})

    expect(errors).toEqual([])
    await waitFor(() => expect(host.querySelector('svg')).not.toBeNull())
    root.unmount()
    host.remove()
  })
})

describe('Diagram: the drawing', () => {
  it('draws the diagram as an image named by alt, and drops the source block', async () => {
    const { container } = renderWithIntl(<Diagram props={{ ...props, alt: 'How a request reaches the queue' }} source={SOURCE} />)

    const image = await screen.findByRole('img', { name: 'How a request reaches the queue' })
    expect(image.querySelector('svg')).not.toBeNull()
    expect(container.querySelector('pre')).toBeNull()
    expect(mermaid.render).toHaveBeenCalledWith(expect.any(String), SOURCE)
  })

  it('names the image by the title when there is no alt, and by a plain word when there is neither', async () => {
    const { unmount } = renderWithIntl(<Diagram props={{ ...props, title: 'Request flow' }} source={SOURCE} />)
    expect(await screen.findByRole('img', { name: 'Request flow' })).toBeInTheDocument()
    unmount()

    renderWithIntl(<Diagram props={props} source={SOURCE} />)
    expect(await screen.findByRole('img', { name: msg('Site.blocks.diagram.label') })).toBeInTheDocument()
  })

  it('shows the title above and the caption under the diagram', async () => {
    const { container } = renderWithIntl(
      <Diagram props={{ ...props, title: 'Request flow', caption: 'Requests wait in the queue.' }} source={SOURCE} />,
    )

    await screen.findByRole('img')
    expect(container.querySelector('figure')).toHaveTextContent('Request flow')
    expect(container.querySelector('figcaption')).toHaveTextContent('Requests wait in the queue.')
  })

  it('asks mermaid for the strict security level, without starting on its own', async () => {
    renderWithIntl(<Diagram props={props} source={SOURCE} />)
    await screen.findByRole('img')

    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: 'strict', startOnLoad: false, suppressErrorRendering: true }),
    )
  })

  it('draws two diagrams on a page with ids that differ', async () => {
    renderWithIntl(
      <>
        <Diagram props={props} source="graph TD\n  A --> B" />
        <Diagram props={props} source="graph TD\n  C --> D" />
      </>,
    )
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(2))

    const ids = mermaid.render.mock.calls.map((call) => call[0] as string)
    expect(new Set(ids).size).toBe(2)
    for (const id of ids) expect(id).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/)
  })
})

describe('Diagram: theme', () => {
  it('draws with the light theme, and with the dark one when the page is dark', async () => {
    renderWithIntl(<Diagram props={props} source={SOURCE} />)
    await screen.findByRole('img')
    expect(mermaid.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'default' }))

    setTheme('dark')
    await waitFor(() => expect(mermaid.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'dark' })))
  })

  it('draws again when the theme changes, and the new drawing replaces the old one', async () => {
    drawing('<svg viewBox="0 0 1 1"><text>light drawing</text></svg>')
    renderWithIntl(<Diagram props={props} source={SOURCE} />)
    expect(await screen.findByRole('img')).toHaveTextContent('light drawing')

    drawing('<svg viewBox="0 0 1 1"><text>dark drawing</text></svg>')
    setTheme('dark')

    await waitFor(() => expect(screen.getByRole('img')).toHaveTextContent('dark drawing'))
    expect(screen.getByRole('img')).not.toHaveTextContent('light drawing')
    expect(screen.getAllByRole('img')).toHaveLength(1)
  })

  it('stays light in the admin, where the page is light whatever the site theme says', async () => {
    setTheme('dark')
    render(
      <IntlWrapper>
        <div data-admin="">
          <Diagram props={props} source={SOURCE} />
        </div>
      </IntlWrapper>,
    )
    await screen.findByRole('img')

    expect(mermaid.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'default' }))
  })
})

describe('Diagram: when it cannot be drawn', () => {
  it('keeps the source and says so when mermaid rejects the diagram, without throwing into React', async () => {
    mermaid.render.mockRejectedValue(new Error('Parse error on line 2'))
    const { container } = renderWithIntl(<Diagram props={props} source={SOURCE} />)

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(msg('Site.blocks.diagram.failed')))
    expect(container.querySelector('pre')!.textContent).toBe(SOURCE)
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('does not show what mermaid said about the error: the message may quote the source', async () => {
    mermaid.render.mockRejectedValue(new Error('Parse error near SECRET_WORD'))
    renderWithIntl(<Diagram props={props} source={SOURCE} />)

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(msg('Site.blocks.diagram.failed')))
    expect(document.body.textContent).not.toContain('SECRET_WORD')
  })

  it('removes the scratch element mermaid leaves in the page after an error', async () => {
    mermaid.render.mockImplementation(async (id: string) => {
      const leftover = document.createElement('div')
      leftover.id = `d${id}`
      document.body.append(leftover)
      throw new Error('Parse error')
    })
    renderWithIntl(<Diagram props={props} source={SOURCE} />)

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(msg('Site.blocks.diagram.failed')))
    expect(document.querySelector('[id^="dmermaid"]')).toBeNull()
  })

  it('falls back to the source when the library cannot be started', async () => {
    mermaid.initialize.mockImplementation(() => {
      throw new Error('boom')
    })
    const { container } = renderWithIntl(<Diagram props={props} source={SOURCE} />)

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(msg('Site.blocks.diagram.failed')))
    expect(container.querySelector('pre')!.textContent).toBe(SOURCE)
  })

  it('treats an answer that is not a drawing as a failure', async () => {
    drawing('this is not an svg')
    const { container } = renderWithIntl(<Diagram props={props} source={SOURCE} />)

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(msg('Site.blocks.diagram.failed')))
    expect(container.querySelector('pre')!.textContent).toBe(SOURCE)
  })

  it('does not touch the page after it is gone', async () => {
    let finish: (value: { svg: string }) => void = () => {}
    mermaid.render.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { unmount } = renderWithIntl(<Diagram props={props} source={SOURCE} />)
    await waitFor(() => expect(mermaid.render).toHaveBeenCalled())

    unmount()
    await act(async () => finish({ svg: DRAWN }))

    expect(error).not.toHaveBeenCalled()
  })
})

describe('Diagram: what a drawing may contain', () => {
  it('removes scripts, event handlers and script URLs from the drawing before it enters the page', async () => {
    drawing(
      '<svg viewBox="0 0 10 10" onload="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)"><text onclick="alert(4)">ok</text></a>' +
        '<image href="data:text/html,x" /><iframe src="https://example.invalid"></iframe><g><text>kept</text></g></svg>',
    )
    renderWithIntl(<Diagram props={props} source={SOURCE} />)
    const image = await screen.findByRole('img')

    const html = image.innerHTML.toLowerCase()
    expect(html).not.toContain('<script')
    expect(html).not.toContain('onload')
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('data:text/html')
    expect(html).not.toContain('<iframe')
    expect(image).toHaveTextContent('kept')
    expect(image).toHaveTextContent('ok')
  })
})

describe('Diagram: a wide drawing on a narrow screen', () => {
  it('never shows a wide drawing below 70% of its width (11px labels), so the frame scrolls instead of shrinking the labels', async () => {
    drawing('<svg viewBox="0 0 900 120"><text>wide</text></svg>')
    renderWithIntl(<Diagram props={props} source={SOURCE} />)

    const svg = (await screen.findByRole('img')).querySelector('svg')!
    expect(svg.getAttribute('style')).toContain('min-width: min(900px, max(22.5rem, 630px))')
  })

  it('a drawing a little wider than a phone column floors at 22.5rem (the column), so it scales to fit instead of scrolling', async () => {
    drawing('<svg viewBox="0 0 451 120"><text>medium</text></svg>')
    renderWithIntl(<Diagram props={props} source={SOURCE} />)

    const svg = (await screen.findByRole('img')).querySelector('svg')!
    expect(svg.getAttribute('style')).toContain('min-width: min(451px, max(22.5rem, 316px))')
  })

  it('fades the right edge of the box while there is more drawing to scroll to, and stops at the end', async () => {
    drawing('<svg viewBox="0 0 900 120"><text>wide</text></svg>')
    renderWithIntl(<Diagram props={props} source={SOURCE} />)

    const box = await screen.findByRole('img')
    expect(box.className).toContain('data-[more=true]:[mask-image:linear-gradient(to_right')
    // jsdom has no layout: the box is made to look 300px wide over a 900px drawing.
    let left = 0
    Object.defineProperty(box, 'clientWidth', { configurable: true, value: 300 })
    Object.defineProperty(box, 'scrollWidth', { configurable: true, value: 900 })
    Object.defineProperty(box, 'scrollLeft', { configurable: true, get: () => left })

    fireEvent.scroll(box)
    expect(box).toHaveAttribute('data-more', 'true')
    left = 600
    fireEvent.scroll(box)
    expect(box).toHaveAttribute('data-more', 'false')
  })

  it('scrolls inside its own box, which the keyboard can reach once the drawing is there', async () => {
    mermaid.render.mockImplementation(() => new Promise(() => {}))
    const first = renderWithIntl(<Diagram props={props} source={SOURCE} />)
    await waitFor(() => expect(mermaid.render).toHaveBeenCalled())
    expect(first.container.querySelector('[role="img"]')).not.toHaveAttribute('tabindex')
    first.unmount()

    drawing('<svg viewBox="0 0 900 120"><text>wide</text></svg>')
    renderWithIntl(<Diagram props={props} source={SOURCE} />)

    const image = await screen.findByRole('img')
    expect(image).toHaveAttribute('tabindex', '0')
    expect(image.className).toContain('overflow-x-auto')
  })

  it('does nothing to a drawing that has no usable viewBox', async () => {
    drawing('<svg><text>plain</text></svg>')
    renderWithIntl(<Diagram props={props} source={SOURCE} />)

    const svg = (await screen.findByRole('img')).querySelector('svg')!
    expect(svg.getAttribute('style') ?? '').not.toContain('min-width')
  })
})

describe('Diagram: in an article', () => {
  it('reaches the component from the Markdown with the source exactly as written, and is named by alt', async () => {
    const { content, problems } = await renderMarkdown(
      [
        ':::diagram{type="mermaid" alt="Request flow" caption="One request."}',
        '',
        'flowchart LR',
        '    A[API] --> B[Queue]',
        '',
        ':::',
      ].join('\n'),
    )
    expect(problems).toEqual([])
    const { container } = renderWithIntl(<>{content}</>)

    await screen.findByRole('img', { name: 'Request flow' })
    expect(mermaid.render).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('A[API] --> B[Queue]'))
    expect(container.querySelector('figcaption')).toHaveTextContent('One request.')
  })
})
