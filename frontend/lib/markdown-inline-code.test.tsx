import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

async function html(markdown: string): Promise<HTMLElement> {
  const { content } = await renderMarkdown(markdown)
  return render(<>{content}</>).container
}

describe('short inline code', () => {
  it('is marked so that it stays on one line on a phone: no break at a hyphen of --flag or single-process', async () => {
    const container = await html('Use `--single-process` or `single-process` here.')

    const codes = [...container.querySelectorAll('code')]
    expect(codes).toHaveLength(2)
    for (const code of codes) expect(code).toHaveAttribute('data-short')
  })

  it('is not marked when it is long or holds a space, so a long command still wraps', async () => {
    const container = await html('Run `npm run build --workspace frontend` and `a-very-long-identifier-that-does-not-fit`.')

    for (const code of container.querySelectorAll('code')) expect(code).not.toHaveAttribute('data-short')
  })

  it('leaves a fenced code block alone', async () => {
    const container = await html('```\nx\n```')

    expect(container.querySelector('pre code')).not.toHaveAttribute('data-short')
  })
})
