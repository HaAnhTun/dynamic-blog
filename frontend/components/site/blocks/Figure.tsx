import { BLOCK_WRAP } from './content-prose'
import type { BlockComponentProps } from './types'

/**
 * An image with its caption. The image itself comes from the pipeline as the child (`finishBlocks` builds one `img` from the
 * validated `src` and `alt`, and the image rules that follow add the `#WxH` size, lazy loading and async decoding), so a figure
 * block is drawn exactly like a Markdown image. A package-relative path (`assets/x.png`) passes through unchanged until the
 * importer rewrites it to `/media/...`.
 *
 * Standard is a centred figure up to a comfortable reading width, wide is the whole width of the article body. Neither is ever
 * wider than the body. The frame, border and caption colors of a figure under `.prose` come from `app/globals.css`, which also
 * handles dark mode for them; only the attribution, which that file does not know, is styled here.
 */
export function Figure({ props, children }: BlockComponentProps<'figure'>) {
  const { caption, attribution, variant } = props
  const wide = variant === 'wide'

  return (
    <div data-block="figure" data-variant={variant} className="not-prose w-full max-w-full min-w-0">
      <figure className={wide ? 'w-full min-w-0' : 'mx-auto! w-full max-w-3xl min-w-0'}>
        {children}
        {caption || attribution ? (
          <figcaption>
            {caption ? <span className={`block ${BLOCK_WRAP}`}>{caption}</span> : null}
            {attribution ? (
              <span className={`block ${BLOCK_WRAP} text-xs text-neutral-500 dark:text-neutral-400`}>{attribution}</span>
            ) : null}
          </figcaption>
        ) : null}
      </figure>
    </div>
  )
}
