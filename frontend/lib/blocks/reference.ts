import { blockSection } from './authoring-prompt'
import { BLOCKS } from './registry'
import type { BlockSpec } from './types'

/**
 * The generated block of `docs/content-blocks.md`: an overview table and one section per registry entry, rendered by the same
 * function that writes the authoring prompt, so the documentation and what an AI is told cannot disagree. Pure; only the drift
 * test (`content-blocks-doc.test.ts`) imports it, and that test also rewrites the document on request (see its header).
 */

/** One table cell: no pipe and no line break. */
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()

function overviewRow(spec: BlockSpec): string {
  const variants = spec.variants.length === 0 ? '' : spec.variants.map((v) => `\`${v}\``).join(', ')
  const contains = spec.allowedChildren.length === 0 ? '' : spec.allowedChildren.map((c) => `\`${c}\``).join(', ')
  const where = spec.parent === undefined ? 'anywhere' : `inside \`${spec.parent}\``
  return `| [\`${spec.type}\`](#${spec.type}) | ${spec.kind} | ${where} | ${cell(variants)} | ${cell(contains)} |`
}

/** The text between the BEGIN and END markers of the registry reference, without the markers. */
export function blocksReference(specs: readonly BlockSpec[] = BLOCKS): string {
  return [
    '| Block | Form | Where | Variants | May contain |',
    '| --- | --- | --- | --- | --- |',
    ...specs.map(overviewRow),
    '',
    ...specs.map(blockSection),
  ]
    .join('\n')
    .trimEnd()
}

export const REFERENCE_BEGIN = '<!-- BEGIN BLOCKS -->'
export const REFERENCE_END = '<!-- END BLOCKS -->'

/** The part of a document between the markers, or `undefined` when a marker is missing. Line endings are normalised to `\n`. */
export function markedBlock(document: string): string | undefined {
  const text = document.replace(/\r\n/g, '\n')
  const start = text.indexOf(`${REFERENCE_BEGIN}\n`)
  const end = text.indexOf(REFERENCE_END)
  if (start === -1 || end === -1 || end < start) return undefined
  return text.slice(start + REFERENCE_BEGIN.length + 1, end).trimEnd()
}

/** The document with the part between the markers replaced by `reference`. */
export function withReference(document: string, reference: string): string {
  const text = document.replace(/\r\n/g, '\n')
  const start = text.indexOf(`${REFERENCE_BEGIN}\n`) + REFERENCE_BEGIN.length + 1
  const end = text.indexOf(REFERENCE_END)
  return `${text.slice(0, start)}${reference}\n${text.slice(end)}`
}
