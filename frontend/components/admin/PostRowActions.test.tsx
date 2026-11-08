import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PostListActions, { type BulkOutcome, type FeatureOutcome, type ListPost } from './PostListActions'
import PostRowActions from './PostRowActions'
import { msg } from '@/test/render-intl'

const onSetPublished = vi.fn<(ids: string[], published: boolean) => Promise<BulkOutcome>>()
const onDelete = vi.fn<(ids: string[]) => Promise<BulkOutcome>>()
const onFeature = vi.fn<(id: string) => Promise<FeatureOutcome>>()
const onUnfeature = vi.fn<(id: string) => Promise<FeatureOutcome>>()

afterEach(() => vi.clearAllMocks())

const ID = '11111111-1111-1111-1111-111111111111'
const draft: ListPost = { id: ID, title: 'Draft about the queue', status: 'DRAFT', featured: false }
const other: ListPost = { id: 'other', title: 'Another post', status: 'PUBLISHED', featured: false }

/** A two-row table inside PostListActions, as the list page builds it. */
function Rows({ items }: { items: ListPost[] }) {
  return (
    <ul>
      {items.map((post) => (
        <li key={post.id}>
          <p>{post.title}</p>
          <PostRowActions post={post} />
        </li>
      ))}
    </ul>
  )
}

function renderRows(items: ListPost[] = [draft, other], author = false) {
  const handlers = { onSetPublished, onDelete, onFeature, onUnfeature }
  const view = render(
    <PostListActions posts={items} author={author} {...handlers}>
      <Rows items={items} />
    </PostListActions>,
  )
  return {
    ...view,
    serverRerender: (next: ListPost[]) =>
      view.rerender(
        <PostListActions posts={next} author={author} {...handlers}>
          <Rows items={next} />
        </PostListActions>,
      ),
  }
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element)
  })
}

const NAME = `“${draft.title}”`
const OTHER = `“${other.title}”`
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const row = (key: string, name: string) => `${msg(`Admin.posts.row.${key}`)} ${name}`
const deleteName = (name: string) => `${msg('Admin.posts.row.delete')} ${msg('Admin.posts.row.deleteSr', { title: name })}`

describe('PostRowActions: the paths', () => {
  it('preview and ZIP download: a separate link per post, the name says which post', () => {
    renderRows()

    expect(screen.getByRole('link', { name: row('preview', NAME) })).toHaveAttribute('href', `/admin/posts/${ID}/preview`)
    const download = screen.getByRole('link', { name: row('download', NAME) })
    expect(download).toHaveAttribute('href', `/admin/posts/${ID}/export`)
    expect(download).toHaveAttribute('download')
  })

  it('button follows the status: draft → "Publish"; published → "Unpublish"; "Best posts" is a toggle button', () => {
    renderRows([draft, { ...other, featured: true }])

    expect(screen.getByRole('button', { name: row('publish', NAME) })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: row('unpublish', OTHER) })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: row('featured', NAME) })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: row('featured', OTHER) })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: deleteName(NAME) })).toBeInTheDocument()
  })
})

describe('PostRowActions: publish and unpublish', () => {
  it('"Publish" calls the bulk action with exactly one id; reports the result in the shared notification line', async () => {
    onSetPublished.mockResolvedValue({ done: [ID], skipped: [], failed: [] })
    renderRows()

    await click(screen.getByRole('button', { name: row('publish', NAME) }))

    expect(onSetPublished).toHaveBeenCalledExactlyOnceWith([ID], true)
    expect(screen.getByRole('status')).toHaveTextContent(msg('Admin.posts.row.announcePublished', { title: NAME }))
  })

  it('the server redraws with the new status: the same button changes its text to "Unpublish", focus stays there', async () => {
    onSetPublished.mockResolvedValue({ done: [ID], skipped: [], failed: [] })
    const { serverRerender } = renderRows()
    const toggle = screen.getByRole('button', { name: row('publish', NAME) })
    toggle.focus()

    await click(toggle)
    serverRerender([{ ...draft, status: 'PUBLISHED' }, other])

    expect(screen.getByRole('button', { name: row('unpublish', NAME) })).toHaveFocus()
  })

  it('the row moves when redrawn (sorting by "Recently edited") and focus is lost: focus is put back on that button', async () => {
    onSetPublished.mockResolvedValue({ done: [ID], skipped: [], failed: [] })
    const { serverRerender } = renderRows()
    await click(screen.getByRole('button', { name: row('publish', NAME) }))
    // Like the browser when React moves a row holding the focused element elsewhere: focus goes to <body>.
    ;(document.activeElement as HTMLElement | null)?.blur()

    serverRerender([other, { ...draft, status: 'PUBLISHED' }])

    expect(screen.getByRole('button', { name: row('unpublish', NAME) })).toHaveFocus()
  })

  it('while filtering "Draft": a just-published post leaves the list; focus goes to the notification line instead of falling to <body>', async () => {
    onSetPublished.mockResolvedValue({ done: [ID], skipped: [], failed: [] })
    const { serverRerender } = renderRows()
    const toggle = screen.getByRole('button', { name: row('publish', NAME) })
    toggle.focus()

    await click(toggle)
    serverRerender([other])

    expect(screen.getByRole('status')).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent(msg('Admin.posts.row.announcePublished', { title: NAME }))
  })

  it('publish fails (missing category): the reason right under the row, focus stays on the button for a retry', async () => {
    onSetPublished.mockResolvedValue({
      done: [],
      skipped: [],
      failed: [{ id: ID, error: 'Cannot publish: a saved post needs content and a category.' }],
    })
    renderRows()
    const toggle = screen.getByRole('button', { name: row('publish', NAME) })
    toggle.focus()

    await click(toggle)

    expect(screen.getByRole('alert')).toHaveTextContent('Cannot publish: a saved post needs content and a category.')
    expect(toggle).toHaveFocus()
    expect(toggle).not.toHaveAttribute('aria-disabled')
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('unpublishing a post already unpublished in another tab: says so plainly, not as an error', async () => {
    onSetPublished.mockResolvedValue({ done: [], skipped: ['other'], failed: [] })
    renderRows()

    await click(screen.getByRole('button', { name: row('unpublish', OTHER) }))

    expect(onSetPublished).toHaveBeenCalledWith(['other'], false)
    expect(screen.getByRole('status')).toHaveTextContent(msg('Admin.posts.row.skippedUnpublished', { title: OTHER }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('pending: the button is aria-disabled (keeping focus), a second click is dropped', async () => {
    let resolve!: (value: BulkOutcome) => void
    onSetPublished.mockReturnValue(new Promise((done) => (resolve = done)))
    renderRows()
    const toggle = screen.getByRole('button', { name: row('publish', NAME) })

    await click(toggle)
    await click(toggle)

    expect(onSetPublished).toHaveBeenCalledTimes(1)
    expect(toggle).toHaveAttribute('aria-disabled', 'true')
    await act(async () => resolve({ done: [ID], skipped: [], failed: [] }))
  })
})

describe('PostRowActions: featured posts', () => {
  it('on: calls feature; off: calls unfeature; reports with its own sentence', async () => {
    onFeature.mockResolvedValue({ id: ID })
    onUnfeature.mockResolvedValue({ id: 'other' })
    renderRows([draft, { ...other, featured: true }])

    await click(screen.getByRole('button', { name: row('featured', NAME) }))
    expect(onFeature).toHaveBeenCalledExactlyOnceWith(ID)
    expect(screen.getByRole('status')).toHaveTextContent(msg('Admin.posts.row.announceFeatured', { title: NAME }))

    await click(screen.getByRole('button', { name: row('featured', OTHER) }))
    expect(onUnfeature).toHaveBeenCalledExactlyOnceWith('other')
    expect(screen.getByRole('status')).toHaveTextContent(msg('Admin.curated.removed', { title: other.title }))
  })

  it('failure: error sentence under the row', async () => {
    onFeature.mockResolvedValue({ error: msg('Errors.admin.codes.POST_NOT_FOUND') })
    renderRows()

    await click(screen.getByRole('button', { name: row('featured', NAME) }))

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Errors.admin.codes.POST_NOT_FOUND'))
  })
})

describe('PostRowActions: delete', () => {
  it('in-place confirmation names the post, focus on "Cancel"; Escape cancels and returns focus to "Delete"', async () => {
    renderRows()

    await click(screen.getByRole('button', { name: deleteName(NAME) }))

    const confirm = screen.getByRole('group', {
      name: new RegExp(`^${escapeRegExp(msg('Admin.posts.row.confirmQuestion', { title: NAME }))}`),
    })
    expect(confirm).toHaveTextContent(msg('Admin.postImages.deleteDetails'))
    expect(within(confirm).getByRole('button', { name: msg('Site.comments.form.cancel') })).toHaveFocus()

    await act(async () => {
      fireEvent.keyDown(within(confirm).getByRole('button', { name: msg('Site.comments.form.cancel') }), { key: 'Escape' })
    })
    expect(screen.queryByRole('group')).toBeNull()
    expect(screen.getByRole('button', { name: deleteName(NAME) })).toHaveFocus()
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('an author is told the post leaves the site and their list and an administrator keeps it: no "cannot be undone", no "permanently"', async () => {
    renderRows([draft, other], true)

    await click(screen.getByRole('button', { name: deleteName(NAME) }))

    const confirm = screen.getByRole('group')
    expect(confirm).toHaveTextContent(msg('Admin.posts.row.author.consequences'))
    expect(confirm).not.toHaveTextContent(msg('Admin.posts.row.consequences'))
    expect(within(confirm).queryByRole('button', { name: msg('Admin.posts.row.deleteForever') })).toBeNull()
    expect(within(confirm).getByRole('button', { name: msg('Admin.posts.row.author.confirm') })).toBeInTheDocument()
  })

  it('the author confirming deletes with the same action as an administrator: one id, once', async () => {
    onDelete.mockResolvedValue({ done: [ID], skipped: [], failed: [] })
    renderRows([draft, other], true)
    await click(screen.getByRole('button', { name: deleteName(NAME) }))

    await click(within(screen.getByRole('group')).getByRole('button', { name: msg('Admin.posts.row.author.confirm') }))

    expect(onDelete).toHaveBeenCalledExactlyOnceWith([ID])
  })

  it('published post: the confirmation says the public path will become a 404', async () => {
    renderRows()

    await click(screen.getByRole('button', { name: deleteName(OTHER) }))

    expect(screen.getByRole('group')).toHaveTextContent(msg('Admin.posts.row.publishedWarning'))
  })

  it('"Delete permanently": one id, once; the row disappears when the server redraws, focus goes to the notification line', async () => {
    onDelete.mockResolvedValue({ done: [ID], skipped: [], failed: [] })
    const { serverRerender } = renderRows()
    await click(screen.getByRole('button', { name: deleteName(NAME) }))
    const confirm = within(screen.getByRole('group')).getByRole('button', { name: msg('Admin.posts.delete.forever') })
    confirm.focus()

    await click(confirm)
    serverRerender([other])

    expect(onDelete).toHaveBeenCalledExactlyOnceWith([ID])
    expect(screen.getByRole('status')).toHaveTextContent(msg('Admin.posts.row.announceDeleted', { title: NAME }))
    expect(screen.getByRole('status')).toHaveFocus()
  })

  it('delete fails: error in the confirmation panel, the panel stays open, focus goes to "Cancel"', async () => {
    onDelete.mockResolvedValue({
      done: [],
      skipped: [],
      failed: [{ id: ID, error: msg('Errors.admin.codes.FORBIDDEN') }],
    })
    renderRows()
    await click(screen.getByRole('button', { name: deleteName(NAME) }))

    await click(within(screen.getByRole('group')).getByRole('button', { name: msg('Admin.posts.delete.forever') }))

    const group = screen.getByRole('group')
    expect(within(group).getByRole('alert')).toHaveTextContent(msg('Errors.admin.codes.FORBIDDEN'))
    expect(within(group).getByRole('button', { name: msg('Site.comments.form.cancel') })).toHaveFocus()
  })

  it('action rejected (network down): the "could not reach the server" sentence, nothing thrown', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    onDelete.mockRejectedValue(new TypeError('Failed to fetch'))
    renderRows()
    await click(screen.getByRole('button', { name: deleteName(NAME) }))

    await click(within(screen.getByRole('group')).getByRole('button', { name: msg('Admin.posts.delete.forever') }))

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Errors.admin.unreachable'))
    log.mockRestore()
  })
})
