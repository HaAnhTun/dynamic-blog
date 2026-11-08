import type { Root } from 'mdast'
import type { Plugin } from 'unified'
import {
  closestBlockType,
  echo,
  getBlockSpec,
  parseBlockProps,
  parseFenceHighlight,
  parseFenceTitle,
  quoted,
  BLOCK_TYPES,
  MAX_FENCE_HIGHLIGHT_ENTRIES,
  MAX_FENCE_TITLE,
  TOP_LEVEL_BLOCK_TYPES,
} from './registry'
import type { BlockSpec, Problem, ProblemCode } from './types'

/**
 * The directive syntax of an article, checked against the registry and turned into the tree the renderer reads.
 *
 * `remark-directive` parses `:::name{...}` into `containerDirective`, `leafDirective` and `textDirective` nodes and leaves their
 * meaning to us. This module gives them one: a directive that is a valid block of the registry becomes an `ai-block` element (through
 * `data.hName` and `data.hProperties`, which `remark-rehype` honours); anything else becomes plain content, so a mistake never makes
 * the article lose text, and is listed as a {@link Problem} with a 1-based line and a message that says what to do.
 *
 * Two passes over the same tree, so the validator and the renderer cannot disagree: the first only looks and collects problems
 * (bottom-up facts such as "this block is valid" need the children first), the second rewrites. `validateBlocks` runs the first alone.
 */

/** A node of the Markdown tree, loosely typed: the directive types are an extension of `mdast` that this file reads field by field. */
interface MNode {
  type: string
  children?: MNode[]
  position?: { start: { line: number; offset?: number }; end: { line: number; offset?: number } }
  data?: Record<string, unknown>
  [key: string]: unknown
}

/** The longest diagram source we accept, in characters. The authoring prompt prints it. */
export const MAX_RAW_SOURCE = 20_000

/** The raw HTML tag the pipeline reserves for the blocks it generates. */
const RESERVED_TAG = /<\/?ai-block(?=[\s/>]|$)/i

interface Analysis {
  readonly spec: BlockSpec | undefined
  /** What the author wrote, valid, in the form the HTML tree carries. */
  given: Record<string, string | true>
  /** No problem of its own and, for blocks made of blocks, no invalid child. */
  valid: boolean
  /** The raw body of a `raw` block (diagram), cut from the source. */
  raw?: string
  /** Directive children, for the "all children valid" rule. */
  children: MNode[]
}

/** The block that owns the Markdown being scanned: headings found inside it are its problem. */
interface Owner {
  readonly spec: BlockSpec
  readonly headings: MNode[]
}

/** Where a node stands: at the top, directly inside a known block, inside another Markdown container (a list, a quote), or inside an unknown block. */
interface Ctx {
  readonly placement: 'root' | 'block' | 'other' | 'unknown'
  readonly parentSpec?: BlockSpec
  readonly owner?: Owner
}

const isDirective = (node: MNode) => node.type === 'containerDirective' || node.type === 'leafDirective'
const lineOf = (node: MNode) => node.position?.start.line ?? 1
const isLabel = (node: MNode) =>
  node.type === 'paragraph' && (node.data as { directiveLabel?: boolean } | undefined)?.directiveLabel === true

/** The `title` a directive was written with, trimmed; `undefined` when it has none (a missing title is reported on the child itself). */
function directiveTitle(node: MNode): string | undefined {
  const title = (node.attributes as Record<string, unknown> | null | undefined)?.title
  return typeof title === 'string' && title.trim() !== '' ? title.trim() : undefined
}

/** The sentence for a fence highlight that cannot be used. Numbers only: nothing of what the author wrote is echoed. */
function highlightMessage(problem: 'empty' | 'format' | 'order' | 'too-many'): string {
  switch (problem) {
    case 'empty':
      return 'A code fence highlight needs line numbers: write highlight="2,5-7" after the language.'
    case 'format':
      return 'A code fence highlight lists line numbers and ranges separated by commas, such as highlight="2,5-7". Use positive whole numbers.'
    case 'order':
      return 'The lines of a code fence highlight must go up and must not overlap: write highlight="2,5-7", not highlight="5-7,2".'
    case 'too-many':
      return `A code fence highlight lists at most ${MAX_FENCE_HIGHLIGHT_ENTRIES} lines or ranges.`
  }
}

/** What a Markdown node is called in a message. */
function describeNode(node: MNode): string {
  if (isDirective(node)) return `a "${String(node.name)}" block`
  switch (node.type) {
    case 'paragraph':
      return 'text'
    case 'list':
      return 'a list'
    case 'code':
      return 'a code block'
    case 'table':
      return 'a table'
    case 'heading':
      return 'a heading'
    case 'blockquote':
      return 'a quote'
    case 'thematicBreak':
      return 'a rule'
    case 'html':
      return 'HTML'
    default:
      return 'other content'
  }
}

function lineStarts(source: string): number[] {
  const starts = [0]
  for (const match of source.matchAll(/\r\n|\r|\n/g)) starts.push(match.index + match[0].length)
  return starts
}

/**
 * Runs the first pass (and, with `transform`, the second) over a parsed tree. Returns the problems, sorted by line.
 * `source` is the text the tree was parsed from: positions are offsets into it. `directives: false` says the tree was parsed WITHOUT the
 * directive syntax (the article nests too deeply, `./nesting.ts`): every line that starts with colons is then text, and the
 * one problem the caller reports explains them all, so they are not listed one by one.
 */
export function processBlocks(tree: Root, source: string, options: { transform: boolean; directives?: boolean }): Problem[] {
  const root = tree as unknown as MNode
  const starts = lineStarts(source)
  const problems: Problem[] = []
  const analysis = new Map<MNode, Analysis>()
  const reservedHtml = new Set<MNode>()
  const fenceTitles = new Map<MNode, string>()
  const fenceHighlights = new Map<MNode, string>()

  const add = (code: ProblemCode, line: number, message: string, block?: string) => {
    problems.push(block === undefined ? { line, code, message } : { line, code, block, message })
  }

  const lineText = (line: number) => source.slice(starts[line - 1] ?? 0, starts[line] ?? source.length).replace(/\r\n|\r|\n$/, '')

  /** How many colons the opening line of a container directive has. */
  const openingColons = (node: MNode) => /^\s*(:{3,})/.exec(lineText(lineOf(node)))?.[1]?.length ?? 3

  /**
   * A container is closed when its last line is a fence of at least as many colons as it opened with. Measured on the end position:
   * a container that the parent's fence closed ends at the start of that line (nothing on it), one that runs to the end of the
   * document ends on its last content line.
   */
  const isClosed = (node: MNode) => {
    const end = node.position?.end
    if (!end || end.offset === undefined) return false
    const text = source.slice(starts[end.line - 1] ?? 0, end.offset)
    const fence = /^\s{0,3}(:{3,})\s*$/.exec(text)
    return fence !== null && fence[1]!.length >= openingColons(node)
  }

  /** The body of a raw block as written: the lines between its opening line and its closing fence, outer blank lines trimmed. */
  const rawBody = (node: MNode) => {
    const first = lineOf(node)
    const last = node.position?.end.line ?? first
    return source
      .slice(starts[first] ?? source.length, starts[last - 1] ?? source.length)
      .replace(/\r\n|\r/g, '\n')
      .replace(/^\n+|\n+$/g, '')
  }

  function unknownBlockMessage(name: string): string {
    const nested = BLOCK_TYPES.filter((type) => getBlockSpec(type)?.parent)
    const places = nested.map((type) => `"${type}" inside "${getBlockSpec(type)!.parent}"`)
    const nestedNote = places.length > 1 ? `${places.slice(0, -1).join(', ')} and ${places[places.length - 1]}` : places.join('')
    const suggestion = closestBlockType(name)
    return (
      `Unknown block "${echo(name, 40)}". Supported blocks: ${quoted(TOP_LEVEL_BLOCK_TYPES)}, and ${nestedNote}.` +
      (suggestion ? ` Did you mean "${suggestion}"?` : '') +
      ' To write the text literally, escape the first colon with a backslash.'
    )
  }

  function checkBody(spec: BlockSpec, kids: MNode[], variant: unknown): { line: number; message: string }[] {
    const out: { line: number; message: string }[] = []
    const at = (node: MNode | undefined, message: string) => out.push({ line: node ? lineOf(node) : 0, message })
    const t = spec.type
    const min = spec.minChildren ?? 0
    const max = spec.maxChildren ?? Number.POSITIVE_INFINITY
    switch (spec.body) {
      case 'none':
        if (kids.length > 0) at(kids[0], `Block "${t}" takes no body: write it on one line as ::${t}{...}.`)
        break
      case 'markdown':
        if (kids.length === 0)
          at(undefined, `Block "${t}" has no content: put the Markdown between its opening line and the closing fence.`)
        break
      case 'markdown-optional':
      case 'raw':
        break
      case 'blocks': {
        const allowed = spec.allowedChildren
        const titles = new Set<string>()
        let count = 0
        for (const kid of kids) {
          if (isDirective(kid) && allowed.includes(String(kid.name))) {
            count += 1
            const title = spec.uniqueTitles ? directiveTitle(kid) : undefined
            if (title === undefined) continue
            if (titles.has(title.toLowerCase())) {
              at(
                kid,
                `Two "${String(kid.name)}" blocks inside "${t}" are both titled "${echo(title, 40)}": give each one its own title.`,
              )
            } else {
              titles.add(title.toLowerCase())
            }
          } else {
            at(kid, `Only ${quoted(allowed)} blocks may stand directly inside "${t}" (found ${describeNode(kid)}).`)
          }
        }
        const limit = Math.min(max, spec.maxChildrenByVariant?.[String(variant)] ?? max)
        if (count < min)
          at(undefined, `Block "${t}" needs at least ${min} ${quoted(allowed)} block${min === 1 ? '' : 's'} (found ${count}).`)
        if (count > limit)
          at(
            undefined,
            `Block "${t}" takes at most ${limit} ${quoted(allowed)} blocks${variant ? ` with variant "${String(variant)}"` : ''} (found ${count}).`,
          )
        break
      }
      case 'images': {
        let count = 0
        let offending = false
        for (const kid of kids) {
          const images = kid.type === 'paragraph' ? (kid.children ?? []) : []
          const onlyImages =
            kid.type === 'paragraph' &&
            images.length > 0 &&
            images.every(
              (child) =>
                child.type === 'image' || child.type === 'break' || (child.type === 'text' && String(child.value).trim() === ''),
            )
          if (!onlyImages) {
            offending = true
            at(
              kid,
              `The body of "${t}" is Markdown images only, such as ![alt text](assets/name.png) (found ${describeNode(kid)}).`,
            )
            continue
          }
          for (const image of images.filter((child) => child.type === 'image')) {
            count += 1
            if (String(image.alt ?? '').trim() === '')
              at(image, `Every image in "${t}" needs alternative text: ![what it shows](path).`)
          }
        }
        if (count < min && !offending) at(undefined, `Block "${t}" needs at least ${min} images (found ${count}).`)
        if (count > max) at(undefined, `Block "${t}" takes at most ${max} images (found ${count}).`)
        break
      }
      case 'table':
        if (!kids.some((kid) => kid.type === 'table'))
          at(undefined, `Block "${t}" needs a Markdown table in its body (| a | b | rows with a | --- | --- | line).`)
        break
      case 'list':
        if (!kids.some((kid) => kid.type === 'list'))
          at(undefined, `Block "${t}" needs a Markdown list in its body (lines starting with - or 1.).`)
        break
      case 'task-list': {
        const lists = kids.filter((kid) => kid.type === 'list')
        if (lists.length === 0)
          at(undefined, `Block "${t}" needs a task list in its body (lines such as "- [ ] item" and "- [x] item").`)
        for (const list of lists) {
          if ((list.children ?? []).some((item) => typeof item.checked !== 'boolean')) {
            at(list, `Every item of the list in "${t}" must be a task: "- [ ] item" or "- [x] item".`)
          }
        }
        break
      }
      case 'code-fences': {
        const titles = new Set<string>()
        let count = 0
        let offending = false
        for (const kid of kids) {
          if (kid.type !== 'code') {
            offending = true
            at(kid, `The body of "${t}" is fenced code blocks only (found ${describeNode(kid)}).`)
            continue
          }
          count += 1
          const title = parseFenceTitle(kid.meta as string | null | undefined).title
          if (!title) {
            at(kid, `Every code block in "${t}" needs a tab label: \`\`\`lang title="Label".`)
          } else if (titles.has(title.toLowerCase())) {
            at(kid, `Two tabs of "${t}" are both labelled "${echo(title, 40)}": give each code block its own title.`)
          } else {
            titles.add(title.toLowerCase())
          }
        }
        if (count < min && !offending)
          at(
            undefined,
            `Block "${t}" needs at least ${min} code blocks (found ${count}); for one code block use a plain fence with title="...".`,
          )
        if (count > max) at(undefined, `Block "${t}" takes at most ${max} code blocks (found ${count}).`)
        break
      }
    }
    return out
  }

  function scanChildren(parent: MNode, ctx: Ctx) {
    for (const child of parent.children ?? []) scanNode(child, ctx)
  }

  function scanNode(node: MNode, ctx: Ctx) {
    switch (node.type) {
      case 'containerDirective':
      case 'leafDirective':
        scanBlock(node, ctx)
        return
      case 'textDirective':
        scanTextDirective(node)
        return
      case 'heading':
        ctx.owner?.headings.push(node)
        break
      case 'paragraph':
        if (options.directives !== false) scanFenceLines(node)
        break
      case 'html':
        if (RESERVED_TAG.test(String(node.value))) {
          reservedHtml.add(node)
          // One problem per line: an inline element and its closing tag are two nodes.
          if (problems.some((problem) => problem.code === 'reserved-tag' && problem.line === lineOf(node))) return
          add(
            'reserved-tag',
            lineOf(node),
            'The <ai-block> tag is reserved for the renderer. Write blocks with the ::: syntax, for example :::callout{type="note"} ... :::.',
          )
        }
        return
      case 'code': {
        const { title, problem } = parseFenceTitle(node.meta as string | null | undefined)
        if (title) fenceTitles.set(node, title)
        if (problem === 'too-long')
          add('bad-fence-title', lineOf(node), `A code fence title is longer than ${MAX_FENCE_TITLE} characters.`)
        if (problem === 'control') add('bad-fence-title', lineOf(node), 'A code fence title must not contain control characters.')
        scanFenceHighlight(node)
        return
      }
    }
    if (node.children) scanChildren(node, { ...ctx, placement: 'other' })
  }

  /**
   * The `highlight="2,5-7"` of a fence: kept for the page when it is usable, otherwise a problem and the fence is drawn without it. A
   * highlight written where the language belongs would be read as the language, so that is named too; and a highlight must not name a
   * line the code does not have.
   */
  function scanFenceHighlight(node: MNode) {
    if (/^highlight=/.test(String(node.lang ?? ''))) {
      add(
        'bad-fence-highlight',
        lineOf(node),
        'A highlight comes after the language: write the language first, for example ```yaml highlight="2".',
      )
      return
    }
    const found = parseFenceHighlight(node.meta as string | null | undefined)
    if (found.problem) {
      add('bad-fence-highlight', lineOf(node), highlightMessage(found.problem))
      return
    }
    const last = found.ranges?.[found.ranges.length - 1]?.[1]
    if (found.highlight === undefined || last === undefined) return
    const lines = String(node.value ?? '').split(/\r\n|\r|\n/).length
    if (last > lines) {
      add(
        'bad-fence-highlight',
        lineOf(node),
        `The highlight names line ${last}, but the code block has ${lines} ${lines === 1 ? 'line' : 'lines'}.`,
      )
      return
    }
    fenceHighlights.set(node, found.highlight)
  }

  /**
   * A line of ordinary text that starts with two or more colons is a block line the parser did not accept: an opening with a
   * broken attribute list (a missing quote or brace), a closing line with nothing to close, or a stray `::`. Left alone it would
   * show up as literal colons in the article and no one would be told.
   */
  function scanFenceLines(node: MNode) {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start === undefined || end === undefined) return
    source
      .slice(start, end)
      .split(/\r\n|\r|\n/)
      .forEach((text, index) => {
        if (!/^\s{0,3}:{2,}/.test(text)) return
        add(
          'bad-fence',
          lineOf(node) + index,
          'This line starts with colons but is not a valid block line. A block opens with :::name{attributes} (check the quotes and the closing brace), ' +
            'one-line blocks are written ::name{attributes}, and a block closes with a line of only colons that matches an opening. ' +
            'An extra closing line is a mistake too. To write the colons literally, escape the first one with a backslash.',
        )
      })
  }

  /**
   * `:name` inside a line of text is a text directive to the parser. Most of them are prose ("10:30", "Note:this", an emoji code),
   * and those are given back as the text they were without a word. One that carries attributes or a label, or that is named like a
   * block, looks like a block somebody mistyped, so it is a problem.
   */
  function scanTextDirective(node: MNode) {
    const name = String(node.name)
    const attributes = Object.keys((node.attributes as Record<string, unknown> | null | undefined) ?? {})
    if (!getBlockSpec(name) && attributes.length === 0 && (node.children ?? []).length === 0) return
    const isBlock = getBlockSpec(name) !== undefined
    add(
      'text-directive',
      lineOf(node),
      isBlock
        ? `":${name}" inside a line of text looks like the "${name}" block. A block starts its own line with three colons: :::${name}{...} ... :::. To write the text literally, escape the colon with a backslash.`
        : `":${echo(name, 40)}" followed by attributes or a label is not supported inside text. To write it literally, escape the colon with a backslash.`,
      isBlock ? name : undefined,
    )
  }

  function scanBlock(node: MNode, ctx: Ctx) {
    const name = String(node.name)
    const spec = getBlockSpec(name)
    const line = lineOf(node)
    const state: Analysis = { spec, given: {}, valid: false, children: [] }
    analysis.set(node, state)

    if (!spec) {
      add('unknown-block', line, unknownBlockMessage(name), echo(name, 40))
      scanChildren(node, { placement: 'unknown', owner: ctx.owner })
      return
    }

    let own = 0
    const flag = (code: ProblemCode, message: string, at = line) => {
      own += 1
      add(code, at, message, spec.type)
    }
    const isContainer = node.type === 'containerDirective'

    // The form: container or one-line leaf.
    let formOk = true
    if (spec.kind === 'container' && !isContainer) {
      formOk = false
      flag(
        'bad-form',
        `"${spec.type}" holds content: open it with :::${spec.type}{...}, put the content below and close it with :::.`,
      )
    } else if (spec.kind === 'leaf' && isContainer) {
      formOk = false
      flag('bad-form', `"${spec.type}" has no body: write it on one line as ::${spec.type}{...}.`)
    }

    // A label in square brackets is not part of the syntax.
    const kids = (node.children ?? []).filter((child) => !isLabel(child))
    const hasLabel = isContainer ? (node.children ?? []).some(isLabel) : (node.children ?? []).length > 0
    if (hasLabel) {
      const names = spec.props.map((prop) => prop.name)
      flag(
        'bad-label',
        `Labels in square brackets are not supported on "${spec.type}"${names.length > 0 ? `: use its attributes (${quoted(names)})` : ''}.`,
      )
    }

    // Where the block stands.
    if (ctx.placement === 'root') {
      if (spec.parent) flag('bad-nesting', `Block "${spec.type}" only belongs directly inside "${spec.parent}".`)
    } else if (ctx.placement === 'other') {
      flag(
        'bad-nesting',
        `Block "${spec.type}" cannot be placed inside a list, a quote or a table. Put it at the top level of the article, or directly inside a block that allows it.`,
      )
    } else if (ctx.placement === 'block' && ctx.parentSpec && !ctx.parentSpec.allowedChildren.includes(spec.type)) {
      const parent = ctx.parentSpec
      const allowed =
        parent.allowedChildren.length > 0
          ? `Blocks allowed inside "${parent.type}": ${quoted(parent.allowedChildren)}.`
          : `"${parent.type}" holds Markdown only, no other blocks.`
      flag(
        'bad-nesting',
        `Block "${spec.type}" cannot be placed inside "${parent.type}". ${allowed}${spec.parent ? ` "${spec.type}" belongs directly inside "${spec.parent}".` : ''}`,
      )
    }

    // Closed.
    // Inside a list or a quote the closing line carries the quote or indent prefix: the nesting problem is the one to fix first.
    if (isContainer && ctx.placement !== 'other' && !isClosed(node)) {
      const colons = ':'.repeat(openingColons(node))
      flag(
        'unclosed-block',
        `Block "${spec.type}" is never closed: add a line with only ${colons} after its content. A block that holds other blocks uses more colons than the blocks inside it, for example :::::steps around ::::step around :::callout.`,
      )
    }

    // Attributes.
    const parsed = parseBlockProps(spec, (node.attributes as Record<string, unknown> | null | undefined) ?? {})
    for (const issue of parsed.issues) flag(issue.code, issue.message)
    state.given = parsed.given

    // Body.
    if (spec.body === 'raw') {
      const raw = rawBody(node)
      if (raw.trim() === '')
        flag('bad-body', `Block "${spec.type}" has no source: put it between the opening line and the closing fence.`)
      else if (raw.length > MAX_RAW_SOURCE)
        flag('bad-body', `The source of "${spec.type}" is longer than ${MAX_RAW_SOURCE} characters; split the diagram.`)
      else if (/^\s*(```|~~~)/.test(raw))
        // rawBody trims leading blank lines, so the start of `raw` is the first non-blank line. A fence later in the body
        // (say inside a Mermaid comment) is part of the source and is not looked at.
        flag(
          'bad-body',
          `Write the source of "${spec.type}" directly between the :::${spec.type} line and the closing fence, without a code fence.`,
        )
      state.raw = raw
    } else {
      if (formOk) {
        for (const problem of checkBody(spec, kids, parsed.props.variant)) flag('bad-body', problem.message, problem.line || line)
      }
      const owner: Owner = { spec, headings: [] }
      scanChildren({ type: 'x', children: kids }, { placement: 'block', parentSpec: spec, owner })
      for (const heading of owner.headings) {
        flag(
          'heading-in-block',
          `Headings are not allowed inside the "${spec.type}" block: use bold text, or move the heading outside the block.`,
          lineOf(heading),
        )
      }
    }

    state.children = kids.filter(isDirective)
    state.valid = own === 0 && (spec.body !== 'blocks' || state.children.every((child) => analysis.get(child)?.valid === true))
  }

  scanChildren(root, { placement: 'root' })

  if (options.transform) transform(root)

  return problems.sort((a, b) => a.line - b.line)

  // ------------------------------------------------------------------------------------------------------------------
  // Second pass: the rewrite.

  function sliceOf(node: MNode): string {
    return source.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0)
  }

  /** Adjacent text nodes become one, so giving a text directive back as text leaves the paragraph exactly as it was. */
  function mergeText(nodes: MNode[]): MNode[] {
    const out: MNode[] = []
    for (const node of nodes) {
      const last = out[out.length - 1]
      if (last && last.type === 'text' && node.type === 'text' && !last.data && !node.data) {
        out[out.length - 1] = { ...last, value: String(last.value) + String(node.value), position: undefined }
      } else {
        out.push(node)
      }
    }
    return out
  }

  function emitAll(nodes: MNode[], renderedParent: BlockSpec | undefined): MNode[] {
    return mergeText(nodes.flatMap((node) => emit(node, renderedParent)))
  }

  function emit(node: MNode, renderedParent: BlockSpec | undefined): MNode[] {
    switch (node.type) {
      case 'containerDirective':
      case 'leafDirective': {
        const state = analysis.get(node)
        const spec = state?.spec
        if (state && spec && state.valid && (!spec.parent || renderedParent?.type === spec.parent)) {
          node.data = { ...node.data, hName: 'ai-block', hProperties: { block: spec.type, ...state.given } }
          if (spec.body === 'raw') {
            // `hChildren`, not a text child: the Markdown-to-HTML step trims the spaces around every line of a text node, and the
            // indentation of a diagram is part of its source.
            node.children = []
            node.data.hChildren = [{ type: 'text', value: state.raw ?? '' }]
          } else {
            node.children = emitAll(
              (node.children ?? []).filter((child) => !isLabel(child)),
              spec,
            )
          }
          return [node]
        }
        // Not a block we can draw: its content stays, the markers go.
        if (node.type === 'leafDirective') return [{ type: 'paragraph', children: [{ type: 'text', value: sliceOf(node) }] }]
        return emitAll(node.children ?? [], renderedParent)
      }
      case 'textDirective':
        return [{ type: 'text', value: sliceOf(node) }]
      case 'html':
        return reservedHtml.has(node) ? [{ type: 'text', value: String(node.value) }] : [node]
      case 'code': {
        const title = fenceTitles.get(node)
        const highlight = fenceHighlights.get(node)
        if (title || highlight) {
          const previous = (node.data?.hProperties ?? {}) as Record<string, unknown>
          node.data = {
            ...node.data,
            hProperties: {
              ...previous,
              ...(title ? { dataTitle: title } : {}),
              ...(highlight ? { dataHighlight: highlight } : {}),
            },
          }
        }
        return [node]
      }
      default:
        if (node.children) node.children = emitAll(node.children, renderedParent)
        return [node]
    }
  }

  function transform(top: MNode) {
    top.children = emitAll(top.children ?? [], undefined)
  }
}

export interface BlocksOptions {
  /** The text the tree was parsed from. Without it the plugin reads the file it is given, which `processor.run(tree)` leaves empty. */
  source?: string
  /** Receives the problems found, in line order. */
  problems?: Problem[]
  /** `false` when the tree was parsed without the directive syntax; see {@link processBlocks}. */
  directives?: boolean
}

/**
 * The remark plugin: must run after `remark-directive` (and `remark-gfm`) and before `remark-rehype`. Valid blocks leave it as
 * `containerDirective` or `leafDirective` nodes carrying `hName: 'ai-block'`; everything else leaves as ordinary Markdown nodes.
 */
export const remarkBlocks: Plugin<[BlocksOptions?], Root> = function remarkBlocks(options = {}) {
  return (tree, file) => {
    const found = processBlocks(tree, options.source ?? String(file.value ?? ''), {
      transform: true,
      directives: options.directives,
    })
    // Sorted again: the caller may have put a problem of its own in first (`./nesting.ts` is found before the parse).
    options.problems?.push(...found)
    options.problems?.sort((a, b) => a.line - b.line)
  }
}
