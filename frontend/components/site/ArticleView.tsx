import type { Translator } from '@/i18n/translator'
import type { ReactNode } from 'react'
import { DEFAULT_LOCALE, type Locale } from '@/i18n/config'
import { EyeIcon } from '@/components/icons'
import { shouldShowViews } from '@/lib/discovery'
import type { TocEntry } from '@/lib/markdown'
import type { Post, SeriesDetail } from '@/lib/types'
import { Breadcrumb } from './Breadcrumb'
import { CodeScrollCue } from './CodeScrollCue'
import { Container } from './Container'
import { formatCount } from './DiscoveryGrid'
import { PostCover } from './PostCover'
import { META_ICON, ReadingMeta, TagList, readingMinutesOf } from './ReadingMeta'
import { SeriesBlock } from './SeriesBlock'
import { MIN_TOC_ENTRIES, TocNav } from './TocNav'

// The table of contents moved to TocNav; the constant stays importable from here for existing callers.
export { MIN_TOC_ENTRIES }

/**
 * Classes of the post body (what `renderMarkdown` produced). Links carry the brand color with a half-strength underline, so
 * a link is told apart from the text by more than color (WCAG 1.4.1); heading and marker details are in globals.css.
 */
const PROSE =
  'prose prose-base sm:prose-lg prose-neutral max-w-none dark:prose-invert max-sm:prose-h2:mt-10 max-sm:prose-h2:mb-4 max-sm:prose-h2:text-2xl max-sm:prose-h3:mt-8 max-sm:prose-h3:mb-3 max-sm:prose-h3:text-xl prose-headings:tracking-tight prose-headings:text-balance prose-a:text-brand prose-a:font-medium prose-a:underline prose-a:decoration-brand/50 prose-a:underline-offset-4 hover:prose-a:decoration-brand prose-li:marker:text-neutral-400'

export type ArticleHeaderProps = {
  post: Post
  /** The locale the counts are formatted in; a prop rather than a hook because this stays a server component. */
  locale?: Locale
  /** Translator of the `Site.article` namespace; a prop for the same reason as `locale`. */
  t: Translator
  /** Top of the header, before the breadcrumb: structured data (JSON-LD) of the public page. */
  head?: ReactNode
}

/**
 * Everything above the body: breadcrumb → title, lead, one meta row, tags → cover image. No wrapper element: the caller
 * owns the `<article>` (the preview's ArticleView below, the public page's three-column grid).
 */
export function ArticleHeader({ post, locale = DEFAULT_LOCALE, t, head }: ArticleHeaderProps) {
  const excerpt = post.excerpt?.trim()

  return (
    <>
      {head}

      <Breadcrumb category={post.category} />

      <h1 className="mt-4 text-3xl leading-[1.12] font-bold tracking-tight text-balance break-words sm:text-4xl rail:text-[2.5rem]">
        {post.title}
      </h1>

      {/* Dek: the excerpt is a summary the author wrote for this very post, so it sits under the
          title like a lead. Without one there is no empty <p> holding margin. */}
      {excerpt ? <p className="mt-5 text-lg text-pretty text-neutral-600 dark:text-neutral-400">{excerpt}</p> : null}

      {/* The date, updated date and reading time go through ReadingMeta (UTC time zone in one place), views at the end of
          the same single flex row (`trailing`). The category is not here: it is in the breadcrumb, and two links to the
          same category are two keyboard stops for one target. ReadingMeta shows the updated date only when the post was
          edited on a day after the publish day — the same value as `dateModified` of the BlogPosting. */}
      <ReadingMeta
        className="mt-5"
        publishedAt={post.publishedAt}
        updatedAt={post.updatedAt}
        category={null}
        tags={[]}
        readingMinutes={readingMinutesOf(post)}
        trailing={
          shouldShowViews(post.viewCount) ? (
            // "views", not "reads": the beacon counts page opens, it does not know who read to the end.
            <span className="inline-flex items-center gap-1.5">
              <EyeIcon size={14} className={META_ICON} />
              {t('views', { count: formatCount(post.viewCount as number, locale), n: post.viewCount as number })}
            </span>
          ) : null
        }
      />

      <TagList tags={post.tags} className="mt-4" />

      {/* Cover image (high fetchPriority, no preload) or the post's own cover art. */}
      <PostCover post={post} variant="hero" className="mt-8" />
    </>
  )
}

/**
 * The post body after `renderMarkdown` in its prose wrapper. `data-post-body` (not an id) is how the reading progress finds
 * it: heading ids come from the author's headings, so a heading titled "Post body" would collide with an id. `className` is the margin
 * above the body (32px after a header); a page that already pads the body with a band passes its own.
 */
export function ArticleBody({ content, className = 'mt-8' }: { content: ReactNode; className?: string }) {
  return (
    <div data-post-body="" className={`${className} ${PROSE}`}>
      {content}
      <CodeScrollCue />
    </div>
  )
}

export type ArticleViewProps = {
  post: Post
  /** The post body after `renderMarkdown` (lib/markdown.tsx): the same pipeline for every place a post is shown. */
  content: ReactNode
  /** The table of contents returned by that same `renderMarkdown` call, so each link points to an id that exists in the body. */
  toc: TocEntry[]
  /** The post's series as the reader sees it, or null; SeriesBlock hides itself when the post is not in one. */
  series: SeriesDetail | null
  /** Top of `<article>`, before the breadcrumb: structured data (JSON-LD) of the public page. */
  head?: ReactNode
  /** After the post body, still inside `<article>`: like button, share, author box, beacon of the public page. */
  footer?: ReactNode
  /** The locale the counts are formatted in; a prop rather than a hook because this stays a server component. */
  locale?: Locale
  /** Translator of the `Site.article` namespace; a prop for the same reason as `locale`. */
  t: Translator
}

/**
 * A post as one centred column: header → series block → table of contents (closed, inline) → body, then room for the
 * end of the post. The admin draft preview (app/admin/(shell)/posts/[id]/preview/page.tsx) uses it as is; the public page
 * composes ArticleHeader, TocNav and ArticleBody itself inside its three-column layout.
 *
 * Whatever only the public page has goes into the two slots `head`/`footer`, never a flag
 * here: JSON-LD, like button, share, view beacon all talk to real readers or crawlers,
 * and the preview must not drag in any of them. It reads no cookie, header or request.
 */
export function ArticleView({ post, content, toc, series, head, footer, locale = DEFAULT_LOCALE, t }: ArticleViewProps) {
  return (
    // No <main> here: the page layout (app/(site)/layout.tsx for the blog, the admin shell for the
    // preview) already has the single `<main id="main-content">`, the target of the skip link. Container keeps the margins and the
    // reading width, so the post lines up with every other page. The order inside <article> follows the spec.
    <Container as="article" width="prose" className="py-10 sm:py-14">
      <ArticleHeader post={post} locale={locale} t={t} head={head} />

      {series ? <SeriesBlock series={series} currentSlug={post.slug} /> : null}

      {/* The preview has no reading rail, so this nav carries its own TocSpy. */}
      <TocNav variant="inline" toc={toc} t={t} spy />

      <ArticleBody content={content} />

      {footer}
    </Container>
  )
}
