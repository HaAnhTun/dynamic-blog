import type { ReactNode } from 'react'
import type { BlockPropsOf, BlockType, RawBodyType } from '@/lib/blocks/registry'

/**
 * What every block component receives from the dispatcher (`./AiBlock.tsx`).
 *
 * - `props`: the attributes of the block, already checked against the registry, with the defaults applied. The type is derived from
 *   the registry entry, so `props.variant` of a callout is `'compact' | 'prominent'`, not a string.
 * - `children`: the content of the block, rendered by the same pipeline as the rest of the article (Markdown, code, images, nested blocks).
 * - `source`: only for blocks whose body is raw (diagram): the text as the author wrote it, never parsed as Markdown.
 *
 * A block is width-agnostic: it fills the article body column (`w-full min-w-0 max-w-full`), uses container queries for its inner
 * layout and never sets a fixed pixel width. The `not-prose` class goes on its root so the typography plugin leaves it alone.
 */
export type BlockComponentProps<T extends BlockType> = {
  props: BlockPropsOf<T>
  children?: ReactNode
} & (T extends RawBodyType ? { source: string } : unknown)

export type BlockComponent<T extends BlockType> = (props: BlockComponentProps<T>) => ReactNode
