import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  BLOCKS,
  BLOCK_PROP_NAMES,
  BLOCK_TYPES,
  type BlockPropsOf,
  type RawBodyType,
  TOP_LEVEL_BLOCK_TYPES,
  closestBlockType,
  getBlockSpec,
  isImageSource,
  MAX_FENCE_HIGHLIGHT_ENTRIES,
  parseBlockProps,
  parseFenceHighlight,
  parseFenceTitle,
  parseHighlightValue,
} from './registry'

const spec = (type: string) => getBlockSpec(type)!

describe('the block registry', () => {
  it('lists the sixteen blocks an author can write on their own, and the five that only live inside another', () => {
    expect(TOP_LEVEL_BLOCK_TYPES).toEqual([
      'callout',
      'figure',
      'gallery',
      'compare',
      'comparison',
      'diagram',
      'steps',
      'code-tabs',
      'details',
      'takeaways',
      'checklist',
      'pullquote',
      'file-tree',
      'timeline',
      'metrics',
      'tabs',
    ])
    expect(BLOCK_TYPES.filter((type) => !TOP_LEVEL_BLOCK_TYPES.includes(type))).toEqual([
      'pane',
      'step',
      'event',
      'metric',
      'tab',
    ])
  })

  it('has unique kebab-case types and an English description and accessibility note for each', () => {
    expect(new Set(BLOCK_TYPES).size).toBe(BLOCK_TYPES.length)
    for (const block of BLOCKS) {
      expect(block.type, block.type).toMatch(/^[a-z]+(?:-[a-z]+)*$/)
      for (const text of [block.description, block.a11y]) {
        expect(text.length, block.type).toBeGreaterThan(20)
        expect(text, block.type).toMatch(/^[\x20-\x7e]+$/)
      }
    }
  })

  it('describes every attribute completely: a plain word name, a kind, bounds, a default that is allowed, a description', () => {
    for (const block of BLOCKS) {
      const names = block.props.map((prop) => prop.name)
      expect(new Set(names).size, block.type).toBe(names.length)
      for (const prop of block.props as readonly {
        name: string
        type: string
        required?: boolean
        values?: readonly string[]
        min?: number
        max?: number
        maxLength?: number
        default?: string | number | boolean
        description: string
      }[]) {
        const where = `${block.type}.${prop.name}`
        expect(prop.name, where).toMatch(/^[a-z]+$/)
        expect(prop.description.length, where).toBeGreaterThan(10)
        expect(!(prop.required && prop.default !== undefined), `${where}: required with a default`).toBe(true)
        if (prop.type === 'enum') {
          expect(prop.values?.length, where).toBeGreaterThan(0)
          expect(new Set(prop.values).size, where).toBe(prop.values!.length)
          if (prop.default !== undefined) expect(prop.values, where).toContain(prop.default)
        }
        if (prop.type === 'integer') {
          expect(prop.min, where).toBeDefined()
          expect(prop.max, where).toBeDefined()
          if (prop.default !== undefined) {
            expect(prop.default as number, where).toBeGreaterThanOrEqual(prop.min!)
            expect(prop.default as number, where).toBeLessThanOrEqual(prop.max!)
          }
        }
        // A boolean that is on is written into the HTML tree, one that is off is left out: so the default is always off.
        if (prop.type === 'boolean') expect(prop.default, where).toBe(false)
        if (prop.type === 'text' || prop.type === 'url') expect(prop.maxLength, where).toBeGreaterThan(0)
      }
    }
  })

  it('keeps variants and the variant attribute in step', () => {
    for (const block of BLOCKS) {
      const variant = (block.props as readonly { name: string; values?: readonly string[]; default?: string }[]).find(
        (prop) => prop.name === 'variant',
      )
      if (block.variants.length === 0) {
        expect(variant, block.type).toBeUndefined()
      } else {
        expect(variant?.values, block.type).toEqual(block.variants)
        expect(block.variants, block.type).toContain(variant?.default)
      }
    }
  })

  it('has consistent nesting: allowed children exist, and a child that needs a parent is listed by exactly that parent', () => {
    for (const block of BLOCKS) {
      for (const child of block.allowedChildren) {
        const childSpec = getBlockSpec(child)
        expect(childSpec, `${block.type} allows unknown ${child}`).toBeDefined()
        if (childSpec?.parent) expect(childSpec.parent, `${child} inside ${block.type}`).toBe(block.type)
      }
      if ('parent' in block) {
        expect(getBlockSpec(block.parent)?.allowedChildren, `${block.type} is not listed by ${block.parent}`).toContain(
          block.type,
        )
      }
      if (block.body === 'blocks') expect(block.allowedChildren.length, block.type).toBeGreaterThan(0)
    }
  })

  it('gives the sanitize schema every attribute name once', () => {
    expect([...BLOCK_PROP_NAMES].sort()).toEqual(
      [
        'alt',
        'attribution',
        'caption',
        'columns',
        'group',
        'label',
        'note',
        'open',
        'src',
        'title',
        'trend',
        'type',
        'value',
        'variant',
        'when',
      ].sort(),
    )
  })

  it('suggests the closest block for a typo, and nothing for a stranger', () => {
    expect(closestBlockType('callot')).toBe('callout')
    expect(closestBlockType('Steps')).toBe('steps')
    expect(closestBlockType('codetabs')).toBe('code-tabs')
    expect(closestBlockType('completely-different')).toBeUndefined()
  })
})

describe('the types derived from the registry', () => {
  it('give a component exactly the attributes of its block, required and defaulted ones always present', () => {
    expectTypeOf<BlockPropsOf<'callout'>>().toEqualTypeOf<{
      type: 'info' | 'note' | 'tip' | 'warning' | 'danger'
      variant: 'compact' | 'prominent'
      title?: string
    }>()
    expectTypeOf<BlockPropsOf<'figure'>>().toEqualTypeOf<{
      src: string
      alt: string
      variant: 'standard' | 'wide'
      caption?: string
      attribution?: string
    }>()
    expectTypeOf<BlockPropsOf<'details'>>().toEqualTypeOf<{
      title: string
      open: boolean
      variant: 'inline' | 'appendix'
      group?: string
    }>()
    expectTypeOf<BlockPropsOf<'metric'>>().toEqualTypeOf<{
      label: string
      value: string
      trend?: 'up' | 'down' | 'flat'
      note?: string
    }>()
    expectTypeOf<BlockPropsOf<'event'>>().toEqualTypeOf<{ title: string; when: string }>()
    expectTypeOf<BlockPropsOf<'gallery'>>().toEqualTypeOf<{ columns: number; caption?: string }>()
    expectTypeOf<BlockPropsOf<'diagram'>>().toEqualTypeOf<{ type: 'mermaid'; title?: string; caption?: string; alt?: string }>()
    expectTypeOf<RawBodyType>().toEqualTypeOf<'diagram'>()
    expect(true).toBe(true)
  })
})

describe('parseBlockProps', () => {
  it('applies defaults and reports only what the author wrote as given', () => {
    const parsed = parseBlockProps(spec('callout'), { title: 'Heads up' })

    expect(parsed.issues).toEqual([])
    expect(parsed.props).toEqual({ type: 'info', title: 'Heads up', variant: 'compact' })
    expect(parsed.given).toEqual({ title: 'Heads up' })
  })

  it('reads booleans as flags, integers as numbers, and drops a boolean that is off', () => {
    expect(parseBlockProps(spec('details'), { title: 'T', open: '' }).props).toMatchObject({ open: true })
    expect(parseBlockProps(spec('details'), { title: 'T', open: 'true' }).given).toMatchObject({ open: true })
    expect(parseBlockProps(spec('details'), { title: 'T', open: 'false' }).given).toEqual({ title: 'T' })
    expect(parseBlockProps(spec('details'), { title: 'T' }).props).toMatchObject({ open: false })
    expect(parseBlockProps(spec('gallery'), { columns: '3' }).props).toEqual({ columns: 3 })
    expect(parseBlockProps(spec('gallery'), {}).props).toEqual({ columns: 2 })
  })

  it('takes HTML properties as the tree carries them: a boolean true, a number', () => {
    expect(parseBlockProps(spec('details'), { title: 'T', open: true }, { ignoreUnknown: true }).props).toMatchObject({
      open: true,
    })
    expect(parseBlockProps(spec('gallery'), { columns: 3 }, { ignoreUnknown: true }).props).toEqual({ columns: 3 })
  })

  it('reports each class of attribute problem with the allowed alternatives', () => {
    const messages = (type: string, raw: Record<string, unknown>) =>
      parseBlockProps(spec(type), raw).issues.map((issue) => issue.message)

    expect(messages('callout', { type: 'x' })[0]).toContain('"info", "note", "tip", "warning", "danger"')
    expect(messages('callout', { color: 'red' })[0]).toContain('"type", "title", "variant"')
    expect(messages('takeaways', { color: 'red' })[0]).toContain('"title"')
    expect(messages('figure', { src: 'assets/a.png' })[0]).toContain('"alt"')
    expect(messages('callout', { title: '' })[0]).toContain('needs a value')
    expect(messages('callout', { title: 'a\u0007b' })[0]).toContain('control characters')
    expect(messages('gallery', { columns: '4' })[0]).toContain('from 2 to 3')
    expect(messages('gallery', { columns: 'two' })[0]).toContain('whole number')
  })

  it('ignores the properties of the HTML tree that are not attributes of the block when asked to', () => {
    const raw = { block: 'callout', className: ['x'], id: 'y', type: 'tip' }

    expect(parseBlockProps(spec('callout'), raw).issues.length).toBeGreaterThan(0)
    expect(parseBlockProps(spec('callout'), raw, { ignoreUnknown: true }).issues).toEqual([])
  })

  it('does not echo more than a few words of a bad value', () => {
    const message = parseBlockProps(spec('callout'), { type: 'x'.repeat(500) }).issues[0]!.message

    expect(message.length).toBeLessThan(250)
  })
})

describe('isImageSource', () => {
  it('accepts a package path, a /media path (with the size hint) and an https URL', () => {
    for (const value of [
      'assets/a.png',
      'assets/sub/dir/photo-1.webp',
      '/media/0b5c3f1e-2d4a-4b6c-8d9e-0f1a2b3c4d5e.png',
      '/media/0b5c3f1e-2d4a-4b6c-8d9e-0f1a2b3c4d5e.png#640x480',
      'https://example.com/a/b.png',
    ]) {
      expect(isImageSource(value), value).toBe(true)
    }
  })

  it('refuses everything that could reach outside the article or run', () => {
    for (const value of [
      '',
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:image/png;base64,AAAA',
      'http://example.com/a.png',
      'ftp://example.com/a.png',
      '//example.com/a.png',
      '/etc/passwd',
      '/media/../secret',
      '../a.png',
      'assets/../../a.png',
      './a.png',
      'assets//a.png',
      'assets\\a.png',
      'C:/a.png',
      'assets/a b.png',
      'assets/a.png?x=1',
      'https://',
      'https://exa mple.com/a.png',
      'https://example.com/"onerror="x',
    ]) {
      expect(isImageSource(value), value).toBe(false)
    }
  })
})

describe('parseFenceTitle', () => {
  it('reads a quoted or a bare title from the fence meta, among other words', () => {
    expect(parseFenceTitle('title="app.py"')).toEqual({ title: 'app.py' })
    expect(parseFenceTitle("title='a b'")).toEqual({ title: 'a b' })
    expect(parseFenceTitle('{1,3} title=bare other')).toEqual({ title: 'bare' })
    expect(parseFenceTitle('mytitle="x"')).toEqual({})
    expect(parseFenceTitle('')).toEqual({})
    expect(parseFenceTitle(null)).toEqual({})
    expect(parseFenceTitle('title=""')).toEqual({})
  })

  it('refuses a title that is too long', () => {
    expect(parseFenceTitle(`title="${'x'.repeat(121)}"`)).toEqual({ problem: 'too-long' })
    expect(parseFenceTitle(`title="${'x'.repeat(120)}"`).title).toHaveLength(120)
  })
})

describe('the blocks of round two', () => {
  it('has file-tree, timeline, metrics and tabs as top-level blocks with the child each one lists', () => {
    expect(spec('file-tree')).toMatchObject({ kind: 'container', body: 'list', allowedChildren: [] })
    expect(spec('timeline')).toMatchObject({ body: 'blocks', allowedChildren: ['event'], minChildren: 2, maxChildren: 20 })
    expect(spec('metrics')).toMatchObject({ body: 'blocks', allowedChildren: ['metric'], minChildren: 2, maxChildren: 6 })
    expect(spec('tabs')).toMatchObject({ body: 'blocks', allowedChildren: ['tab'], minChildren: 2, maxChildren: 6 })
  })

  it('has event, metric and tab only inside their parent, and metric is the first leaf child', () => {
    expect(spec('event')).toMatchObject({ kind: 'container', parent: 'timeline', body: 'markdown-optional' })
    expect(spec('metric')).toMatchObject({ kind: 'leaf', parent: 'metrics', body: 'none' })
    expect(spec('tab')).toMatchObject({ kind: 'container', parent: 'tabs', body: 'markdown' })
  })

  it('asks for unique titles on tabs and nowhere else', () => {
    expect(BLOCKS.filter((block) => 'uniqueTitles' in block).map((block) => block.type)).toEqual(['tabs'])
  })

  it('gives metric a trend of up, down or flat and no default', () => {
    const trend = spec('metric').props.find((prop) => prop.name === 'trend')
    expect(trend).toMatchObject({ type: 'enum', values: ['up', 'down', 'flat'] })
    expect(trend?.default).toBeUndefined()
    expect(parseBlockProps(spec('metric'), { label: 'p95', value: '38 ms', trend: 'sideways' }).issues[0]!.message).toContain(
      '"up", "down", "flat"',
    )
  })

  it('lets a step, a tab and details hold a file tree, and none of them hold tabs, a timeline or metrics', () => {
    for (const type of ['step', 'details', 'tab'] as const) {
      const children: readonly string[] = spec(type).allowedChildren
      expect(children, type).toContain('file-tree')
      for (const heavy of ['tabs', 'timeline', 'metrics']) expect(children, `${type} holds ${heavy}`).not.toContain(heavy)
    }
  })

  it('lets details take a group of up to forty characters', () => {
    expect(parseBlockProps(spec('details'), { title: 'T', group: 'faq' }).props).toMatchObject({ group: 'faq' })
    expect(parseBlockProps(spec('details'), { title: 'T', group: 'x'.repeat(41) }).issues[0]!.message).toContain('longer than 40')
  })
})

describe('parseHighlightValue', () => {
  it('reads lines and ranges and writes them in one form', () => {
    expect(parseHighlightValue('2,5-7')).toEqual({
      ranges: [
        [2, 2],
        [5, 7],
      ],
      highlight: '2,5-7',
    })
    expect(parseHighlightValue(' 2 , 5 - 7 ,9').highlight).toBe('2,5-7,9')
    expect(parseHighlightValue('3-3').highlight).toBe('3')
  })

  it('refuses what is not a list of lines and ranges', () => {
    for (const value of ['0', '-1', '1.5', 'a', '1,,2', '1-', '-3', '1-2-3', '10000', '02', '1;3']) {
      expect(parseHighlightValue(value), value).toEqual({ problem: 'format' })
    }
    expect(parseHighlightValue('')).toEqual({ problem: 'empty' })
    expect(parseHighlightValue('  ')).toEqual({ problem: 'empty' })
  })

  it('refuses lines that do not go up, ranges that run backwards and ranges that overlap', () => {
    for (const value of ['5,2', '7-5', '1-4,3', '2,2', '1-3,3-5']) {
      expect(parseHighlightValue(value), value).toEqual({ problem: 'order' })
    }
    expect(parseHighlightValue('1-3,4-5').highlight).toBe('1-3,4-5')
  })

  it('takes at most forty entries', () => {
    const entries = (n: number) => Array.from({ length: n }, (_, i) => String(i * 2 + 1)).join(',')
    expect(MAX_FENCE_HIGHLIGHT_ENTRIES).toBe(40)
    expect(parseHighlightValue(entries(40)).problem).toBeUndefined()
    expect(parseHighlightValue(entries(41))).toEqual({ problem: 'too-many' })
  })
})

describe('parseFenceHighlight', () => {
  it('reads a quoted or a bare highlight from the fence meta, among other words', () => {
    expect(parseFenceHighlight('highlight="2,5-7"').highlight).toBe('2,5-7')
    expect(parseFenceHighlight("title=a.py highlight='3'").highlight).toBe('3')
    expect(parseFenceHighlight('{1} highlight=4-6 other').highlight).toBe('4-6')
  })

  it('finds nothing in a meta without one, and only a whole word counts', () => {
    expect(parseFenceHighlight('')).toEqual({})
    expect(parseFenceHighlight(null)).toEqual({})
    expect(parseFenceHighlight('title="x"')).toEqual({})
    expect(parseFenceHighlight('nohighlight="2"')).toEqual({})
  })

  it('reports the problem of a highlight that was written', () => {
    expect(parseFenceHighlight('highlight="5,2"')).toEqual({ problem: 'order' })
    expect(parseFenceHighlight('highlight=""')).toEqual({ problem: 'empty' })
  })

  it('reports a highlight that is written but cannot be read: an unterminated quote, a single quote or no value', () => {
    expect(parseFenceHighlight('highlight="2')).toEqual({ problem: 'format' })
    expect(parseFenceHighlight('highlight="2,5-7')).toEqual({ problem: 'format' })
    expect(parseFenceHighlight("highlight='2")).toEqual({ problem: 'format' })
    expect(parseFenceHighlight('highlight=')).toEqual({ problem: 'format' })
    expect(parseFenceHighlight('title="a.py" highlight= 2')).toEqual({ problem: 'format' })
  })

  it('does not take the text of a quoted title for a highlight', () => {
    expect(parseFenceHighlight('title="use highlight= to mark"')).toEqual({})
    expect(parseFenceHighlight("title='use highlight= to mark'")).toEqual({})
    expect(parseFenceHighlight('title="use highlight= to mark" highlight="2"').highlight).toBe('2')
  })
})
