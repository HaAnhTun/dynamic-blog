import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import type { BlockComponentProps } from './types'

type Picture = { image: ReactElement; caption?: ReactNode }

/**
 * The images of the body, in order. The pipeline hands over Markdown as it renders it: a line with one image is a `figure` (with a
 * `figcaption` when the image has a title), lines that follow each other share a `p`, and the validated body holds nothing else.
 * Reading the tree instead of the source keeps every image rule of the pipeline (size hint, lazy loading, the title as caption).
 */
function pictures(nodes: ReactNode): Picture[] {
  const found: Picture[] = []
  for (const node of Children.toArray(nodes)) {
    if (!isValidElement<{ children?: ReactNode }>(node)) continue
    if (node.type === 'img') {
      // Lines that follow each other share a paragraph, so the pipeline did not make a figure of this image. Its title becomes the
      // caption here, as it does for a lone image, and leaves the image: a title attribute is a tooltip a keyboard cannot reach.
      const title = (node.props as { title?: unknown }).title
      found.push(
        typeof title === 'string' && title.trim() !== ''
          ? { image: cloneElement(node, { title: undefined } as object), caption: title.trim() }
          : { image: node },
      )
    } else if (node.type === 'figure') {
      const parts = Children.toArray(node.props.children).filter(isValidElement<{ children?: ReactNode }>)
      const image = parts.find((part) => part.type === 'img')
      const caption = parts.find((part) => part.type === 'figcaption')
      if (image) found.push({ image, caption: caption?.props.children })
    } else {
      found.push(...pictures(node.props.children))
    }
  }
  return found
}

/**
 * Two or three images side by side, one column when the article is narrow. The columns follow the width of the block itself
 * (container queries), not the window, so the same gallery fits a wide article and a narrow one. Every image keeps its own
 * alternative text; there is no lightbox, so nothing traps focus. Items are a list, so a screen reader announces the count.
 */
export function Gallery({ props, children }: BlockComponentProps<'gallery'>) {
  const { columns, caption } = props
  const items = pictures(children)
  const grid = columns === 3 ? 'grid-cols-1 @md:grid-cols-2 @xl:grid-cols-3' : 'grid-cols-1 @md:grid-cols-2'

  return (
    <div data-block="gallery" data-columns={columns} className="not-prose @container my-6 sm:my-8 w-full max-w-full min-w-0">
      <ul className={`grid list-none! gap-3 p-0! ps-0! ${grid}`}>
        {items.map(({ image, caption: text }, index) => (
          <li key={index} className="min-w-0">
            <figure className="m-0! min-w-0">
              {image}
              {text ? <figcaption>{text}</figcaption> : null}
            </figure>
          </li>
        ))}
      </ul>
      {caption ? <p className="mt-3 text-center text-sm text-neutral-500 dark:text-neutral-400">{caption}</p> : null}
    </div>
  )
}
