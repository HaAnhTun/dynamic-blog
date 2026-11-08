'use client'

import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { BookmarkIcon } from '@/components/icons'
import { bookmarkUrl, isBookmarkState } from '@/components/site/BookmarkButton'
import { GitHubLoginLink } from '@/components/site/GitHubLoginLink'
import { ListRow } from '@/components/site/ListRow'
import { FOCUS_RING, TRANSITION } from '@/components/site/SectionHeading'
import { callBff } from '@/lib/bff-client'
import { interactionMessage, needsLogin } from '@/lib/interaction-errors'
import { setAnonymous, useSession } from '@/lib/session-client'
import type { PostSummary } from '@/lib/types'

/**
 * Content of /bookmarks, modelled on NotificationsCenter: loads only when signed in, every write is confirmed by
 * the server, and focus always has somewhere to go. Each row is a ListRow (same row as PostList) plus an "Unsave" button:
 * PostList does not accept per-row actions.
 */

const PAGE_SIZE = 20

/** Same primary button style as /notifications and /profile. */
const PRIMARY = `inline-flex items-center gap-2 rounded-md border border-neutral-900 bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:border-brand hover:bg-brand dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:border-brand dark:hover:bg-brand dark:hover:text-white ${TRANSITION} ${FOCUS_RING}`

/** Outlined secondary button ("Load more", "Try again"), 40px on a phone. */
const SECONDARY = `inline-flex h-10 items-center justify-center rounded-md border border-neutral-300 px-4 text-sm font-medium text-neutral-700 hover:border-brand hover:text-brand aria-disabled:cursor-not-allowed aria-disabled:opacity-60 sm:h-9 dark:border-neutral-700 dark:text-neutral-300 ${TRANSITION} ${FOCUS_RING}`

/** Same shape as the bookmark button at the end of a post. */
const UNSAVE = `inline-flex h-10 shrink-0 items-center gap-1.5 rounded-md border border-neutral-200 px-3 text-sm text-neutral-600 hover:border-brand hover:text-brand aria-disabled:cursor-wait aria-disabled:opacity-60 sm:h-8 sm:px-2.5 dark:border-neutral-800 dark:text-neutral-400 ${FOCUS_RING} ${TRANSITION}`

type ListState = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; items: PostSummary[]; hasMore: boolean }

type Outcome = { kind: 'page'; posts: PostSummary[] } | { kind: 'login' } | { kind: 'failed' }

type FocusTarget = { kind: 'item'; id: string } | { kind: 'heading' }

/** Enough for ListRow to draw without breaking; a post off contract fails the whole page ("could not load"), it is not silently dropped. */
function isPostSummary(value: unknown): value is PostSummary {
  if (value === null || typeof value !== 'object') return false
  const post = value as Record<string, unknown>
  return (
    typeof post.id === 'string' &&
    typeof post.slug === 'string' &&
    post.slug !== '' &&
    typeof post.title === 'string' &&
    Array.isArray(post.tags)
  )
}

// callBff only returns `data`, so "there is more" is inferred from a full page in place of `pagination`.
async function fetchPage(page: number): Promise<Outcome> {
  const result = await callBff<unknown>(`/api/me/bookmarks?page=${page}&size=${PAGE_SIZE}`)
  if (!result.ok) return needsLogin(result.code, result.status) ? { kind: 'login' } : { kind: 'failed' }
  const posts = result.data
  return Array.isArray(posts) && posts.every(isPostSummary) ? { kind: 'page', posts } : { kind: 'failed' }
}

function appendFresh(items: PostSummary[], incoming: PostSummary[]): PostSummary[] {
  const known = new Set(items.map((item) => item.id))
  return [...items, ...incoming.filter((item) => !known.has(item.id))]
}

export function BookmarkList({ headingId }: { headingId: string }) {
  const session = useSession()
  const t = useTranslations('Site.bookmarks')

  if (session.status === 'loading') {
    // A few placeholder rows (text on the left, image on the right like ListRow) so the page does not jump when the session answers.
    return (
      <div aria-busy="true" className="mt-8 space-y-8">
        {[0, 1, 2].map((row) => (
          <span key={row} aria-hidden="true" className="flex items-start gap-4">
            <span className="flex-1 space-y-2">
              <span className="block h-5 w-3/4 rounded bg-neutral-100 dark:bg-neutral-900" />
              <span className="block h-3 w-1/3 rounded bg-neutral-100 dark:bg-neutral-900" />
            </span>
            <span className="aspect-[3/2] w-24 shrink-0 rounded-md bg-neutral-100 sm:w-40 dark:bg-neutral-900" />
          </span>
        ))}
      </div>
    )
  }

  if (session.status === 'anonymous') {
    return (
      <div className="mt-8">
        <p className="text-neutral-700 dark:text-neutral-300">{t('signInPrompt')}</p>
        <GitHubLoginLink returnTo="/bookmarks" className={`${PRIMARY} mt-4`}>
          {t('signIn')}
        </GitHubLoginLink>
      </div>
    )
  }

  return <Saved headingId={headingId} />
}

function Saved({ headingId }: { headingId: string }) {
  const t = useTranslations('Site.bookmarks')
  const tErrors = useTranslations('Errors.interaction')
  const [list, setList] = useState<ListState>({ status: 'loading' })
  const [more, setMore] = useState<'idle' | 'loading' | 'failed'>('idle')
  const [removing, setRemoving] = useState<ReadonlySet<string>>(() => new Set())
  const [itemError, setItemError] = useState<{ id: string; message: string } | null>(null)
  const [announcement, setAnnouncement] = useState('')
  // Latest first-page load: the answer of an older load (including a "Load more" started before it) is dropped.
  const loadSeq = useRef(0)
  const moreInFlight = useRef(false)
  const removePending = useRef(new Set<string>())
  // Unbookmark finished on the server: two unbookmarks in the same tick see each other through here.
  const removed = useRef(new Set<string>())
  const focusTarget = useRef<FocusTarget | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const latest = useRef(list)

  useEffect(() => {
    latest.current = list
  }, [list])

  function loadFirst(): void {
    const seq = ++loadSeq.current
    void fetchPage(0).then((outcome) => {
      if (seq !== loadSeq.current) return
      if (outcome.kind === 'login') {
        setAnonymous()
        return
      }
      setList(
        outcome.kind === 'failed'
          ? { status: 'failed' }
          : { status: 'ready', items: outcome.posts, hasMore: outcome.posts.length === PAGE_SIZE },
      )
    })
  }

  const onMount = useEffectEvent(() => loadFirst())
  useEffect(() => {
    onMount()
  }, [])

  /** The row of post `id` in the list being drawn. */
  function rowOf(id: string): HTMLElement | null {
    const rows = listRef.current?.children ?? []
    return (Array.from(rows) as HTMLElement[]).find((row) => row.dataset.bookmarkId === id) ?? null
  }

  useEffect(() => {
    const target = focusTarget.current
    if (target === null) return
    focusTarget.current = null
    if (target.kind === 'heading') document.getElementById(headingId)?.focus()
    else rowOf(target.id)?.querySelector<HTMLElement>('h2 a')?.focus()
  })

  function reload(): void {
    setList({ status: 'loading' })
    setMore('idle')
    setItemError(null)
    removed.current.clear()
    loadFirst()
  }

  async function loadMore() {
    const base = latest.current
    if (base.status !== 'ready' || !base.hasMore || moreInFlight.current) return
    const seq = loadSeq.current
    moreInFlight.current = true
    setMore('loading')
    // The page containing the next position, computed from the number of posts shown: unbookmarking pulls later posts up, and counting by pages
    // already loaded would skip them. Overlap with the posts already shown is filtered by id.
    const outcome = await fetchPage(Math.floor(base.items.length / PAGE_SIZE))
    moreInFlight.current = false
    if (seq !== loadSeq.current) return
    if (outcome.kind === 'login') {
      setAnonymous()
      return
    }
    if (outcome.kind === 'failed') {
      setMore('failed')
      return
    }
    const current = latest.current
    if (current.status !== 'ready') return
    const fresh = appendFresh(current.items, outcome.posts).slice(current.items.length)
    const hasMore = outcome.posts.length === PAGE_SIZE && fresh.length > 0
    // The "Load more" button holds focus: move to the first new post, or to the last post when the button disappears with nothing new.
    const target = fresh[0] ?? current.items.at(-1)
    if (target !== undefined) focusTarget.current = { kind: 'item', id: target.id }
    setMore('idle')
    setList((state) =>
      state.status === 'ready' ? { status: 'ready', items: appendFresh(state.items, outcome.posts), hasMore } : state,
    )
  }

  async function remove(post: PostSummary) {
    const { id } = post
    if (removePending.current.has(id)) return
    removePending.current.add(id)
    setRemoving(new Set(removePending.current))
    setItemError(null)
    setAnnouncement('')
    const result = await callBff<unknown>(bookmarkUrl(post.slug), { method: 'DELETE' })
    removePending.current.delete(id)
    setRemoving(new Set(removePending.current))
    // 404: the post was removed or deleted, and the server list no longer has it either.
    const gone = !result.ok && result.code === 'POST_NOT_FOUND'
    if (!gone && !(result.ok && isBookmarkState(result.data) && !result.data.bookmarked)) {
      if (!result.ok && needsLogin(result.code, result.status)) {
        setAnonymous()
        return
      }
      const status = result.ok ? 502 : result.status
      const code = result.ok ? 'BAD_RESPONSE' : result.code
      setItemError({ id, message: interactionMessage(tErrors, code, status, 'bookmark') })
      return
    }

    removed.current.add(id)
    const current = latest.current
    if (current.status === 'ready') {
      const index = current.items.findIndex((item) => item.id === id)
      const row = rowOf(id)
      const active = document.activeElement
      // The row is about to disappear along with the button holding focus: move to the next post, else the previous one, then the page heading.
      if (index !== -1 && (active === null || active === document.body || (row?.contains(active) ?? false))) {
        const staying = (item: PostSummary) => !removePending.current.has(item.id) && !removed.current.has(item.id)
        const neighbour = current.items.slice(index + 1).find(staying) ?? current.items.slice(0, index).reverse().find(staying)
        focusTarget.current = neighbour === undefined ? { kind: 'heading' } : { kind: 'item', id: neighbour.id }
      }
    }
    setList((state) => (state.status === 'ready' ? { ...state, items: state.items.filter((item) => item.id !== id) } : state))
    setAnnouncement(gone ? interactionMessage(tErrors, 'POST_NOT_FOUND', 404, 'bookmark') : t('unsaved'))
    // Unbookmarked every shown post while the server still has a next page: reload the first page, never report "no saved posts".
    if (current.status === 'ready' && current.hasMore && current.items.every((item) => removed.current.has(item.id))) {
      reload()
    }
  }

  return (
    <div className="mt-6">
      {list.status === 'loading' ? (
        <p aria-busy="true" className="py-8 text-center text-sm text-neutral-500 dark:text-neutral-400">
          {t('loading')}
        </p>
      ) : list.status === 'failed' ? (
        <div className="py-8 text-center">
          <p className="text-neutral-700 dark:text-neutral-300">{t('loadFailed')}</p>
          <button
            type="button"
            onClick={() => {
              focusTarget.current = { kind: 'heading' }
              reload()
            }}
            className={`${SECONDARY} mt-4`}
          >
            {t('retry')}
          </button>
        </div>
      ) : list.items.length === 0 ? (
        <div className="py-8 text-center">
          <p className="text-neutral-700 dark:text-neutral-300">{t('empty')}</p>
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">{t('emptyHint')}</p>
        </div>
      ) : (
        <>
          <ul ref={listRef}>
            {list.items.map((post) => (
              <li
                key={post.id}
                data-bookmark-id={post.id}
                className="border-b border-neutral-200 py-6 last:border-0 dark:border-neutral-800"
              >
                <ListRow post={post} headingLevel={2} />
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <button
                    type="button"
                    aria-label={t('unsaveLabel', { title: post.title })}
                    aria-disabled={removing.has(post.id) || undefined}
                    onClick={() => void remove(post)}
                    className={UNSAVE}
                  >
                    <BookmarkIcon filled />
                    <span>{t('unsave')}</span>
                  </button>
                  {itemError?.id === post.id ? (
                    <p role="alert" className="text-sm text-red-700 dark:text-red-300">
                      {itemError.message}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          {list.hasMore ? (
            <div className="mt-6 text-center">
              <button
                type="button"
                onClick={() => void loadMore()}
                aria-disabled={more === 'loading' || undefined}
                className={SECONDARY}
              >
                {more === 'loading' ? t('loading') : t('loadMore')}
              </button>
              {more === 'failed' ? (
                <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">
                  {t('loadFailed')}
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      )}

      {/* Always present, empty when there is nothing to say: a live region must exist BEFORE its text changes. */}
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </div>
  )
}
