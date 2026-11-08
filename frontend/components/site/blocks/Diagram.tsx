import { useTranslations } from 'next-intl'
import { DiagramView } from './DiagramView'
import { BLOCK_ROOT, BLOCK_TITLE } from './structure-styles'
import type { BlockComponentProps } from './types'

/**
 * A diagram written as Mermaid text in the body of the block. The frame, the title and the caption are drawn here, on the server;
 * the drawing is made in the browser by `DiagramView`, which shows the source in a `<pre>` until then (and when the drawing is not
 * possible), so the diagram is never an empty hole. The image is named by `alt`, else by the title, else by a plain word.
 *
 * The frame is a `figure` like the images of the article; the figure rules of app/globals.css (margin, a scroll container for
 * a wide drawing, the caption) apply to it, and the colors are the neutral pair of the page in both themes.
 */
export function Diagram({ props, source }: BlockComponentProps<'diagram'>) {
  const t = useTranslations('Site.blocks.diagram')
  const { title, caption, alt } = props

  return (
    <div data-block="diagram" className={BLOCK_ROOT}>
      <figure className="rounded-lg border border-neutral-200 p-3 sm:p-4 dark:border-neutral-800">
        {title ? <p className={`${BLOCK_TITLE} mb-3 text-sm`}>{title}</p> : null}
        <DiagramView source={source} label={alt ?? title ?? t('label')} failedMessage={t('failed')} />
        {caption ? <figcaption>{caption}</figcaption> : null}
      </figure>
    </div>
  )
}
