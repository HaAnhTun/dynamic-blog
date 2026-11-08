import { useTranslations } from 'next-intl'
import { BrandIcon } from '@/components/BrandIcon'
import type { Locale } from '@/i18n/config'
import { postUrl } from './ArticleJsonLd'
import { NativeShare } from './NativeShare'
import { FOCUS_RING, TRANSITION } from './SectionHeading'
import { SHARE_TARGETS } from './share-targets'

/**
 * A hairline-bordered cell: 44px below the `rail` breakpoint and on a coarse pointer (a 32px cell is too small a tap target for a
 * site read mostly on phones), 32px from `rail` on a fine pointer. The focus ring and the color transition are the site's shared
 * constants, not retyped.
 */
const SHARE_LINK = `inline-flex h-11 w-11 items-center justify-center rounded-md border border-neutral-200 text-neutral-600 hover:border-brand hover:text-brand rail:pointer-fine:h-8 rail:pointer-fine:w-8 dark:border-neutral-800 dark:text-neutral-400 ${FOCUS_RING} ${TRANSITION}`

const LABEL_ID = 'chia-se'

/**
 * The share controls of a post, for the right column (and the toolbar drawn after the article below the `rail` breakpoint): the
 * share label (`id="chia-se"`) above one row of icon cells, Facebook, LinkedIn, X, then the operating system's share button when
 * available. There is no copy-link button here: Copy link lives in the hero. The destinations come from `SHARE_TARGETS`, the same
 * list the hero's Share menu uses, so both produce identical URLs.
 * The post page renders it ONCE; it has no outer margin or border, the toolbar owns its rhythm.
 *
 * The URL is the canonical built from the slug (`postUrl`), the same string as the canonical tag and JSON-LD — a share link that
 * differs from the canonical is a duplicate URL being spread around.
 *
 * Links open a new tab with `rel="noopener noreferrer"`: the share page must not keep a `window.opener`
 * pointing back to the post, and does not need to know which page the reader came from. Each link's name is sr-only text "Share
 * on …" (in the site language); the brand mark is aria-hidden and filled with `currentColor`, no brand color.
 */
export function ShareBar({
  slug,
  title,
  language,
}: {
  slug: string
  title: string
  language?: Locale
  /** Accepted only so a caller written for the old two-variant bar still compiles; there is a single (rail) layout. */
  variant?: 'rail'
}) {
  const t = useTranslations('Site.share')
  const url = postUrl(slug, language)

  // print:hidden: no button can be clicked on paper.
  return (
    // One line below `rail` (the label, then the icons: the toolbar under the article), a label above the icons in the column of the rail.
    <div className="flex items-center gap-3 rail:flex-col rail:items-start rail:gap-2 print:hidden">
      <p id={LABEL_ID} className="text-sm text-neutral-600 dark:text-neutral-400">
        {t('label')}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <ul aria-labelledby={LABEL_ID} className="flex gap-2">
          {SHARE_TARGETS.map((target) => (
            <li key={target.brand}>
              <a href={target.href(url, title)} target="_blank" rel="noopener noreferrer" className={SHARE_LINK}>
                <BrandIcon name={target.brand} />
                <span className="sr-only">{t('shareOn', { target: target.label })}</span>
              </a>
            </li>
          ))}
        </ul>
        <NativeShare slug={slug} title={title} language={language} />
      </div>
    </div>
  )
}
