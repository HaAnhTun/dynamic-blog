import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import NoAccess from '@/components/admin/NoAccess'
import PostEditor from '@/components/admin/PostEditor'
import { SessionExpiredError, listCategories, listTags } from '@/lib/admin-api'
import { ApiError } from '@/lib/api'
import { addCategory, addTag, savePost } from '../actions'

export const dynamic = 'force-dynamic'

export default async function NewPostPage() {
  const t = await getTranslations('Admin.editor')
  let categories
  let tags
  try {
    ;[categories, tags] = await Promise.all([listCategories(), listTags()])
  } catch (error) {
    if (error instanceof SessionExpiredError) redirect('/admin/login')
    // The token still carries the old role (demoted to reader, locked): say why instead of an error page.
    if (error instanceof ApiError && error.status === 403) return <NoAccess title={t('titleNew')} reason="account" back />
    throw error
  }

  async function onSave(form: FormData) {
    'use server'
    const result = await savePost(null, form)
    if ('error' in result) return result
    // Straight into the editor for the post that now exists, so the next save is an
    // update rather than a second create.
    redirect(`/admin/posts/${result.id}/edit`)
  }

  // No cover image, no preview: a post that does not exist yet has nothing to attach an image to or to
  // render. The first save redirects straight to the edit page, where both appear.
  return (
    <PostEditor
      post={null}
      categories={categories}
      tags={tags}
      onSave={onSave}
      onCreateCategory={addCategory}
      onCreateTag={addTag}
    />
  )
}
