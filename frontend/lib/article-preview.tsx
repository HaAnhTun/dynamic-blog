import 'server-only'
import type { ReactNode } from 'react'
import { getTranslations } from 'next-intl/server'
import { ArticleView } from '@/components/site/ArticleView'
import { DEFAULT_LOCALE, isLocale } from '@/i18n/config'
import { renderMarkdown } from '@/lib/markdown'
import type { PostArticlePreview } from '@/lib/post-import'
import { dataUrlsOf } from '@/lib/preview-images'
import { slugify } from '@/lib/slug'
import type { Post } from '@/lib/types'

/** The name of the file without its extension, for a file whose front matter has no title. */
function nameOf(fileName: string): string {
  return fileName.replace(/\.(md|zip)$/i, '')
}

/**
 * The article of one file as the post page will show it, for the import page: the real `ArticleView` (header, table of contents,
 * body) around the body that the real `renderMarkdown` made, with the images of a package shown from their bytes.
 *
 * The file is not a post yet, so the `Post` handed to the view is made here from the front matter values and carries what the
 * header reads and nothing else: no id of a real post, no date (so none is shown), no cover (the view draws its generated cover art), no series, no
 * views. The reading time is left out on purpose (0 is "unknown" to the header): the backend computes it from the stored body, and
 * a number invented here could disagree with it. Nothing is read from a cookie or written.
 */
export async function articlePreviewNode(article: PostArticlePreview): Promise<ReactNode> {
  const [{ content, toc }, t] = await Promise.all([
    renderMarkdown(article.body ?? '', { imageSource: dataUrlsOf(article.assets) }),
    getTranslations('Site.article'),
  ])
  const now = new Date().toISOString()
  const title = article.title?.trim() || nameOf(article.fileName)
  const post: Post = {
    id: 'preview',
    title,
    slug: article.slug ?? 'preview',
    excerpt: article.excerpt,
    status: 'DRAFT',
    category:
      article.category === null
        ? null
        : { id: 'preview', name: article.category, slug: slugify(article.category), description: null },
    tags: article.tags.map((name) => ({ id: name, name, slug: slugify(name) })),
    featured: false,
    readingMinutes: 0,
    publishedAt: null,
    content: '',
    createdAt: now,
    updatedAt: now,
    cover: null,
    series: null,
  }
  const locale = isLocale(article.language) ? article.language : DEFAULT_LOCALE
  return <ArticleView post={post} content={content} toc={toc} series={null} locale={locale} t={t} />
}
