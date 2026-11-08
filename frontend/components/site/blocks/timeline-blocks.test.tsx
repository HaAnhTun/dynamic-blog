import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderMarkdown, renderMarkdownToFeedHtml } from '@/lib/markdown'
import { msg } from '@/test/render-intl'
import { Event } from './Event'
import { Timeline } from './Timeline'

const page = async (markdown: string) => {
  const result = await renderMarkdown(markdown)
  return { ...result, ...render(<>{result.content}</>) }
}

/** A class that sets a fixed pixel width or a negative margin: blocks fill the column the page shell gives them. */
const FIXED_WIDTH = /(^|\s)(w|min-w|max-w)-\[\d+px\]|(^|\s)-m[xlrtb]?-/
const WRAP = '[overflow-wrap:anywhere]'

const MARKDOWN = [
  '::::timeline{title="Outage"}',
  ':::event{title="Alert fires" when="09:02"}',
  'The pager goes off with **two** alarms.',
  ':::',
  ':::event{title="Fixed" when="Phase 2"}',
  'Rolled back.',
  ':::',
  '::::',
].join('\n')

const sample = (title?: string) => (
  <Timeline props={{ title }}>
    <Event props={{ title: 'Alert fires', when: '2025-03-02' }}>
      <p>Paged.</p>
    </Event>
    <Event props={{ title: 'Fixed', when: 'Phase 2' }} />
  </Timeline>
)

describe('timeline and event', () => {
  it('is an ordered list with one item per event, in order, each leading with its label as text and then its title', () => {
    const { container } = render(sample())

    const list = container.querySelector('ol')!
    const items = list.querySelectorAll(':scope > li')
    expect(items).toHaveLength(2)
    // The label comes first in the text, so the order and the meaning do not depend on any CSS.
    expect(items[0]!.textContent).toMatch(/^2025-03-02Alert firesPaged\.$/)
    expect(items[1]!.textContent).toMatch(/^Phase 2Fixed$/)
    expect(container.querySelectorAll('[data-block="event"]')).toHaveLength(2)
    expect(container.querySelector('[data-block="timeline"]')).not.toBeNull()
  })

  it('keeps the list a list for assistive technology and hides the drawn marker and line from it', () => {
    const { container } = render(sample())

    expect(container.querySelector('ol')).toHaveAttribute('role', 'list')
    const markers = container.querySelectorAll('li > [aria-hidden="true"]')
    expect(markers).toHaveLength(2)
    for (const marker of markers) expect(marker).toBeEmptyDOMElement()
    // The line is a pseudo element of the item, so no node of it exists to be read.
    for (const item of container.querySelectorAll('li')) expect(item.className).toContain('before:bg-neutral-300')
  })

  it('names the list by its title, or by a default label when there is no title', () => {
    const titled = render(sample('Outage'))
    const list = titled.container.querySelector('ol')!
    expect(titled.getByText('Outage')).toHaveAttribute('id', list.getAttribute('aria-labelledby'))
    titled.unmount()

    const plain = render(sample())
    expect(plain.getByRole('list', { name: msg('Site.blocks.timelineLabel') })).toBeInTheDocument()
  })

  it('does not use a heading for any title, so the table of contents of the article stays right', () => {
    const { container } = render(sample('Outage'))

    expect(container.querySelector('h1,h2,h3,h4,h5,h6')).toBeNull()
  })

  it('shows no empty body wrapper for an event without content', () => {
    const { container } = render(sample())

    const items = container.querySelectorAll('li')
    expect(items[0]!.querySelector('.prose')).not.toBeNull()
    expect(items[1]!.querySelector('.prose')).toBeNull()
  })

  it('lets a long label and a long title wrap instead of overflowing', () => {
    const longTitle = 'T'.repeat(200)
    const longLabel = 'W'.repeat(200)
    const { container } = render(
      <Timeline props={{}}>
        <Event props={{ title: longTitle, when: longLabel }} />
      </Timeline>,
    )

    const item = container.querySelector('li')!
    for (const text of [longTitle, longLabel]) {
      const element = within(item).getByText(text)
      expect(element.className).toContain(WRAP)
      expect(element.className).not.toMatch(/truncate|whitespace-nowrap/)
    }
  })

  it('has dark classes, container queries, data-block roots and no fixed pixel width', () => {
    const { container } = render(sample())

    expect(container.innerHTML).toContain('dark:')
    const root = container.querySelector('[data-block="timeline"]')!
    expect(root.className).toContain('@container')
    expect(root.className).toContain('not-prose')
    expect(root.className).toContain('min-w-0')
    expect(root.className).toContain('max-w-full')
    for (const element of container.querySelectorAll('[class]')) {
      expect(element.getAttribute('class'), element.tagName).not.toMatch(FIXED_WIDTH)
    }
  })

  it('keeps Markdown inside an event, in order, through the real pipeline', async () => {
    const { container, problems } = await page(MARKDOWN)

    expect(problems).toEqual([])
    const items = container.querySelectorAll('[data-block="timeline"] > ol > li')
    expect(items).toHaveLength(2)
    expect(items[0]!.textContent).toMatch(/^09:02Alert firesThe pager goes off with two alarms\.$/)
    expect(items[0]!.querySelector('strong')).toHaveTextContent('two')
    expect(items[1]).toHaveTextContent('Phase 2')
    // The newlines between the child blocks are not rendered as content.
    expect(container.textContent).not.toContain(':::')
  })

  it('restores the element styles inside the body: lists, code and links keep their look', async () => {
    const { container, problems } = await page(
      [
        '::::timeline',
        ':::event{title="Setup" when="Day 1"}',
        '- one',
        '- two',
        '',
        '```bash',
        'make build',
        '```',
        ':::',
        ':::event{title="Done" when="Day 2"}',
        'See [the notes](https://example.com/notes).',
        ':::',
        '::::',
      ].join('\n'),
    )

    expect(problems).toEqual([])
    const body = container.querySelector('[data-block="event"] .prose')!
    expect(body).not.toBeNull()
    expect(body.className).toContain(WRAP)
    expect(body.className).toContain('[&>:first-child]:mt-0')
    expect(body.className).toContain('[&_a]:text-brand')
    expect(body.querySelectorAll('li')).toHaveLength(2)
    expect(body.querySelector('pre')).toHaveTextContent('make build')
  })

  it('draws a callout nested in an event through the real pipeline', async () => {
    const { container, problems } = await page(
      [
        ':::::timeline',
        '::::event{title="Alert" when="09:02"}',
        'Paged.',
        '',
        ':::callout{type="warning" title="Careful"}',
        'Do not restart yet.',
        ':::',
        '::::',
        '::::event{title="Fixed" when="11:30"}',
        'Done.',
        '::::',
        ':::::',
      ].join('\n'),
    )

    expect(problems).toEqual([])
    const first = container.querySelector('[data-block="event"]')!
    expect(first.querySelector('[data-block="callout"]')).toHaveTextContent('Do not restart yet.')
    expect(screen.getAllByRole('listitem').length).toBeGreaterThanOrEqual(2)
  })

  it('becomes an ordered list in the feed, each event leading with its label', async () => {
    const html = await renderMarkdownToFeedHtml(MARKDOWN, 'https://blog.example/posts/x')

    expect(html).toContain('<ol>')
    expect(html.match(/<li>/g)).toHaveLength(2)
    expect(html).toContain('<strong>09:02 - Alert fires</strong>')
    expect(html).not.toContain('ai-block')
  })
})
