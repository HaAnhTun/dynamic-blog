/**
 * The shapes of the article block registry (`./registry.ts`). Pure types, no React: the registry, the validator and the Markdown
 * pipeline all import this file, and none of them may pull a component in.
 */

/** How the value of one attribute is checked. `url` is an image source: a package-relative path, a `/media/...` path or an https URL. */
export type PropType = 'enum' | 'text' | 'url' | 'boolean' | 'integer'

export type PropValue = string | number | boolean

export interface PropSpec {
  readonly name: string
  readonly type: PropType
  readonly required?: boolean
  /** The allowed values of an `enum` attribute. */
  readonly values?: readonly string[]
  /** The longest value of a `text` or `url` attribute, in characters. Defaults to {@link DEFAULT_TEXT_MAX}. */
  readonly maxLength?: number
  /** The bounds of an `integer` attribute, both inclusive. */
  readonly min?: number
  readonly max?: number
  /**
   * Used when the author leaves the attribute out. A `boolean` attribute always defaults to `false`: the pipeline writes only the
   * `true` ones into the tree, because an absent HTML-style boolean is the one spelling that survives the HTML round trip.
   */
  readonly default?: PropValue
  /** English, one sentence; the generated documentation and the authoring prompt print it. */
  readonly description: string
}

/**
 * `container` takes a body between `:::name` and `:::`, `leaf` is the one-line form `::name{...}`, `either` accepts both (the
 * container form must then have an empty body).
 */
export type BlockForm = 'container' | 'leaf' | 'either'

/**
 * What the body of a block has to be.
 * - `none`: nothing.
 * - `markdown`: any Markdown without headings, at least one node; `markdown-optional` may be empty.
 * - `raw`: the source text is kept as written and never parsed as Markdown (`diagram`).
 * - `blocks`: only the blocks of `allowedChildren`, between `minChildren` and `maxChildren` of them.
 * - `images`: paragraphs that hold nothing but images, every image with alt text, counted by `minChildren` and `maxChildren`.
 * - `table`, `list`, `task-list`: Markdown that holds at least one GFM table, list, or list of `- [ ]` items.
 * - `code-fences`: nothing but fenced code blocks, each with a `title="..."` in its fence meta, counted by `minChildren` and `maxChildren`.
 */
export type BodyRule =
  'none' | 'markdown' | 'markdown-optional' | 'raw' | 'blocks' | 'images' | 'table' | 'list' | 'task-list' | 'code-fences'

export interface BlockSpec {
  /** The directive name, kebab-case. */
  readonly type: string
  readonly kind: BlockForm
  readonly props: readonly PropSpec[]
  /** The values of the `variant` attribute, in documentation order (empty when the block has none). */
  readonly variants: readonly string[]
  /** The block types that may stand directly inside this one. Blocks of other types are a problem. */
  readonly allowedChildren: readonly string[]
  /** Set on a block that only makes sense inside one parent (`pane` inside `compare`): it cannot stand on its own. */
  readonly parent?: string
  readonly body: BodyRule
  readonly minChildren?: number
  readonly maxChildren?: number
  /** A tighter `maxChildren` for one variant, such as two panes for `before-after`. */
  readonly maxChildrenByVariant?: Readonly<Record<string, number>>
  /** For a `blocks` body: two children may not share a title (ignoring case), because the title is the label the reader picks by (`tabs`). */
  readonly uniqueTitles?: boolean
  /** English, one or two sentences; the generated documentation and the authoring prompt print it. */
  readonly description: string
  /** English: what the component does for keyboard and screen reader users. */
  readonly a11y: string
}

export const DEFAULT_TEXT_MAX = 200

export type ProblemCode =
  | 'unknown-block'
  | 'bad-form'
  | 'unknown-attribute'
  | 'missing-attribute'
  | 'bad-attribute'
  | 'bad-nesting'
  | 'heading-in-block'
  | 'unclosed-block'
  | 'text-directive'
  | 'bad-fence'
  | 'bad-label'
  | 'bad-body'
  | 'reserved-tag'
  | 'bad-fence-title'
  | 'bad-fence-highlight'
  | 'too-deep'
  | 'too-heavy'

/** One thing wrong with the block syntax of an article: where it is (1-based line) and what to do about it. */
export interface Problem {
  readonly line: number
  readonly code: ProblemCode
  /** The block type the problem is about, when there is one. */
  readonly block?: string
  /** English, actionable: names the block and lists the supported alternatives. Never carries more than a few words of the author's text. */
  readonly message: string
}
