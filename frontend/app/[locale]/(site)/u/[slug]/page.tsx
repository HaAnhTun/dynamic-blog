import type { Metadata } from 'next'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { redirect } from '@/i18n/navigation'
import { BrandIcon } from '@/components/BrandIcon'
import { Pagination } from '@/components/Pagination'
import { githubProfileUrl } from '@/components/site/ArticleJsonLd'
import { Avatar } from '@/components/site/Avatar'
import { BrowseFrame } from '@/components/site/BrowseFrame'
import { LanguageFallback } from '@/components/site/LanguageFallback'
import { PostList } from '@/components/site/PostList'
import { INLINE_LINK } from '@/components/site/SectionHeading'
import { NotFoundError, getPosts, getUserProfile } from '@/lib/api'
import { otherLanguageWithPosts } from '@/lib/language-fallback'
import { metadataLocale } from '@/lib/locale-path'
import { pageMetadata } from '@/lib/metadata'
import { formatJoinedMonth, isProfileSlug, profilePath } from '@/lib/profile'
import type { UserProfile } from '@/lib/types'

/**
 * /u/[slug]: the public profile of one person. Only what comments already make public (avatar, name,
 * @login) plus the join month; an author also gets the list of published posts. No comment history.
 *
 * The site owner has no page here: a temporary redirect (307) to /about, where the full profile page already exists.
 */

export const revalidate = 300

const PAGE_SIZE = 10

/** Like the tag page: the backend reads `page` as a 32-bit int, so an absurd number is rejected before any call. */
const MAX_PAGE = 10_000

/** Like app/(site)/tags/[slug]/page.tsx: catches the `{ params: { slug } }` signature synchronously inside this very file. */
type AcceptsGeneratedProps<T extends (props: PageProps<'/[locale]/u/[slug]'>) => unknown> = T
export type _UserPageAcceptsGeneratedProps = AcceptsGeneratedProps<typeof UserProfilePage>
export type _UserMetadataAcceptsGeneratedProps = AcceptsGeneratedProps<typeof generateMetadata>

function parsePage(page: string | string[] | undefined): number {
  const raw = Array.isArray(page) ? (page[0] ?? '') : (page ?? '')
  return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : 0
}

/**
 * The profile, or null when this person does not exist. A malformed slug is null without calling the backend: a valid slug is
 * ASCII only, so the undecoded param can be compared directly. An error other than 404 passes through (error.tsx), it does not become a cached 404.
 */
async function resolveUser(params: Promise<{ slug: string }>): Promise<UserProfile | null> {
  const { slug } = await params
  if (!isProfileSlug(slug)) return null
  try {
    return await getUserProfile(slug)
  } catch (error) {
    if (error instanceof NotFoundError) return null
    throw error
  }
}

function canonicalOf(user: UserProfile, page: number): string {
  const base = profilePath(user.slug)
  return page > 0 ? `${base}?page=${page}` : base
}

export async function generateMetadata(props: PageProps<'/[locale]/u/[slug]'>): Promise<Metadata> {
  const { locale } = await props.params
  const pageLocale = await metadataLocale(props.params)
  const t = await getTranslations({ locale: pageLocale, namespace: 'Site.userProfile' })
  const { page } = await props.searchParams
  const user = await resolveUser(props.params).catch(() => null)
  if (!user) return { title: t('notFoundTitle') }
  // Outside every try: redirect throws NEXT_REDIRECT. Metadata sometimes runs before the page, so it redirects here too.
  if (user.siteOwner) redirect({ href: '/about', locale })

  const author = user.publishedPosts > 0
  const metadata = await pageMetadata({
    locale: pageLocale,
    title: user.displayName,
    description: author
      ? t('descriptionAuthor', { name: user.displayName, count: user.publishedPosts })
      : t('descriptionReader', { name: user.displayName }),
    canonical: canonicalOf(user, parsePage(page)),
  })
  // A reader who has written no posts: a thin page, not worth indexing, but the links on it are still followed.
  return author ? metadata : { ...metadata, robots: { index: false, follow: true } }
}

/** Neutral text label like the "Site owner" label of comments (enough contrast in both themes). */
const BADGE =
  'inline-block rounded-full border border-neutral-300 px-2 text-xs leading-5 font-medium whitespace-nowrap text-neutral-700 dark:border-neutral-700 dark:text-neutral-300'

export default async function UserProfilePage(props: PageProps<'/[locale]/u/[slug]'>) {
  const { locale } = await props.params
  setRequestLocale(locale)
  const pageLocale = await metadataLocale(props.params)
  const t = await getTranslations('Site.userProfile')
  const profileMeta = await getTranslations('Meta.profile')
  const { page } = await props.searchParams
  const current = parsePage(page)
  if (current > MAX_PAGE) notFound()

  const user = await resolveUser(props.params)
  if (!user) notFound()
  if (user.siteOwner) redirect({ href: '/about', locale })

  const author = user.publishedPosts > 0
  const posts = author ? await getPosts({ page: current, size: PAGE_SIZE, author: user.slug, language: pageLocale }) : null
  // A reader has no page 2; an author past the last page is a 404 like the tag page.
  const fallbackLanguage =
    posts !== null && posts.meta.totalElements === 0
      ? await otherLanguageWithPosts(
          pageLocale,
          async (language) => (await getPosts({ page: 0, size: 1, author: user.slug, language })).meta.totalElements,
        )
      : null
  if (current > 0 && (posts === null || current >= posts.meta.totalPages)) notFound()

  const github = githubProfileUrl(user.githubLogin)
  const joined = formatJoinedMonth(user.joinedAt, profileMeta)

  return (
    <>
      <BrowseFrame>
        <header className="pb-6">
          <div className="flex items-center gap-4 sm:gap-5">
            <Avatar name={user.displayName} src={user.avatarUrl} size={64} />
            <div className="min-w-0">
              <h1 className="text-3xl font-bold tracking-tight [overflow-wrap:anywhere] sm:text-4xl">
                <bdi>{user.displayName}</bdi>
              </h1>
              <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-neutral-600 dark:text-neutral-400">
                {author ? <span className={BADGE}>{t('authorBadge')}</span> : null}
                {github ? (
                  <a
                    href={github}
                    rel="noopener noreferrer"
                    className={`inline-flex items-center gap-1.5 [overflow-wrap:anywhere] ${INLINE_LINK}`}
                  >
                    <BrandIcon name="github" size={14} />@{user.githubLogin}
                  </a>
                ) : null}
                {joined !== null ? (
                  <span>
                    {t.rich('joined', {
                      date: joined,
                      time: (chunks) => <time dateTime={user.joinedAt}>{chunks}</time>,
                    })}
                  </span>
                ) : null}
              </p>
            </div>
          </div>
        </header>

        {posts !== null ? (
          // The section label is text, not a heading: the PostList rows are h2, and an h2 "Posts" would become their sibling.
          <section aria-labelledby="bai-viet">
            <p
              id="bai-viet"
              className="border-t border-neutral-200 pt-6 text-xs font-semibold tracking-wide text-neutral-600 uppercase dark:border-neutral-800 dark:text-neutral-400"
            >
              {t('posts')}
            </p>
            <PostList
              posts={posts.items}
              emptyMessage={t('empty')}
              emptyFallback={
                fallbackLanguage ? <LanguageFallback path={profilePath(user.slug)} language={fallbackLanguage} /> : undefined
              }
            />
            <Pagination meta={posts.meta} basePath={profilePath(user.slug)} />
          </section>
        ) : null}
      </BrowseFrame>
    </>
  )
}
