import Image from 'next/image'
import { useTranslations } from 'next-intl'
import { EyeIcon, ChevronRightIcon } from '@/components/icons'
import type { Locale } from '@/i18n/config'
import { Link } from '@/i18n/navigation'
import type { Translator } from '@/i18n/translator'
import { shouldShowViews } from '@/lib/discovery'
import { postLinkLocale } from '@/lib/post-language'
import { partBadge, type HeroAuthor, type HeroSeries, type NextReading } from '@/lib/reader-hero'
import type { Post } from '@/lib/types'
import { Avatar } from '../Avatar'
import { Breadcrumb } from '../Breadcrumb'
import { CopyLink } from '../CopyLink'
import { formatCount } from '../DiscoveryGrid'
import { META_ICON, ReadingMeta, TagList, readingMinutesOf } from '../ReadingMeta'
import { TAP_TARGET, TITLE_LINK } from '../SectionHeading'
import { HERO_BUTTON } from './hero-button'
import { HERO_SLOT } from './reader-layout'
import { ShareMenu } from './ShareMenu'

export type ArticleHeroProps = {
  post: Post
  /** The locale the counts and dates are formatted in; a prop rather than a hook for the same reason as ArticleHeader's. */
  locale: Locale
  /** The language of the post: Copy link, Share and the Next link are built in it. */
  language: Locale
  /** Translator of the `Site.article` namespace. */
  t: Translator
  /** Translator of the `Site.reader` namespace. */
  tReader: Translator
  author: HeroAuthor
  /** The series of the post for the meta line, or null for a post that is in none. */
  series: HeroSeries | null
  /** Where "Next" leads; null hides the button. */
  next: NextReading
  /** False for an admin preview of a draft: no Copy link, Share or Next (nothing public to copy, share or go to). */
  published: boolean
}

const BADGE =
  'inline-flex shrink-0 items-center rounded-md border border-neutral-200 px-1.5 py-0.5 text-xs font-semibold text-neutral-700 tabular-nums dark:border-neutral-800 dark:text-neutral-300'

const SERIES_LINK = `min-w-0 max-w-[18rem] truncate font-medium text-neutral-800 dark:text-neutral-200 ${TITLE_LINK}`

/**
 * The hero block of the post page: everything above the cover and the text, one `<header>` of the article. Order: breadcrumb,
 * one meta line (series badge and title when the post is in a series, then date, updated date, reading time, views), the one `h1`,
 * the dek, the tags, then the author row: avatar, name and a Subscribe link on the left, the print-hidden actions Copy link,
 * Share and Next on the right. No background, no card: the hairline of HERO_SLOT closes it. The component renders the `<header>`
 * element itself (HERO_SLOT classes from reader-layout.ts and the `data-reader-hero` hook), so the page must not wrap it again;
 * the JSON-LD stays the first child of `<article>`, before this header.
 *
 * The admin preview keeps ArticleHeader; this component is for the public page only. Copy link, Share and Next exist only for a
 * published post. Subscribe and the author are shown for a draft preview too.
 */
export function ArticleHero({ post, locale, language, t, tReader, author, series, next, published }: ArticleHeroProps) {
  // The root translator and a full key: the Site.postNav namespace is opened by PostNav; this file takes the one label it needs
  // ("Next post") by its full path, so it stays a consumer of the translators it is handed (the page's `t` and `tReader`).
  const tAll = useTranslations()
  const excerpt = post.excerpt?.trim()

  // Below `lg` the series is named by the card above the hero (LeftRail), which also opens the list of parts: a second line with the
  // same badge and a truncated title would say it twice. `contents` keeps the two items direct flex children of the meta row.
  const leading = series ? (
    <span className="contents max-lg:hidden">
      {series.badge ? (
        <span className={BADGE}>
          <span aria-hidden="true">{partBadge(series.badge.current, series.badge.total)}</span>
          <span className="sr-only">{tReader('partBadge', { current: series.badge.current, total: series.badge.total })}</span>
        </span>
      ) : null}
      <Link href={`/series/${encodeURIComponent(series.slug)}`} className={SERIES_LINK}>
        {series.title}
      </Link>
    </span>
  ) : null

  return (
    <header className={HERO_SLOT} data-reader-hero="">
      <div className="mb-5">
        <Breadcrumb category={post.category} />
      </div>

      <ReadingMeta
        publishedAt={post.publishedAt}
        updatedAt={post.updatedAt}
        category={null}
        tags={[]}
        readingMinutes={readingMinutesOf(post)}
        leading={leading}
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

      <h1 className="mt-4 max-w-4xl text-3xl leading-[1.2] font-bold tracking-tight text-balance break-words sm:text-4xl sm:leading-[1.1] xl:text-[2.75rem]">
        {post.title}
      </h1>

      {excerpt ? (
        <p className="mt-4 max-w-2xl max-sm:line-clamp-4 text-[1.0625rem] leading-[1.6] text-pretty text-neutral-600 sm:mt-5 sm:text-lg sm:leading-7 xl:text-xl xl:leading-7 dark:text-neutral-400">
          {excerpt}
        </p>
      ) : null}

      <TagList tags={post.tags} className="mt-4 sm:mt-5" />

      <div className="mt-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-4 sm:mt-8">
        <div className="flex min-w-0 items-center gap-3">
          {author.avatar ? (
            author.avatar.kind === 'image' ? (
              <Image
                src={author.avatar.src}
                alt=""
                width={32}
                height={32}
                unoptimized
                className="h-8 w-8 shrink-0 rounded-full border border-neutral-200 object-cover dark:border-neutral-800"
              />
            ) : (
              <Avatar name={author.name} src={author.avatar.src} size={32} />
            )
          ) : null}

          {/* <bdi>: the name is user-set. A same-site link, no `rel="me"` (the author box keeps that). */}
          <span className="min-w-0 text-sm font-medium [overflow-wrap:anywhere]">
            {author.href !== null ? (
              <Link
                href={author.href}
                className={`${TITLE_LINK} ${TAP_TARGET} max-sm:inline-flex max-sm:h-11 max-sm:items-center`}
              >
                <bdi>{author.name}</bdi>
              </Link>
            ) : (
              <bdi>{author.name}</bdi>
            )}
          </span>

          <Link href="/newsletter" className={`${HERO_BUTTON} shrink-0 max-sm:hidden print:hidden`}>
            {tReader('subscribe')}
          </Link>
        </div>

        {published ? (
          <div
            role="group"
            aria-label={tReader('actionsLabel')}
            className="flex w-full items-start gap-2 sm:w-auto sm:flex-wrap sm:items-center print:hidden"
          >
            <CopyLink variant="hero" slug={post.slug} language={language} />
            <ShareMenu slug={post.slug} title={post.title} language={language} />
            {next ? (
              <Link
                href={`/posts/${encodeURIComponent(next.post.slug)}`}
                locale={postLinkLocale(next.post, locale)}
                className={`${HERO_BUTTON} max-sm:min-w-0 max-sm:flex-1 max-sm:justify-center`}
              >
                {next.kind === 'part' ? tReader('nextPart') : tAll('Site.postNav.next')}
                {/* The explicit space is load-bearing: jsdom and an unstyled page glue the visible label to the title otherwise. */}{' '}
                <span className="sr-only">: {next.post.title}</span>
                <ChevronRightIcon size={16} />
              </Link>
            ) : null}
          </div>
        ) : null}
      </div>
    </header>
  )
}
