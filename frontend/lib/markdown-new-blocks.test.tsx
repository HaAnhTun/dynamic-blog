import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { BLOCK_COMPONENTS } from '@/components/site/blocks'
import { useBlockDoubles } from '@/test/block-doubles'
import { renderMarkdown, renderMarkdownToFeedHtml } from './markdown'

/**
 * The blocks added in round two (file-tree, timeline, metrics, tabs and the group of details) through the whole pipeline: the
 * attributes survive the HTML steps (the names `label`, `value` and `group` are also HTML attribute names), each block reaches its
 * component, and the feed shows plain HTML.
 */

const page = async (markdown: string) => {
  const result = await renderMarkdown(markdown)
  const view = render(<>{result.content}</>)
  return { ...result, ...view }
}
const feed = (markdown: string) => renderMarkdownToFeedHtml(markdown, 'https://blog.example/posts/a')
const propsOf = (type: keyof typeof BLOCK_COMPONENTS) =>
  vi.mocked(BLOCK_COMPONENTS[type] as (props: { props: unknown }) => unknown).mock.calls.map((call) => call[0].props)

describe('renderMarkdown with the blocks of round two', () => {
  useBlockDoubles()

  it('hands the metrics their figures with the attributes as written', async () => {
    const { problems, container } = await page(
      [
        ':::metrics{title="After the fix" caption="One cluster."}',
        '::metric{label="p95 latency" value="38 ms" trend=down note="was 410 ms"}',
        '::metric{label="Throughput" value="1,200 jobs/s"}',
        ':::',
      ].join('\n'),
    )

    expect(problems).toEqual([])
    expect(propsOf('metrics')).toEqual([{ title: 'After the fix', caption: 'One cluster.' }])
    expect(propsOf('metric')).toEqual([
      { label: 'p95 latency', value: '38 ms', trend: 'down', note: 'was 410 ms' },
      { label: 'Throughput', value: '1,200 jobs/s' },
    ])
    expect(container.querySelectorAll('[data-block="metrics"] [data-block="metric"]')).toHaveLength(2)
  })

  it('hands a timeline its events and an event its label', async () => {
    const { problems, container } = await page(
      [
        '::::timeline{title="Order"}',
        ':::event{title="First alert" when="09:02"}',
        'Paged.',
        ':::',
        ':::event{title="Fixed" when="Phase 2"}',
        ':::',
        '::::',
      ].join('\n'),
    )

    expect(problems).toEqual([])
    expect(propsOf('event')).toEqual([
      { title: 'First alert', when: '09:02' },
      { title: 'Fixed', when: 'Phase 2' },
    ])
    expect(container.querySelectorAll('[data-block="timeline"] > [data-block="event"]')).toHaveLength(2)
  })

  it('hands tabs their tabs, a file tree its list and details its group', async () => {
    const { problems, container } = await page(
      [
        '::::tabs{title="Systems"}',
        ':::tab{title="macOS"}',
        'Mac.',
        ':::',
        ':::tab{title="Linux"}',
        'Linux.',
        ':::',
        '::::',
        '',
        ':::file-tree{title="Layout"}',
        '- src/',
        '  - main.py',
        ':::',
        '',
        ':::details{title="Why" group="faq"}',
        'Because.',
        ':::',
      ].join('\n'),
    )

    expect(problems).toEqual([])
    expect(propsOf('tab')).toEqual([{ title: 'macOS' }, { title: 'Linux' }])
    expect(propsOf('file-tree')).toEqual([{ title: 'Layout' }])
    expect(propsOf('details')).toEqual([{ title: 'Why', open: false, variant: 'inline', group: 'faq' }])
    expect(container.querySelector('[data-block="file-tree"] ul ul')).not.toBeNull()
  })

  it('draws two tabs of the same title as plain content and reports it', async () => {
    const { problems, container } = await page(
      ['::::tabs', ':::tab{title="Mac"}', 'One.', ':::', ':::tab{title="mac"}', 'Two.', ':::', '::::'].join('\n'),
    )

    expect(problems.map((problem) => problem.code)).toEqual(['bad-body'])
    expect(container.querySelector('[data-block]')).toBeNull()
    expect(container).toHaveTextContent('One.')
    expect(container).toHaveTextContent('Two.')
  })
})

describe('renderMarkdownToFeedHtml with the blocks of round two', () => {
  it('shows each block as plain HTML with its content in order', async () => {
    const html = await feed(
      [
        ':::file-tree{title="Layout"}',
        '- src/',
        '  - main.py',
        ':::',
        '',
        '::::timeline{title="Order"}',
        ':::event{title="Alert" when="09:02"}',
        'Paged.',
        ':::',
        ':::event{title="Fixed" when="11:30"}',
        ':::',
        '::::',
        '',
        ':::metrics{title="Figures"}',
        '::metric{label="p95" value="38 ms" trend=down note="was 410 ms"}',
        '::metric{label="Errors" value="0.2%"}',
        ':::',
        '',
        '::::tabs{title="Systems"}',
        ':::tab{title="macOS"}',
        'Mac.',
        ':::',
        ':::tab{title="Linux"}',
        'Linux.',
        ':::',
        '::::',
      ].join('\n'),
    )

    expect(html).toMatch(/<p><strong>Layout<\/strong><\/p>\s*<ul>\s*<li>src\//)
    expect(html).toContain(
      '<ol><li><p><strong>09:02 - Alert</strong></p><p>Paged.</p></li><li><p><strong>11:30 - Fixed</strong></p></li></ol>',
    )
    expect(html).toContain(
      '<ul><li><strong>p95:</strong> 38 ms (down) - was 410 ms</li><li><strong>Errors:</strong> 0.2%</li></ul>',
    )
    expect(html).toContain(
      '<section><p><strong>macOS</strong></p><p>Mac.</p></section><section><p><strong>Linux</strong></p><p>Linux.</p></section>',
    )
    expect(html).not.toMatch(/ai-block|data-block/)
  })
})
