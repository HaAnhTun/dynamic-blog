import { Children, type ReactNode } from 'react'
import { getBlockSpec, parseBlockProps, type BlockType } from '@/lib/blocks/registry'
import type { BlockSpec, PropValue } from '@/lib/blocks/types'
import { imageFor, type PreviewImages } from '@/lib/preview-images'
import { BLOCK_COMPONENTS } from './index'
import type { BlockComponentProps } from './types'

/** The text of a node that the pipeline made a single string (the raw source of a diagram). */
function textOf(children: ReactNode): string {
  return Children.toArray(children)
    .filter((child): child is string | number => typeof child === 'string' || typeof child === 'number')
    .join('')
}

/**
 * The renderer of the `ai-block` element: `lib/markdown.tsx` hands this tag to `toJsxRuntime` (`components['ai-block']`), so the
 * public page, the admin preview and the editor preview all draw blocks here.
 *
 * It checks the attributes against the registry again instead of trusting the tree. The pipeline emits only valid blocks, but a
 * raw `<ai-block>` typed into the Markdown passes the sanitize schema as well (the tag has to be allowed for the pipeline's own
 * blocks), so this is where it is held to the same rules as a directive. A block that does not pass is drawn as its plain content:
 * what the author wrote stays on the page and nothing about the block is made up.
 *
 * `images` is only given by the preview of the import page (`renderMarkdown` with an `imageSource`), never by the tree: it maps the
 * image paths of a ZIP package to data URLs. It is applied AFTER the attributes were checked as the author wrote them, so a `data:`
 * URL typed in the Markdown is still refused and only the preview's own mapping can put one in front of the component.
 *
 * A server component, no hooks: block components that need a browser (tabs, diagrams) are client islands imported by their own file.
 */
export function AiBlock({
  children,
  images,
  ...attributes
}: Record<string, unknown> & { children?: ReactNode; images?: PreviewImages }) {
  const type = typeof attributes.block === 'string' ? attributes.block : ''
  const spec = getBlockSpec(type)
  if (!spec) return <>{children}</>

  const parsed = parseBlockProps(spec, attributes, { ignoreUnknown: true })
  if (parsed.issues.length > 0) return <>{children}</>

  const Component = BLOCK_COMPONENTS[spec.type as BlockType] as (
    props: BlockComponentProps<BlockType> & { source?: string },
  ) => ReactNode
  const props = (
    images instanceof Map ? withPreviewImages(spec, parsed.props, images) : parsed.props
  ) as BlockComponentProps<BlockType>['props']
  return spec.body === 'raw' ? (
    <Component props={props} source={textOf(children)} />
  ) : (
    <Component props={props}>{children}</Component>
  )
}

/** The same props with every image source that names an image of the package replaced by its data URL. */
function withPreviewImages(spec: BlockSpec, props: Record<string, PropValue>, images: PreviewImages): Record<string, PropValue> {
  const mapped = { ...props }
  for (const prop of spec.props) {
    const value = mapped[prop.name]
    if (prop.type !== 'url' || typeof value !== 'string') continue
    mapped[prop.name] = imageFor(images, value) ?? value
  }
  return mapped
}
