import { expect, type Locator, type Page } from '@playwright/test'
import type { CommentPage, CommentThread, PublicComment } from '../../lib/types'
import { msg } from './i18n'

/**
 * The comment section at the bottom of the post page (components/site/comments/) as a reader sees it, and
 * the list of comments as the backend returns it. Shared by the comment, moderation and overflow specs.
 */

/** The section's text (CommentSection.tsx, CommentItem.tsx): readers see exactly these sentences. */
export const COMMENT_TEXT = {
  rootLabel: msg('Site.comments.rootForm.label'),
  replyLabel: msg('Site.comments.replyForm.label'),
  editLabel: msg('Site.comments.item.editLabel'),
  loginCta: msg('Site.comments.loginPrompt'),
  more: msg('Site.comments.loadMore'),
  empty: msg('Site.comments.empty'),
  loadFailed: msg('Site.comments.loadFailed'),
  deleted: msg('Site.comments.item.deleted'),
  hidden: msg('Site.comments.item.hidden'),
  invalidLength: msg('Errors.interaction.invalid.comment'),
} as const

/** `<section id="binh-luan" aria-labelledby>`: the region named "Comments". */
export function commentsSection(page: Page): Locator {
  return page.getByRole('region', { name: msg('Site.comments.heading'), exact: true })
}

/** The guest's sign-in invitation in the comment section. */
export function commentLoginLink(section: Locator): Locator {
  return section.getByRole('link', { name: COMMENT_TEXT.loginCta, exact: true })
}

/** The root comment form (only present once signed in). */
export function rootComposer(section: Locator): Locator {
  return section.locator('form').filter({ has: section.page().getByLabel(COMMENT_TEXT.rootLabel, { exact: true }) })
}

/**
 * A comment by author name (the accessible name of the `<article>`, i.e. the name `<bdi>`) and a piece of its
 * content. A reply is its own `<article>`, not inside the root's `<article>`.
 *
 * `scope` is `Page` when the locator is the `has` condition of another locator: the condition is searched inside
 * the outer element, so it must not carry the comment section's locator chain along.
 */
export function commentArticle(scope: Page | Locator, author: string, content: string): Locator {
  return scope.getByRole('article', { name: author, exact: true }).filter({ hasText: content })
}

/** The content paragraph of a comment: the `<p>` holding `content` (the name, @login and time lines do not contain it). */
export function commentBody(article: Locator, content: string): Locator {
  return article.locator('p', { hasText: content })
}

/** Every comment `<article>` currently shown, roots and replies, in page order. */
export function commentIds(section: Locator): Promise<string[]> {
  return section
    .locator('article[data-comment-id]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-comment-id') ?? ''))
}

export type OpenCommentsOptions = {
  /** Signed in (waiting for the root form), guest (waiting for the invitation), or unknown (waiting for either). */
  signedIn?: boolean
  /**
   * Click the "load more comments" button until the end. The temporary post is shared by the whole spec: a comment just built by a later
   * test may not be on the first page (10 roots per page).
   */
  all?: boolean
}

/**
 * Scroll to the comment section (it only loads when near the screen) and wait for the first page: the loading frame
 * (`aria-busy`) disappears, there is no error notice, and the root form or the sign-in invitation has shown.
 */
export async function openComments(page: Page, { signedIn, all = false }: OpenCommentsOptions = {}): Promise<Locator> {
  const section = commentsSection(page)
  await section.scrollIntoViewIfNeeded()
  await expect(section.locator('[aria-busy="true"]')).toHaveCount(0)
  await expect(section.getByText(COMMENT_TEXT.loadFailed, { exact: true })).toHaveCount(0)
  const composer = section.getByLabel(COMMENT_TEXT.rootLabel, { exact: true })
  const login = commentLoginLink(section)
  if (signedIn === true) await expect(composer).toBeVisible()
  else if (signedIn === false) await expect(login).toBeVisible()
  else await expect(composer.or(login)).toBeVisible()
  if (all) await loadAllComments(page, section)
  return section
}

/** A GET request for a page of comments through the BFF; `more`: only the later pages (with an `after` cursor). */
export function isCommentPageRequest(url: string, more: boolean): boolean {
  const parsed = new URL(url)
  if (!/^\/api\/posts\/[^/]+\/comments$/.test(parsed.pathname)) return false
  return !more || parsed.searchParams.has('after')
}

/**
 * Click the "load more comments" button until the pages run out. Each time wait for that page to come back, then wait for the list to stop being
 * `aria-busy`: the button and the new cursor are only correct after that paint.
 */
export async function loadAllComments(page: Page, section: Locator): Promise<void> {
  const more = section.getByRole('button', { name: COMMENT_TEXT.more, exact: true })
  for (let round = 0; round < 50; round += 1) {
    if ((await more.count()) === 0) return
    const loaded = page.waitForResponse(
      (response) => response.request().method() === 'GET' && isCommentPageRequest(response.url(), true),
    )
    await more.click()
    expect((await loaded).status(), 'GET of the next comment page').toBe(200)
    await expect(section.locator('ol[aria-busy="true"]')).toHaveCount(0)
  }
  throw new Error('The "load more comments" button is still there after 50 pages')
}

/** Every thread of a post, walking all the keyset pages of `read` (a guest or a specific person). */
export async function allThreads(read: (after?: string) => Promise<CommentPage>): Promise<CommentThread[]> {
  const threads: CommentThread[] = []
  let after: string | undefined
  for (let round = 0; round < 50; round += 1) {
    const page = await read(after)
    threads.push(...page.threads)
    if (page.nextCursor === null) return threads
    after = page.nextCursor
  }
  throw new Error('The post has more than 50 pages of comments')
}

/** A comment (root or reply) with exactly this content in the threads; undefined when absent. */
export function findComment(threads: CommentThread[], content: string): PublicComment | undefined {
  for (const thread of threads) {
    if (thread.comment.content === content) return thread.comment
    const reply = thread.replies.find((candidate) => candidate.content === content)
    if (reply) return reply
  }
  return undefined
}
