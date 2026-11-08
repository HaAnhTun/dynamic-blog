import remarkDirective from 'remark-directive'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { describe, expect, it } from 'vitest'
import { remarkBlocks } from './remark-blocks'
import type { Problem } from './types'

interface Out {
  type: string
  value?: string
  children?: Out[]
  data?: { hName?: string; hProperties?: Record<string, unknown>; hChildren?: unknown }
}

/** Parses and runs the plugin the way the pipeline does: the source is handed over, because `run(tree)` has no file to read. */
function run(markdown: string, options: { withSource?: boolean } = { withSource: true }) {
  const problems: Problem[] = []
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkDirective)
    .use(remarkBlocks, { source: options.withSource ? markdown : undefined, problems })
  const tree = processor.runSync(processor.parse(markdown)) as unknown as Out
  return { tree, problems }
}

describe('remarkBlocks', () => {
  it('marks a valid block for the HTML step: element name, the block type and only the attributes the author wrote', () => {
    const { tree, problems } = run(':::callout{type=warning title="Careful"}\nText.\n:::')

    expect(problems).toEqual([])
    expect(tree.children).toHaveLength(1)
    expect(tree.children![0]!.data).toEqual({
      hName: 'ai-block',
      hProperties: { block: 'callout', type: 'warning', title: 'Careful' },
    })
    expect(tree.children![0]!.children![0]!.type).toBe('paragraph')
  })

  it('writes a boolean that is on as true and leaves one that is off out', () => {
    expect(run(':::details{title=T open}\nx\n:::').tree.children![0]!.data!.hProperties).toEqual({
      block: 'details',
      title: 'T',
      open: true,
    })
    expect(run(':::details{title=T}\nx\n:::').tree.children![0]!.data!.hProperties).toEqual({ block: 'details', title: 'T' })
  })

  it('hands the body of a diagram over untouched, as children of the HTML element', () => {
    const { tree } = run(':::diagram{type=mermaid}\ngraph TD\n    A --> B\n\n# note\n:::')

    const node = tree.children![0]!
    expect(node.children).toEqual([])
    expect(node.data?.hChildren).toEqual([{ type: 'text', value: 'graph TD\n    A --> B\n\n# note' }])
  })

  it('reports a diagram wrapped in a code fence and keeps its text as plain content, not dropped', () => {
    const { tree, problems } = run(':::diagram{type=mermaid}\n```mermaid\ngraph TD\n  A --> B\n```\n:::')

    expect(problems.map((p) => p.code)).toEqual(['bad-body'])
    expect(problems[0]!.message).toContain('without a code fence')
    expect(tree.children!.map((node) => node.type)).toEqual(['code'])
    expect(tree.children![0]).toMatchObject({ type: 'code', lang: 'mermaid', value: 'graph TD\n  A --> B' })
  })

  it('replaces an invalid block by its children and a leaf by a paragraph of its own text', () => {
    const { tree, problems } = run(':::nope\nInside.\n:::\n\n::alsonope{a=1}')

    expect(problems.map((p) => p.code)).toEqual(['unknown-block', 'unknown-block'])
    expect(tree.children!.map((node) => node.type)).toEqual(['paragraph', 'paragraph'])
    expect(tree.children![1]!.children![0]).toMatchObject({ type: 'text', value: '::alsonope{a=1}' })
  })

  it('gives a text directive back as the text it was, in one text node with its neighbours', () => {
    const { tree, problems } = run('At 10:30 sharp, Note:this, :smile: end.')

    expect(problems).toEqual([])
    expect(tree.children![0]!.children).toHaveLength(1)
    expect(tree.children![0]!.children![0]).toMatchObject({ type: 'text', value: 'At 10:30 sharp, Note:this, :smile: end.' })
  })

  it('a child block whose parent is not drawn as a block is not drawn as one either', () => {
    // The steps block is unclosed, so it is plain content, and a step is meaningless outside it.
    const { tree } = run(['::::steps{title=x', ':::step{title=A}', 'text', ':::'].join('\n'))

    const names: string[] = []
    const walk = (node: Out) => {
      if (node.data?.hName) names.push(String(node.data.hProperties?.block))
      node.children?.forEach(walk)
    }
    walk(tree)
    expect(names).not.toContain('step')
  })

  it('turns the title of a code fence into a property of the code element', () => {
    const { tree } = run('```js title="a.js" {1}\nx\n```')

    expect(tree.children![0]!.data?.hProperties).toEqual({ dataTitle: 'a.js' })
  })

  it('carries the highlight of a code fence next to its title, as properties of the code element', () => {
    const code = (meta: string) => run('```yaml ' + meta + '\na: 1\nb: 2\nc: 3\n```').tree.children![0]!.data?.hProperties

    expect(code('title="a.yaml" highlight="2, 3"')).toEqual({ dataTitle: 'a.yaml', dataHighlight: '2,3' })
    expect(code('highlight=1-2')).toEqual({ dataHighlight: '1-2' })
    expect(code('title="a.yaml"')).toEqual({ dataTitle: 'a.yaml' })
  })

  it('reports a highlight it cannot use and draws the code without it', () => {
    const { tree, problems } = run('```yaml title="a.yaml" highlight="4,2"\na: 1\nb: 2\n```')

    expect(problems.map((problem) => problem.code)).toEqual(['bad-fence-highlight'])
    expect(problems[0]!.line).toBe(1)
    expect(tree.children![0]!.data?.hProperties).toEqual({ dataTitle: 'a.yaml' })
  })

  it('refuses two tabs of the same title and draws the block as plain content', () => {
    const { tree, problems } = run(
      ['::::tabs', ':::tab{title=Mac}', 'a', ':::', ':::tab{title=mac}', 'b', ':::', '::::'].join('\n'),
    )

    expect(problems.map((problem) => problem.code)).toEqual(['bad-body'])
    const names: string[] = []
    const walk = (node: Out) => {
      if (node.data?.hName) names.push(String(node.data.hProperties?.block))
      node.children?.forEach(walk)
    }
    walk(tree)
    expect(names).toEqual([])
  })

  it('marks a leaf child of a block as a block of its own', () => {
    const { tree, problems } = run(
      [':::metrics', '::metric{label=a value=1}', '::metric{label=b value=2 trend=up}', ':::'].join('\n'),
    )

    expect(problems).toEqual([])
    expect(tree.children![0]!.children!.map((node) => node.data?.hProperties)).toEqual([
      { block: 'metric', label: 'a', value: '1' },
      { block: 'metric', label: 'b', value: '2', trend: 'up' },
    ])
  })

  it('reads the source from the file when none is given', () => {
    const processor = unified().use(remarkParse).use(remarkDirective).use(remarkBlocks, {})
    const markdown = ':::callout\nText.\n:::'
    const tree = processor.runSync(processor.parse(markdown), markdown) as unknown as Out

    expect(tree.children![0]!.data?.hName).toBe('ai-block')
  })

  it('does nothing to a document without directives', () => {
    const markdown = '# T\n\nText with `code`.\n\n- a\n- b\n'
    const plain = unified().use(remarkParse).use(remarkGfm)
    const before = JSON.stringify(plain.runSync(plain.parse(markdown)))
    const { tree, problems } = run(markdown)

    expect(problems).toEqual([])
    expect(JSON.stringify(tree)).toBe(before)
  })
})
