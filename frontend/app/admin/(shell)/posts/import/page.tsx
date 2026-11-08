import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import NoAccess from '@/components/admin/NoAccess'
import PostImport from '@/components/admin/posts/post-import/PostImport'
import { PageHeader } from '@/components/admin/primitives'
import { PAGE } from '@/components/admin/ui'
import { SessionExpiredError, listCategories } from '@/lib/admin-api'
import { adminRole } from '@/lib/admin-role'
import { ApiError } from '@/lib/api'
import { applyPosts, checkArticle, previewPosts, renderArticle } from './actions'

/**
 * Import posts from Markdown files: for admins and authors, so unlike the profile import this is not an admin-only page. The role
 * in the token only chooses what to show; the backend decides on every call (a 403 or an expired session in the preview or the
 * apply is shown or redirected by the actions).
 */
export default async function PostImportPage() {
  const t = await getTranslations('Admin.posts.import.page')
  // A token that still carries an old role (demoted to reader, locked): say why instead of a form that can only be refused.
  if ((await adminRole()) === null) return <NoAccess title={t('title')} reason="account" back />
  // The same cheap read the new-post page makes, so the page treats a refusal like the post pages: an expired session goes to the
  // login, a 403 (the token still carries the old role) says why instead of a form whose first preview would only be refused.
  try {
    await listCategories()
  } catch (error) {
    if (error instanceof SessionExpiredError) redirect('/admin/login')
    if (error instanceof ApiError && error.status === 403) return <NoAccess title={t('title')} reason="account" back />
    throw error
  }

  return (
    <div className={PAGE}>
      <PageHeader title={t('title')} description={t('description')} back={{ href: '/admin', label: t('back') }} />
      <PostImport onPreview={previewPosts} onApply={applyPosts} onCheck={checkArticle} onArticle={renderArticle} />
    </div>
  )
}
