import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import MarkdownPreview from './MarkdownPreview'
import { renderMarkdown } from '@/lib/markdown'

describe('MarkdownPreview', () => {
  it('renders the same markup the public page would for the same Markdown', async () => {
    const markdown = '# Heading\n\n```java\nSystem.out.println("hi");\n```\n'

    const preview = render(await MarkdownPreview({ markdown })).container.innerHTML
    // `.content`, because `renderMarkdown` returns `{ content, toc }`. The plan's
    // `{await renderMarkdown(markdown)}` hands React the object itself and throws
    // "Objects are not valid as a React child" — the same defect it had in the component.
    const publicMarkup = render(<>{(await renderMarkdown(markdown)).content}</>).container.innerHTML

    // The reason the Admin UI lives in the same Next app: one pipeline, so a preview
    // cannot drift from the page it is previewing. Comparing the markup is what makes
    // that structural rather than aspirational.
    expect(preview).toContain(publicMarkup)
  })

  it('does not execute script in the Markdown', async () => {
    const { container } = render(await MarkdownPreview({ markdown: '<script>window.x=1</script>\n\nhello' }))

    // rehype-sanitize is in the public pipeline; this proves the preview inherits it
    // rather than re-deriving a looser one. The channel is the DOM, not the text.
    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toContain('hello')
  })
})
