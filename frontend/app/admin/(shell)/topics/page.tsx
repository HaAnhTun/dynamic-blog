import { getTranslations } from 'next-intl/server'
import { redirect } from 'next/navigation'
import AdminOnly from '@/components/admin/AdminOnly'
import { PageHeader } from '@/components/admin/primitives'
import TopicManager, { type TopicItem } from '@/components/admin/TopicManager'
import { PAGE } from '@/components/admin/ui'
import { SessionExpiredError, listCategories, listTags } from '@/lib/admin-api'
import { adminRole } from '@/lib/admin-role'
import { ApiError } from '@/lib/api'
import type { PostSummary } from '@/lib/types'
import { everyAdminPost } from '../every-admin-post'
import { mergeCategoryInto, mergeTagInto, newCategory, newTag, removeCategory, removeTag, saveCategory, saveTag } from './actions'

/**
 * The number of posts using each category / tag, counted over every post the admin sees (any status): the admin API for
 * categories and tags returns no counts, and every post is already available through every-admin-post.ts (the same source as the
 * post list). No N+1: one read of the list, counted here.
 */
function usage(posts: readonly PostSummary[]) {
  const categories = new Map<string, { posts: number; published: number }>()
  const tags = new Map<string, { posts: number; published: number }>()
  const bump = (map: typeof categories, key: string, published: boolean) => {
    const entry = map.get(key) ?? { posts: 0, published: 0 }
    entry.posts += 1
    if (published) entry.published += 1
    map.set(key, entry)
  }
  for (const post of posts) {
    const published = post.status === 'PUBLISHED'
    if (post.category !== null) bump(categories, post.category.id, published)
    for (const tag of post.tags) bump(tags, tag.id, published)
  }
  return { categories, tags }
}

/**
 * The Topics page: manage categories and tags — before, they could only be created, in place in the
 * editor, and nothing could be edited or deleted. The same name as the public /topics page, where readers see
 * these very categories and tags.
 */
export default async function TopicsPage() {
  const t = await getTranslations('Admin.topics')
  // Before any call: categories, tags and one's own posts stay open to AUTHOR, so asking the backend would draw
  // rename, delete and merge buttons they cannot use.
  if ((await adminRole()) !== 'ADMIN') return <AdminOnly title={t('title')} />

  let categories
  let tags
  let posts: PostSummary[]
  try {
    ;[categories, tags, posts] = await Promise.all([listCategories(), listTags(), everyAdminPost()])
  } catch (error) {
    // Only an expired session goes to the login page; a 403 (the token still carries an old role) is the no-permission state;
    // another error goes to the admin error page.
    if (error instanceof SessionExpiredError) redirect('/admin/login')
    if (error instanceof ApiError && error.status === 403) return <AdminOnly title={t('title')} />
    throw error
  }

  const counts = usage(posts)
  const none = { posts: 0, published: 0 }
  const categoryItems: TopicItem[] = categories.map((category) => ({
    id: category.id,
    name: category.name,
    slug: category.slug,
    description: category.description,
    translations: category.translations,
    ...(counts.categories.get(category.id) ?? none),
  }))
  const tagItems: TopicItem[] = tags.map((tag) => ({
    id: tag.id,
    name: tag.name,
    slug: tag.slug,
    description: null,
    translations: tag.translations,
    ...(counts.tags.get(tag.id) ?? none),
  }))

  return (
    <div className={PAGE}>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="grid gap-12 xl:grid-cols-2 xl:gap-10">
        <TopicManager
          kind="category"
          items={categoryItems}
          onCreate={newCategory}
          onSave={saveCategory}
          onDelete={removeCategory}
          onMerge={mergeCategoryInto}
        />
        {/* Pass the Server Action straight through, no wrapping arrow: a Server Component may only give a Server Action
                    to a Client Component. A tag has no description, so the description parameter TopicManager sends along is dropped. */}
        <TopicManager
          kind="tag"
          items={tagItems}
          onCreate={newTag}
          onSave={saveTag}
          onDelete={removeTag}
          onMerge={mergeTagInto}
        />
      </div>
    </div>
  )
}
