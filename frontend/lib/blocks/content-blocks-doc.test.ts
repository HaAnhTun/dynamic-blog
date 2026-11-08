// @vitest-environment node
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  POST_IMPORT_MAX_FILE_BYTES,
  POST_IMPORT_MAX_PACKAGE_ASSET_BYTES,
  POST_IMPORT_MAX_PACKAGE_BYTES,
  POST_IMPORT_MAX_PACKAGE_ENTRIES,
} from '@/lib/post-import'
import {
  AUTHORING_RULES,
  EXAMPLE_NESTING,
  FRONT_MATTER_LIMITS,
  blockNotesReference,
  frontMatterReference,
  mermaidReference,
  pitfallsReference,
} from './authoring-prompt'
import { CODE_LANGUAGES } from './code-languages'
import { blocksReference, markedBlock, withReference } from './reference'
import { BLOCKS, BLOCK_TYPES } from './registry'
import type { BlockSpec } from './types'
import { validateBlocks } from './validate'

/**
 * The drift test of `docs/content-blocks.md`: the part of the page between `<!-- BEGIN BLOCKS -->` and `<!-- END BLOCKS -->` is
 * generated from the block registry, and this fails when the page and the registry differ, in either direction. A block, an attribute,
 * an allowed value, a default or a limit added to the registry (or taken out) fails here until the page is refreshed.
 *
 * To refresh the page after changing the registry:
 *   UPDATE_BLOCK_DOCS=1 npx vitest run lib/blocks/content-blocks-doc.test.ts
 * The run rewrites the generated part, then the test passes; commit the page. The tests that follow prove the check itself can fail.
 *
 * The same file checks the numbers and the rules that `docs/ai-article-authoring.md` repeats from the code.
 */

const DOCS = join(process.cwd(), '..', 'docs')
const REFERENCE_DOC = join(DOCS, 'content-blocks.md')
const AUTHORING_DOC = join(DOCS, 'ai-article-authoring.md')
const FORMAT_DOC = join(DOCS, 'post-file-format.md')
const present = existsSync(REFERENCE_DOC) && existsSync(AUTHORING_DOC) && existsSync(FORMAT_DOC)

const read = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
const specs: readonly BlockSpec[] = BLOCKS
const RULES_BLOCK = /<!-- BEGIN RULES -->\n[\s\S]*?<!-- END RULES -->/
const rulesText = () => AUTHORING_RULES.map((rule, index) => `${index + 1}. ${rule}`).join('\n')

/** A generated part of a page between `<!-- BEGIN NAME -->` and `<!-- END NAME -->`. */
const sectionPattern = (name: string) => new RegExp(`<!-- BEGIN ${name} -->\n([\\s\\S]*?)<!-- END ${name} -->`)
const sectionOf = (document: string, name: string) => sectionPattern(name).exec(document)?.[1]?.replace(/\n$/, '')
const withSection = (document: string, name: string, text: string) => {
  if (!sectionPattern(name).test(document)) throw new Error(`a page has no BEGIN ${name} and END ${name} markers`)
  return document.replace(sectionPattern(name), () => `<!-- BEGIN ${name} -->\n${text}\n<!-- END ${name} -->`)
}

if (process.env.UPDATE_BLOCK_DOCS === '1' && present) {
  const current = read(REFERENCE_DOC)
  if (markedBlock(current) === undefined) throw new Error('docs/content-blocks.md has no BEGIN BLOCKS and END BLOCKS markers')
  writeFileSync(REFERENCE_DOC, withSection(withReference(current, blocksReference()), 'PITFALLS', pitfallsReference()))
  const authoring = read(AUTHORING_DOC)
  if (!RULES_BLOCK.test(authoring)) throw new Error('docs/ai-article-authoring.md has no BEGIN RULES and END RULES markers')
  writeFileSync(
    AUTHORING_DOC,
    withSection(
      withSection(
        withSection(
          authoring.replace(RULES_BLOCK, () => `<!-- BEGIN RULES -->\n${rulesText()}\n<!-- END RULES -->`),
          'FRONT MATTER',
          frontMatterReference(),
        ),
        'NOTES',
        blockNotesReference(),
      ),
      'DIAGRAMS',
      mermaidReference(),
    ),
  )
}

describe.skipIf(!present)('docs/content-blocks.md and the block registry', () => {
  const document = present ? read(REFERENCE_DOC) : ''

  it('holds exactly the reference generated from the registry between its markers', () => {
    expect(markedBlock(document), 'run UPDATE_BLOCK_DOCS=1 npx vitest run lib/blocks/content-blocks-doc.test.ts').toBe(
      blocksReference(),
    )
  })

  it('has a section for every block and for nothing else', () => {
    const named = [...(markedBlock(document) ?? '').matchAll(/^### `([^`]+)`$/gm)].map((match) => match[1])

    expect(named).toEqual([...BLOCK_TYPES])
  })

  it('documents every attribute of every block with its allowed values', () => {
    const generated = markedBlock(document) ?? ''
    for (const spec of specs) {
      for (const prop of spec.props) {
        expect(generated, `${spec.type}.${prop.name}`).toContain(`| \`${prop.name}\` |`)
        for (const value of prop.values ?? []) expect(generated, `${spec.type}.${prop.name}=${value}`).toContain(value)
      }
    }
  })

  it('notices a block that is added to the registry without the page', () => {
    const extra: BlockSpec = {
      type: 'sundial',
      kind: 'container',
      props: [],
      variants: [],
      allowedChildren: [],
      body: 'markdown',
      description: 'A made-up block.',
      a11y: 'None.',
    }

    expect(blocksReference([...specs, extra])).not.toBe(markedBlock(document))
  })

  it('notices an attribute that is added to a block without the page', () => {
    const [first, ...rest] = specs
    const widened: BlockSpec = {
      ...first!,
      props: [...first!.props, { name: 'density', type: 'text', description: 'A made-up attribute.' }],
    }

    expect(blocksReference([widened, ...rest])).not.toBe(markedBlock(document))
  })

  it('notices an allowed value that is added to an enum without the page', () => {
    const widened = specs.map((spec) => ({
      ...spec,
      props: spec.props.map((prop) =>
        prop.name === 'type' && prop.values ? { ...prop, values: [...prop.values, 'extra'] } : prop,
      ),
    }))

    expect(blocksReference(widened)).not.toBe(markedBlock(document))
  })

  it('notices a block that is taken out of the registry while the page keeps it', () => {
    expect(blocksReference(specs.slice(1))).not.toBe(markedBlock(document))
  })

  it('has to be refreshed when a marker is missing instead of passing silently', () => {
    expect(markedBlock('# No markers here')).toBeUndefined()
  })

  it('holds the common mistakes of the authoring prompt, generated from the same list', () => {
    expect(sectionOf(document, 'PITFALLS'), 'run UPDATE_BLOCK_DOCS=1 npx vitest run lib/blocks/content-blocks-doc.test.ts').toBe(
      pitfallsReference(),
    )
  })

  it('tells the colon rule with the number the registry computes, and shows three levels', () => {
    expect(document).toContain('Colons.')
    expect(document).toContain(EXAMPLE_NESTING.trimEnd())
    expect(document).toContain('`details` (6) around `steps` (5) around `step` (4) around `callout` (3)')
  })

  it('names every highlighted language of the one constant that the code highlighter loads', () => {
    for (const language of CODE_LANGUAGES) expect(document, language).toContain(`\`${language}\``)
  })

  it('lists the blocks of round two in the introduction and keeps the old claim about colons out', () => {
    for (const word of ['file trees', 'timelines', 'metrics', 'tabs']) expect(document.slice(0, 1500)).toContain(word)
    expect(document).not.toContain('`::::steps` holds `:::step`')
  })
})

describe.skipIf(!present)('docs/ai-article-authoring.md and the code', () => {
  const document = present ? read(AUTHORING_DOC) : ''

  it('states the package limits the import enforces', () => {
    const rows = new Map(
      [...document.matchAll(/^\| ([^|]+?) \| ([0-9,]+) \|$/gm)].map(
        (match) => [match[1], Number(match[2]!.replace(/,/g, ''))] as const,
      ),
    )

    expect(Object.fromEntries(rows)).toEqual({
      'Bytes per ZIP package': POST_IMPORT_MAX_PACKAGE_BYTES,
      'Entries per ZIP package': POST_IMPORT_MAX_PACKAGE_ENTRIES,
      'Bytes per image': POST_IMPORT_MAX_PACKAGE_ASSET_BYTES,
      'Bytes of the article (the .md file)': POST_IMPORT_MAX_FILE_BYTES,
    })
  })

  it('lists the fourteen rules of the authoring prompt, in order', () => {
    const block = /<!-- BEGIN RULES -->\n([\s\S]*?)<!-- END RULES -->/.exec(document)?.[1]

    expect(block?.trimEnd()).toBe(rulesText())
  })

  it('shows only blocks that exist in its examples', () => {
    const used = [...document.matchAll(/^:{2,}([a-z][a-z-]*)(?=[{\s]|$)/gm)].map((match) => match[1]!)

    expect(used.length).toBeGreaterThan(0)
    for (const type of used) expect(BLOCK_TYPES as readonly string[], type).toContain(type)
  })

  it('holds the front matter of the authoring prompt, generated from the same text', () => {
    expect(
      sectionOf(document, 'FRONT MATTER'),
      'run UPDATE_BLOCK_DOCS=1 npx vitest run lib/blocks/content-blocks-doc.test.ts',
    ).toBe(frontMatterReference())
  })

  it('holds the notes on using the blocks and the Mermaid types of the authoring prompt, generated from the same lists', () => {
    expect(sectionOf(document, 'NOTES'), 'run UPDATE_BLOCK_DOCS=1 npx vitest run lib/blocks/content-blocks-doc.test.ts').toBe(
      blockNotesReference(),
    )
    expect(sectionOf(document, 'DIAGRAMS'), 'run UPDATE_BLOCK_DOCS=1 npx vitest run lib/blocks/content-blocks-doc.test.ts').toBe(
      mermaidReference(),
    )
  })

  it('shows a package named after the slug, and mentions article.zip only to explain the slug trap', () => {
    const layout = /```text\n([\s\S]*?)```/.exec(document)?.[1]
    expect(layout).toContain('named after the slug')
    expect(layout).not.toContain('article.zip')
    expect(document).toContain('### The slug trap')
  })

  it('explains the series, the names of the images and the traps of the body', () => {
    for (const phrase of [
      'series_part',
      'Name the ZIP file after the slug',
      'lower case ASCII letters',
      'match the file name exactly',
      '`##` to `####` only',
      'the tag disappears',
      'No block inside a list',
    ]) {
      expect(document, phrase).toContain(phrase)
    }
  })

  it('has examples that pass the block validation', () => {
    const examples = [...document.matchAll(/^````markdown\n([\s\S]*?)\n````$/gm)].map((match) => match[1]!)

    expect(examples).toHaveLength(3)
    for (const example of examples) expect(validateBlocks(example)).toEqual([])
  })
})

describe.skipIf(!present)('docs/post-file-format.md and the limits the authoring prompt prints', () => {
  const document = present ? read(FORMAT_DOC) : ''
  const row = (label: string) => {
    const match = new RegExp(`^\\| ${label} \\| ([0-9,]+) \\|$`, 'm').exec(document)
    return match ? Number(match[1]!.replace(/,/g, '')) : undefined
  }

  it('pin the same numbers as the front matter limits of the prompt (the page is pinned against the backend by its own test)', () => {
    expect(row('Characters of a title')).toBe(FRONT_MATTER_LIMITS.title)
    expect(row('Tags per post')).toBe(FRONT_MATTER_LIMITS.tags)
    expect(row('Characters of a tag name')).toBe(FRONT_MATTER_LIMITS.tag)
    expect(row('Characters of a series name')).toBe(FRONT_MATTER_LIMITS.series)
    expect(row('Characters of a series description')).toBe(FRONT_MATTER_LIMITS.seriesDescription)
    expect(row('Highest series part')).toBe(FRONT_MATTER_LIMITS.seriesPart)
    expect(row('New categories per import')).toBe(FRONT_MATTER_LIMITS.newCategories)
    expect(row('New tags per import')).toBe(FRONT_MATTER_LIMITS.newTags)
  })

  it('tells in its layout section how to write the front matter and the slug of a package', () => {
    expect(document).toContain('Always write `slug`')
    expect(document).toContain('`series_part`')
  })
})
