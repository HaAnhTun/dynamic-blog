import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../markdown'
import { validateBlocks } from './validate'

/**
 * What the authoring guide says about the page, pinned by drawing it. Each test is one sentence of the guide (`authoring-prompt.ts`,
 * `docs/ai-article-authoring.md`) that the blind test of round two found unclear: the guide may only say what these tests show.
 */

async function draw(markdown: string) {
  const { content, problems } = await renderMarkdown(markdown)
  const { container } = render(<>{content}</>)
  return { container, problems }
}

describe('what the guide says about code inside a block', () => {
  const inCallout = (fence: string) => `:::callout\nRun this:\n\n${fence}\n:::`

  it('a # comment line in a fence inside a block is not a heading', async () => {
    const markdown = inCallout('```bash\n# install the client\nnpm ci\n```')
    expect(validateBlocks(markdown)).toEqual([])
    const { container, problems } = await draw(markdown)
    expect(problems).toEqual([])
    expect(container.querySelector('h1, h2, h3, h4, h5, h6')).toBeNull()
    expect(container.querySelector('[data-block="callout"] pre')?.textContent).toContain('# install the client')
  })

  it('a TOML section line and the context lines of a diff are fine inside a block', async () => {
    const markdown = inCallout(
      '```toml\n[rules.pdf]\nname = "x"\n```\n\n```diff\n@@ -1,2 +1,2 @@\n context line\n-old\n+new\n```',
    )
    expect(validateBlocks(markdown)).toEqual([])
    const { container, problems } = await draw(markdown)
    expect(problems).toEqual([])
    expect(container.querySelector('[data-block="callout"]')?.textContent).toContain('[rules.pdf]')
  })

  it('a diff colours the added and the removed line and leaves the context line and the hunk header alone', async () => {
    const { container } = await draw('```diff\n@@ -1,2 +1,2 @@\n context line\n-old\n+new\n```')
    expect(container.querySelectorAll('.line[data-diff="add"]')).toHaveLength(1)
    expect(container.querySelectorAll('.line[data-diff="remove"]')).toHaveLength(1)
    expect(container.querySelectorAll('.line')).toHaveLength(4)
  })

  it('highlight counts from 1 on the first line of the code inside the fence', async () => {
    const { container } = await draw('```java highlight="2"\nfirst\nsecond\nthird\n```')
    const marked = [...container.querySelectorAll('.line[data-highlighted]')]
    expect(marked.map((line) => line.textContent)).toEqual(['second'])
  })

  it('a label that is not listed, such as powershell, is plain text and not a problem; a shellsession keeps its prompts', async () => {
    const { container, problems } = await draw(
      '```powershell\nGet-Item x\n```\n\n```text title="PowerShell"\nGet-Item x\n```\n\n```shellsession\n$ ls\nfile.txt\n```',
    )
    expect(problems).toEqual([])
    const code = [...container.querySelectorAll('pre')].map((pre) => pre.textContent)
    expect(code).toEqual(['Get-Item x', 'Get-Item x', '$ ls\nfile.txt'])
  })
})

describe('what the guide says about text inside a block', () => {
  it('kbd, sub, sup and the glossary tags work in a block body and abbr loses its tag', async () => {
    const { container, problems } = await draw(
      ':::callout\nPress <kbd>Ctrl</kbd> + <kbd>C</kbd>, H<sub>2</sub>O, x<sup>2</sup> and <abbr>HTTP</abbr>.\n\n<dl><dt>Term</dt><dd>Meaning</dd></dl>\n:::',
    )
    expect(problems).toEqual([])
    const callout = container.querySelector('[data-block="callout"]')!
    expect(callout.querySelectorAll('kbd')).toHaveLength(2)
    expect(callout.querySelector('sub')).not.toBeNull()
    expect(callout.querySelector('sup')).not.toBeNull()
    expect(callout.querySelector('dl > dt')?.textContent).toBe('Term')
    expect(callout.querySelector('dl > dd')?.textContent).toBe('Meaning')
    expect(callout.querySelector('abbr')).toBeNull()
    expect(callout.textContent).toContain('HTTP')
  })

  it('a footnote reference in a block body is a footnote link and the definition at the end of the article is read', async () => {
    const { container, problems } = await draw(':::callout\nInside the block[^1].\n:::\n\n[^1]: The note.')
    expect(problems).toEqual([])
    expect(container.querySelector('[data-block="callout"] sup a[data-footnote-ref]')).not.toBeNull()
    expect(container.querySelector('section[data-footnotes]')?.textContent).toContain('The note.')
  })

  it('an ampersand in text is shown as an ampersand', async () => {
    const { container } = await draw('Lantern & Loom')
    expect(container.textContent).toContain('Lantern & Loom')
  })

  it('a link keeps the path as written, with or without a language prefix', async () => {
    const { container } = await draw('[One](/posts/next-part) and [Two](/en/posts/next-part)')
    expect([...container.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual([
      '/posts/next-part',
      '/en/posts/next-part',
    ])
  })
})

describe('what the guide says about the blank lines around a block', () => {
  it('the importer reads a block that follows a line of text or another block directly', async () => {
    const markdown = 'Some text\n:::callout\nFirst\n:::\n:::callout\nSecond\n:::\nMore text'
    expect(validateBlocks(markdown)).toEqual([])
    const { container, problems } = await draw(markdown)
    expect(problems).toEqual([])
    expect(container.querySelectorAll('[data-block="callout"]')).toHaveLength(2)
    expect([...container.querySelectorAll(':scope > p')].map((paragraph) => paragraph.textContent)).toEqual([
      'Some text',
      'More text',
    ])
  })

  it('sibling blocks inside a container follow each other with no blank line', async () => {
    const markdown = ':::::steps\n::::step{title="One"}\nA\n::::\n::::step{title="Two"}\nB\n::::\n:::::'
    expect(validateBlocks(markdown)).toEqual([])
    const { container } = await draw(markdown)
    expect(container.querySelectorAll('[data-block="step"]')).toHaveLength(2)
  })
})

describe('what the guide says about the other blocks', () => {
  it('an entry of a file tree may carry a description and plain words that mark it, and is drawn as written', async () => {
    const { container, problems } = await draw(
      ':::file-tree\n- src/\n  - main.ts - the entry point (new)\n  - util.ts (changed)\n- README.md\n:::',
    )
    expect(problems).toEqual([])
    const items = [...container.querySelectorAll('[data-block="file-tree"] li')].map((item) =>
      item.firstChild?.textContent?.trim(),
    )
    expect(items).toEqual(['src/', 'main.ts - the entry point (new)', 'util.ts (changed)', 'README.md'])
    expect(container.querySelector('[data-block="file-tree"] ul ul')).not.toBeNull()
  })

  it('takeaways may open the article, before the first heading', async () => {
    const { container, problems } = await draw(':::takeaways{title="In short"}\n- One\n- Two\n:::\n\n## Body\n\nText.')
    expect(problems).toEqual([])
    expect(container.firstElementChild?.getAttribute('data-block')).toBe('takeaways')
  })

  it('details with the same group share one name, wherever they stand, and the default variant is inline', async () => {
    const { container } = await draw(
      ':::details{title="One" group="faq"}\nA\n:::\n\nText between.\n\n:::details{title="Two" group="faq"}\nB\n:::',
    )
    const details = [...container.querySelectorAll('details[data-block="details"]')]
    expect(details.map((element) => element.getAttribute('name'))).toEqual(['faq', 'faq'])
    expect(details.map((element) => element.getAttribute('data-variant'))).toEqual(['inline', 'inline'])
  })

  it('the panels of tabs that are not selected are hidden and only the first one shows', async () => {
    const { container } = await draw(
      ':::::::tabs\n::::::tab{title="One"}\nFirst panel.\n::::::\n::::::tab{title="Two"}\nSecond panel.\n::::::\n:::::::',
    )
    const panels = [...container.querySelectorAll('[role="tabpanel"]')]
    expect(panels.map((panel) => panel.hasAttribute('hidden'))).toEqual([false, true])
  })

  it('a Markdown image has no limit on its alt text and a title that becomes its caption', async () => {
    const alt = 'a'.repeat(400)
    const { container, problems } = await draw(`![${alt}](https://example.com/a.png "The caption")`)
    expect(problems).toEqual([])
    expect(container.querySelector('img')?.getAttribute('alt')).toHaveLength(400)
    expect(container.querySelector('figcaption')?.textContent).toBe('The caption')
  })
})

describe('what the guide says about habits that import without a report', () => {
  it('a GitHub-style note is an ordinary quote with the literal text, and nothing is reported', async () => {
    const markdown = '> [!NOTE]\n> Careful.'
    expect(validateBlocks(markdown)).toEqual([])
    const { container } = await draw(markdown)
    expect(container.querySelector('[data-block]')).toBeNull()
    expect(container.querySelector('blockquote')?.textContent).toContain('[!NOTE]')
  })

  it('a bare task list outside a checklist is a plain list of disabled checkboxes, and nothing is reported', async () => {
    const markdown = '- [ ] One\n- [x] Two'
    expect(validateBlocks(markdown)).toEqual([])
    const { container } = await draw(markdown)
    expect(container.querySelector('[data-block="checklist"]')).toBeNull()
    const boxes = [...container.querySelectorAll('ul.contains-task-list input[type="checkbox"]')]
    expect(boxes.map((box) => box.hasAttribute('disabled'))).toEqual([true, true])
  })
})
