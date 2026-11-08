import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderMarkdown, renderMarkdownToFeedHtml } from '@/lib/markdown'
import { msg, renderWithIntl } from '@/test/render-intl'
import { Metric } from './Metric'
import { Metrics } from './Metrics'

type MetricProps = React.ComponentProps<typeof Metric>['props']

const WRAP = '[overflow-wrap:anywhere]'
const FIXED_WIDTH = /(^|\s)(w|min-w|max-w)-\[\d+px\]|(^|\s)-m[xlrtb]?-/

function expectWidthAgnostic(container: HTMLElement) {
  for (const element of container.querySelectorAll('[class]')) {
    expect(element.getAttribute('class'), element.tagName).not.toMatch(FIXED_WIDTH)
  }
  const root = container.querySelector('[data-block]')!
  expect(root.className).toContain('not-prose')
  expect(root.className).toContain('min-w-0')
  expect(root.className).toContain('max-w-full')
}

const metric = (props: Partial<MetricProps> = {}) => <Metric props={{ label: 'p95 latency', value: '38 ms', ...props }} />

const sample = (props: { title?: string; caption?: string } = {}) => (
  <Metrics props={props}>
    {metric({ trend: 'down', note: 'was 410 ms' })}
    {metric({ label: 'Throughput', value: '1,200 jobs/s', trend: 'up' })}
    {metric({ label: 'Errors', value: '0.2%', trend: 'flat' })}
  </Metrics>
)

describe('metrics and metric', () => {
  it('is a semantic list with one item per figure, each marked as a metric block', () => {
    const { container } = renderWithIntl(sample())

    const list = container.querySelector('[data-block="metrics"] ul')!
    expect(list).toHaveAttribute('role', 'list')
    const items = list.querySelectorAll(':scope > li')
    expect(items).toHaveLength(3)
    for (const item of items) expect(item).toHaveAttribute('data-block', 'metric')
  })

  it('names the list by its title, or by a default label when there is no title', () => {
    const titled = renderWithIntl(sample({ title: 'After the fix' }))
    const list = titled.container.querySelector('ul')!
    expect(titled.getByText('After the fix')).toHaveAttribute('id', list.getAttribute('aria-labelledby'))
    expect(list).not.toHaveAttribute('aria-label')
    titled.unmount()

    const plain = renderWithIntl(sample())
    expect(plain.getByRole('list', { name: msg('Site.blocks.metricsLabel') })).toBeInTheDocument()
  })

  // Both blind authors wrote exactly four figures: in three columns the fourth card stood alone on a second row.
  it('keeps two across for four figures, so the last one is not left alone on a second row', () => {
    const four = renderWithIntl(
      <Metrics props={{}}>
        {metric()}
        {metric()}
        {metric()}
        {metric()}
      </Metrics>,
    )
    const list = four.container.querySelector('ul')!
    expect(list.className).toContain('@lg:grid-cols-2')
    expect(list.className).not.toContain('@2xl:grid-cols-3')
    four.unmount()

    const three = renderWithIntl(sample())
    expect(three.container.querySelector('ul')!.className).toContain('@2xl:grid-cols-3')
  })

  it('does not use a heading for the title, so the table of contents of the article stays right', () => {
    const { container } = renderWithIntl(sample({ title: 'After the fix' }))

    expect(container.querySelector('h1,h2,h3,h4,h5,h6')).toBeNull()
  })

  it('shows the caption below the figures', () => {
    const { container } = renderWithIntl(sample({ caption: 'One cluster, one week.' }))

    const root = container.querySelector('[data-block="metrics"]')!
    expect(root.lastElementChild).toHaveTextContent('One cluster, one week.')
  })

  it.each(['up', 'down', 'flat'] as const)('writes the %s trend out in words and draws an arrow shape', (trend) => {
    const { container } = renderWithIntl(metric({ trend }))

    const item = container.querySelector('li')!
    expect(item).toHaveTextContent(msg(`Site.blocks.metric.trend.${trend}`))
    const arrow = item.querySelector('svg')!
    expect(arrow).toHaveAttribute('aria-hidden', 'true')
    expect(arrow).toHaveAttribute('data-trend', trend)
  })

  it('draws a different shape for each trend, so the direction never depends on colour', () => {
    const shapes = (['up', 'down', 'flat'] as const).map((trend) => {
      const { container, unmount } = renderWithIntl(metric({ trend }))
      const shape = container.querySelector('svg')!.innerHTML
      unmount()
      return shape
    })

    expect(new Set(shapes).size).toBe(3)
  })

  it('shows no trend line and no arrow without a trend', () => {
    const { container } = renderWithIntl(metric())

    expect(container.querySelector('svg')).toBeNull()
    for (const trend of ['up', 'down', 'flat']) {
      expect(container.textContent).not.toContain(msg(`Site.blocks.metric.trend.${trend}`))
    }
  })

  it('reads label, value, trend and note, in that order', () => {
    const { container } = renderWithIntl(metric({ trend: 'down', note: 'was 410 ms' }))

    const text = container.querySelector('li')!.textContent!
    const positions = ['p95 latency', '38 ms', msg('Site.blocks.metric.trend.down'), 'was 410 ms'].map((part) =>
      text.indexOf(part),
    )
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('keeps the value as text and sets it large', () => {
    const { container } = renderWithIntl(metric())

    const value = [...container.querySelectorAll('li *')].find((element) => element.textContent === '38 ms')!
    expect(value.tagName).not.toBe('IMG')
    expect(value.className).toContain('text-3xl')
    expect(container.querySelector('img')).toBeNull()
  })

  it('wraps a long label, value and note inside the frame instead of overflowing it', () => {
    const long = 'x'.repeat(60)
    const { container } = renderWithIntl(metric({ label: long, value: 'y'.repeat(40), note: 'z'.repeat(120), trend: 'up' }))

    const item = container.querySelector('li')!
    expect(item.className).toContain('min-w-0')
    for (const part of [long, 'y'.repeat(40), 'z'.repeat(120)]) {
      const element = [...item.querySelectorAll('*')].find((candidate) => candidate.textContent === part)!
      expect(element.className, part.slice(0, 1)).toContain(WRAP)
    }
  })

  it('lays the figures out with container queries and no fixed widths', () => {
    const { container } = renderWithIntl(sample())

    const root = container.querySelector('[data-block="metrics"]')!
    expect(root.className).toContain('@container')
    const list = root.querySelector('ul')!
    expect(list.className).toContain('grid')
    expect(list.className).toContain('grid-cols-1')
    expect(list.className).toMatch(/@\w+:grid-cols-2/)
    expect(list.className).toMatch(/@\w+:grid-cols-3/)
    expect(list.className).not.toMatch(/(^|\s)(sm|md|lg|xl):/)
    expectWidthAgnostic(container)
  })

  it('has dark mode classes', () => {
    const { container } = renderWithIntl(sample({ title: 'Figures', caption: 'Source.' }))

    expect(container.querySelector('[data-block="metric"]')!.className).toContain('dark:')
    expect(container.innerHTML).toContain('dark:text-neutral-100')
  })

  it('works through the real pipeline, with the attributes as written', async () => {
    const result = await renderMarkdown(
      [
        ':::metrics{title="After the fix" caption="One cluster."}',
        '::metric{label="p95 latency" value="38 ms" trend=down note="was 410 ms"}',
        '::metric{label="Throughput" value="1,200 jobs/s"}',
        ':::',
      ].join('\n'),
    )
    const { container } = render(<>{result.content}</>)

    expect(result.problems).toEqual([])
    expect(container.querySelectorAll('[data-block="metrics"] > ul > [data-block="metric"]')).toHaveLength(2)
    expect(container.textContent).toContain('was 410 ms')
    expect(container.textContent).not.toContain('::metric')
  })

  it('becomes a plain list in the feed, with the trend as a word', async () => {
    const html = await renderMarkdownToFeedHtml(
      [
        ':::metrics{title="After the fix"}',
        '::metric{label="p95 latency" value="38 ms" trend=down note="was 410 ms"}',
        '::metric{label="Errors" value="0.2%"}',
        ':::',
      ].join('\n'),
      'https://blog.example/posts/x',
    )

    expect(html).toContain('<ul>')
    expect(html.match(/<li>/g)).toHaveLength(2)
    expect(html).toContain('p95 latency')
    expect(html).toContain('was 410 ms')
    expect(html).not.toContain('ai-block')
    expect(html).not.toContain('<svg')
  })
})
