import { DEFAULT_TEXT_MAX, type BlockSpec, type PropSpec, type PropValue } from './types'

/**
 * The single source of truth for the article blocks: `:::name{attributes}` ... `:::` in the Markdown of a post. Pure data and pure
 * functions, no React and no unified, so the renderer, the import validation, the authoring prompt and the documentation all read the
 * same list. A block here needs a component under `components/site/blocks/` with the PascalCase name of its type (a test checks both
 * directions), and a new attribute needs a row in `docs/content-blocks.md` (a drift test checks that too).
 *
 * Rules for an entry:
 * - Attribute names are plain lower-case words, because they become attributes of the `ai-block` element the pipeline emits and the
 *   sanitize schema allows exactly the names listed here.
 * - A `boolean` attribute defaults to `false` (see `PropSpec.default`).
 * - `variant`, where it exists, is the enum of `variants`.
 * - A block that only fits inside one parent names it in `parent`, and that parent lists it in `allowedChildren`.
 * - Blocks are width-agnostic: they live in the article body column, whatever its width.
 */
export const BLOCKS = [
  {
    type: 'callout',
    kind: 'container',
    props: [
      {
        name: 'type',
        type: 'enum',
        values: ['info', 'note', 'tip', 'warning', 'danger'],
        default: 'info',
        description: 'What kind of aside this is. The kind is also written out as text, never shown by color alone.',
      },
      { name: 'title', type: 'text', maxLength: 120, description: 'An optional short heading for the callout.' },
      {
        name: 'variant',
        type: 'enum',
        values: ['compact', 'prominent'],
        default: 'compact',
        description: 'Compact for a short aside, prominent for a warning the reader must not miss.',
      },
    ],
    variants: ['compact', 'prominent'],
    allowedChildren: [],
    body: 'markdown',
    description:
      'A short aside set apart from the text: a note, a tip, a warning. Use it sparingly, only where it helps the reader.',
    a11y: 'A note landmark. The kind of callout is announced as a text label as well as shown by icon and color.',
  },
  {
    type: 'figure',
    kind: 'either',
    props: [
      {
        name: 'src',
        type: 'url',
        required: true,
        maxLength: 500,
        description: 'The image: a path inside the package such as assets/diagram.png, a /media/ path, or an https URL.',
      },
      {
        name: 'alt',
        type: 'text',
        required: true,
        maxLength: 300,
        description: 'What the image shows, for readers who cannot see it.',
      },
      { name: 'caption', type: 'text', maxLength: 400, description: 'What the reader should take from the image.' },
      { name: 'attribution', type: 'text', maxLength: 200, description: 'Who made the image, when it is not the author.' },
      {
        name: 'variant',
        type: 'enum',
        values: ['standard', 'wide'],
        default: 'standard',
        description: 'Wide uses the whole width of the article body; it never goes wider than that.',
      },
    ],
    variants: ['standard', 'wide'],
    allowedChildren: [],
    body: 'none',
    description:
      'An image with alternative text, an optional caption and an optional attribution. Written on one line: ::figure{src="..." alt="..."}.',
    a11y: 'A figure with a figcaption. The alternative text is required; images load lazily and keep their size so the text does not jump.',
  },
  {
    type: 'gallery',
    kind: 'container',
    props: [
      {
        name: 'columns',
        type: 'integer',
        min: 2,
        max: 3,
        default: 2,
        description: 'How many images sit side by side when there is room; one column when the article is narrow.',
      },
      { name: 'caption', type: 'text', maxLength: 300, description: 'A caption for the whole gallery.' },
    ],
    variants: [],
    allowedChildren: [],
    body: 'images',
    minChildren: 2,
    maxChildren: 12,
    description: 'A grid of images. The body is Markdown images only, one per line, each with alternative text.',
    a11y: 'A list of figures. Every image needs alternative text; there is no lightbox to trap focus.',
  },
  {
    type: 'compare',
    kind: 'container',
    props: [
      {
        name: 'variant',
        type: 'enum',
        values: ['columns', 'before-after'],
        default: 'columns',
        description: 'Columns for two or three alternatives, before-after for exactly two states of the same thing.',
      },
    ],
    variants: ['columns', 'before-after'],
    allowedChildren: ['pane'],
    body: 'blocks',
    minChildren: 2,
    maxChildren: 3,
    maxChildrenByVariant: { 'before-after': 2 },
    description: 'Two or three panes side by side, stacked when the article is narrow. Each pane is a pane block.',
    a11y: 'Each pane is a labelled group, so the order and the titles are read out in sequence.',
  },
  {
    type: 'pane',
    kind: 'container',
    props: [
      {
        name: 'title',
        type: 'text',
        required: true,
        maxLength: 120,
        description: 'The label of the pane, such as Before or Option A.',
      },
    ],
    variants: [],
    allowedChildren: ['figure', 'callout'],
    parent: 'compare',
    body: 'markdown',
    description: 'One pane of a compare block: text, code or images. Only valid directly inside the compare block.',
    a11y: 'A labelled group named by its title.',
  },
  {
    type: 'comparison',
    kind: 'container',
    props: [
      { name: 'title', type: 'text', maxLength: 120, description: 'A heading for the table panel.' },
      { name: 'caption', type: 'text', maxLength: 300, description: 'A sentence under the table.' },
    ],
    variants: [],
    allowedChildren: [],
    body: 'table',
    description: 'A titled panel around a Markdown table, for comparing options across several criteria.',
    a11y: 'The table keeps its header cells and its keyboard-focusable scroll region on narrow screens.',
  },
  {
    type: 'diagram',
    kind: 'container',
    props: [
      {
        name: 'type',
        type: 'enum',
        values: ['mermaid'],
        required: true,
        description: 'The diagram language. Only mermaid is supported.',
      },
      { name: 'title', type: 'text', maxLength: 120, description: 'A heading for the diagram.' },
      { name: 'caption', type: 'text', maxLength: 300, description: 'A sentence under the diagram.' },
      { name: 'alt', type: 'text', maxLength: 300, description: 'What the diagram shows, used as its accessible name.' },
    ],
    variants: [],
    allowedChildren: [],
    body: 'raw',
    description:
      'A diagram written as Mermaid source in the body. The body is kept exactly as written and is not read as Markdown.',
    a11y: 'Drawn in the browser. Before that, and when it cannot be drawn, the source shows as preformatted text; the drawing is an image named by alt.',
  },
  {
    type: 'steps',
    kind: 'container',
    props: [
      { name: 'title', type: 'text', maxLength: 120, description: 'A heading for the procedure.' },
      {
        name: 'variant',
        type: 'enum',
        values: ['sequential', 'grouped'],
        default: 'sequential',
        description: 'Sequential numbers every step in a line, grouped sets each step in its own panel.',
      },
    ],
    variants: ['sequential', 'grouped'],
    allowedChildren: ['step'],
    body: 'blocks',
    minChildren: 1,
    description:
      'A numbered procedure. A block that holds other blocks uses more colons than the blocks inside it; the Colons line below gives the number.',
    a11y: 'An ordered list; the numbers are real list numbers, not decoration.',
  },
  {
    type: 'step',
    kind: 'container',
    props: [{ name: 'title', type: 'text', required: true, maxLength: 120, description: 'The one-line name of the step.' }],
    variants: [],
    allowedChildren: ['callout', 'figure', 'gallery', 'diagram', 'code-tabs', 'comparison', 'file-tree'],
    parent: 'steps',
    body: 'markdown-optional',
    description:
      'One step of a steps block: a title and optional text, code or images. Only valid directly inside the steps block.',
    a11y: 'A list item whose number is announced by the list.',
  },
  {
    type: 'code-tabs',
    kind: 'container',
    props: [{ name: 'title', type: 'text', maxLength: 120, description: 'A heading for the group of tabs.' }],
    variants: [],
    allowedChildren: [],
    body: 'code-fences',
    minChildren: 2,
    maxChildren: 8,
    description:
      'The same thing in several languages or files. The body is fenced code blocks only, each with title="Label" after the language.',
    a11y: 'The WAI-ARIA tabs pattern: arrow keys, Home and End move between tabs, every panel stays in the document.',
  },
  {
    type: 'details',
    kind: 'container',
    props: [
      { name: 'title', type: 'text', required: true, maxLength: 120, description: 'The always-visible summary line.' },
      { name: 'open', type: 'boolean', default: false, description: 'Open when the page loads. Written as a bare flag: {open}.' },
      {
        name: 'variant',
        type: 'enum',
        values: ['inline', 'appendix'],
        default: 'inline',
        description: 'Inline for a detail inside the flow of the text, appendix for material the reader can skip.',
      },
      {
        name: 'group',
        type: 'text',
        maxLength: 40,
        description: 'Details blocks with the same group open one at a time, like an FAQ accordion.',
      },
    ],
    variants: ['inline', 'appendix'],
    allowedChildren: [
      'callout',
      'figure',
      'gallery',
      'comparison',
      'diagram',
      'code-tabs',
      'steps',
      'checklist',
      'takeaways',
      'file-tree',
    ],
    body: 'markdown',
    description: 'Expandable details: troubleshooting, background, an appendix. Collapsed by default.',
    a11y: 'A native details element with a summary: operable by keyboard, with a visible focus ring.',
  },
  {
    type: 'takeaways',
    kind: 'container',
    props: [{ name: 'title', type: 'text', maxLength: 120, description: 'A heading for the list.' }],
    variants: [],
    allowedChildren: [],
    body: 'list',
    description: 'The key points of the article. The body is a Markdown list.',
    a11y: 'A list inside a labelled group.',
  },
  {
    type: 'checklist',
    kind: 'container',
    props: [{ name: 'title', type: 'text', maxLength: 120, description: 'A heading for the checklist.' }],
    variants: [],
    allowedChildren: [],
    body: 'task-list',
    description: 'A read-only checklist. The body is a Markdown task list: - [ ] item and - [x] item.',
    a11y: 'A list whose items state whether they are checked, as text as well as by symbol. The reader cannot change them.',
  },
  {
    type: 'pullquote',
    kind: 'container',
    props: [{ name: 'attribution', type: 'text', maxLength: 200, description: 'Who said it.' }],
    variants: [],
    allowedChildren: [],
    body: 'markdown',
    description: 'A short quotation set large. Use it for a line worth remembering, not to decorate the page.',
    a11y: 'A blockquote; the attribution is part of the quote, not a separate caption.',
  },
  {
    type: 'file-tree',
    kind: 'container',
    props: [{ name: 'title', type: 'text', maxLength: 120, description: 'A heading for the tree.' }],
    variants: [],
    allowedChildren: [],
    body: 'list',
    description: 'A directory structure as a nested Markdown list. Folders end with a slash.',
    a11y: 'A nested list, so depth is announced. Folders are told apart by the trailing slash in the text, not by an icon.',
  },
  {
    type: 'timeline',
    kind: 'container',
    props: [{ name: 'title', type: 'text', maxLength: 120, description: 'A heading for the timeline.' }],
    variants: [],
    allowedChildren: ['event'],
    body: 'blocks',
    minChildren: 2,
    maxChildren: 20,
    description: 'Dated or phased events in order: an incident, a release history.',
    a11y: 'An ordered list. Each event starts with its date or label as text.',
  },
  {
    type: 'event',
    kind: 'container',
    props: [
      { name: 'title', type: 'text', required: true, maxLength: 120, description: 'The one-line name of the event.' },
      {
        name: 'when',
        type: 'text',
        required: true,
        maxLength: 40,
        description: 'The date or phase, such as 2025-03-02 or Phase 2.',
      },
    ],
    variants: [],
    allowedChildren: ['callout', 'figure', 'code-tabs'],
    parent: 'timeline',
    body: 'markdown-optional',
    description: 'One event of a timeline. Only valid directly inside the timeline block.',
    a11y: 'A list item that leads with its label as plain text.',
  },
  {
    type: 'metrics',
    kind: 'container',
    props: [
      { name: 'title', type: 'text', maxLength: 120, description: 'A heading for the figures.' },
      { name: 'caption', type: 'text', maxLength: 300, description: 'Where the figures come from.' },
    ],
    variants: [],
    allowedChildren: ['metric'],
    body: 'blocks',
    minChildren: 2,
    maxChildren: 6,
    description: 'Key figures side by side, for a benchmark or a case study. Written with one-line metric blocks.',
    a11y: 'A list of figures. Each reads as label, value, trend and note, in words.',
  },
  {
    type: 'metric',
    kind: 'leaf',
    props: [
      { name: 'label', type: 'text', required: true, maxLength: 60, description: 'What is measured.' },
      {
        name: 'value',
        type: 'text',
        required: true,
        maxLength: 40,
        description: 'The figure with its unit, such as 38 ms.',
      },
      {
        name: 'trend',
        type: 'enum',
        values: ['up', 'down', 'flat'],
        description:
          'Direction of change, written out as text. It says which way the figure moved, never whether that is good or bad.',
      },
      { name: 'note', type: 'text', maxLength: 120, description: 'A short remark, such as the baseline.' },
    ],
    variants: [],
    allowedChildren: [],
    parent: 'metrics',
    body: 'none',
    description: 'One figure of a metrics block. Written on one line: ::metric{label="p95" value="38 ms"}.',
    a11y: 'A list item. The trend is a text label from the catalog plus an arrow shape, never colour alone.',
  },
  {
    type: 'tabs',
    kind: 'container',
    props: [{ name: 'title', type: 'text', maxLength: 120, description: 'A heading for the tabs.' }],
    variants: [],
    allowedChildren: ['tab'],
    body: 'blocks',
    minChildren: 2,
    maxChildren: 6,
    uniqueTitles: true,
    description: 'The same task for different setups, such as macOS, Linux and Windows. Each tab holds text, code or images.',
    a11y: 'The WAI-ARIA tabs pattern: arrow keys, Home and End. Every panel stays in the document.',
  },
  {
    type: 'tab',
    kind: 'container',
    props: [{ name: 'title', type: 'text', required: true, maxLength: 40, description: 'The tab label.' }],
    variants: [],
    allowedChildren: ['callout', 'figure', 'code-tabs', 'steps', 'file-tree'],
    parent: 'tabs',
    body: 'markdown',
    description: 'One tab of a tabs block. Only valid directly inside the tabs block.',
    a11y: 'A tab panel named by its tab.',
  },
] as const satisfies readonly BlockSpec[]

type AnyBlock = (typeof BLOCKS)[number]

/** Every block type of the registry, in documentation order. */
export type BlockType = AnyBlock['type']

export const BLOCK_TYPES: readonly BlockType[] = BLOCKS.map((block) => block.type)

type PropValueOf<P> = P extends { type: 'boolean' }
  ? boolean
  : P extends { type: 'integer' }
    ? number
    : P extends { type: 'enum'; values: readonly (infer V)[] }
      ? V
      : string

type HasValue<P> = P extends { required: true } ? true : P extends { default: PropValue } ? true : false

type Simplify<T> = { [K in keyof T]: T[K] } & unknown

/**
 * The attributes a component of this block type receives: the ones that are required or have a default are always there, the rest may
 * be missing. Derived from the registry, so a new attribute reaches the component types without a second edit.
 */
export type BlockPropsOf<T extends BlockType> = Simplify<
  {
    [P in Extract<AnyBlock, { type: T }>['props'][number] as HasValue<P> extends true ? P['name'] : never]: PropValueOf<P>
  } & {
    [P in Extract<AnyBlock, { type: T }>['props'][number] as HasValue<P> extends true ? never : P['name']]?: PropValueOf<P>
  }
>

/** The block types whose body is kept as raw source: their component receives it as `source`. */
export type RawBodyType = Extract<AnyBlock, { body: 'raw' }>['type']

const SPEC_BY_TYPE: ReadonlyMap<string, BlockSpec> = new Map(BLOCKS.map((block) => [block.type, block]))

export function getBlockSpec(type: string): BlockSpec | undefined {
  return SPEC_BY_TYPE.get(type)
}

/** The blocks an author can write on their own, that is those that do not need a particular parent. */
export const TOP_LEVEL_BLOCK_TYPES: readonly BlockType[] = BLOCKS.filter((block) => !('parent' in block)).map(
  (block) => block.type,
)

/** The attribute names of every block, once each: what the sanitize schema allows on the `ai-block` element. */
export const BLOCK_PROP_NAMES: readonly string[] = [...new Set(BLOCKS.flatMap((block) => block.props.map((prop) => prop.name)))]

/** `"a", "b" or "c"`-style list for messages. */
export function quoted(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(', ')
}

/** Short echo of something the author wrote, for a message: cut, one line, no markup characters. */
export function echo(value: string, max = 30): string {
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** The registered type closest to `name` within two edits, for "did you mean". */
export function closestBlockType(name: string): string | undefined {
  const wanted = name.toLowerCase()
  let best: { type: string; distance: number } | undefined
  for (const type of BLOCK_TYPES) {
    const distance = editDistance(wanted, type)
    if (distance <= 2 && (!best || distance < best.distance)) best = { type, distance }
  }
  return best?.type
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i]
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    previous = row
  }
  return previous[b.length]!
}

const MEDIA_SIZE = '#[1-9]\\d{0,4}x[1-9]\\d{0,4}'
/** `/media/<name>` with the optional `#WxH` hint the editor and the importer write. */
const MEDIA_PATH = new RegExp(`^/media/[A-Za-z0-9._~-]+(?:${MEDIA_SIZE})?$`)
/** `assets/diagram.png`: plain segments, no scheme, no leading slash, no dot segments. */
const PACKAGE_PATH = /^(?:[A-Za-z0-9._~%@+-]+\/)*[A-Za-z0-9._~%@+-]+$/

/**
 * An image source the figure block accepts: a package-relative path, a `/media/...` path or an https URL. Anything else, a `data:`
 * or `javascript:` URL, plain http, a protocol-relative URL, a path that climbs out with `..`, is refused.
 */
export function isImageSource(value: string): boolean {
  if (MEDIA_PATH.test(value)) return true
  if (value.startsWith('https://')) {
    if (/[\s<>"'\\]/.test(value)) return false
    try {
      return new URL(value).hostname !== ''
    } catch {
      return false
    }
  }
  return PACKAGE_PATH.test(value) && value.split('/').every((segment) => segment !== '.' && segment !== '..')
}

/** The longest title a code fence may carry. */
export const MAX_FENCE_TITLE = 120

/**
 * The `title="file.py"` of a code fence's meta (the text after the language), or `undefined` when the meta carries none. A title
 * is quoted with either quote, or a single bare word. `tooLong` and `control` report a title that was found but cannot be used.
 */
export function parseFenceTitle(meta: string | null | undefined): { title?: string; problem?: 'too-long' | 'control' } {
  if (!meta) return {}
  const match = /(?:^|\s)title=(?:"([^"]*)"|'([^']*)'|([^\s"']+))/.exec(meta)
  const raw = match?.[1] ?? match?.[2] ?? match?.[3]
  const title = raw?.trim()
  if (!title) return {}
  if (/[\u0000-\u001f\u007f]/.test(title)) return { problem: 'control' }
  if (title.length > MAX_FENCE_TITLE) return { problem: 'too-long' }
  return { title }
}

/** The most lines and ranges one fence `highlight` may list. */
export const MAX_FENCE_HIGHLIGHT_ENTRIES = 40

/** A run of highlighted lines, 1-based and inclusive on both ends. */
export type HighlightRange = readonly [start: number, end: number]

export interface FenceHighlight {
  /** The ranges in ascending order, apart from each other. Set together with {@link FenceHighlight.highlight}. */
  readonly ranges?: readonly HighlightRange[]
  /** The same ranges in their one written form: no spaces, a range of one line written as that line (`2,5-7`). */
  readonly highlight?: string
  /** What is wrong with a highlight that was found: `empty`, `format` (not lines and ranges), `order` (not ascending or overlapping) or `too-many`. */
  readonly problem?: 'empty' | 'format' | 'order' | 'too-many'
}

/** One line or one range: positive whole numbers of up to four digits. */
const HIGHLIGHT_ENTRY = /^([1-9]\d{0,3})(?:\s*-\s*([1-9]\d{0,3}))?$/

/**
 * Checks the value of a fence `highlight` (`2,5-7`): lines and ranges of positive whole numbers up to 9999, separated by commas, in
 * ascending order and not overlapping, at most {@link MAX_FENCE_HIGHLIGHT_ENTRIES} of them. Pure: the validator, the pipeline and the
 * code highlighter all read the value through this.
 */
export function parseHighlightValue(value: string): FenceHighlight {
  const text = value.trim()
  if (text === '') return { problem: 'empty' }
  const entries = text.split(',').map((entry) => entry.trim())
  if (entries.length > MAX_FENCE_HIGHLIGHT_ENTRIES) return { problem: 'too-many' }
  const ranges: HighlightRange[] = []
  for (const entry of entries) {
    const match = HIGHLIGHT_ENTRY.exec(entry)
    if (!match) return { problem: 'format' }
    const start = Number(match[1])
    const end = match[2] === undefined ? start : Number(match[2])
    if (end < start) return { problem: 'order' }
    const previous = ranges[ranges.length - 1]
    if (previous && start <= previous[1]) return { problem: 'order' }
    ranges.push([start, end])
  }
  return { ranges, highlight: ranges.map(([start, end]) => (start === end ? `${start}` : `${start}-${end}`)).join(',') }
}

/**
 * The `highlight="2,5-7"` of a code fence's meta (the text after the language), read like `title`: quoted with either quote, or a
 * single bare word. `{}` when the meta carries none; otherwise the checked value, or the `problem` with it (`format` also for a
 * `highlight=` that is cut short or has no value).
 */
export function parseFenceHighlight(meta: string | null | undefined): FenceHighlight {
  if (!meta) return {}
  const match = /(?:^|\s)highlight=(?:"([^"]*)"|'([^']*)'|([^\s"']+))/.exec(meta)
  const raw = match?.[1] ?? match?.[2] ?? match?.[3]
  if (raw !== undefined) return parseHighlightValue(raw)
  // A `highlight=` word the value pattern cannot read (an unterminated quote, no value) is written but wrong, so it is reported. The
  // quoted spans are blanked first, so the text of a valid title that contains the word is not mistaken for one.
  return /(?:^|\s)highlight=/.test(meta.replace(/"[^"]*"|'[^']*'/g, ' ')) ? { problem: 'format' } : {}
}

export interface PropIssue {
  readonly code: 'unknown-attribute' | 'missing-attribute' | 'bad-attribute'
  readonly prop: string
  readonly message: string
}

export interface ParsedBlockProps {
  /** Every attribute of the block with its default applied, typed by the spec. */
  readonly props: Record<string, PropValue>
  /** Only what the author wrote, in the form the HTML tree carries: strings, and `true` for a boolean that is on. */
  readonly given: Record<string, string | true>
  readonly issues: readonly PropIssue[]
}

/** A directive attribute (a string, `''` for a bare flag) or an HTML property (a string, a number, a boolean) as a string. */
function rawString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === false) return undefined
  if (value === true) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.join(' ')
  return undefined
}

function checkValue(spec: BlockSpec, prop: PropSpec, raw: string): { value: PropValue } | { issue: string } {
  const where = `Attribute "${prop.name}" on "${spec.type}"`
  switch (prop.type) {
    case 'enum': {
      const values = prop.values ?? []
      return values.includes(raw) ? { value: raw } : { issue: `${where} must be one of ${quoted(values)} (got "${echo(raw)}").` }
    }
    case 'boolean': {
      if (raw === '' || raw === 'true') return { value: true }
      if (raw === 'false') return { value: false }
      return { issue: `${where} is a flag: write {${prop.name}} to turn it on, or leave it out (got "${echo(raw)}").` }
    }
    case 'integer': {
      const min = prop.min ?? Number.MIN_SAFE_INTEGER
      const max = prop.max ?? Number.MAX_SAFE_INTEGER
      const number = /^-?\d{1,9}$/.test(raw) ? Number(raw) : Number.NaN
      if (Number.isNaN(number) || number < min || number > max) {
        return { issue: `${where} must be a whole number from ${min} to ${max} (got "${echo(raw)}").` }
      }
      return { value: number }
    }
    case 'url':
    case 'text': {
      const text = raw.trim()
      if (text === '') return { issue: `${where} needs a value: write ${prop.name}="...".` }
      if (/[\u0000-\u001f\u007f]/.test(text)) return { issue: `${where} must not contain control characters.` }
      const max = prop.maxLength ?? DEFAULT_TEXT_MAX
      if (text.length > max) return { issue: `${where} is longer than ${max} characters.` }
      if (prop.type === 'url' && !isImageSource(text)) {
        return {
          issue: `${where} must be a path inside the package such as assets/name.png, a /media/ path or an https URL (got "${echo(text, 60)}").`,
        }
      }
      return { value: text }
    }
  }
}

/**
 * Checks the attributes of one block against its spec and applies the defaults. `raw` is the attribute map of a directive, or the
 * properties of an `ai-block` element; `ignoreUnknown` is for the second, where the tree carries extra properties of its own (`block`,
 * `className`) that are not the author's attributes. Pure: the same call serves the validator, the pipeline and the dispatcher.
 */
export function parseBlockProps(
  spec: BlockSpec,
  raw: Readonly<Record<string, unknown>>,
  options: { ignoreUnknown?: boolean } = {},
): ParsedBlockProps {
  const issues: PropIssue[] = []
  const props: Record<string, PropValue> = {}
  const given: Record<string, string | true> = {}
  const known = new Set(spec.props.map((prop) => prop.name))

  if (!options.ignoreUnknown) {
    for (const name of Object.keys(raw)) {
      if (known.has(name) || rawString(raw[name]) === undefined) continue
      const allowed =
        spec.props.length === 0 ? `"${spec.type}" takes no attributes.` : `Allowed attributes: ${quoted([...known])}.`
      issues.push({
        code: 'unknown-attribute',
        prop: name,
        message: `Unknown attribute "${echo(name)}" on "${spec.type}". ${allowed}`,
      })
    }
  }

  for (const prop of spec.props) {
    const text = rawString(raw[prop.name])
    if (text === undefined) {
      if (prop.required) {
        issues.push({
          code: 'missing-attribute',
          prop: prop.name,
          message: `Block "${spec.type}" needs the attribute "${prop.name}": ${prop.description}`,
        })
      } else if (prop.default !== undefined) {
        props[prop.name] = prop.default
      }
      continue
    }
    const checked = checkValue(spec, prop, text)
    if ('issue' in checked) {
      issues.push({ code: 'bad-attribute', prop: prop.name, message: checked.issue })
      continue
    }
    props[prop.name] = checked.value
    // A boolean that is off is left out: it is the default, and `open="false"` would read as on once it has been through HTML.
    if (checked.value !== false) given[prop.name] = checked.value === true ? true : String(checked.value)
  }

  return { props, given, issues }
}
