import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import CoverPanel from '@/components/admin/CoverPanel'
import DeletePost from '@/components/admin/DeletePost'
import MarkdownPreview from '@/components/admin/MarkdownPreview'
import NoAccess from '@/components/admin/NoAccess'
import PostEditor from '@/components/admin/PostEditor'
import TranslationsPanel from '@/components/admin/TranslationsPanel'
import { FOCUS_RING, LABEL } from '@/components/admin/ui'
import { LayersIcon } from '@/components/icons'
import {
  SessionExpiredError,
  getAdminPost,
  listCategories,
  listPostImages,
  listPostRevisions,
  listPostTranslations,
  listTags,
} from '@/lib/admin-api'
import { DEFAULT_LOCALE } from '@/i18n/config'
import { adminRole } from '@/lib/admin-role'
import { ApiError } from '@/lib/api'
import { notFound } from 'next/navigation'
import { addCategory, addTag, removePost, savePost, setPublished } from '../../actions'
import { removeCover, saveCoverAlt, uploadCover } from '../../cover-actions'
import {
  createTranslationAction,
  duplicatePost,
  linkTranslationAction,
  loadRevision,
  removeBodyImage,
  restoreRevision,
  unlinkTranslationAction,
  uploadBodyImage,
} from '../../editor-actions'
import { everyAdminPost } from '../../../every-admin-post'

export const dynamic = 'force-dynamic'

/**
 * The editor's side lists (in-body images, history): if they fail the editor still opens and that area
 * says "could not load" (null), instead of the whole page becoming an error page over a side list. A backend older than the
 * UI (404 ENDPOINT_NOT_FOUND) is a known case, not logged. An expired session and a 403 are still thrown: they belong to
 * the whole page, as when reading the post.
 */
async function optional<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load()
  } catch (error) {
    if (error instanceof SessionExpiredError || (error instanceof ApiError && error.status === 403)) throw error
    if (!(error instanceof ApiError && error.code === 'ENDPOINT_NOT_FOUND')) console.error('Editor side list failed', error)
    return null
  }
}

/**
 * Posts that could be linked as a translation: the admin's own list (an AUTHOR only gets theirs), without this post, without posts
 * already in a group and without languages the group already has (the panel filters the languages). `translations` only lists
 * PUBLISHED siblings, so a post whose only siblings are drafts still looks ungrouped here: the backend then answers 409 and the panel shows it.
 */
async function linkCandidates(id: string) {
  const posts = await everyAdminPost()
  return posts
    .filter((candidate) => candidate.id !== id && (candidate.translations ?? []).length === 0 && candidate.language !== undefined)
    .map((candidate) => ({ id: candidate.id, title: candidate.title, language: candidate.language as string }))
}

export default async function EditPostPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams?: Promise<{ restored?: string | string[] }>
}) {
  const { id } = await params
  const t = await getTranslations('Admin.editor')
  const tPosts = await getTranslations('Admin.posts')
  // `?restored=<key>`: restoreRevision (editor-actions.ts) just restored an old revision. A new key each time is
  // the editor's `key`, so it is rebuilt from scratch with the restored post, even on a second restore.
  const restored = (await searchParams)?.restored
  const restoredKey = typeof restored === 'string' && restored !== '' ? restored : null
  // Only chooses the UI (series, "Best posts", comments belong to ADMIN); permission on the post is decided by the backend.
  const admin = (await adminRole()) === 'ADMIN'

  let post
  let categories
  let tags
  let images
  let revisions
  let siblings
  let candidates
  try {
    ;[post, categories, tags, images, revisions, siblings, candidates] = await Promise.all([
      getAdminPost(id),
      listCategories(),
      listTags(),
      optional(() => listPostImages(id)),
      optional(() => listPostRevisions(id)),
      optional(() => listPostTranslations(id)),
      optional(() => linkCandidates(id)),
    ])
  } catch (error) {
    if (error instanceof SessionExpiredError) redirect('/admin/login')
    // 403: another author's post (AUTHOR gets 403 even for an id that does not exist: no id can be probed for existence), or a token
    // still carrying an old role. A real 404 only goes to ADMIN; for AUTHOR it is also "cannot open", not a public 404.
    if (error instanceof ApiError && (error.status === 403 || (error.status === 404 && !admin))) {
      return <NoAccess title={t('titleEdit')} reason="post" back />
    }
    // admin-api throws ApiError(404), never NotFoundError (only the public lib/api throws that class):
    // check by status, like the series edit page.
    if (error instanceof ApiError && error.status === 404) notFound()
    throw error
  }

  async function onSave(form: FormData) {
    'use server'
    return savePost(id, form)
  }
  async function onPublish() {
    'use server'
    return setPublished(id, true)
  }
  async function onUnpublish() {
    'use server'
    return setPublished(id, false)
  }
  // Cover image: the same way of packaging the id as the three actions above, so CoverPanel holds no id.
  async function onUploadCover(form: FormData) {
    'use server'
    return uploadCover(id, form)
  }
  async function onSaveCoverAlt(altText: string) {
    'use server'
    return saveCoverAlt(id, altText)
  }
  async function onRemoveCover() {
    'use server'
    return removeCover(id)
  }
  // In-body images, history, duplicating — the same way of packaging the id. No action redirects when
  // the session expires (editor-actions.ts): redirecting loses the post being written.
  async function onUploadImage(form: FormData) {
    'use server'
    return uploadBodyImage(id, form)
  }
  async function onDeleteImage(mediaId: string) {
    'use server'
    return removeBodyImage(id, mediaId)
  }
  async function onLoadRevision(revisionId: string) {
    'use server'
    return loadRevision(id, revisionId)
  }
  async function onRestoreRevision(revisionId: string) {
    'use server'
    return restoreRevision(id, revisionId)
  }
  async function onDuplicate() {
    'use server'
    return duplicatePost(id)
  }
  // Translations: the same way of packaging the id.
  async function onCreateTranslation(language: string, slug: string) {
    'use server'
    return createTranslationAction(id, language, slug)
  }
  async function onLinkTranslation(otherId: string) {
    'use server'
    return linkTranslationAction(id, otherId)
  }
  async function onUnlinkTranslation() {
    'use server'
    return unlinkTranslationAction(id)
  }
  async function onDelete() {
    'use server'
    return removePost(id)
  }

  // The series line is the path to the series screen, which only ADMIN can enter.
  const series = admin ? (post.series ?? null) : null

  return (
    <PostEditor
      key={restoredKey ?? 'editor'}
      adminTools={admin}
      post={post}
      categories={categories}
      tags={tags}
      onSave={onSave}
      onPublish={onPublish}
      onUnpublish={onUnpublish}
      onCreateCategory={addCategory}
      onCreateTag={addTag}
      preview={<MarkdownPreview markdown={post.content} />}
      images={images}
      onUploadImage={onUploadImage}
      onDeleteImage={onDeleteImage}
      revisions={revisions}
      onLoadRevision={onLoadRevision}
      onRestoreRevision={onRestoreRevision}
      onDuplicate={onDuplicate}
      initialNotice={restoredKey === null ? undefined : t('restoredNotice')}
      aside={
        <>
          {series !== null && (
            // Read-only: series membership is only written through the series screen (one endpoint replaces the whole
            // list), so here it is a path there, not an input field.
            <section aria-label={tPosts('seriesLabel')}>
              <h3 className={LABEL}>{tPosts('seriesLabel')}</h3>
              <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] leading-5 text-slate-600">
                <LayersIcon size={14} className="text-slate-500" />
                {tPosts.rich('inSeries', {
                  title: series.title,
                  position: series.position,
                  name: (chunks) => <span className="font-medium text-slate-900">{chunks}</span>,
                })}{' '}
                ·{' '}
                <Link
                  href={`/admin/series/${encodeURIComponent(series.id)}`}
                  className={`rounded-sm font-medium text-slate-700 underline decoration-slate-300 underline-offset-4 hover:text-slate-900 ${FOCUS_RING}`}
                >
                  {tPosts('manageSeries')}
                </Link>
              </p>
            </section>
          )}
          <TranslationsPanel
            language={post.language ?? DEFAULT_LOCALE}
            translations={siblings}
            candidates={candidates ?? []}
            onCreate={onCreateTranslation}
            onLink={onLinkTranslation}
            onUnlink={onUnlinkTranslation}
          />
          <CoverPanel post={post} onUpload={onUploadCover} onSaveAlt={onSaveCoverAlt} onRemove={onRemoveCover} />
        </>
      }
      // At the end of the settings column, after in-body images, history, download: deleting is the last job so it is found last.
      dangerZone={<DeletePost title={post.title} published={post.status === 'PUBLISHED'} author={!admin} onDelete={onDelete} />}
    />
  )
}
