import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderMarkdown, renderMarkdownToFeedHtml } from '@/lib/markdown'
import { Details } from './Details'

const FAQ = [
  ':::details{title="How long does it take?" group="faq"}',
  'A minute.',
  ':::',
  '',
  ':::details{title="Does it cost anything?" group="faq" open}',
  'No.',
  ':::',
  '',
  ':::details{title="Where is the code?"}',
  'On the page.',
  ':::',
].join('\n')

describe('details: the group', () => {
  it('passes the group to the native name attribute, which makes the browser open one of them at a time', () => {
    const { container } = render(
      <Details props={{ title: 'Why', open: false, variant: 'inline', group: 'faq' }}>
        <p>Because.</p>
      </Details>,
    )

    expect(container.querySelector('details')).toHaveAttribute('name', 'faq')
  })

  it('has no name attribute without a group, so a lone details block stays independent', () => {
    const { container } = render(
      <Details props={{ title: 'Why', open: false, variant: 'inline' }}>
        <p>Because.</p>
      </Details>,
    )

    expect(container.querySelector('details')).not.toHaveAttribute('name')
  })

  it('gives every block of a group the same name through the real pipeline, and leaves the others alone', async () => {
    const { content, problems } = await renderMarkdown(FAQ)
    expect(problems).toEqual([])
    const { container } = render(<>{content}</>)

    const blocks = [...container.querySelectorAll('details')]
    expect(blocks.map((element) => element.getAttribute('name'))).toEqual(['faq', 'faq', null])
    expect(blocks.map((element) => element.hasAttribute('open'))).toEqual([false, true, false])
  })

  it('keeps one group apart from another', async () => {
    const { content } = await renderMarkdown(
      ':::details{title="A" group="first"}\na\n:::\n\n:::details{title="B" group="second"}\nb\n:::',
    )
    const { container } = render(<>{content}</>)

    expect([...container.querySelectorAll('details')].map((element) => element.getAttribute('name'))).toEqual(['first', 'second'])
  })

  it('keeps each block usable on its own: the title is still the summary and the body is still inside', async () => {
    const { content } = await renderMarkdown(FAQ)
    const { container } = render(<>{content}</>)

    const [first] = container.querySelectorAll('details')
    expect(first!.querySelector(':scope > summary')).toHaveTextContent('How long does it take?')
    expect(first).toHaveTextContent('A minute.')
  })

  it('is plain details in the feed, whatever the group, because a feed reader has no accordion', async () => {
    const html = await renderMarkdownToFeedHtml(FAQ, 'https://blog.example/posts/x')

    expect(html).toMatch(/<details><summary>How long does it take\?<\/summary>/)
    expect(html).not.toContain('name="faq"')
  })
})
