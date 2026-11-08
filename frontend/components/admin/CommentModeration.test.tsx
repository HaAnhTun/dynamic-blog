import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AdminComment, CommentStatus } from '@/lib/types'
import CommentModeration from './CommentModeration'
import { createTranslator } from 'next-intl'
import { msg } from '@/test/render-intl'
import { CATALOGS } from '@/test/intl'
import { COMMENT_DATE_TEXT } from '@/test/fixtures/vi/adminUnit-comment-moderation'

// The reload-list button (StaleListNotice) is router.refresh(): here we only need to know it was called.
const router = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => router,
}))

const onHide = vi.fn()
const onRestore = vi.fn()
const onDelete = vi.fn()

afterEach(() => vi.clearAllMocks())

const ID = '11111111-1111-1111-1111-111111111111'

const FIRST_TEXT = 'A great article, thank you author.'
const FIRST_POST = 'The first post'
const AUTHOR = 'John Smith'
const CAPTION_ALL = 'Comments (all), page 1/1'
const CAPTION_VISIBLE = 'Comments (visible), page 1/1'

const comment = (over: Partial<AdminComment> = {}): AdminComment => ({
  id: ID,
  content: FIRST_TEXT,
  status: 'VISIBLE',
  reply: false,
  createdAt: '2026-10-02T19:00:00Z',
  editedAt: null,
  postId: 'p1',
  postSlug: 'the-first-post',
  postTitle: FIRST_POST,
  postStatus: 'PUBLISHED',
  authorId: 'u1',
  authorDisplayName: AUTHOR,
  authorGithubLogin: 'nva',
  authorAvatarUrl: null,
  authorRole: 'USER',
  authorStatus: 'ACTIVE',
  ...over,
})

function renderTable(comments: AdminComment[], statusFilter: CommentStatus | null = null) {
  return render(
    <CommentModeration
      comments={comments}
      caption={CAPTION_ALL}
      statusFilter={statusFilter}
      onHide={onHide}
      onRestore={onRestore}
      onDelete={onDelete}
    />,
  )
}

/** A promise so the test decides when the action answers: the "pending" state becomes observable. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element)
  })
}

/** The row (tr) of the table that holds a comment, found by its content. */
function rowOf(text: string): HTMLElement {
  return screen.getByText(text).closest('tr')!
}

const tableText = createTranslator({
  locale: 'vi',
  messages: CATALOGS.vi as never,
  namespace: 'Admin.comments.table' as never,
}) as unknown as { markup: (key: string, values?: Record<string, unknown>) => string }

/** A catalog message that carries markup (`<strong>`, `<bdi>`), as plain text. */
const plain = (key: string, values: Record<string, unknown> = {}) =>
  tableText.markup(key, { strong: (c: string) => c, bdi: (c: string) => c, ...values })

const word = (key: string) => msg(`Admin.comments.table.${key}`)
/** What the screen reader hears for the comment of `content` by `name`: "comment of {name}: “{excerpt}”". */
const target = (content: string, name: string = AUTHOR) => msg('Admin.comments.table.target', { name, excerpt: content })
/** The accessible name of a row action: its visible word and the target. */
const action = (key: string, content: string = FIRST_TEXT, name: string = AUTHOR) => `${word(key)} ${target(content, name)}`
const startsWith = (text: string) => (name: string) => name.startsWith(text)
const NAME = target(FIRST_TEXT)

describe('CommentModeration: rendering', () => {
  it('one row per comment, in a table with a caption; the notification region exists before any action', () => {
    renderTable([comment(), comment({ id: 'c2', content: 'The second comment' })])

    const table = screen.getByRole('table', { name: CAPTION_ALL })
    expect(within(table).getAllByRole('row')).toHaveLength(3)
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual([
      msg('Site.comments.heading'),
      msg('Admin.comments.table.author'),
      msg('Site.about.readNextLinks.writing'),
      msg('Admin.analytics.daily.day'),
      msg('Admin.dashboard.table.status'),
      msg('Admin.comments.table.actions'),
    ])
    // Always present: a live region must exist before its content changes for the change to be announced.
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('content is plain text and keeps line breaks: HTML tags in a comment never become elements', () => {
    const payload = '<img src=x onerror=alert(1)>\n  indented line'
    const { container } = renderTable([comment({ content: payload })])

    const content = container.querySelector('p.whitespace-pre-wrap')!
    expect(content.textContent).toBe(payload)
    expect(content).toHaveClass('line-clamp-3', '[overflow-wrap:anywhere]')
    expect(container.querySelector('img[src="x"]')).toBeNull()
  })

  it('author: name in <bdi>, @login only when present, never "@null"; a suspended account is stated clearly', () => {
    const { container } = renderTable([
      comment(),
      comment({
        id: 'c2',
        content: 'By the admin',
        authorDisplayName: 'Site Admin',
        authorGithubLogin: null,
        authorRole: 'ADMIN',
      }),
      comment({ id: 'c3', content: 'By a suspended user', authorDisplayName: 'Spammer', authorStatus: 'SUSPENDED' }),
    ])

    const names = Array.from(container.querySelectorAll('bdi')).map((bdi) => bdi.textContent)
    expect(names).toContain(AUTHOR)
    expect(names).toContain('Site Admin')
    expect(within(rowOf(FIRST_TEXT)).getAllByText('@nva').length).toBeGreaterThan(0)
    expect(container.textContent).not.toContain('@null')
    expect(within(rowOf('By a suspended user')).getAllByText(msg('Admin.statuses.user.SUSPENDED')).length).toBeGreaterThan(0)
    expect(within(rowOf(FIRST_TEXT)).queryByText(msg('Admin.statuses.user.SUSPENDED'))).toBeNull()
  })

  it('published post: link to the post comments section, new tab; unpublished post: opens in the editor, never a 404 link', () => {
    renderTable([
      comment(),
      comment({
        id: 'c2',
        content: 'On a draft',
        postTitle: msg('Admin.statuses.post.DRAFT'),
        postSlug: 'ban-nhap',
        postStatus: 'DRAFT',
      }),
    ])

    const links = within(rowOf(FIRST_TEXT)).getAllByRole('link', {
      name: `${FIRST_POST} ${word('viewCommentsSr')}`,
    })
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) {
      expect(link).toHaveAttribute('href', '/posts/the-first-post#binh-luan')
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    }
    // An unpublished post can still be viewed: in the admin editor, new tab, with its status.
    const draftTitle = msg('Admin.statuses.post.DRAFT')
    const draft = rowOf('On a draft')
    const editorLinks = within(draft).getAllByRole('link', {
      name: `${draftTitle} ${msg('Admin.comments.table.postNotPublished', { status: draftTitle.toLowerCase() })} ${word('newTabSr')}`,
    })
    expect(editorLinks.length).toBeGreaterThan(0)
    for (const link of editorLinks) {
      expect(link).toHaveAttribute('href', '/admin/posts/p1/edit')
      expect(link).toHaveAttribute('target', '_blank')
    }
    // No public link at all: /posts/ban-nhap is a 404 for readers. Pinned on purpose: the row
    // now also has a link to the author's Users page, so the check is "no link to /posts/",
    // not "every link goes to the editor".
    const hrefs = within(draft)
      .getAllByRole('link')
      .map((link) => link.getAttribute('href') ?? '')
    expect(hrefs).toContain('/admin/posts/p1/edit')
    expect(hrefs.filter((href) => href.startsWith('/posts/'))).toEqual([])
  })

  it('dates are in UTC (lib/date.ts), not in the server time zone', () => {
    // 19:00Z is 02:00 THE NEXT DAY in Asia/Ho_Chi_Minh, the time zone the test suite pins.
    const { container } = renderTable([comment()])

    const times = Array.from(container.querySelectorAll('time'))
    expect(times.length).toBeGreaterThan(0)
    for (const time of times) {
      expect(time).toHaveAttribute('dateTime', '2026-10-02T19:00:00Z')
      expect(time.textContent).toContain(COMMENT_DATE_TEXT)
    }
  })

  it('a reply carries the "Reply" label; an edited comment says "edited"', () => {
    renderTable([
      comment({ reply: true, content: 'This is a reply' }),
      comment({ id: 'c2', content: 'Original, edited', editedAt: '2026-10-03T00:00:00Z' }),
    ])

    expect(within(rowOf('This is a reply')).getByText(msg('Site.comments.item.reply'))).toBeInTheDocument()
    expect(within(rowOf('Original, edited')).queryByText(msg('Site.comments.item.reply'))).toBeNull()
    expect(within(rowOf('Original, edited')).getByText(msg('Site.comments.item.edited'))).toBeInTheDocument()
  })

  it('buttons follow the status: visible -> "Hide", "Delete"; hidden -> "Unhide", "Delete"; deleted -> no buttons at all', () => {
    renderTable([
      comment(),
      comment({ id: 'c2', status: 'HIDDEN', content: 'Already hidden' }),
      comment({ id: 'c3', status: 'DELETED', content: 'Already deleted' }),
    ])

    const names = (text: string) =>
      within(rowOf(text))
        .queryAllByRole('button')
        .map((b) => b.textContent)
    expect(names(FIRST_TEXT)).toEqual([`${word('hide')} ${NAME}`, `${word('delete')} ${NAME}`])
    expect(names('Already hidden')).toEqual([action('restore', 'Already hidden'), action('delete', 'Already hidden')])
    expect(names('Already deleted')).toEqual([])
    // The status label is text, not just color.
    expect(within(rowOf('Already hidden')).getAllByText(msg('Admin.statuses.comment.HIDDEN')).length).toBeGreaterThan(0)
  })

  it('button name includes the beginning of the comment, shortened when long', () => {
    renderTable([comment({ content: 'A very long comment '.repeat(10) })])

    expect(screen.getByRole('button', { name: action('hide', 'A very long comment A very long comment…') })).toBeInTheDocument()
  })

  it('long comment: "Show full" removes the three-line clamp, aria-expanded follows; a short one has no button', () => {
    const long = 'x '.repeat(200).trim()
    renderTable([comment({ content: long }), comment({ id: 'c2', content: 'Short' })])

    expect(within(rowOf('Short')).queryByRole('button', { name: startsWith(word('expand')) })).toBeNull()
    // A distinct name per comment, like the row buttons: not ten buttons all named like the show-full button.
    const clipped = target(`${'x '.repeat(20).trim()}…`)
    const toggle = screen.getByRole('button', { name: `${word('expand')} ${clipped}` })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText(long)).toHaveClass('line-clamp-3')

    fireEvent.click(toggle)

    expect(screen.getByRole('button', { name: `${word('collapse')} ${clipped}` })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(long)).not.toHaveClass('line-clamp-3')
  })

  it('author is a reader: the name links to the Users page, searching by login (or by name when there is no login)', () => {
    renderTable([comment(), comment({ id: 'c2', content: 'No login', authorDisplayName: 'Mary Jones', authorGithubLogin: null })])

    for (const link of within(rowOf(FIRST_TEXT)).getAllByRole('link', {
      name: `${AUTHOR} ${word('usersPageSr')}`,
    })) {
      expect(link).toHaveAttribute('href', '/admin/users?q=nva')
    }
    const byName = within(rowOf('No login')).getAllByRole('link', { name: `Mary Jones ${word('usersPageSr')}` })
    expect(byName.length).toBeGreaterThan(0)
    for (const link of byName)
      expect(link).toHaveAttribute('href', `/admin/users?q=${encodeURIComponent('Mary Jones').replace(/%20/g, '+')}`)
  })

  it('author is an admin (or an author): no link, because the Users page can only suspend readers', () => {
    renderTable([comment({ content: 'By the admin', authorDisplayName: 'Site Admin', authorRole: 'ADMIN' })])

    expect(within(rowOf('By the admin')).queryByRole('link', { name: (name) => name.includes(word('usersPageSr')) })).toBeNull()
  })

  it('with a per-post filter link (passed by the page): each row has "Only this post", its name says which post', () => {
    render(
      <CommentModeration
        comments={[comment(), comment({ id: 'c2', content: 'Other post comment', postId: 'p2', postTitle: 'The second post' })]}
        caption="c"
        statusFilter={null}
        postFilterHrefs={{ p1: '/admin/comments?post=p1', p2: '/admin/comments?post=p2' }}
        onHide={onHide}
        onRestore={onRestore}
        onDelete={onDelete}
      />,
    )

    const first = within(rowOf(FIRST_TEXT)).getAllByRole('link', {
      name: `${word('onlyThisPost')} ${msg('Admin.comments.table.onlyThisPostSr', { title: FIRST_POST })}`,
    })
    expect(first.length).toBeGreaterThan(0)
    for (const link of first) expect(link).toHaveAttribute('href', '/admin/comments?post=p1')
    for (const link of within(rowOf('Other post comment')).getAllByRole('link', { name: startsWith(word('onlyThisPost')) })) {
      expect(link).toHaveAttribute('href', '/admin/comments?post=p2')
    }
  })

  it('without a per-post filter link (already filtered by that very post): no redundant link', () => {
    renderTable([comment()])

    expect(screen.queryByRole('link', { name: startsWith(word('onlyThisPost')) })).toBeNull()
  })

  it('two long comments by the same author: two "Show full" buttons carry two different names', () => {
    renderTable([
      comment({ content: `First opening ${'a '.repeat(80)}` }),
      comment({ id: 'c2', content: `Second opening ${'b '.repeat(80)}` }),
    ])

    const names = screen.getAllByRole('button', { name: startsWith(word('expand')) }).map((button) => button.textContent)
    expect(names).toHaveLength(2)
    expect(new Set(names).size).toBe(2)
  })
})

describe('CommentModeration: hide and unhide', () => {
  it('hide: while pending the button is aria-disabled and a second click is dropped; when done the label changes, focus moves to "Unhide", a notification appears', async () => {
    const answer = deferred<AdminComment>()
    onHide.mockReturnValue(answer.promise)
    renderTable([comment()])
    const hide = screen.getByRole('button', { name: `${word('hide')} ${NAME}` })
    hide.focus()

    await click(hide)
    await click(hide)

    expect(onHide).toHaveBeenCalledTimes(1)
    expect(onHide).toHaveBeenCalledWith(ID)
    expect(hide).toHaveAttribute('aria-disabled', 'true')
    expect(hide).toHaveFocus()

    await act(async () => answer.resolve(comment({ status: 'HIDDEN' })))

    expect(screen.queryByRole('button', { name: `${word('hide')} ${NAME}` })).toBeNull()
    expect(screen.getByRole('button', { name: `${word('restore')} ${NAME}` })).toHaveFocus()
    expect(within(rowOf(FIRST_TEXT)).getAllByText(msg('Admin.statuses.comment.HIDDEN')).length).toBeGreaterThan(0)
    expect(screen.getByRole('status')).toHaveTextContent(plain('notice.hide', { name: AUTHOR }))
  })

  it('unhide: focus returns to "Hide", notification "Unhidden…"', async () => {
    onRestore.mockResolvedValue(comment())
    renderTable([comment({ status: 'HIDDEN' })])
    const restore = screen.getByRole('button', { name: `${word('restore')} ${NAME}` })
    restore.focus()

    await click(restore)

    expect(onRestore).toHaveBeenCalledWith(ID)
    expect(screen.getByRole('button', { name: `${word('hide')} ${NAME}` })).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent(plain('notice.restore', { name: AUTHOR }))
  })

  it('failure: error sentence right under the row, status unchanged, focus stays on the button for a retry', async () => {
    onHide.mockResolvedValue({ error: msg('Errors.interaction.byCode.COMMENT_NOT_FOUND') })
    renderTable([comment()])
    const hide = screen.getByRole('button', { name: `${word('hide')} ${NAME}` })
    hide.focus()

    await click(hide)

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Errors.interaction.byCode.COMMENT_NOT_FOUND'))
    expect(hide).toHaveFocus()
    expect(hide).not.toHaveAttribute('aria-disabled')
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('action rejected (network down): the "cannot connect" sentence, nothing thrown', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    onHide.mockRejectedValue(new TypeError('Failed to fetch'))
    renderTable([comment()])

    await click(screen.getByRole('button', { name: `${word('hide')} ${NAME}` }))

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Errors.admin.unreachable'))
    log.mockRestore()
  })

  it('session expired (redirect error): the router navigates by itself, no error is shown', async () => {
    onHide.mockRejectedValue(Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;push;/admin/login;307;' }))
    renderTable([comment()])

    await click(screen.getByRole('button', { name: `${word('hide')} ${NAME}` }))

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('user already tabbed elsewhere while waiting: focus is not pulled back', async () => {
    const answer = deferred<AdminComment>()
    onHide.mockReturnValue(answer.promise)
    renderTable([comment(), comment({ id: 'c2', content: 'Another comment' })])

    await click(screen.getByRole('button', { name: `${word('hide')} ${NAME}` }))
    const elsewhere = within(rowOf('Another comment')).getByRole('button', { name: startsWith(word('delete')) })
    elsewhere.focus()
    await act(async () => answer.resolve(comment({ status: 'HIDDEN' })))

    expect(elsewhere).toHaveFocus()
  })
})

describe('CommentModeration: fresh data from the server', () => {
  it('re-entering this very URL (same key): the server list replaces the old list', () => {
    const props = { caption: 'c', statusFilter: null, onHide, onRestore, onDelete }
    const { rerender } = render(<CommentModeration comments={[comment()]} {...props} />)

    rerender(<CommentModeration comments={[comment({ id: 'c9', content: 'A newly arrived comment' })]} {...props} />)

    expect(screen.getByText('A newly arrived comment')).toBeInTheDocument()
    expect(screen.queryByText(FIRST_TEXT)).toBeNull()
  })

  it('parent re-renders with the SAME list: a change just made in place is not overwritten', async () => {
    onHide.mockResolvedValue(comment({ status: 'HIDDEN' }))
    const comments = [comment()]
    const props = { caption: 'c', statusFilter: null, onHide, onRestore, onDelete }
    const { rerender } = render(<CommentModeration comments={comments} {...props} />)

    await click(screen.getByRole('button', { name: `${word('hide')} ${NAME}` }))
    rerender(<CommentModeration comments={comments} {...props} />)

    expect(screen.getByRole('button', { name: `${word('restore')} ${NAME}` })).toBeInTheDocument()
  })
})

describe('CommentModeration: row leaves the current filter', () => {
  const RELOAD = msg('Admin.common.staleList.reload')
  const STALE_NOTICE = (count: number) => msg('Admin.common.staleList.notice', { count, unit: 'comment', kept: 'undo' })

  it('filter "Visible", hide a comment: warns the pagination is stale, "Reload list" redraws the page; undoing removes the notice', async () => {
    onHide.mockResolvedValue(comment({ status: 'HIDDEN' }))
    onRestore.mockResolvedValue(comment())
    renderTable([comment(), comment({ id: 'c2', content: 'Another comment' })], 'VISIBLE')
    expect(screen.queryByRole('button', { name: RELOAD })).toBeNull()

    await click(screen.getByRole('button', { name: `${word('hide')} ${NAME}` }))

    // The row stays in place for undo, but the server next page will skip a comment that just moved up.
    expect(screen.getByText(STALE_NOTICE(1))).toBeInTheDocument()
    const reload = screen.getByRole('button', { name: RELOAD })
    expect(reload).toHaveAccessibleDescription(STALE_NOTICE(1))
    await click(reload)
    expect(router.refresh).toHaveBeenCalledTimes(1)

    await click(screen.getByRole('button', { name: `${word('restore')} ${NAME}` }))
    expect(screen.queryByRole('button', { name: RELOAD })).toBeNull()
  })

  it('counts every row that left: deleting under "Hidden" also leaves', async () => {
    onRestore.mockResolvedValue(comment())
    onDelete.mockResolvedValue(null)
    renderTable([comment({ status: 'HIDDEN' }), comment({ id: 'c2', status: 'HIDDEN', content: 'Another comment' })], 'HIDDEN')

    await click(screen.getByRole('button', { name: `${word('restore')} ${NAME}` }))
    await click(screen.getByRole('button', { name: action('delete', 'Another comment') }))
    await click(within(screen.getByRole('group')).getByRole('button', { name: msg('Site.comments.item.delete') }))

    expect(screen.getByText(STALE_NOTICE(2))).toBeInTheDocument()
  })

  it('"All": no row can leave, the notice never appears', async () => {
    onHide.mockResolvedValue(comment({ status: 'HIDDEN' }))
    renderTable([comment()], null)

    await click(screen.getByRole('button', { name: `${word('hide')} ${NAME}` }))

    expect(screen.queryByRole('button', { name: RELOAD })).toBeNull()
    expect(screen.queryByText(STALE_NOTICE(1))).toBeNull()
  })

  it('fresh list arrives after reloading: notice disappears, focus moves from the button to the table instead of falling into <body>', async () => {
    onHide.mockResolvedValue(comment({ status: 'HIDDEN' }))
    const props = { caption: CAPTION_VISIBLE, statusFilter: 'VISIBLE' as const, onHide, onRestore, onDelete }
    const { rerender } = render(
      <CommentModeration comments={[comment(), comment({ id: 'c2', content: 'The remaining one' })]} {...props} />,
    )
    await click(screen.getByRole('button', { name: `${word('hide')} ${NAME}` }))
    const reload = screen.getByRole('button', { name: RELOAD })
    reload.focus()
    await click(reload)

    // The server redraws the page: the comment just hidden no longer belongs to the visible filter.
    rerender(<CommentModeration comments={[comment({ id: 'c2', content: 'The remaining one' })]} {...props} />)

    expect(screen.queryByText(FIRST_TEXT)).toBeNull()
    expect(screen.queryByRole('button', { name: RELOAD })).toBeNull()
    expect(screen.getByRole('table', { name: CAPTION_VISIBLE })).toHaveFocus()
  })

  it('user moved elsewhere while reloading: focus is not pulled back to the table', async () => {
    onHide.mockResolvedValue(comment({ status: 'HIDDEN' }))
    const props = { caption: 'c', statusFilter: 'VISIBLE' as const, onHide, onRestore, onDelete }
    const { rerender } = render(
      <CommentModeration comments={[comment(), comment({ id: 'c2', content: 'The remaining one' })]} {...props} />,
    )
    await click(screen.getByRole('button', { name: `${word('hide')} ${NAME}` }))
    await click(screen.getByRole('button', { name: RELOAD }))
    const elsewhere = screen.getByRole('button', { name: action('hide', 'The remaining one') })
    elsewhere.focus()

    rerender(<CommentModeration comments={[comment({ id: 'c2', content: 'The remaining one' })]} {...props} />)

    expect(screen.getByRole('button', { name: action('hide', 'The remaining one') })).toHaveFocus()
  })
})

describe('CommentModeration: delete', () => {
  it('confirms in place with the exact sentence from the design, focus on "Cancel"; Escape cancels and returns focus to "Delete"', async () => {
    renderTable([comment()])

    await click(screen.getByRole('button', { name: `${word('delete')} ${NAME}` }))

    const group = screen.getByRole('group', { name: plain('confirmDelete') })
    expect(within(group).getByRole('button', { name: msg('Site.comments.form.cancel') })).toHaveFocus()
    // While confirming, the row buttons make room: a comment awaiting deletion cannot be hidden.
    expect(screen.queryByRole('button', { name: `${word('hide')} ${NAME}` })).toBeNull()

    await act(async () => {
      fireEvent.keyDown(within(group).getByRole('button', { name: msg('Site.comments.form.cancel') }), { key: 'Escape' })
    })

    expect(screen.queryByRole('group')).toBeNull()
    expect(screen.getByRole('button', { name: `${word('delete')} ${NAME}` })).toHaveFocus()
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('"Cancel" with the mouse also returns focus to "Delete"', async () => {
    renderTable([comment()])

    await click(screen.getByRole('button', { name: `${word('delete')} ${NAME}` }))
    await click(screen.getByRole('button', { name: msg('Site.comments.form.cancel') }))

    expect(screen.getByRole('button', { name: `${word('delete')} ${NAME}` })).toHaveFocus()
  })

  it('after deleting: becomes "Deleted", no buttons left, focus returns to that row, a notification appears', async () => {
    const answer = deferred<null>()
    onDelete.mockReturnValue(answer.promise)
    renderTable([comment()])

    await click(screen.getByRole('button', { name: `${word('delete')} ${NAME}` }))
    const confirm = within(screen.getByRole('group')).getByRole('button', { name: msg('Site.comments.item.delete') })
    confirm.focus()
    await click(confirm)
    await click(confirm)

    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onDelete).toHaveBeenCalledWith(ID)
    expect(within(screen.getByRole('group')).getByRole('button', { name: msg('Site.comments.item.deleting') })).toHaveAttribute(
      'aria-disabled',
      'true',
    )

    await act(async () => answer.resolve(null))

    const row = rowOf(FIRST_TEXT)
    expect(screen.queryByRole('group')).toBeNull()
    expect(within(row).queryAllByRole('button')).toEqual([])
    expect(within(row).getAllByText(msg('Admin.statuses.comment.DELETED')).length).toBeGreaterThan(0)
    expect(row.querySelector('td')).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent(plain('notice.delete', { name: AUTHOR }))
  })

  it('delete failure: error sentence inside the confirm panel, panel stays open for a retry; cancelling always clears the error', async () => {
    onDelete.mockResolvedValue({ error: msg('Errors.interaction.byCode.COMMENT_NOT_FOUND') })
    renderTable([comment()])

    await click(screen.getByRole('button', { name: `${word('delete')} ${NAME}` }))
    await click(within(screen.getByRole('group')).getByRole('button', { name: msg('Site.comments.item.delete') }))

    const group = screen.getByRole('group')
    expect(within(group).getByRole('alert')).toHaveTextContent(msg('Errors.interaction.byCode.COMMENT_NOT_FOUND'))
    expect(within(group).getByRole('button', { name: msg('Site.comments.item.delete') })).not.toHaveAttribute('aria-disabled')

    await click(within(group).getByRole('button', { name: msg('Site.comments.form.cancel') }))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
