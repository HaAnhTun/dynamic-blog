import type { Element, ElementContent, Root, Text } from 'hast'
import { toString } from 'hast-util-to-string'
import { visit } from 'unist-util-visit'
import { getBlockSpec, parseBlockProps, parseHighlightValue } from './registry'
import type { BlockSpec, PropValue } from './types'

/**
 * The steps of the Markdown pipeline that work on the HTML tree and know about blocks. Pure hast, no React: the page, the admin
 * preview and the feed run the same ones (`lib/markdown.tsx` lists them in order).
 */

/** The element the pipeline emits for a block, and the only block-related tag the sanitize schema lets through. */
export const AI_BLOCK_TAG = 'ai-block'

/** The property that carries the block type on the element. It is not `type`, because `callout` and `diagram` have an attribute of that name. */
export const BLOCK_PROPERTY = 'block'

/** The spec and the validated attributes of an `ai-block` element, or `undefined` when it is not a block we can draw. */
export function readBlock(node: Element): { spec: BlockSpec; props: Record<string, PropValue> } | undefined {
  const type = node.properties[BLOCK_PROPERTY]
  const spec = typeof type === 'string' ? getBlockSpec(type) : undefined
  if (!spec) return undefined
  const parsed = parseBlockProps(spec, node.properties, { ignoreUnknown: true })
  return parsed.issues.length === 0 ? { spec, props: parsed.props } : undefined
}

/**
 * Runs after sanitize, on a tree that is already clean. Gives the blocks that need it the children the component expects, built
 * from their validated attributes rather than from whatever the HTML carried: a figure gets one `img`, so the image rules that run
 * next (`#WxH` hints, lazy loading, the size of a local SVG) apply to it like to any Markdown image; a raw block (diagram) gets its
 * source as one text node, and a block made of blocks (steps, compare) gets its child blocks and no whitespace between them. Blocks whose attributes do not pass are left alone and drawn as plain content by the dispatcher.
 */
export function finishBlocks() {
  return (tree: Root) => {
    visit(tree, 'element', (node) => {
      if (node.tagName !== AI_BLOCK_TAG) return
      const block = readBlock(node)
      if (!block) return
      if (block.spec.type === 'figure') {
        node.children = [
          {
            type: 'element',
            tagName: 'img',
            properties: { src: String(block.props.src), alt: String(block.props.alt) },
            children: [],
          },
        ]
      } else if (block.spec.body === 'raw') {
        node.children = [{ type: 'text', value: toString(node) }]
      } else if (block.spec.body === 'blocks') {
        // The newlines the Markdown step puts between the child blocks are not content: a list or a grid of panes gets elements only.
        node.children = node.children.filter((child) => child.type === 'element')
      }
    })
  }
}

/**
 * Hands the meta of a fence (`title="file.py"`, `highlight="2,5-7"` in the Markdown fence) from the `code` element, where the pipeline
 * puts it, to the `pre`. Shiki replaces the whole `pre`, so the values travel on the `pre` the highlighter reads them from
 * (`parseMetaString` in `lib/markdown.tsx` takes them off it), and the `meta` of the `code` element only has to be there, because the
 * highlighter calls `parseMetaString` for a fence that has any. A transformer writes the title on the new `pre` and marks the highlighted
 * lines; a `pre` that Shiki leaves alone, a fence without a language, keeps the title directly. A highlight that does not pass
 * `parseHighlightValue` (raw HTML can carry anything) is dropped. Runs after sanitize and before Shiki, and only on the page.
 */
export function carryCodeMeta() {
  return (tree: Root) => {
    visit(tree, 'element', (pre) => {
      if (pre.tagName !== 'pre') return
      const code = pre.children[0]
      if (code?.type !== 'element' || code.tagName !== 'code') return
      const title = code.properties.dataTitle
      const written = code.properties.dataHighlight
      const highlight = typeof written === 'string' ? parseHighlightValue(written).highlight : undefined
      const hasTitle = typeof title === 'string' && title !== ''
      if (hasTitle) {
        pre.properties.dataTitle = title
        delete code.properties.dataTitle
      }
      if (highlight !== undefined) pre.properties.dataHighlight = highlight
      if (typeof written === 'string') delete code.properties.dataHighlight
      const meta = hasTitle ? title : highlight
      if (meta !== undefined) code.data = { ...code.data, meta }
    })
  }
}

/** The name the step had before the highlight travelled with the title. */
export const carryCodeTitle = carryCodeMeta

const text = (value: string): Text => ({ type: 'text', value })
const el = (tagName: string, properties: Element['properties'], children: ElementContent[]): Element => ({
  type: 'element',
  tagName,
  properties,
  children,
})
const strongLine = (title: string) => el('p', {}, [el('strong', {}, [text(title)])])
const emLine = (caption: string) => el('p', {}, [el('em', {}, [text(caption)])])
const str = (value: PropValue | undefined) => (typeof value === 'string' && value !== '' ? value : undefined)

/** One block as plain HTML that any feed reader draws: the content is kept, the presentation is dropped. */
function plainBlock(node: Element, spec: BlockSpec, props: Record<string, PropValue>): ElementContent[] {
  const title = str(props.title)
  const caption = str(props.caption)
  const head = title ? [strongLine(title)] : []
  const tail = caption ? [emLine(caption)] : []
  switch (spec.type) {
    case 'callout': {
      // The kind is the capitalised type word: the feed has no catalog, and a reader must tell a danger from a tip without color or icon.
      const kind = str(props.type) ?? 'info'
      return [el('blockquote', {}, [strongLine(kind.charAt(0).toUpperCase() + kind.slice(1)), ...head, ...node.children])]
    }
    case 'figure': {
      const credit = [caption, str(props.attribution)].filter(Boolean).join(' — ')
      return [el('figure', {}, [...node.children, ...(credit ? [el('figcaption', {}, [text(credit)])] : [])])]
    }
    case 'diagram': {
      const code = el('code', { className: ['language-mermaid'] }, [text(toString(node))])
      return [...head, el('pre', {}, [code]), ...tail]
    }
    case 'steps': {
      const items = node.children.filter((child) => child.type === 'element' && child.tagName === 'li')
      const rest = node.children.filter((child) => !items.includes(child))
      return [...head, el('ol', {}, items), ...rest]
    }
    case 'step':
      return [el('li', {}, [strongLine(title ?? ''), ...node.children])]
    case 'pane':
    case 'tab':
      return [el('section', {}, [strongLine(title ?? ''), ...node.children])]
    case 'file-tree':
      // The nested list is the tree: a feed reader shows it as an indented list, and the trailing slash of a folder is in the text.
      return [...head, ...node.children]
    case 'timeline': {
      const items = node.children.filter((child) => child.type === 'element' && child.tagName === 'li')
      return [...head, el('ol', {}, items), ...node.children.filter((child) => !items.includes(child))]
    }
    case 'event': {
      const when = str(props.when)
      return [el('li', {}, [strongLine(when ? `${when} - ${title ?? ''}` : (title ?? '')), ...node.children])]
    }
    case 'metrics': {
      const items = node.children.filter((child) => child.type === 'element' && child.tagName === 'li')
      return [...head, el('ul', {}, items), ...node.children.filter((child) => !items.includes(child)), ...tail]
    }
    case 'metric': {
      const trend = str(props.trend)
      const note = str(props.note)
      return [
        el('li', {}, [
          el('strong', {}, [text(`${str(props.label) ?? ''}:`)]),
          text(` ${str(props.value) ?? ''}${trend ? ` (${trend})` : ''}${note ? ` - ${note}` : ''}`),
        ]),
      ]
    }
    case 'details':
      return [
        el('details', props.open === true ? { open: true } : {}, [el('summary', {}, [text(title ?? '')]), ...node.children]),
      ]
    case 'pullquote': {
      const attribution = str(props.attribution)
      return [el('blockquote', {}, [...node.children, ...(attribution ? [el('p', {}, [text(`— ${attribution}`)])] : [])])]
    }
    default:
      // compare, comparison, gallery, code-tabs, takeaways, checklist, tabs: their content in order, with the title and caption around it.
      return [...head, ...node.children, ...tail]
  }
}

/**
 * The feed's replacement of blocks: every `ai-block` becomes plain HTML (callout to blockquote that starts with its kind, figure to figure and img, details to
 * details, diagram to `pre code.language-mermaid`, steps to ol, compare to a sequence of sections, comparison to its table, code tabs
 * to titled code blocks, file tree to its list, timeline to an ordered list, metrics to a list, tab to a section like a pane). A fence title becomes a bold line above its code block, a line highlight is dropped. Runs after sanitize and `finishBlocks`.
 */
export function blocksToPlainHtml() {
  function rewrite(parent: Root | Element, inChecklist = false) {
    const out: ElementContent[] = []
    for (const child of parent.children as ElementContent[]) {
      if (child.type !== 'element') {
        out.push(child)
        continue
      }
      rewrite(child, inChecklist || (child.tagName === AI_BLOCK_TAG && readBlock(child)?.spec.type === 'checklist'))
      // A checkbox of a checklist block (`<input type="checkbox" checked disabled>`) becomes its state as text: many feed readers strip
      // form controls, and done against not done must survive. Only a checklist block: the task list of an ordinary post is left as it
      // was before blocks existed (the golden document test pins it).
      if (inChecklist && child.tagName === 'input' && child.properties.type === 'checkbox') {
        out.push(text(child.properties.checked ? '[x]' : '[ ]'))
        continue
      }
      if (child.tagName === AI_BLOCK_TAG) {
        const block = readBlock(child)
        out.push(...(block ? plainBlock(child, block.spec, block.props) : child.children))
        continue
      }
      const code = child.tagName === 'pre' ? child.children[0] : undefined
      const title = child.properties.dataTitle ?? (code?.type === 'element' ? code.properties.dataTitle : undefined)
      if (child.tagName === 'pre' && typeof title === 'string' && title !== '') {
        delete child.properties.dataTitle
        if (code?.type === 'element') delete code.properties.dataTitle
        out.push(strongLine(title))
      }
      // Highlighted lines are presentation: a feed shows the code as it is.
      if (child.tagName === 'pre') {
        delete child.properties.dataHighlight
        if (code?.type === 'element') delete code.properties.dataHighlight
      }
      out.push(child)
    }
    parent.children = out as typeof parent.children
  }
  return (tree: Root) => rewrite(tree)
}
