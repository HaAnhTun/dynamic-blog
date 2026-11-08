import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { getTranslations } from 'next-intl/server'
import NoAccess from '@/components/admin/NoAccess'
import { StatusBadge } from '@/components/admin/primitives'
import { BACK_LINK, button } from '@/components/admin/ui'
import { ArrowUpRightIcon, ChevronLeftIcon, PenLineIcon } from '@/components/icons'
import { ArticleView } from '@/components/site/ArticleView'
import { SessionExpiredError, getAdminPost, getAdminSeries } from '@/lib/admin-api'
import { adminRole } from '@/lib/admin-role'
import { ApiError } from '@/lib/api'
import { renderMarkdown } from '@/lib/markdown'
import type { Post, PostSummary, SeriesAdminPost, SeriesDetail } from '@/lib/types'

/*
 * The full-page preview of a post, drafts included: exactly the post body a reader will see —
 * breadcrumb, cover image, table of contents, series block, text — built with ArticleView, the component the public page
 * also uses, instead of the editor's "Preview" frame with only the post body.
 *
 * The SAVED version, read through the admin API (a draft is not in the public API): unsaved changes in the editor
 * are not here, and the top bar says so plainly. Nothing of a real reader: no JSON-LD, no
 * like button, share, author box, view beacon or comments — each of those either talks to the
 * public backend (a draft is a 404 there) or asserts to crawlers about a URL that does not exist yet.
 * The noindex/nofollow of the whole admin branch is already in app/admin/layout.tsx; this page declares nothing more.
 *
 * No sidebar (AdminSidebar.isFullWidthRoute): the post needs exactly the reading width of the blog.
 */

export const dynamic = 'force-dynamic'

/** `SeriesAdminPost` → a part of `SeriesDetail`. SeriesBlock only reads id, slug and title; the other
 *  fields of `PostSummary` are shown by nobody here, so they carry empty values. */
function asPart(part: SeriesAdminPost): PostSummary {
  return {
    id: part.id,
    title: part.title,
    slug: part.slug,
    status: part.status,
    excerpt: null,
    category: null,
    tags: [],
    featured: false,
    readingMinutes: 1,
    publishedAt: null,
  }
}

/**
 * The series as a reader will see it when this post is published: the PUBLISHED parts plus this post itself, by the saved
 * position. The public series API only has published parts, so for a draft it does not contain the post being viewed and
 * the series block would vanish — exactly when the author most needs to see their "Part n/m". OTHER drafts of the same
 * series are not included: readers do not see them. For a published post, the result equals the public series exactly.
 *
 * A secondary block: an error only loses the series block, with one log line, the page still shows.
 */
async function previewSeries(post: Post): Promise<SeriesDetail | null> {
  const ref = post.series ?? null
  if (ref === null) return null
  try {
    const series = await getAdminSeries(ref.id)
    const parts = series.posts
      .filter((part) => part.status === 'PUBLISHED' || part.id === post.id)
      .sort((a, b) => a.position - b.position)
    return { id: series.id, title: series.title, slug: series.slug, description: series.description, posts: parts.map(asPart) }
  } catch (error) {
    console.warn(
      `[admin preview] Could not read series "${ref.id}" (${error instanceof Error ? error.message : String(error)}). Hiding the series block.`,
    )
    return null
  }
}

/**
 * The top bar: this is the preview of the saved version, the post status, and the way back. Not sticky: a
 * bar stuck to the top would cover the heading every time an item of the table of contents is clicked. The `<section>` is named by the very sentence
 * "Preview (saved version)", so a screen reader meets it as a region before the post title.
 */
function PreviewBar({ post }: { post: Post }) {
  const t = useTranslations('Admin.posts.preview')
  const published = post.status === 'PUBLISHED'
  return (
    <section aria-labelledby="ban-xem-truoc" className="border-b border-slate-200 bg-white">
      <div className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 sm:px-6">
        <Link href="/admin" className={BACK_LINK}>
          <ChevronLeftIcon />
          {t('back')}
        </Link>
        <span aria-hidden="true" className="text-slate-400">
          /
        </span>
        <p id="ban-xem-truoc" className="text-sm font-medium text-slate-900">
          {/* A space OUTSIDE the span: the name of the region concatenates the children text, without it it is "Preview(saved…". */}
          {t('heading')} <span className="font-normal text-slate-500">{t('savedVersion')}</span>
        </p>
        <StatusBadge status={post.status} />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {published && (
            <a
              href={`/posts/${encodeURIComponent(post.slug)}`}
              target="_blank"
              rel="noopener noreferrer"
              className={button('ghost', 'sm')}
            >
              {/* A space OUTSIDE the sr-only span: the accessible name is "View on blog (new tab)". */}
              {t('viewOnBlog')} <span className="sr-only">{t('newTab')}</span>
              <ArrowUpRightIcon />
            </a>
          )}
          <Link href={`/admin/posts/${encodeURIComponent(post.id)}/edit`} className={button('primary', 'sm')}>
            <PenLineIcon />
            {t('edit')}
          </Link>
        </div>
      </div>
    </section>
  )
}

export default async function PostPreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  let post: Post
  try {
    post = await getAdminPost(id)
  } catch (error) {
    // The same branches as the post edit page: an expired session goes to login (a Server Component cannot set
    // cookies); 403, and 404 for a non-ADMIN, are "cannot open this post" inside the admin frame; the 404
    // of ADMIN is the 404 page (admin-api throws ApiError(404), never NotFoundError); the rest — server
    // down — goes to the admin error.tsx, where "Try again" makes sense.
    if (error instanceof SessionExpiredError) redirect('/admin/login')
    if (error instanceof ApiError && (error.status === 403 || (error.status === 404 && (await adminRole()) !== 'ADMIN'))) {
      return <NoAccess title={(await getTranslations('Admin.posts.preview'))('heading')} reason="post" back />
    }
    if (error instanceof ApiError && error.status === 404) notFound()
    throw error
  }

  // Two independent jobs; Shiki is the heavy one. previewSeries does not throw (the secondary block catches its own errors), so only
  // a real renderMarkdown error reaches error.tsx.
  const [{ content, toc }, series] = await Promise.all([renderMarkdown(post.content), previewSeries(post)])

  return (
    <>
      <PreviewBar post={post} />
      <ArticleView post={post} content={content} toc={toc} series={series} t={await getTranslations('Site.article')} />
    </>
  )
}
