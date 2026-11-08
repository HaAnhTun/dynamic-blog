import Image from 'next/image'
import { CoverArt } from '@/components/site/CoverArt'
import { coverInputOf } from '@/lib/cover-art'
import { mediaPath } from '@/lib/media'
import type { PostSummary } from '@/lib/types'

/**
 * The small image of a post in the admin list: exactly what readers see on the public post row, the cover image
 * if one was uploaded, otherwise the cover art generated from the slug (lib/cover-art.ts). Recognize the post at a glance, and
 * see at once which post has a real cover image.
 *
 * PostCover is not used: its frame carries `dark:` classes and the site's sizes. Here the frame is a fixed 3:2,
 * one theme (globals.css excludes the admin frame from `dark:` and from the dark ink set of the cover art).
 *
 * Decorative: `alt=""`, because the post title right next to it already says everything.
 */
export function PostThumb({
  post,
  className,
}: {
  post: Pick<PostSummary, 'slug' | 'category' | 'series' | 'cover'>
  className?: string
}) {
  const cover = post.cover ?? null
  return (
    <span
      className={`relative block aspect-[3/2] overflow-hidden rounded-md border border-slate-200 bg-slate-100 ${className ?? ''}`}
    >
      {cover !== null ? (
        <Image src={mediaPath(cover)} alt="" fill sizes="6rem" className="object-cover" />
      ) : (
        <CoverArt input={coverInputOf(post)} />
      )}
    </span>
  )
}
