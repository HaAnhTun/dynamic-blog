import {
  POST_IMPORT_MAX_FILE_BYTES,
  POST_IMPORT_MAX_PACKAGE_ASSET_BYTES,
  POST_IMPORT_MAX_PACKAGE_BYTES,
  POST_IMPORT_MAX_PACKAGE_ENTRIES,
} from '@/lib/post-import'
import { CODE_LANGUAGES, type CodeLanguage } from './code-languages'
import { MAX_RAW_SOURCE } from './remark-blocks'
import { BLOCKS, MAX_FENCE_HIGHLIGHT_ENTRIES, MAX_FENCE_TITLE, getBlockSpec } from './registry'
import type { BlockSpec, BodyRule, ProblemCode, PropSpec } from './types'
import { DEFAULT_TEXT_MAX } from './types'

/**
 * The authoring prompt: one Markdown document that a person gives to an AI assistant so that what comes back imports cleanly. It is
 * generated, not written twice: the block section is rendered from the registry (`./registry.ts`), the numbers come from the same
 * constants the import page checks with, and the two examples are checked by `validateBlocks` in the test. A block added to the
 * registry is in the next download with no other change; `authoring-prompt.test.ts` fails when the two disagree.
 */

const KIB = 1024
const MIB = 1024 * KIB

/** The fourteen rules of the authoring contract, in the order the brief gives them. */
export const AUTHORING_RULES: readonly string[] = [
  'Understand the topic, the audience, the purpose and the source material you are given before you write.',
  'Choose a suitable structure for the article before you write it. Do not force a template such as introduction, image, code, conclusion: the structure follows the subject.',
  'Write the complete article in Markdown.',
  'Use the native blocks below where they materially improve understanding, and only those blocks.',
  'Choose the order of the blocks from the narrative and the technical content, not from a fixed sequence. Articles may have different numbers of headings and blocks.',
  'Include the images the article needs as local files in the package, and refer to them by their exact relative path.',
  'Give every image useful alternative text (what it shows) and, where it helps, a caption (what the reader should take from it).',
  'Give every code block an accurate language identifier. A title="file.py" on the fence names the file.',
  'Use a table only where it improves a comparison, never only for visual variety.',
  'Avoid unnecessary callouts, diagrams, tabs and other decorative blocks. A plain article of headings and prose is valid.',
  'Do not write an article header, a table of contents, an author section or a site footer. The page provides them; the title comes from the front matter.',
  'Do not write HTML or CSS, except the few tags named under "The body". Scripts, styles, iframes and inline event handlers are rejected, and other tags are silently dropped.',
  'Check that every image reference points to a file in the package and that every file in the package is used. Check every block against the reference below.',
  'Return one importable ZIP package, as described below, and nothing else.',
]

/** What each kind of body means, in a sentence. Exhaustive on purpose: a new body rule needs its words here. */
const BODY_TEXT: Record<BodyRule, string> = {
  none: 'No body: it is written on one line.',
  markdown: 'Markdown without headings: paragraphs, lists, code, images, tables. The body must not be empty.',
  'markdown-optional': 'Markdown without headings. The body may be empty.',
  raw: `The raw source text, written directly under the opening line without a code fence and kept exactly as written. It is not parsed as Markdown. It must not be empty and is at most ${MAX_RAW_SOURCE.toLocaleString('en-US')} characters.`,
  blocks: 'Only blocks of the types listed under "Contains".',
  images: 'Markdown images only, one per line, each with alternative text.',
  table: 'Markdown that holds at least one table.',
  list: 'Markdown that holds a list.',
  'task-list':
    'Markdown that holds a task list: lines starting with "- [ ]" or "- [x]". Every item must be a task; a plain bullet is an error.',
  'code-fences': `Fenced code blocks only, each with a title="Label" after the language. The titles must be different from each other (ignoring letter case) and at most ${MAX_FENCE_TITLE} characters. There must be no text between the fences.`,
}

const KIND_TEXT: Record<BlockSpec['kind'], string> = {
  container: 'container (a line of colons and the name opens it, a line of the same number of colons closes it)',
  leaf: 'leaf (one line: ::name{...})',
  either: 'leaf (one line: ::name{...}); a container with an empty body is accepted too',
}

/** A block written on one line, with two colons, instead of an opening and a closing line. */
const isOneLine = (spec: BlockSpec) => spec.kind === 'leaf' || spec.body === 'none'

/**
 * The fewest colons a block can be opened and closed with and still hold anything the registry lets it hold: three, plus one for every
 * level of container blocks below it (a block with a child that holds a child needs one more than that child, and so on). A one-line
 * block (a leaf, or a block without a body) is written with two colons and adds no level. Computed, never written by hand.
 */
function colonsOfSpec(spec: BlockSpec, seen: ReadonlySet<string> = new Set()): number {
  if (isOneLine(spec)) return 2
  const below = new Set(seen).add(spec.type)
  let colons = 3
  for (const type of spec.allowedChildren) {
    const child = getBlockSpec(type)
    if (child && !below.has(type)) colons = Math.max(colons, colonsOfSpec(child, below) + (isOneLine(child) ? 0 : 1))
  }
  return colons
}

/** The colons of the block of this type (see {@link colonsOfSpec}); three for a type the registry does not know. */
export function colonsOf(type: string): number {
  const spec = getBlockSpec(type)
  return spec === undefined ? 3 : colonsOfSpec(spec)
}

/** One attribute for the syntax line: the default of an enum, a quoted text, a bare flag; in brackets when it is optional. */
function placeholder(prop: PropSpec): string {
  const written = (() => {
    switch (prop.type) {
      case 'enum':
        return `${prop.name}=${prop.default ?? prop.values?.[0] ?? ''}`
      case 'integer':
        return `${prop.name}=${prop.default ?? prop.min ?? 1}`
      case 'boolean':
        return prop.name
      case 'url':
        return `${prop.name}="assets/image.png"`
      case 'text':
        return `${prop.name}="..."`
    }
  })()
  return prop.required ? written : `[${written}]`
}

function syntaxOf(spec: BlockSpec): string {
  const attributes = spec.props.length === 0 ? '' : `{${spec.props.map(placeholder).join(' ')}}`
  // A block with no body is written on one line, even when the container form with an empty body is accepted too.
  if (isOneLine(spec)) return `::${spec.type}${attributes}`
  const colons = ':'.repeat(colonsOfSpec(spec))
  return `${colons}${spec.type}${attributes}\n...\n${colons}`
}

function typeOf(prop: PropSpec): string {
  switch (prop.type) {
    case 'enum':
      return (prop.values ?? []).join(' or ')
    case 'integer':
      return `whole number ${prop.min ?? ''}${prop.min !== undefined && prop.max !== undefined ? ' to ' : ''}${prop.max ?? ''}`.trim()
    case 'boolean':
      return 'flag'
    case 'url':
      return `image path or URL, up to ${prop.maxLength ?? DEFAULT_TEXT_MAX} characters`
    case 'text':
      return `text, up to ${prop.maxLength ?? DEFAULT_TEXT_MAX} characters`
  }
}

/** One cell may not contain the pipe or a line break of a table row. */
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()

function propRows(spec: BlockSpec): string[] {
  if (spec.props.length === 0) return ['This block takes no attributes.']
  return [
    '| Attribute | Required | Value | Default | Meaning |',
    '| --- | --- | --- | --- | --- |',
    ...spec.props.map(
      (prop) =>
        `| \`${prop.name}\` | ${prop.required ? 'yes' : 'no'} | ${cell(typeOf(prop))} | ${prop.default === undefined ? '' : `\`${prop.default}\``} | ${cell(prop.description)} |`,
    ),
  ]
}

function bodyText(spec: BlockSpec): string {
  let text = BODY_TEXT[spec.body]
  if (spec.minChildren !== undefined || spec.maxChildren !== undefined) {
    const range =
      spec.minChildren !== undefined && spec.maxChildren !== undefined
        ? `${spec.minChildren} to ${spec.maxChildren}`
        : spec.minChildren !== undefined
          ? `at least ${spec.minChildren}`
          : `at most ${spec.maxChildren}`
    text += ` Number of items: ${range}.`
  }
  for (const [variant, max] of Object.entries(spec.maxChildrenByVariant ?? {})) {
    text += ` With variant "${variant}": at most ${max}.`
  }
  if (spec.uniqueTitles) text += ' Each item needs its own title (ignoring letter case).'
  return text
}

export function blockSection(spec: BlockSpec): string {
  const lines = [
    `### \`${spec.type}\``,
    '',
    spec.description,
    '',
    `- Form: ${KIND_TEXT[spec.kind]}.`,
    `- Syntax:`,
    '',
    '  ```markdown',
    ...syntaxOf(spec)
      .split('\n')
      .map((line) => `  ${line}`),
    '  ```',
    '',
    isOneLine(spec)
      ? '- Colons: two, written on one line.'
      : `- Colons: ${colonsOfSpec(spec)} or more, the same number on the opening and the closing line.`,
    `- Body: ${bodyText(spec)}`,
  ]
  if (spec.allowedChildren.length > 0) {
    const children = spec.allowedChildren.map((type) => `\`${type}\``).join(', ')
    lines.push(spec.body === 'blocks' ? `- Contains: ${children}.` : `- May also contain these blocks: ${children}.`)
  } else if (!isOneLine(spec)) {
    lines.push('- Contains no other blocks.')
  }
  if (spec.parent !== undefined) lines.push(`- Only valid directly inside \`${spec.parent}\`.`)
  if (spec.variants.length > 0)
    lines.push(`- Variants (attribute \`variant\`): ${spec.variants.map((v) => `\`${v}\``).join(', ')}.`)
  lines.push(`- Accessibility: ${spec.a11y}`, '', ...propRows(spec), '')
  return lines.join('\n')
}

/** The opening or closing line of a block of this type, as the registry says it must be written. */
const fence = (type: string) => ':'.repeat(colonsOf(type))

/** A short tutorial: steps with nested blocks, code in tabs, a callout, a figure and a checklist, the first part of a series. Checked by `validateBlocks` in the test. */
export const EXAMPLE_TUTORIAL = `---
title: Send your first request
slug: send-your-first-request
language: en
excerpt: Install the client, send one request and read the answer.
category: Guides
tags: tutorial, http
series: Getting started with the client
series_part: 1
series_description: Install the client, send requests and read the answers, one part at a time.
---

This guide sends one request and reads the answer.

## Before you start

:::callout{type=note title="You need"}
A terminal and the client installed.
:::

## Send the request

:::::steps{title="Three steps"}
::::step{title="Install"}
Download the client and put it on your path.
::::
::::step{title="Send"}
Run the command below.

::figure{src="assets/terminal.png" alt="A terminal that shows the command and its answer" caption="The command and its answer."}
::::
::::step{title="Read the answer"}
A status of 200 means the request worked.
::::
:::::

:::code-tabs{title="The same request"}
\`\`\`bash title="curl"
curl https://example.com/api/status
\`\`\`
\`\`\`python title="Python"
import urllib.request
print(urllib.request.urlopen("https://example.com/api/status").read())
\`\`\`
:::

## Check your work

:::checklist{title="Done when"}
- [ ] The command printed an answer
- [ ] The status was 200
:::
`

/** A design article: a diagram, a comparison table, a details block and the takeaways. Checked by `validateBlocks` in the test. */
export const EXAMPLE_ARCHITECTURE = `---
title: Why the service has two queues
slug: why-the-service-has-two-queues
language: en
excerpt: One queue for fast work and one for slow work keeps both predictable.
category: Architecture
tags: architecture, queues
---

A single queue made slow jobs block fast ones. The service now has two.

## The design

:::diagram{type=mermaid title="Request flow" alt="A request goes to the router, which sends it to the fast or the slow queue"}
flowchart LR
  A[Request] --> B{Router}
  B --> C[Fast queue]
  B --> D[Slow queue]
:::

## The options we compared

:::comparison{title="One queue or two" caption="Measured on one test machine."}
| Option | Latency of fast jobs | Complexity |
| --- | --- | --- |
| One queue | high when slow jobs arrive | low |
| Two queues | stable | medium |
:::

::::::details{title="How the router decides"}
A job that declares more than a second of expected work goes to the slow queue.
::::::

## What to remember

:::takeaways{title="Takeaways"}
- Separate work by how long it takes.
- Measure before you add a queue.
:::
`

/** Three levels of blocks, each with the colons the registry asks for. Checked by `validateBlocks` in the test. */
export const EXAMPLE_NESTING = `${fence('details')}details{title="Troubleshooting"}
Open this when the request fails.

${fence('steps')}steps{title="Check in order"}
${fence('step')}step{title="Read the status"}
Look at the status code first.

${fence('callout')}callout{type=tip title="Common cause"}
A status of 401 means the key is missing.
${fence('callout')}
${fence('step')}
${fence('step')}step{title="Try again"}
Send the request once more.
${fence('step')}
${fence('steps')}
${fence('details')}
`

/**
 * Four blocks that hold only blocks, images or a list, filled the way their Body line says (the generic "replace the dots" does not
 * fit them). Two levels at most; the colons come from the registry. Checked by `validateBlocks` in the test.
 */
export const EXAMPLE_FILLING = `${fence('metrics')}metrics{title="After the change"}
::metric{label="p95 latency" value="38 ms" trend=down note="was 61 ms"}
::metric{label="Error rate" value="0.2%" trend=flat}
${fence('metrics')}

${fence('gallery')}gallery{columns=2}
![The dashboard before the change](assets/before.png "Before")
![The dashboard after the change](assets/after.png "After")
${fence('gallery')}

${fence('timeline')}timeline{title="What happened"}
${fence('event')}event{title="Deploy" when="14:02"}
The new version went out.
${fence('event')}
${fence('event')}event{title="Rollback" when="14:20"}
The old version came back.
${fence('event')}
${fence('timeline')}

${fence('file-tree')}file-tree{title="The package"}
- src/
  - main.ts - the entry point (new)
  - util.ts (changed)
- README.md
${fence('file-tree')}
`

/** The longest text that a prop of a block may hold, from the registry, for the sentences that name it. */
function maxLengthOf(type: string, prop: string): number {
  return getBlockSpec(type)?.props.find((candidate) => candidate.name === prop)?.maxLength ?? DEFAULT_TEXT_MAX
}

/**
 * How to use the blocks well, in the words of the guide. Each sentence was checked against the code or a test (`authoring-prompt.test.ts`
 * and the renderer tests); keep angle brackets out, the prompt is plain Markdown text.
 */
export const BLOCK_NOTES: readonly string[] = [
  'Panes of `compare`: with `variant=before-after` title the two panes `Before` and `After`; for alternatives use titles such as `Option A` and `Option B`.',
  'Details with the same `group` open one at a time wherever they stand in the article, so write them one after another. Leave `variant` at its default `inline` for an FAQ or a troubleshooting aside in the flow of the text, and use `appendix` for background the reader can skip.',
  'The `trend` of a `metric` says only which way the figure moved (`up`, `down` or `flat`), never whether that is good or bad: say that in the `note`, or leave the trend out when there is no baseline.',
  `The \`when\` of an \`event\` is any short text up to ${maxLengthOf('event', 'when')} characters: a date, a phase or a clock time such as \`14:02\`. Write it in double quotes.`,
  'Items of a `file-tree`: a folder ends with a slash and holds the nested list. After a name you may write a short description, for example `main.ts - the entry point`, and mark an entry with plain words such as `(new)`, `(changed)` or `(removed)`. The list is drawn as written; nothing else in an item is read.',
  'A `takeaways` block may open the article as a summary.',
  'The panels of `tabs` and `code-tabs` that are not selected are hidden: find-in-page and print skip them, and without script only the first tab shows. Put the essential text outside the tabs and use tabs only for alternatives the reader chooses between.',
]

/**
 * The version of the Mermaid library whose diagram types were drawn one by one in headless Chrome with the options of `DiagramView`
 * (strict security level, no error drawing). A test compares it with the installed library, so an upgrade fails there until the
 * census is run again and this list is checked.
 */
export const MERMAID_VERIFIED_VERSION = '12.1.0'

/** A diagram type that drew in the census, with a one-line syntax hint. Free of angle brackets on purpose. */
export const MERMAID_TYPES: readonly { readonly keyword: string; readonly hint: string }[] = [
  {
    keyword: 'flowchart TD',
    hint: 'boxes and arrows, such as A[Start] --> B{Choice} --> C[End]; TD is top down, LR is left to right. Write a label in double quotes when it holds parentheses or brackets: A["Call (retry)"]',
  },
  {
    keyword: 'sequenceDiagram',
    hint: 'participant A as Client, then A->>B: message. The message text may hold parentheses, slashes and colons',
  },
  { keyword: 'classDiagram', hint: 'class Name with members, and relations such as Parent <|-- Child' },
  { keyword: 'stateDiagram-v2', hint: '[*] --> State, then State --> Other: event' },
  { keyword: 'erDiagram', hint: 'relations such as POST ||--o{ COMMENT : has' },
  { keyword: 'gantt', hint: 'a schedule: title, dateFormat YYYY-MM-DD, section, then Task :id, 2025-03-01, 5d' },
  { keyword: 'pie', hint: 'a share: pie title Traffic, then one line per slice such as "Search" : 55' },
  { keyword: 'timeline', hint: 'events by period: timeline, then lines such as 2024 : Event : Another event' },
  {
    keyword: 'xychart-beta',
    hint: 'a time series or a comparison as bars or a line: title "Errors per hour", x-axis [10, 11, 12], y-axis "Errors" 0 --> 100, bar [5, 20, 80], line [5, 20, 80]',
  },
  {
    keyword: 'quadrantChart',
    hint: 'x-axis Low --> High, y-axis Low --> High, quadrant-1 to quadrant-4 titles, then points such as Name: [0.3, 0.6]',
  },
  { keyword: 'sankey-beta', hint: 'flows: after a blank line, one line per flow as source,target,value' },
  { keyword: 'mindmap', hint: 'root((Topic)), then the branches, one indent level deeper each' },
  { keyword: 'journey', hint: 'title, section, then steps such as Task: 5: Actor' },
  { keyword: 'gitGraph', hint: 'commit, branch name, checkout main, merge name' },
  { keyword: 'block-beta', hint: 'columns 3, then blocks such as a["Client"] and links such as a --> b' },
  { keyword: 'requirementDiagram', hint: 'requirement and element blocks joined by a relation' },
  { keyword: 'C4Context', hint: 'Person, System and Rel lines' },
  {
    keyword: 'architecture-beta',
    hint: 'group and service lines with the icons cloud, database or server, and edges such as db:L -- R:server',
  },
  { keyword: 'packet-beta', hint: 'bit ranges such as 0-15: "Source port"' },
  { keyword: 'kanban', hint: 'columns with indented tasks such as t1[Write the post]' },
  { keyword: 'radar-beta', hint: 'axis a["Speed"], b["Cost"], then curve x["Option"]{3, 2}' },
  { keyword: 'treemap', hint: 'indented names, leaves written as "Name": value' },
]

/** Types that drew in the census too, but that an article rarely needs: named without a hint. */
export const MERMAID_OTHER_TYPES: readonly string[] = [
  'venn-beta',
  'info',
  'treeView-beta',
  'ishikawa-beta',
  'eventmodeling',
  'cynefin-beta',
  'agentflow-beta',
  'railroad-ebnf-beta',
]

/** The notes on using the blocks well as a Markdown list. Part of the prompt and of `docs/ai-article-authoring.md`. */
export function blockNotesReference(): string {
  return BLOCK_NOTES.map((note) => `- ${note}`).join('\n')
}

/** The Mermaid types that draw, as a table with their syntax hints. Stands in `docs/ai-article-authoring.md` between its DIAGRAMS markers. */
export function mermaidReference(): string {
  const cell = (text: string) => text.replace(/\|/g, '\\|')
  return [
    '| Type | Syntax |',
    '| --- | --- |',
    ...MERMAID_TYPES.map((type) => `| \`${type.keyword}\` | ${cell(type.hint)} |`),
    '',
    `These draw too and are rarely needed: ${MERMAID_OTHER_TYPES.map((type) => `\`${type}\``).join(', ')}.`,
  ].join('\n')
}

/** A wrong way to write something, the right way, and the problem the validator reports for the wrong one (a test proves both). */
export interface Pitfall {
  readonly title: string
  readonly wrong: string
  readonly right: string
  readonly code: ProblemCode
}

/**
 * The mistakes an assistant makes most often, each as a wrong and a right example. Every wrong example must fail `validateBlocks`
 * with `code` and every right one must pass (`authoring-prompt.test.ts`), so none of these sentences can drift from the validator.
 * Keep angle brackets out: the prompt is plain Markdown text.
 */
export const PITFALLS: readonly Pitfall[] = [
  {
    title: 'A kind of callout written as a block',
    wrong: ':::note\nBack up the database first.\n:::',
    right: ':::callout{type=note}\nBack up the database first.\n:::',
    code: 'unknown-block',
  },
  {
    title: 'A label in square brackets',
    wrong: ':::callout[Heads up]\nCheck the version.\n:::',
    right: ':::callout{title="Heads up"}\nCheck the version.\n:::',
    code: 'bad-label',
  },
  {
    title: 'The same number of colons around a block and the block inside it',
    wrong: ':::steps\n:::step{title="Install"}\nRun the installer.\n:::\n:::',
    right: `${fence('steps')}steps\n${fence('step')}step{title="Install"}\nRun the installer.\n${fence('step')}\n${fence('steps')}`,
    code: 'unclosed-block',
  },
  {
    title: 'A block inside a list',
    wrong: '- Install the client\n\n  :::callout{type=tip}\n  Use the latest version.\n  :::',
    right: '- Install the client\n\n:::callout{type=tip}\nUse the latest version.\n:::',
    code: 'bad-nesting',
  },
  {
    title: 'A heading inside a block',
    wrong: ':::callout\n## Notes\nText.\n:::',
    right: '## Notes\n\n:::callout\nText.\n:::',
    code: 'heading-in-block',
  },
  {
    title: 'A diagram wrapped in a code fence',
    wrong: ':::diagram{type=mermaid alt="A goes to B"}\n```mermaid\nflowchart LR\n  A --> B\n```\n:::',
    right: ':::diagram{type=mermaid alt="A goes to B"}\nflowchart LR\n  A --> B\n:::',
    code: 'bad-body',
  },
  {
    title: 'Plain bullets in a checklist',
    wrong: ':::checklist\n- Back up the data\n- [ ] Run the migration\n:::',
    right: ':::checklist\n- [ ] Back up the data\n- [ ] Run the migration\n:::',
    code: 'bad-body',
  },
  {
    title: 'Two code tabs with the same title',
    wrong: ':::code-tabs\n```bash title="Install"\nnpm install\n```\n```bash title="install"\nnpm ci\n```\n:::',
    right: ':::code-tabs\n```bash title="npm"\nnpm install\n```\n```bash title="pnpm"\npnpm install\n```\n:::',
    code: 'bad-body',
  },
  {
    title: 'Text that looks like a block',
    wrong: 'Use :callout{type=note} for asides.',
    right: 'Use `:callout{type=note}` for asides.',
    code: 'text-directive',
  },
  {
    title: 'A closing line with nothing to close',
    wrong: 'Text.\n\n:::callout\nNote.\n:::\n:::',
    right: 'Text.\n\n:::callout\nNote.\n:::',
    code: 'bad-fence',
  },
  {
    title: 'An image without alternative text',
    wrong: '::figure{src="assets/a.png" alt=""}',
    right: '::figure{src="assets/a.png" alt="A terminal that shows the answer"}',
    code: 'bad-attribute',
  },
]

/** The common mistakes as Markdown: the wrong and the right way, one under the other. Part of the prompt and of `docs/content-blocks.md`. */
export function pitfallsReference(): string {
  return PITFALLS.flatMap((pitfall) => [
    `**${pitfall.title}.** Wrong:`,
    '',
    '`````markdown',
    pitfall.wrong,
    '`````',
    '',
    'Right:',
    '',
    '`````markdown',
    pitfall.right,
    '`````',
    '',
  ])
    .join('\n')
    .trimEnd()
}

/**
 * The limits of the front matter. The backend enforces them (`PostFileLimits`) and `docs/post-file-format.md` pins its Limits table
 * against the backend; a test compares this object with that table, so the numbers the assistant is told cannot drift.
 */
export const FRONT_MATTER_LIMITS = {
  title: 255,
  tags: 20,
  tag: 100,
  series: 255,
  seriesDescription: 2000,
  seriesPart: 1000,
  newCategories: 20,
  newTags: 50,
} as const

/** The longest alternative text of a cover image: the limit of the alt column of the media table, as in the editor. */
export const COVER_ALT_MAX = 300

/** The other spellings of a highlighted language that the installed grammar knows (a test reads them from the grammar). */
export const CODE_LANGUAGE_ALIASES = {
  typescript: ['ts'],
  javascript: ['js'],
  python: ['py'],
  bash: ['sh', 'shell', 'zsh'],
  yaml: ['yml'],
  shellsession: ['console'],
  rust: ['rs'],
  markdown: ['md'],
  ini: ['properties'],
} as const satisfies Partial<Record<CodeLanguage, readonly string[]>>

/** The highlighted languages with their aliases, from the one constant that the code highlighter loads its grammars from. */
function languageList(): string {
  const aliases: Partial<Record<CodeLanguage, readonly string[]>> = CODE_LANGUAGE_ALIASES
  return CODE_LANGUAGES.map((language) => {
    const other = aliases[language]
    return other === undefined ? `\`${language}\`` : `\`${language}\` (also ${other.map((alias) => `\`${alias}\``).join(', ')})`
  }).join(', ')
}

/**
 * The front matter as Markdown: the table of the keys with what to write in each, and the rules that are not in a row. Part of the
 * prompt, and the same text stands in `docs/ai-article-authoring.md` between its FRONT MATTER markers, so the two cannot differ.
 */
export function frontMatterReference(): string {
  const limits = FRONT_MATTER_LIMITS
  return [
    '| Key | Required | Meaning |',
    '| --- | --- | --- |',
    `| \`title\` | yes for a new article | The title, one line, at most ${limits.title} characters. |`,
    '| `slug` | no, but write it | For a new article always write `slug`: lower case letters, digits and hyphens made from the title, for example `why-the-service-has-two-queues`. Name the ZIP file after it (`why-the-service-has-two-queues.zip`). Without a slug the ZIP file name becomes the slug, and a slug that an existing post already has means "update that post": the import preview marks it "Will change" and the person looks at the card before confirming. Choose a distinctive slug, not a bare word such as `guide`, because you cannot see which posts the site has. Never change the slug of an article that exists. |',
    '| `language` | no | The language code of the article, for example `en`. It must be a language enabled on the site; leave it out to use the default language of the site. |',
    '| `excerpt` | no | One or two sentences that sum up the article. |',
    '| `cover` | no | The cover image of the article: the path of an image inside a package, such as `assets/cover.png` (JPEG, PNG or WebP, named like the other images, and not used in the body unless you want it there too). Only a package can carry it: in a plain Markdown file a `cover` line is a problem. A path that is not in the package is a problem, and so is a file that is not a JPEG, PNG or WebP image. The image becomes the cover of the article: a new article gets it, and it replaces the cover that an existing article already has, so write `cover` only for the cover the author wants. Leave it out when the author gave you no cover image. |',
    `| \`cover_alt\` | with \`cover\` | One line that says what the cover image shows, at most ${COVER_ALT_MAX} characters. Write \`cover_alt\` whenever you write \`cover\`: it is the alternative text of the cover for readers who cannot see the image, and it replaces the alternative text of the cover that an existing article has. |`,
    `| \`category\` | no | The name of one category. A name that does not exist yet creates the category. When you do not know the categories of the site, leave \`category\` out (an import creates at most ${limits.newCategories} new categories). A post cannot be published without a category: a draft that has none waits until the administrator chooses one in the editor. |`,
    `| \`tags\` | no | Tag names separated by commas, at most ${limits.tags} tags of at most ${limits.tag} characters. A tag that does not exist yet is created. A hyphen in a tag is fine (\`post-mortem\`). When you do not know the tags of the site, leave \`tags\` out (an import creates at most ${limits.newTags} new tags). |`,
    `| \`series\` | only in a series | The name of the series, one line, at most ${limits.series} characters. Write \`series\`, \`series_part\` and \`series_description\` all three or none, and only when the author says the article belongs to a series. Use the exact same series name in every part. A series is applied only when an administrator imports the article; for an author the three lines are ignored and the import card only shows a note, so they are harmless. The article page draws the series navigation itself (part n of m, previous and next): never repeat it in the body, with no list of the parts and no "part 2 of the series" line. |`,
    `| \`series_part\` | with \`series\` | The number of this article in the series: digits only, 1 to ${limits.seriesPart}. It must be unique within a series and a language. The parts can be imported in any order. |`,
    `| \`series_description\` | with \`series\` | One line, at most ${limits.seriesDescription} characters, about the series as a whole. Write the same \`series_description\` line in every part, because the parts can arrive in any order. The import uses it when it creates the series, and it fills the empty description of a series that exists, from any part. It never changes a description that is not empty, and an empty line writes nothing. |`,
    '',
    'Write the front matter as plain text, not YAML: no quotes around a value (a quote would become part of the title), no `[a, b]` lists, no `- item` lines and no value that continues on the next line. A colon inside a value is fine. Every line is `key: value`, or a comment that starts with `#`. Keys are lower case and used once; a key written with capital letters is not recognised and is ignored.',
    '',
    'Do not write `status`, `featured` or `translation_of`: they are ignored. An import never publishes anything; the article arrives as a draft.',
  ].join('\n')
}

/** The generated authoring prompt, ready to be served as a Markdown download. */
export function authoringPrompt(): string {
  const specs: readonly BlockSpec[] = BLOCKS
  return [
    '# Authoring prompt: write one article as an importable package',
    '',
    'You write one blog article for a site that renders Markdown plus a fixed library of native blocks. The author gives you the topic, the audience and the source material. You return one ZIP package that the site imports as a draft and previews in the real article page before anyone publishes it. Use only the capabilities described here: anything else is rejected or shown as plain text.',
    '',
    '## Rules',
    '',
    ...AUTHORING_RULES.map((rule, index) => `${index + 1}. ${rule}`),
    '',
    '## What to return: one ZIP package',
    '',
    '```text',
    'why-two-queues.zip      named after the slug of the article',
    '  article.md            the article: front matter, then the Markdown body',
    '  assets/',
    '    figure-1.png        the images the article uses',
    '```',
    '',
    `- Exactly one Markdown file (\`.md\`, at most ${POST_IMPORT_MAX_FILE_BYTES / KIB} KiB), at the top of the package or inside the one top-level folder. Its name is free (\`article.md\` is as good as any); only the number of Markdown files matters.`,
    '- Name the ZIP file after the slug: the slug `why-two-queues` goes with `why-two-queues.zip`. The site takes the slug from the `slug` line, and from the name of the ZIP file when there is none.',
    '- Images live under `assets/` and are JPEG, PNG or WebP. SVG and every other format are rejected: export diagrams as PNG, or draw them with the `diagram` block.',
    `- At most ${POST_IMPORT_MAX_PACKAGE_ENTRIES} files in the package, ${POST_IMPORT_MAX_PACKAGE_ASSET_BYTES / MIB} MiB for one image and ${POST_IMPORT_MAX_PACKAGE_BYTES / MIB} MiB for the whole ZIP. Folder entries count toward the ${POST_IMPORT_MAX_PACKAGE_ENTRIES} entries, so use few folders.`,
    '- Name the images with lower case ASCII letters, digits, `-`, `_` and `.`, such as `figure-1.png`: no accents, no spaces, no brackets. The folder is `assets/`, in lower case. A reference must match the file name exactly, letter case included: `assets/Figure-1.png` does not find `assets/figure-1.png`. Two names that differ only in letter case are refused.',
    '- Refer to an image by its relative path from the Markdown file: `![Alt text](assets/figure-1.png)`, or the `src` of a `figure` block. No absolute paths, no `..`, no backslashes, no spaces (a space makes Markdown show the image as plain text). Do not use `/media/` paths or `http://` addresses. An `https://` image is allowed but is not packed into the site, so prefer a file in the package. The attribute tables below may allow a `/media/` path for `src`: that is for articles written in the editor, not for a package.',
    '- Every referenced image must exist in the package. An image nothing refers to is not stored; leave it out.',
    '- Put nothing else in the ZIP: no README, no second Markdown file, no text file and nothing outside `assets/` apart from the article. Every other entry is a problem.',
    '- A ZIP that holds only the article, with no `assets/` folder, is valid: add images only when the article has them. A single Markdown file without images may also be imported on its own, in the same format.',
    '',
    '## The front matter',
    '',
    'The file starts with a block of keys between two `---` lines, one `key: value` per line, then the body. A line that starts with `#` is a comment.',
    '',
    frontMatterReference(),
    '',
    '## The body',
    '',
    '- Write Markdown with headings from `##` to `####` only (the page shows the title as the main heading, and these three levels build the table of contents; do not use `#`, `#####` or `######`), paragraphs, bold and italic text, links, lists, quotes, tables, horizontal rules, strikethrough, footnotes and fenced code.',
    '- A short introductory paragraph before the first `##` is fine, and so is a notice such as "This story is fiction": rule 11 forbids a title line, a table of contents, an author section and a footer, not an opening paragraph. An `&` in text is fine.',
    '- Footnotes: write `[^1]` in the text, in a paragraph or in the body of a block, and `[^1]: The note.` on its own line at the end of the article, outside any block.',
    `- An image alone on its line becomes a figure, and the title in quotes after its path is the caption: \`![Alt text](assets/figure-1.png "Caption")\`. Use this form for an ordinary picture. Use the \`figure\` block only when you need \`variant=wide\` or an \`attribution\`, which names who made the image and is only for an image that is not the author's own. Nothing limits the alt text of a Markdown image, but say in it what the image shows and keep it short (the \`figure\` block allows ${maxLengthOf('figure', 'alt')} characters). Put the meaning of an image in its alt text and its caption, never in colour alone: a chart that you draw needs labels in the picture, or a caption that says what it shows.`,
    '- Do not rely on column alignment in tables, math, emoji codes or custom heading ids: they are not supported.',
    `- Start a fenced code block with the language. A label from this list colours the code: ${languageList()}; use these exact words. Any other label (such as \`powershell\` or \`mermaid\`), or none, shows as plain text, which is not an error: for output, logs, PowerShell or any language that is not listed, write \`text\` and say what it is in the title, for example \`title="PowerShell"\`. A \`shellsession\` fence is a terminal session: each prompt line starts with \`$ \` and the output lines follow without it. A \`diff\` fence colours the lines that start with \`+\` and \`-\`, and also takes context lines (a space first) and \`@@\` hunk header lines. Add \`title="file.py"\` after the language to show a file name, and \`highlight="2,5-7"\` to mark lines (line numbers start at 1 on the first line of the code inside the fence; ranges in ascending order, at most ${MAX_FENCE_HIGHLIGHT_ENTRIES} entries, all inside the code).`,
    '- Never write a heading inside a block: headings build the table of contents of the page, so keep them between blocks. Inside a block, a line of `---` or `===` directly under a line of text is a heading too (Markdown reads it that way): leave a blank line before a rule. A \`#\` comment line inside a code fence is not a heading, and neither are TOML section lines such as \`[rules]\` or the context lines of a diff: only a heading line outside a fence is.',
    '- Do not write HTML tags, with these exceptions, which render safely: `kbd` for keys, `sub` and `sup`, and `dl`, `dt` and `dd` for a glossary. Never use `abbr`, `mark`, `small` or `u`: the tag disappears and only its text stays, without a warning. The same tags work inside the body of a block. A glossary is one \`dl\` element that holds a \`dt\` element for each term, each followed by a \`dd\` element with its meaning, written as HTML. Scripts, styles, iframes, inline event handlers and `javascript:` links are rejected.',
    '- Write a callout only with the `callout` block. GitHub-style notes (a quote that starts with `[!NOTE]`) are not supported: they show as an ordinary quote with the literal text `[!NOTE]`. For tasks use the `checklist` block: a bare list of `- [ ]` items outside it renders as an unstyled list of disabled checkboxes.',
    '- To link to another article of the site (another part of a series, or any post), write its path as an ordinary Markdown link with the language code of that article in front: `[Part 2](/en/posts/the-slug)` for an article in English, `[Part 2](/vi/posts/the-slug)` for one in Vietnamese. Always write the code, even when you do not know which language is the default of the site: the site accepts the code for every language and sends the default language to its short address. A path without the code, such as `/posts/the-slug`, opens the article in the page frame of the default language, which is wrong for an article in another language. The slug is the one in the front matter of that article. If you do not know it, name the article in words and do not guess a path.',
    `- A \`diagram\` is Mermaid only. Start the source with the type of diagram. These types draw, each with a hint for its syntax (checked in a browser with the Mermaid library of this site): ${MERMAID_TYPES.map((type) => `\`${type.keyword}\` (${type.hint})`).join('; ')}. These draw too and are rarely needed: ${MERMAID_OTHER_TYPES.map((type) => `\`${type}\``).join(', ')}. Any other type is not supported. Keep it short and plain: no HTML in labels, no \`click\` lines, no \`%%{init}%%\` settings, no icons that are fetched from the web and no line that starts with three colons. \`alt\` is the accessible name of the drawing, so say what the diagram shows. A diagram that Mermaid cannot read is not an import error, but the page shows its source as text instead of a drawing, so stay with these forms.`,
    '',
    '## Blocks',
    '',
    'A block starts with a line of colons and its name, `:::name{attribute="value" other=value flag}`, and ends with a line of only colons. Attribute values are text; write them in double quotes when they contain spaces, and do not put a double quote inside a value: reword it. A flag is written by its name alone. A block with no body may be written on one line with two colons: `::name{...}`. Each block below has a syntax line. Brackets mean optional: leave out what you do not need and do not write the brackets. Replace every `...` with the body that the Body line of that block describes: text, Markdown, or the blocks it contains (for example `::metric` lines inside `metrics`, `event` blocks inside `timeline`). The example after the next paragraph fills four of them.',
    '',
    `A block that holds other blocks needs more colons than the blocks inside it, at every level. With the same number, the first closing line ends the outer block, so the inner block is left unclosed and the closing line you meant for the outer block is stray (the import reports unclosed-block and bad-fence), and both blocks are then drawn as plain text. The section of each block below gives the number of colons to open and to close it with; that number is enough for everything the block may hold, so you only check that every parent has more colons than its children, and no block needs more than ${Math.max(...BLOCKS.map((spec) => colonsOf(spec.type)))}. For example \`details\` (${colonsOf('details')}) around \`steps\` (${colonsOf('steps')}) around \`step\` (${colonsOf('step')}) around \`callout\` (${colonsOf('callout')}):`,
    '',
    '````markdown',
    EXAMPLE_NESTING.trimEnd(),
    '````',
    '',
    'Start every block at the left margin, on its own line, and put a blank line before and after every block that stands in the text. In a block that holds only other blocks, the children follow each other directly, with no blank line between them; in a body of text, a blank line separates the text from a block inside it. The import also reads a block that follows a line of text or another block directly, but write the blank lines, as every example here does. Never put a block inside a list item, a quote or a table, not even indented under a list item: it is an error. A block cannot hold a heading.',
    '',
    'A block that holds only blocks, images or a list is filled with exactly that. This example fills a metrics block, a gallery, a timeline and a file tree:',
    '',
    '````markdown',
    EXAMPLE_FILLING.trimEnd(),
    '````',
    '',
    'How to use the blocks well:',
    '',
    blockNotesReference(),
    '',
    'There is no block named `note`, `tip` or `warning`, and a block takes no label in square brackets. The kind of a callout is its `type` attribute and its heading is `title`: `:::callout{type=warning title="Heads up"}`. Syntax from other tools, such as `:::note` or `:::callout[Title]`, is an error.',
    '',
    'In running text, a line must not start with two or more colons unless it is a real block line, and a colon directly followed by a name and `{` or `[` (such as `:name{x}`) or by the name of a block (such as `:steps`) is read as a block that was mistyped. Put such text in backticks. Times such as 10:30, ratios and URLs are fine. A closing line of colons with nothing to close is an error too.',
    '',
    'An unknown block, an unknown or missing attribute, a value outside the allowed values, a block in the wrong place or a heading inside a block is an error that the import reports with its line number. The page then shows the content of that block as plain text, so nothing is lost, but fix every error before you return the package. Prefer plain Markdown to a block when the block adds nothing.',
    '',
    ...specs.map(blockSection),
    '## Common mistakes',
    '',
    'Each of these is reported as an error by the import. The right way is shown under the wrong one.',
    '',
    pitfallsReference(),
    '',
    '## Two examples',
    '',
    'A tutorial, the first part of a series:',
    '',
    '````markdown',
    EXAMPLE_TUTORIAL.trimEnd(),
    '````',
    '',
    'A design article:',
    '',
    '````markdown',
    EXAMPLE_ARCHITECTURE.trimEnd(),
    '````',
    '',
    '## Before you return the package',
    '',
    '- The front matter has a title and a slug, the ZIP file is named after the slug, and the body has no header, table of contents, author section or footer.',
    '- Every block is on the list above, with its required attributes and allowed values, opened and closed with its number of colons, at the left margin and not inside a list, a quote or a table, and has no heading inside it.',
    '- Every image has alternative text, exists under `assets/` with exactly the name used in the Markdown, and is JPEG, PNG or WebP.',
    '- No HTML tag other than the few named above, no CSS and no script appears anywhere.',
    '- The body does not repeat the series navigation, has no GitHub-style note quotes and no bare task list outside a checklist, and keeps the essential text outside tabs.',
    '- You return the ZIP package only.',
    '',
  ].join('\n')
}
