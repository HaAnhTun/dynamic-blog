import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultSchema } from 'rehype-sanitize'
import { describe, expect, it } from 'vitest'
import {
  POST_IMPORT_MAX_FILE_BYTES,
  POST_IMPORT_MAX_PACKAGE_ASSET_BYTES,
  POST_IMPORT_MAX_PACKAGE_BYTES,
  POST_IMPORT_MAX_PACKAGE_ENTRIES,
} from '@/lib/post-import'
import {
  AUTHORING_RULES,
  BLOCK_NOTES,
  CODE_LANGUAGE_ALIASES,
  EXAMPLE_ARCHITECTURE,
  EXAMPLE_FILLING,
  EXAMPLE_NESTING,
  EXAMPLE_TUTORIAL,
  FRONT_MATTER_LIMITS,
  MERMAID_OTHER_TYPES,
  MERMAID_TYPES,
  MERMAID_VERIFIED_VERSION,
  PITFALLS,
  authoringPrompt,
  colonsOf,
  frontMatterReference,
  pitfallsReference,
} from './authoring-prompt'
import { CODE_LANGUAGES } from './code-languages'
import { MAX_RAW_SOURCE } from './remark-blocks'
import { BLOCKS, BLOCK_TYPES, getBlockSpec } from './registry'
import type { BlockSpec } from './types'
import { validateBlocks } from './validate'

/**
 * The drift test of the authoring prompt: the document people give to an AI is generated from the block registry, and this checks both
 * directions, so a block, an attribute, an allowed value or a default that the registry has and the prompt lacks (or the prompt names
 * and the registry does not have) fails here. The rules that only the validator and the importer know are proved the other way round:
 * every wrong example of the prompt is run through `validateBlocks` and must fail with the code the prompt implies, every right one
 * must pass.
 */

const prompt = authoringPrompt()
const specs: readonly BlockSpec[] = BLOCKS

/** The part of the prompt that describes one block: from its heading to the next heading of the same level. */
const sectionOf = (type: string) => {
  const start = prompt.indexOf(`### \`${type}\`\n`)
  const end = prompt.slice(start + 1).search(/\n##+ /)
  return end === -1 ? prompt.slice(start) : prompt.slice(start, start + 1 + end)
}

const oneLine = (spec: BlockSpec) => spec.kind === 'leaf' || spec.body === 'none'

describe('the authoring prompt and the block registry', () => {
  it('has one section for every block of the registry', () => {
    for (const type of BLOCK_TYPES) {
      expect(prompt.split(`### \`${type}\`\n`), type).toHaveLength(2)
    }
  })

  it('names no block that the registry does not have', () => {
    const named = [...prompt.matchAll(/^### `([^`]+)`$/gm)].map((match) => match[1])

    expect(named.sort()).toEqual([...BLOCK_TYPES].sort())
  })

  it('picks up the blocks of round two without a line of its own', () => {
    for (const type of ['file-tree', 'timeline', 'event', 'metrics', 'metric', 'tabs', 'tab']) {
      expect(BLOCK_TYPES as readonly string[], type).toContain(type)
      expect(sectionOf(type), type).toContain(`### \`${type}\``)
    }
    expect(sectionOf('details')).toContain('| `group` |')
    expect(sectionOf('metric')).toContain('| `trend` |')
  })

  it('lists every attribute of every block with its requirement, allowed values, default and meaning', () => {
    for (const spec of specs) {
      const section = sectionOf(spec.type)
      for (const prop of spec.props) {
        const row = section.split('\n').find((line) => line.startsWith(`| \`${prop.name}\` |`))
        expect(row, `${spec.type}.${prop.name}`).toBeDefined()
        expect(row, `${spec.type}.${prop.name} requirement`).toContain(`| ${prop.required ? 'yes' : 'no'} |`)
        expect(row, `${spec.type}.${prop.name} meaning`).toContain(prop.description.replace(/\|/g, '\\|'))
        for (const value of prop.values ?? []) expect(row, `${spec.type}.${prop.name}=${value}`).toContain(value)
        if (prop.default !== undefined) expect(row, `${spec.type}.${prop.name} default`).toContain(`\`${prop.default}\``)
      }
    }
  })

  it('lists no attribute that the registry does not have', () => {
    for (const spec of specs) {
      const listed = sectionOf(spec.type)
        .split('\n')
        .filter((line) => /^\| `[a-z]+` \|/.test(line))
        .map((line) => /^\| `([a-z]+)`/.exec(line)![1])
      expect(listed, spec.type).toEqual(spec.props.map((prop) => prop.name))
    }
  })

  it('tells where a block may stand and what it may contain', () => {
    for (const spec of specs) {
      const section = sectionOf(spec.type)
      if (spec.parent !== undefined) expect(section, spec.type).toContain(`directly inside \`${spec.parent}\``)
      for (const child of spec.allowedChildren) expect(section, `${spec.type} > ${child}`).toContain(`\`${child}\``)
      for (const variant of spec.variants) expect(section, `${spec.type} variant ${variant}`).toContain(`\`${variant}\``)
      expect(section, spec.type).toContain(spec.description)
      expect(section, spec.type).toContain(spec.a11y)
    }
  })

  it('says that a block without children contains no other blocks, and only such a block', () => {
    for (const spec of specs) {
      const says = sectionOf(spec.type).includes('Contains no other blocks.')
      expect(says, spec.type).toBe(spec.allowedChildren.length === 0 && !oneLine(spec))
    }
  })
})

describe('the colons of a block', () => {
  it('are computed from the registry: three, plus one for every level of container blocks it may hold', () => {
    const expected: Record<string, number> = {
      callout: 3,
      figure: 2,
      gallery: 3,
      pane: 4,
      compare: 5,
      diagram: 3,
      step: 4,
      steps: 5,
      'code-tabs': 3,
      details: 6,
      'file-tree': 3,
      event: 4,
      timeline: 5,
      metric: 2,
      metrics: 3,
      tab: 6,
      tabs: 7,
    }
    for (const [type, colons] of Object.entries(expected)) expect(colonsOf(type), type).toBe(colons)
  })

  it('stay at seven or fewer for every block: a tab that holds steps is the deepest nesting the registry allows', () => {
    // A container that may hold a container raises the colons of every block above it. Past this the author counts colons instead
    // of writing, so a child that would raise the number needs a reason, and this number a decision.
    for (const spec of specs) expect(colonsOf(spec.type), spec.type).toBeLessThanOrEqual(7)
  })

  it('are printed in the syntax line and in the colons line of every block', () => {
    for (const spec of specs) {
      const section = sectionOf(spec.type)
      const colons = colonsOf(spec.type)
      if (oneLine(spec)) {
        expect(section, spec.type).toContain(`  ::${spec.type}`)
        expect(section, spec.type).not.toContain(`  :::${spec.type}`)
        expect(section, spec.type).toContain('- Colons: two, written on one line.')
      } else {
        const fence = ':'.repeat(colons)
        expect(section, spec.type).toContain(`  ${fence}${spec.type}`)
        expect(section, `${spec.type} closing line`).toContain(`\n  ${fence}\n`)
        expect(section, spec.type).toContain(`- Colons: ${colons} or more, the same number on the opening and the closing line.`)
      }
    }
  })

  /** A required attribute written with a value that passes the registry; titles differ by `index`. */
  const attributes = (spec: BlockSpec, index: number) => {
    const written = spec.props
      .filter((prop) => prop.required)
      .map((prop) => {
        switch (prop.type) {
          case 'enum':
            return `${prop.name}=${prop.values![0]}`
          case 'url':
            return `${prop.name}="assets/a.png"`
          case 'integer':
            return `${prop.name}=${prop.min ?? 1}`
          case 'boolean':
            return prop.name
          case 'text':
            return `${prop.name}="${prop.name === 'when' ? 'Phase' : 'Item'} ${index}"`
        }
      })
    return written.length === 0 ? '' : `{${written.join(' ')}}`
  }

  /** The deepest valid block of this type: the child that needs the most colons, all the way down. */
  const deepest = (type: string, colons: (type: string) => number, index = 0): string => {
    const spec = getBlockSpec(type)!
    if (oneLine(spec)) return `::${type}${attributes(spec, index)}`
    const fence = ':'.repeat(colons(type))
    const heaviest = [...spec.allowedChildren]
      .filter((child) => !oneLine(getBlockSpec(child)!))
      .sort((a, b) => colonsOf(b) - colonsOf(a))[0]
    const copies = Math.max(spec.minChildren ?? 1, 1)
    let body: string
    switch (spec.body) {
      case 'markdown':
      case 'markdown-optional':
        body = heaviest ? `Some text.\n\n${deepest(heaviest, colons)}` : 'Some text.'
        break
      case 'blocks':
        body = Array.from({ length: copies }, (_, i) => deepest(spec.allowedChildren[0]!, colons, i + 1)).join('\n')
        break
      case 'raw':
        body = 'graph LR\n  A --> B'
        break
      case 'images':
        body = '![One](assets/a.png)\n![Two](assets/b.png)'
        break
      case 'table':
        body = '| A | B |\n| --- | --- |\n| 1 | 2 |'
        break
      case 'list':
        body = '- One\n- Two'
        break
      case 'task-list':
        body = '- [ ] One\n- [x] Two'
        break
      case 'code-fences':
        body = '```js title="One"\na\n```\n```py title="Two"\nb\n```'
        break
      default:
        body = ''
    }
    return `${fence}${type}${attributes(spec, index)}\n${body}\n${fence}`
  }

  const topLevel = specs.filter((spec) => spec.parent === undefined && !oneLine(spec))

  it.each(topLevel.map((spec) => spec.type))('are enough for the deepest %s', (type) => {
    expect(validateBlocks(deepest(type, colonsOf))).toEqual([])
  })

  it.each(topLevel.filter((spec) => colonsOf(spec.type) > 3).map((spec) => spec.type))(
    'are not too many to count: one colon fewer on %s no longer closes it',
    (type) => {
      const short = (name: string) => (name === type ? colonsOf(type) - 1 : colonsOf(name))
      expect(validateBlocks(deepest(type, short)).length).toBeGreaterThan(0)
    },
  )

  it('have a three-level example in the prompt that follows them and passes the validation', () => {
    expect(prompt).toContain(EXAMPLE_NESTING.trimEnd())
    expect(EXAMPLE_NESTING).toContain(`${':'.repeat(colonsOf('details'))}details`)
    expect(EXAMPLE_NESTING).toContain(`${':'.repeat(colonsOf('steps'))}steps`)
    expect(EXAMPLE_NESTING).toContain(`${':'.repeat(colonsOf('step'))}step`)
    expect(EXAMPLE_NESTING).toContain(`${':'.repeat(colonsOf('callout'))}callout`)
    expect(validateBlocks(EXAMPLE_NESTING)).toEqual([])
  })

  it('are used by every block of the examples, at least as many as the registry needs', () => {
    for (const example of [EXAMPLE_TUTORIAL, EXAMPLE_ARCHITECTURE, EXAMPLE_NESTING]) {
      for (const match of example.matchAll(/^(:{3,})([a-z-]+)/gm)) {
        expect(match[1]!.length, `${match[2]} in an example`).toBeGreaterThanOrEqual(colonsOf(match[2]!))
      }
    }
  })
})

describe('the explanation of equal colon counts', () => {
  it('says that the first closing line ends the outer block, and not that the inner block takes it', () => {
    expect(prompt).toContain('the first closing line ends the outer block, so the inner block is left unclosed')
    expect(prompt).toContain('the import reports unclosed-block and bad-fence')
    expect(prompt).toContain('both blocks are then drawn as plain text')
    expect(prompt).not.toContain('takes the closing line of the outer one and neither closes')
  })

  it('says how many colons at most any block needs, from the registry', () => {
    const most = Math.max(...BLOCKS.map((spec) => colonsOf(spec.type)))
    expect(prompt).toContain(`no block needs more than ${most}.`)
  })

  it('has no colon count written by hand in a description of the registry: the Colons line is the only source', () => {
    for (const spec of specs) {
      expect(spec.description, spec.type).not.toMatch(/:{3,}[a-z-]/)
      expect(spec.a11y, spec.type).not.toMatch(/:{3,}[a-z-]/)
      for (const prop of spec.props) expect(prop.description, `${spec.type}.${prop.name}`).not.toMatch(/:{3,}[a-z-]/)
    }
  })

  it('writes the colon example of the unclosed-block message from the computed counts', () => {
    const problems = validateBlocks('Text\n\n:::callout{type=note}\nNever closed.\n')
    const colons = (type: string) => ':'.repeat(colonsOf(type))
    expect(problems[0]!.message).toContain(
      `${colons('steps')}steps around ${colons('step')}step around ${colons('callout')}callout`,
    )
  })
})

describe('the numbers and forms printed in the section of a block', () => {
  it('prints the range of items of every block that has one, and none for a block that has none', () => {
    const range = (min?: number, max?: number) =>
      min !== undefined && max !== undefined ? `${min} to ${max}` : min !== undefined ? `at least ${min}` : `at most ${max}`
    for (const spec of specs) {
      const section = sectionOf(spec.type)
      if (spec.minChildren === undefined && spec.maxChildren === undefined) {
        expect(section, spec.type).not.toContain('Number of items')
      } else {
        expect(section, spec.type).toContain(` Number of items: ${range(spec.minChildren, spec.maxChildren)}.`)
      }
      for (const [variant, max] of Object.entries(spec.maxChildrenByVariant ?? {})) {
        expect(section, `${spec.type} ${variant}`).toContain(` With variant "${variant}": at most ${max}.`)
      }
      if (spec.maxChildrenByVariant === undefined) expect(section, spec.type).not.toContain('With variant "')
    }
  })

  it('prints the ranges the brief fixes, so a change of the registry fails here and not silently', () => {
    const expected: Record<string, string> = {
      gallery: '2 to 12',
      compare: '2 to 3',
      steps: 'at least 1',
      'code-tabs': '2 to 8',
      timeline: '2 to 20',
      metrics: '2 to 6',
      tabs: '2 to 6',
    }
    for (const [type, range] of Object.entries(expected)) expect(sectionOf(type), type).toContain(` Number of items: ${range}.`)
    expect(sectionOf('compare')).toContain('With variant "before-after": at most 2.')
    expect(sectionOf('tabs')).toContain('Each item needs its own title (ignoring letter case).')
  })

  it('prints the form of every block in words', () => {
    const forms = {
      container: '- Form: container (a line of colons and the name opens it, a line of the same number of colons closes it).',
      leaf: '- Form: leaf (one line: ::name{...}).',
      either: '- Form: leaf (one line: ::name{...}); a container with an empty body is accepted too.',
    }
    for (const spec of specs) expect(sectionOf(spec.type), spec.type).toContain(forms[spec.kind])
    expect(specs.map((spec) => spec.kind)).toEqual(expect.arrayContaining(['container', 'leaf']))
  })
})

describe('the blank lines around a block', () => {
  /** The lines of an example where an outermost block opens or closes: a blank line (or the edge) must stand before and after it. */
  function outermostEdges(example: string) {
    const lines = example.trimEnd().split('\n')
    const edges: { line: number; before: string | undefined; after: string | undefined }[] = []
    const stack: number[] = []
    let fence: string | undefined
    lines.forEach((text, index) => {
      const code = /^(`{3,})/.exec(text)
      if (code) fence = fence === undefined ? code[1] : text.startsWith(fence) ? undefined : fence
      if (fence !== undefined || code) return
      const opening = /^(:{3,})[a-z]/.exec(text)
      const leaf = /^::[a-z]/.test(text)
      const closing = /^(:{3,})$/.exec(text)
      if (opening) {
        if (stack.length === 0) edges.push({ line: index, before: lines[index - 1], after: undefined })
        stack.push(opening[1]!.length)
      } else if (leaf && stack.length === 0) {
        edges.push({ line: index, before: lines[index - 1], after: lines[index + 1] })
      } else if (closing) {
        stack.pop()
        if (stack.length === 0) edges.push({ line: index, before: undefined, after: lines[index + 1] })
      }
    })
    return edges
  }

  it.each([
    ['the tutorial', EXAMPLE_TUTORIAL],
    ['the design article', EXAMPLE_ARCHITECTURE],
    ['the nesting example', EXAMPLE_NESTING],
    ['the filling example', EXAMPLE_FILLING],
  ])('%s has a blank line before and after every block that stands in the text', (_name, example) => {
    const edges = outermostEdges(example)
    expect(edges.length).toBeGreaterThan(0)
    for (const edge of edges) {
      if (edge.before !== undefined) expect(edge.before.trim(), `before line ${edge.line + 1}`).toBe('')
      if (edge.after !== undefined) expect(edge.after.trim(), `after line ${edge.line + 1}`).toBe('')
    }
  })

  it('states the rule with the exceptions that the examples follow', () => {
    expect(prompt).toContain('put a blank line before and after every block that stands in the text')
    expect(prompt).toContain('the children follow each other directly, with no blank line between them')
    expect(prompt).toContain('but write the blank lines, as every example here does')
  })
})

describe('the notes on using the blocks', () => {
  it('are in the prompt, one bullet each', () => {
    expect(BLOCK_NOTES.length).toBeGreaterThanOrEqual(7)
    for (const note of BLOCK_NOTES) expect(prompt).toContain(`- ${note}`)
  })

  it('tell the panes of a before-after compare, the groups of details and the details variants', () => {
    const text = BLOCK_NOTES.join('\n')
    expect(text).toContain('with `variant=before-after` title the two panes `Before` and `After`')
    expect(text).toContain('Details with the same `group` open one at a time wherever they stand in the article')
    expect(text).toContain('`inline` for an FAQ or a troubleshooting aside')
    expect(text).toContain('`appendix` for background the reader can skip')
    expect(getBlockSpec('details')?.variants).toEqual(['inline', 'appendix'])
    expect(getBlockSpec('compare')?.variants).toContain('before-after')
  })

  it('tell that a trend is a direction and not a judgement', () => {
    expect(BLOCK_NOTES.join('\n')).toContain('never whether that is good or bad')
    expect(getBlockSpec('metric')?.props.find((prop) => prop.name === 'trend')?.description).toContain(
      'never whether that is good or bad',
    )
  })

  it('tell that when is any short text up to its limit, with a clock time as an example', () => {
    const limit = getBlockSpec('event')?.props.find((prop) => prop.name === 'when')?.maxLength
    expect(limit).toBe(40)
    expect(prompt).toContain(`any short text up to ${limit} characters: a date, a phase or a clock time such as \`14:02\``)
    expect(
      validateBlocks(
        ':::::timeline\n::::event{title="Alert" when="14:02"}\nText.\n::::\n::::event{title="Fix" when="Phase 2"}\nText.\n::::\n:::::',
      ),
    ).toEqual([])
  })

  it('tell how to describe and mark an entry of a file tree, and that a summary may open the article', () => {
    expect(prompt).toContain('After a name you may write a short description, for example `main.ts - the entry point`')
    expect(prompt).toContain('`(new)`, `(changed)` or `(removed)`')
    expect(prompt).toContain('A `takeaways` block may open the article as a summary.')
  })

  it('tell that the panels of tabs that are not selected are hidden, and to keep the essential text outside', () => {
    expect(prompt).toContain('The panels of `tabs` and `code-tabs` that are not selected are hidden')
    expect(prompt).toContain('find-in-page and print skip them, and without script only the first tab shows')
    expect(prompt).toContain('Put the essential text outside the tabs')
  })
})

describe('the guide for the package, the front matter and the body', () => {
  it('tells what an import does with the series lines and that the page draws the navigation', () => {
    expect(prompt).toContain('the import card only shows a note, so they are harmless')
    expect(prompt).toContain('The article page draws the series navigation itself')
    expect(prompt).toContain('never repeat it in the body')
  })

  it('tells what to do when the categories and tags of the site are unknown, with the caps of an import', () => {
    expect(prompt).toContain('leave `category` out')
    expect(prompt).toContain('leave `tags` out')
    expect(FRONT_MATTER_LIMITS.newCategories).toBe(20)
    expect(FRONT_MATTER_LIMITS.newTags).toBe(50)
    expect(prompt).toContain('an import creates at most 20 new categories')
    expect(prompt).toContain('an import creates at most 50 new tags')
    expect(prompt).toContain('A hyphen in a tag is fine')
  })

  it('tells how to choose a slug and what an existing one does', () => {
    expect(prompt).toContain('Choose a distinctive slug')
    expect(prompt).toContain('marks it "Will change"')
    expect(prompt).toContain('the person looks at the card before confirming')
  })

  it('names the preview state and the note that the import card really shows', () => {
    const messages: unknown = JSON.parse(readFileSync(join(process.cwd(), 'messages', 'en.json'), 'utf8'))
    const values = (key: string) => {
      const found: string[] = []
      const walk = (node: unknown) => {
        if (node === null || typeof node !== 'object') return
        for (const [name, value] of Object.entries(node)) {
          if (name === key && typeof value === 'string') found.push(value)
          else walk(value)
        }
      }
      walk(messages)
      return found
    }
    expect(values('will_change')).toContain('Will change')
    expect(values('series_ignored_author').length).toBeGreaterThan(0)
    expect(values('series_description_will_be_set').length).toBeGreaterThan(0)
  })

  it('tells that a ZIP with only the article is valid and that the Markdown file name is free', () => {
    expect(prompt).toContain('A ZIP that holds only the article, with no `assets/` folder, is valid')
    expect(prompt).toContain('Its name is free')
    expect(prompt).toContain('only the number of Markdown files matters')
  })

  it('gives one rule for the labels of a fence, a shellsession example and the label for PowerShell', () => {
    expect(prompt).toContain(
      'Any other label (such as `powershell` or `mermaid`), or none, shows as plain text, which is not an error',
    )
    expect(prompt).toContain('for example `title="PowerShell"`')
    expect(prompt).toContain('each prompt line starts with `$ ` and the output lines follow without it')
    expect(prompt).toContain('also takes context lines (a space first) and `@@` hunk header lines')
    expect(prompt).toContain('line numbers start at 1 on the first line of the code inside the fence')
  })

  it('tells that a comment line in a fence is not a heading', () => {
    expect(prompt).toContain('A `#` comment line inside a code fence is not a heading')
    expect(prompt).toContain('TOML section lines such as `[rules]`')
  })

  it('tells when to use a Markdown image and when the figure block, and where the meaning of an image goes', () => {
    expect(prompt).toContain('Use the `figure` block only when you need `variant=wide` or an `attribution`')
    expect(prompt).toContain('Nothing limits the alt text of a Markdown image')
    expect(prompt).toContain('the `figure` block allows 300 characters')
    expect(prompt).toContain('never in colour alone')
    expect(prompt).toContain("only for an image that is not the author's own")
  })

  it('tells that an intro paragraph and a fiction notice are fine, and that footnotes work inside a block', () => {
    expect(prompt).toContain('A short introductory paragraph before the first `##` is fine')
    expect(prompt).toContain('This story is fiction')
    expect(prompt).toContain('in a paragraph or in the body of a block')
  })

  it('warns about the two habits of assistants that import without a report and look wrong', () => {
    expect(prompt).toContain('GitHub-style notes (a quote that starts with `[!NOTE]`) are not supported')
    expect(prompt).toContain('show as an ordinary quote with the literal text `[!NOTE]`')
    expect(prompt).toContain('a bare list of `- [ ]` items outside it renders as an unstyled list of disabled checkboxes')
    expect(prompt).toContain('does not repeat the series navigation')
  })

  // The blind authors do not know the default language of the site: a link without the code opened an English article in the Vietnamese
  // page frame (`html lang="vi"`, Vietnamese labels), while `/en/posts/<slug>` always opens it in its own language and the default
  // language redirects from `/vi/posts/<slug>` to the short address. So the guide tells the author to always write the code.
  it('tells how to link to another article, always with the language code in front', () => {
    expect(prompt).toContain('with the language code of that article in front')
    expect(prompt).toContain('`[Part 2](/en/posts/the-slug)` for an article in English')
    expect(prompt).toContain('`[Part 2](/vi/posts/the-slug)` for one in Vietnamese')
    expect(prompt).toContain('Always write the code, even when you do not know which language is the default of the site')
    expect(prompt).toContain(
      'A path without the code, such as `/posts/the-slug`, opens the article in the page frame of the default language',
    )
    expect(prompt).not.toContain('when the article is in the default language of the site')
    expect(prompt).toContain('do not guess a path')
  })

  it('names the glossary tags and that the tags work inside a block, without an angle bracket', () => {
    expect(prompt).toContain('The same tags work inside the body of a block')
    expect(prompt).toContain('one `dl` element that holds a `dt` element for each term, each followed by a `dd` element')
  })
})

describe('the Mermaid types of the authoring prompt', () => {
  it('list exactly the types of the census, each with a hint, and say that any other type is not supported', () => {
    for (const type of MERMAID_TYPES) expect(prompt, type.keyword).toContain(`\`${type.keyword}\` (${type.hint})`)
    for (const type of MERMAID_OTHER_TYPES) expect(prompt, type).toContain(`\`${type}\``)
    expect(prompt).toContain('Any other type is not supported.')
    const keywords = MERMAID_TYPES.map((type) => type.keyword)
    expect(new Set(keywords).size).toBe(keywords.length)
    for (const type of ['gantt', 'pie', 'timeline', 'xychart-beta', 'sankey-beta']) expect(keywords, type).toContain(type)
  })

  it('quote a label with parentheses in the flowchart hint', () => {
    expect(prompt).toContain('Write a label in double quotes when it holds parentheses or brackets: A["Call (retry)"]')
  })

  it('were checked with the version of the library that is installed: run the census again after an upgrade', () => {
    const installed = JSON.parse(readFileSync(join(process.cwd(), 'node_modules', 'mermaid', 'package.json'), 'utf8')) as {
      version: string
    }
    expect(installed.version).toBe(MERMAID_VERIFIED_VERSION)
  })
})

describe('the syntax line of a block', () => {
  it('puts the optional attributes in brackets and the required ones outside them', () => {
    for (const spec of specs) {
      const line = sectionOf(spec.type)
        .split('\n')
        .find((text) => new RegExp(`^ {2}:{2,}${spec.type}(\\{|$)`).test(text))
      expect(line, spec.type).toBeDefined()
      for (const prop of spec.props) {
        expect(line!.includes(`[${prop.name}`), `${spec.type}.${prop.name}`).toBe(!prop.required)
        expect(line!, `${spec.type}.${prop.name}`).toContain(prop.name)
      }
    }
  })

  it('writes a flag in brackets so that copying it does not open every details block', () => {
    const line = sectionOf('details')
      .split('\n')
      .find((text) => text.startsWith('  ::::::details{'))
    expect(line).toContain('[open]')
    expect(line).not.toMatch(/ open[ }]/)
  })

  it('explains the brackets and the placeholders once', () => {
    expect(prompt).toContain('Brackets mean optional: leave out what you do not need and do not write the brackets.')
    expect(prompt).toContain('Replace every `...` with the body that the Body line of that block describes')
    expect(prompt).not.toContain('with your own text')
  })

  it('shows how a block that holds only blocks, images or a list is filled, in an example that passes the validation', () => {
    expect(prompt).toContain(EXAMPLE_FILLING.trimEnd())
    expect(validateBlocks(EXAMPLE_FILLING)).toEqual([])
    const used = new Set([...EXAMPLE_FILLING.matchAll(/^:{2,}([a-z-]+)/gm)].map((match) => match[1]))
    for (const type of ['metrics', 'metric', 'gallery', 'timeline', 'event', 'file-tree']) expect(used, type).toContain(type)
  })
})

describe('the body rules the registry cannot state', () => {
  it('tell the diagram to have its source straight under the opening line, not empty and not longer than the limit', () => {
    const section = sectionOf('diagram')
    expect(section).toContain('without a code fence')
    expect(section).toContain('must not be empty')
    expect(section).toContain(`at most ${MAX_RAW_SOURCE.toLocaleString('en-US')} characters`)
  })

  it('tell code tabs to have different titles, short ones, and no text between the fences', () => {
    const section = sectionOf('code-tabs')
    expect(section).toContain('different from each other (ignoring letter case)')
    expect(section).toContain('at most 120 characters')
    expect(section).toContain('no text between the fences')
  })

  it('tell the checklist that every item is a task', () => {
    expect(sectionOf('checklist')).toContain('Every item must be a task')
  })

  it('tell every Markdown body that it must not be empty', () => {
    for (const type of ['callout', 'pane', 'details', 'pullquote', 'tab'])
      expect(sectionOf(type), type).toContain('must not be empty')
    expect(sectionOf('step')).toContain('may be empty')
  })

  it('tell a block with titled children that the titles differ', () => {
    expect(sectionOf('tabs')).toContain('own title (ignoring letter case)')
    expect(sectionOf('timeline')).not.toContain('own title')
  })
})

describe('the common mistakes', () => {
  it('are a table of wrong and right examples, each checked by the validator', () => {
    expect(PITFALLS.length).toBeGreaterThanOrEqual(10)
    for (const pitfall of PITFALLS) {
      expect(
        validateBlocks(pitfall.wrong).map((problem) => problem.code),
        `wrong: ${pitfall.title}`,
      ).toContain(pitfall.code)
      expect(validateBlocks(pitfall.right), `right: ${pitfall.title}`).toEqual([])
    }
  })

  it('cover the mistakes an assistant is likely to make', () => {
    const codes = new Set(PITFALLS.map((pitfall) => pitfall.code))
    for (const code of [
      'unknown-block',
      'bad-label',
      'unclosed-block',
      'bad-nesting',
      'heading-in-block',
      'bad-body',
      'text-directive',
      'bad-fence',
    ]) {
      expect(codes, code).toContain(code)
    }
    const titles = PITFALLS.map((pitfall) => pitfall.title).join('\n')
    for (const word of ['callout', 'colons', 'list', 'diagram', 'checklist', 'code tabs', 'closing line', 'alternative text']) {
      expect(titles.toLowerCase(), word).toContain(word)
    }
  })

  it('are in the prompt, word for word', () => {
    expect(prompt).toContain('## Common mistakes')
    expect(prompt).toContain(pitfallsReference())
    for (const pitfall of PITFALLS) {
      expect(prompt).toContain(pitfall.wrong)
      expect(prompt).toContain(pitfall.right)
      expect(prompt).toContain(pitfall.title)
    }
  })
})

describe('the authoring prompt as a contract', () => {
  it('carries the fourteen rules of the brief, numbered', () => {
    expect(AUTHORING_RULES).toHaveLength(14)
    AUTHORING_RULES.forEach((rule, index) => expect(prompt).toContain(`${index + 1}. ${rule}`))
  })

  it('names the few HTML tags that render in the rule about HTML, so the rule does not contradict the body section', () => {
    expect(AUTHORING_RULES[11]).toContain('Do not write HTML or CSS')
    expect(AUTHORING_RULES[11]).toContain('the few tags named under "The body"')
  })

  it('states the limits the import page and the backend check, from the same constants', () => {
    expect(prompt).toContain(`at most ${POST_IMPORT_MAX_FILE_BYTES / 1024} KiB`)
    expect(prompt).toContain(`At most ${POST_IMPORT_MAX_PACKAGE_ENTRIES} files in the package`)
    expect(prompt).toContain(`${POST_IMPORT_MAX_PACKAGE_ASSET_BYTES / (1024 * 1024)} MiB for one image`)
    expect(prompt).toContain(`${POST_IMPORT_MAX_PACKAGE_BYTES / (1024 * 1024)} MiB for the whole ZIP`)
  })

  it('names the keys of the post file format and the formats of an image', () => {
    for (const key of [
      'title',
      'slug',
      'language',
      'excerpt',
      'category',
      'tags',
      'series',
      'series_part',
      'series_description',
    ]) {
      expect(prompt).toContain(`| \`${key}\` |`)
    }
    expect(prompt).toMatch(/JPEG, PNG or WebP/)
    expect(prompt).toMatch(/SVG/)
  })

  it('is plain Markdown text of one ASCII-safe kind: no HTML, no tabs, one trailing newline', () => {
    expect(prompt).not.toMatch(/<[a-z]/i)
    expect(prompt).not.toContain('\t')
    expect(prompt.endsWith('\n')).toBe(true)
    expect(prompt.endsWith('\n\n')).toBe(false)
  })

  it('is the same text every time', () => {
    expect(authoringPrompt()).toBe(prompt)
  })
})

describe('the front matter in the authoring prompt', () => {
  const frontMatter = frontMatterReference()

  it('is part of the prompt as it is, and the same text stands in the human guide', () => {
    expect(prompt).toContain(frontMatter)
  })

  it('says that it is plain text and not YAML', () => {
    expect(frontMatter).toContain('plain text, not YAML')
    expect(frontMatter).toContain('no quotes around a value')
    expect(frontMatter).toContain('no `[a, b]` lists')
    expect(frontMatter).toContain('no `- item` lines')
    expect(frontMatter).toContain('A colon inside a value is fine.')
    expect(frontMatter).toContain('Keys are lower case and used once')
  })

  it('tells how to avoid the slug trap', () => {
    expect(frontMatter).toContain('always write `slug`')
    expect(frontMatter).toContain('Name the ZIP file after it')
    expect(frontMatter).toContain('Without a slug the ZIP file name becomes the slug')
    expect(frontMatter).toContain('means "update that post"')
    expect(prompt).toContain('Name the ZIP file after the slug')
  })

  it('states the limits and that the language must be enabled', () => {
    expect(frontMatter).toContain('at most 255 characters')
    expect(frontMatter).toContain('at most 20 tags of at most 100 characters')
    expect(frontMatter).toContain('must be a language enabled on the site')
    expect(frontMatter).toContain('A name that does not exist yet creates the category.')
    expect(frontMatter).toContain('A tag that does not exist yet is created.')
  })

  it('has a row for each series key with the series rules', () => {
    const rows = frontMatter.split('\n').filter((line) => line.startsWith('| `series'))
    expect(rows.map((row) => /^\| `([a-z_]+)`/.exec(row)![1])).toEqual(['series', 'series_part', 'series_description'])
    expect(frontMatter).toContain('all three or none')
    expect(frontMatter).toContain('exact same series name in every part')
    expect(frontMatter).toContain('only when an administrator imports')
    expect(frontMatter).toContain('unique within a series and a language')
    expect(frontMatter).toContain('in any order')
    expect(frontMatter).toContain('when it creates the series')
    expect(frontMatter).toContain('never changes a description that is not empty')
    expect(frontMatter).toContain('digits only, 1 to 1000')
  })

  it('still tells that status, featured and translation_of are ignored and that nothing is published', () => {
    expect(frontMatter).toContain('Do not write `status`, `featured` or `translation_of`')
    expect(frontMatter).toContain('An import never publishes anything')
  })
})

describe('the package in the authoring prompt', () => {
  it('names the ZIP after the slug', () => {
    expect(prompt).toMatch(/\n[a-z-]+\.zip +named after the slug/)
    expect(prompt).not.toContain('article.zip')
  })

  it('tells the rules for the names of the images', () => {
    expect(prompt).toContain('The folder is `assets/`, in lower case.')
    expect(prompt).toContain('lower case ASCII letters, digits, `-`, `_` and `.`')
    expect(prompt).toContain('must match the file name exactly, letter case included')
    expect(prompt).toContain('Two names that differ only in letter case are refused.')
    expect(prompt).toContain('Put nothing else in the ZIP')
    expect(prompt).toContain('Folder entries count toward the')
    expect(prompt).toContain('no spaces')
  })

  it('does not warn about upper case extensions, which are accepted', () => {
    expect(prompt).not.toMatch(/extensions? .*upper|upper case extension/i)
  })

  it('tells what to do with /media/ paths and web addresses', () => {
    expect(prompt).toContain('Do not use `/media/` paths or `http://` addresses.')
    expect(prompt).toContain('An `https://` image is allowed but is not packed')
  })
})

describe('the body in the authoring prompt', () => {
  it('keeps the headings to the levels of the table of contents', () => {
    expect(prompt).toContain('`##` to `####` only')
  })

  it('teaches footnotes and the caption of an image', () => {
    expect(prompt).toContain('[^1]')
    expect(prompt).toContain('outside any block')
    expect(prompt).toContain('![Alt text](assets/figure-1.png "Caption")')
  })

  it('warns about what does not work', () => {
    expect(prompt).toContain('Do not rely on column alignment in tables, math, emoji codes or custom heading ids')
  })

  it('names the HTML tags that render and the tags that silently vanish, as the sanitizer has them', () => {
    const allowed = ['kbd', 'sub', 'sup', 'dl', 'dt', 'dd']
    const vanishing = ['abbr', 'mark', 'small', 'u']
    for (const tag of allowed) {
      expect(defaultSchema.tagNames, tag).toContain(tag)
      expect(prompt, tag).toContain(`\`${tag}\``)
    }
    for (const tag of vanishing) {
      expect(defaultSchema.tagNames, tag).not.toContain(tag)
      expect(prompt, tag).toContain(`\`${tag}\``)
    }
    expect(prompt).toContain('the tag disappears and only its text stays, without a warning')
  })

  it('warns about a rule under a line of text inside a block', () => {
    expect(prompt).toContain('a line of `---` or `===` directly under a line of text is a heading')
  })

  it('tells about Mermaid: the types, what to avoid and the accessible name', () => {
    for (const type of ['flowchart TD', 'sequenceDiagram', 'classDiagram', 'stateDiagram-v2', 'erDiagram']) {
      expect(prompt, type).toContain(`\`${type}\``)
    }
    expect(prompt).toContain('no HTML in labels')
    expect(prompt).toContain('no `click` lines')
    expect(prompt).toContain('no `%%{init}%%` settings')
    expect(prompt).toContain('`alt` is the accessible name')
    expect(prompt).toContain('the page shows its source as text')
  })
})

describe('the blocks section of the authoring prompt', () => {
  it('keeps blocks out of lists, quotes and tables', () => {
    expect(prompt).toContain('Never put a block inside a list item, a quote or a table')
    expect(prompt).toContain('Start every block at the left margin')
  })

  it('says that a callout kind is the type attribute and that Docusaurus blocks do not exist', () => {
    expect(prompt).toContain('There is no block named `note`, `tip` or `warning`')
    expect(prompt).toContain('`:::callout{type=warning title="Heads up"}`')
    expect(prompt).toContain('`:::callout[Title]`')
  })

  it('warns about text that looks like a block', () => {
    expect(prompt).toContain('a colon directly followed by a name and `{` or `[`')
    expect(prompt).toContain('Times such as 10:30, ratios and URLs are fine.')
  })

  it('does not put a double quote inside a value', () => {
    expect(prompt).toContain('do not put a double quote inside a value')
  })
})

describe('the code fences in the authoring prompt', () => {
  it('print the highlighted languages from the one constant, with their aliases', () => {
    for (const language of CODE_LANGUAGES) expect(prompt, language).toContain(`\`${language}\``)
    for (const [language, aliases] of Object.entries(CODE_LANGUAGE_ALIASES)) {
      expect(CODE_LANGUAGES as readonly string[], language).toContain(language)
      for (const alias of aliases) expect(prompt, `${language} ${alias}`).toContain(`\`${alias}\``)
    }
  })

  it('give plain text as the label for what is not listed', () => {
    expect(prompt).toContain('write `text`')
    expect(prompt).toContain('shows as plain text, which is not an error')
  })

  it('teach the title and the line highlight', () => {
    expect(prompt).toContain('`title="file.py"`')
    expect(prompt).toContain('`highlight="2,5-7"`')
    expect(prompt).toContain('at most 40 entries')
  })

  const GRAMMARS: Record<string, () => Promise<{ default: unknown }>> = {
    typescript: () => import('@shikijs/langs/typescript'),
    javascript: () => import('@shikijs/langs/javascript'),
    python: () => import('@shikijs/langs/python'),
    bash: () => import('@shikijs/langs/bash'),
    yaml: () => import('@shikijs/langs/yaml'),
    shellsession: () => import('@shikijs/langs/shellsession'),
    rust: () => import('@shikijs/langs/rust'),
    markdown: () => import('@shikijs/langs/markdown'),
    ini: () => import('@shikijs/langs/ini'),
  }

  it('use only aliases that the installed grammar of the language knows', async () => {
    expect(Object.keys(CODE_LANGUAGE_ALIASES).sort()).toEqual(Object.keys(GRAMMARS).sort())
    for (const [language, aliases] of Object.entries(CODE_LANGUAGE_ALIASES)) {
      const registrations = (await GRAMMARS[language]!()).default as { name: string; aliases?: string[] }[]
      const known = new Set(registrations.flatMap((registration) => [registration.name, ...(registration.aliases ?? [])]))
      for (const alias of aliases) expect(known.has(alias), `${language} ${alias}`).toBe(true)
    }
  })
})

describe('the examples in the authoring prompt', () => {
  const bodyOf = (example: string) => example.slice(example.indexOf('\n---\n', 4) + 5)
  const frontMatterOf = (example: string) => example.slice(4, example.indexOf('\n---\n', 4))

  it.each([
    ['the tutorial', EXAMPLE_TUTORIAL],
    ['the design article', EXAMPLE_ARCHITECTURE],
  ])('%s is in the prompt as written and has no block problem', (_name, example) => {
    expect(prompt).toContain(example.trimEnd())
    expect(validateBlocks(bodyOf(example))).toEqual([])
  })

  it('use several different blocks between them', () => {
    const used = new Set([...(EXAMPLE_TUTORIAL + EXAMPLE_ARCHITECTURE).matchAll(/^:{2,}([a-z-]+)/gm)].map((match) => match[1]))

    expect(used.size).toBeGreaterThanOrEqual(8)
    for (const type of used) expect(BLOCK_TYPES as readonly string[], type).toContain(type)
  })

  it('write a slug, and the tutorial carries a series with its three keys', () => {
    expect(frontMatterOf(EXAMPLE_TUTORIAL)).toMatch(/^slug: [a-z0-9-]+$/m)
    expect(frontMatterOf(EXAMPLE_ARCHITECTURE)).toMatch(/^slug: [a-z0-9-]+$/m)
    expect(frontMatterOf(EXAMPLE_TUTORIAL)).toMatch(/^series: .+$/m)
    expect(frontMatterOf(EXAMPLE_TUTORIAL)).toMatch(/^series_part: [1-9][0-9]{0,2}$/m)
    expect(frontMatterOf(EXAMPLE_TUTORIAL)).toMatch(/^series_description: .+$/m)
  })

  it('use only keys of the front matter table and each key once', () => {
    const keys = [...frontMatterReference().matchAll(/^\| `([a-z_]+)` \|/gm)].map((match) => match[1])
    for (const example of [EXAMPLE_TUTORIAL, EXAMPLE_ARCHITECTURE]) {
      const written = [...frontMatterOf(example).matchAll(/^([a-z_]+):/gm)].map((match) => match[1]!)
      expect(new Set(written).size).toBe(written.length)
      for (const key of written) expect(keys, key).toContain(key)
    }
  })
})
