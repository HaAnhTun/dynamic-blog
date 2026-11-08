import type { Element, Root } from 'hast'
import { describe, expect, it } from 'vitest'
import { blocksToPlainHtml, carryCodeMeta, carryCodeTitle, finishBlocks, readBlock } from './hast'

const el = (tagName: string, properties: Element['properties'] = {}, children: Element['children'] = []): Element => ({
  type: 'element',
  tagName,
  properties,
  children,
})
const text = (value: string) => ({ type: 'text' as const, value })
const root = (...children: Element[]): Root => ({ type: 'root', children })
const block = (properties: Element['properties'], children: Element['children'] = []) => el('ai-block', properties, children)

describe('readBlock', () => {
  it('returns the spec and the attributes with defaults for a valid element', () => {
    const read = readBlock(block({ block: 'callout', type: 'tip' }))

    expect(read?.spec.type).toBe('callout')
    expect(read?.props).toEqual({ type: 'tip', variant: 'compact' })
  })

  it('returns nothing for an unknown block, a missing type or attributes that do not pass', () => {
    expect(readBlock(block({ block: 'nope' }))).toBeUndefined()
    expect(readBlock(block({}))).toBeUndefined()
    expect(readBlock(block({ block: 'callout', type: 'alert' }))).toBeUndefined()
    expect(readBlock(block({ block: 'figure', src: 'javascript:alert(1)', alt: 'x' }))).toBeUndefined()
  })
})

describe('finishBlocks', () => {
  it('replaces whatever a figure holds with one img built from its validated attributes', () => {
    const tree = root(
      block({ block: 'figure', src: 'assets/a.png', alt: 'A chart' }, [
        el('script', {}, [text('alert(1)')]),
        el('img', { src: 'https://evil.example/x.png' }),
      ]),
    )

    finishBlocks()(tree)

    const figure = tree.children[0] as Element
    expect(figure.children).toEqual([el('img', { src: 'assets/a.png', alt: 'A chart' })])
  })

  it('leaves a figure with attributes that do not pass as it is: the dispatcher will draw it as plain content', () => {
    const forged = el('img', { src: 'x.png' })
    const tree = root(block({ block: 'figure', src: '//evil.example/a.png', alt: 'x' }, [forged]))

    finishBlocks()(tree)

    expect((tree.children[0] as Element).children).toEqual([forged])
  })

  it('reduces the body of a diagram to its text, whatever markup came with it', () => {
    const tree = root(block({ block: 'diagram', type: 'mermaid' }, [text('graph TD\n'), el('b', {}, [text('A --> B')])]))

    finishBlocks()(tree)

    expect((tree.children[0] as Element).children).toEqual([text('graph TD\nA --> B')])
  })
})

describe('finishBlocks and whitespace', () => {
  it('keeps only the child blocks inside a block made of blocks, not the newlines between them', () => {
    const step = (title: string) => block({ block: 'step', title }, [el('p', {}, [text(title)])])
    const tree = root(block({ block: 'steps' }, [text('\n'), step('One'), text('\n'), step('Two'), text('\n')]))

    finishBlocks()(tree)

    expect((tree.children[0] as Element).children.map((child) => child.type)).toEqual(['element', 'element'])
  })
})

describe('carryCodeTitle', () => {
  it('moves the title from the code element to its pre and to the highlighter meta', () => {
    const code = el('code', { className: ['language-js'], dataTitle: 'a.js' }, [text('x')])
    const pre = el('pre', {}, [code])

    carryCodeTitle()(root(pre))

    expect(pre.properties.dataTitle).toBe('a.js')
    expect(code.properties.dataTitle).toBeUndefined()
    expect(code.data).toEqual({ meta: 'a.js' })
  })

  it('leaves code without a title alone', () => {
    const code = el('code', {}, [text('x')])
    const pre = el('pre', {}, [code])

    carryCodeTitle()(root(pre))

    expect(pre.properties).toEqual({})
    expect(code.data).toBeUndefined()
  })
})

describe('carryCodeMeta', () => {
  it('moves the title and the highlight from the code element to its pre, and gives the highlighter a meta to read', () => {
    const code = el('code', { className: ['language-yaml'], dataTitle: 'a.yaml', dataHighlight: '2,5-7' }, [text('x')])
    const pre = el('pre', {}, [code])

    carryCodeMeta()(root(pre))

    expect(pre.properties).toEqual({ dataTitle: 'a.yaml', dataHighlight: '2,5-7' })
    expect(code.properties.dataTitle).toBeUndefined()
    expect(code.properties.dataHighlight).toBeUndefined()
    expect(code.data).toEqual({ meta: 'a.yaml' })
  })

  it('carries a highlight alone, in its one written form', () => {
    const code = el('code', { dataHighlight: ' 3 , 5 - 6 ' }, [text('x')])
    const pre = el('pre', {}, [code])

    carryCodeMeta()(root(pre))

    expect(pre.properties).toEqual({ dataHighlight: '3,5-6' })
    expect(code.data).toEqual({ meta: '3,5-6' })
  })

  it('drops a highlight that raw HTML wrote and the rules do not allow', () => {
    for (const written of ['', 'x', '9,2', '0', '1,'.repeat(50)]) {
      const code = el('code', { dataHighlight: written }, [text('x')])
      const pre = el('pre', {}, [code])

      carryCodeMeta()(root(pre))

      expect(pre.properties, written).toEqual({})
      expect(code.properties, written).toEqual({})
      expect(code.data, written).toBeUndefined()
    }
  })

  it('is still reachable under its earlier name', () => {
    expect(carryCodeTitle).toBe(carryCodeMeta)
  })
})

describe('blocksToPlainHtml', () => {
  it('unwraps a block that does not pass, so its content stays', () => {
    const tree = root(
      block({ block: 'callout', type: 'alert' }, [el('p', {}, [text('kept')])]),
      block({ block: 'unknown' }, [el('p', {}, [text('also kept')])]),
    )

    blocksToPlainHtml()(tree)

    expect(tree.children.map((child) => (child as Element).tagName)).toEqual(['p', 'p'])
  })

  it('writes a titled line above a code block that has a title and drops the attribute', () => {
    const code = el('code', { dataTitle: 'a.py' }, [text('x')])
    const tree = root(el('pre', {}, [code]))

    blocksToPlainHtml()(tree)

    expect(tree.children).toEqual([el('p', {}, [el('strong', {}, [text('a.py')])]), el('pre', {}, [el('code', {}, [text('x')])])])
  })

  it('turns nested blocks inside out: steps holds list items made from its steps', () => {
    const tree = root(
      block({ block: 'steps' }, [
        block({ block: 'step', title: 'One' }, [el('p', {}, [text('first')])]),
        block({ block: 'step', title: 'Two' }, [el('p', {}, [text('second')])]),
      ]),
    )

    blocksToPlainHtml()(tree)

    expect(tree.children).toHaveLength(1)
    const list = tree.children[0] as Element
    expect(list.tagName).toBe('ol')
    expect(list.children.map((item) => (item as Element).tagName)).toEqual(['li', 'li'])
  })
})

describe('blocksToPlainHtml for the blocks of round two', () => {
  const convert = (...children: Element[]) => {
    const tree = root(...children)
    blocksToPlainHtml()(tree)
    return tree.children as Element[]
  }
  const tags = (nodes: readonly unknown[]) => (nodes as Element[]).map((node) => node.tagName)

  it('shows a file tree as its own list, under its title', () => {
    const list = el('ul', {}, [el('li', {}, [text('src/')])])

    const out = convert(block({ block: 'file-tree', title: 'Layout' }, [list]))

    expect(out).toEqual([el('p', {}, [el('strong', {}, [text('Layout')])]), list])
  })

  it('turns a timeline into an ordered list of events that lead with their label', () => {
    const out = convert(
      block({ block: 'timeline', title: 'Order' }, [
        block({ block: 'event', title: 'Alert', when: '09:02' }, [el('p', {}, [text('Paged.')])]),
        block({ block: 'event', title: 'Fixed', when: '11:30' }),
      ]),
    )

    expect(tags(out)).toEqual(['p', 'ol'])
    const items = out[1]!.children as Element[]
    expect(tags(items)).toEqual(['li', 'li'])
    expect(items[0]).toEqual(
      el('li', {}, [el('p', {}, [el('strong', {}, [text('09:02 - Alert')])]), el('p', {}, [text('Paged.')])]),
    )
  })

  it('turns metrics into a list of label, value, trend and note, with the caption below', () => {
    const out = convert(
      block({ block: 'metrics', title: 'Figures', caption: 'One cluster.' }, [
        block({ block: 'metric', label: 'p95', value: '38 ms', trend: 'down', note: 'was 410 ms' }),
        block({ block: 'metric', label: 'Errors', value: '0.2%' }),
      ]),
    )

    expect(tags(out)).toEqual(['p', 'ul', 'p'])
    const items = out[1]!.children as Element[]
    expect(items[0]).toEqual(el('li', {}, [el('strong', {}, [text('p95:')]), text(' 38 ms (down) - was 410 ms')]))
    expect(items[1]).toEqual(el('li', {}, [el('strong', {}, [text('Errors:')]), text(' 0.2%')]))
    expect(out[2]).toEqual(el('p', {}, [el('em', {}, [text('One cluster.')])]))
  })

  it('shows a tab as a titled section, like a pane, and tabs as the sections in order', () => {
    const out = convert(
      block({ block: 'tabs', title: 'Systems' }, [
        block({ block: 'tab', title: 'macOS' }, [el('p', {}, [text('Mac.')])]),
        block({ block: 'tab', title: 'Linux' }, [el('p', {}, [text('Linux.')])]),
      ]),
    )

    expect(tags(out)).toEqual(['p', 'section', 'section'])
    expect(out[1]).toEqual(el('section', {}, [el('p', {}, [el('strong', {}, [text('macOS')])]), el('p', {}, [text('Mac.')])]))
  })

  it('still draws details as details, whatever its group', () => {
    const out = convert(block({ block: 'details', title: 'Why', group: 'faq' }, [el('p', {}, [text('Because.')])]))

    expect(out).toEqual([el('details', {}, [el('summary', {}, [text('Why')]), el('p', {}, [text('Because.')])])])
  })

  it('drops the highlight of a code fence, because a feed shows the code as it is', () => {
    const code = el('code', { dataHighlight: '2,3' }, [text('x')])

    const out = convert(el('pre', { dataHighlight: '2,3' }, [code]))

    expect(out).toEqual([el('pre', {}, [el('code', {}, [text('x')])])])
  })
})
