import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PostListActions, { RowCheckbox, SelectAllCheckbox, type BulkOutcome, type ListPost } from './PostListActions'
import { msg } from '@/test/render-intl'

const onSetPublished = vi.fn<(ids: string[], published: boolean) => Promise<BulkOutcome>>()
const onDelete = vi.fn<(ids: string[]) => Promise<BulkOutcome>>()
const onFeature = vi.fn()
const onUnfeature = vi.fn()

afterEach(() => vi.clearAllMocks())

const posts: ListPost[] = [
  { id: 'a', title: 'Published post', status: 'PUBLISHED', featured: false },
  { id: 'b', title: 'Draft one', status: 'DRAFT', featured: false },
  { id: 'c', title: 'Draft two', status: 'DRAFT', featured: true },
]

/** A fake table: exactly how the list page places the two kinds of checkboxes (the "select whole page" box at the table head, one per row). */
function Table({ items }: { items: ListPost[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>
            <SelectAllCheckbox />
          </th>
        </tr>
      </thead>
      <tbody>
        {items.map((post) => (
          <tr key={post.id}>
            <td>
              <RowCheckbox id={post.id} title={post.title} />
            </td>
            <td>{post.title}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function renderList(items: ListPost[] = posts, author = false) {
  const actions = { onSetPublished, onDelete, onFeature, onUnfeature }
  const view = render(
    <PostListActions posts={items} author={author} {...actions}>
      <Table items={items} />
    </PostListActions>,
  )
  return {
    ...view,
    /** The server redraws the page after updateTag: the new list enters the SAME tree. */
    serverRerender: (next: ListPost[]) =>
      view.rerender(
        <PostListActions posts={next} author={author} {...actions}>
          <Table items={next} />
        </PostListActions>,
      ),
  }
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element)
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const startsWith = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
const SELECTED_PREFIX = startsWith(msg('Admin.posts.list.selected', { count: '#' }).split('#')[0])
const UNPUBLISH_PREFIX = startsWith(msg('Admin.posts.list.unpublishN', { count: '#' }).split('#')[0])
const SELECT_ROW_PREFIX = startsWith(msg('Admin.posts.list.selectRowAria', { title: '#' }).split('#')[0])
const CONFIRM_PREFIX = startsWith(msg('Admin.posts.list.confirmQuestion', { count: '#' }).split('#')[0])

const bar = () => screen.getByRole('group', { name: SELECTED_PREFIX })

describe('PostListActions: selecting posts', () => {
  it('each row has a checkbox with its own name; with nothing selected there is no action bar, the notification region exists', () => {
    renderList()

    expect(
      screen.getByRole('checkbox', { name: msg('Admin.posts.list.selectRowAria', { title: 'Draft one' }) }),
    ).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: msg('Admin.posts.list.selectAllAria', { count: '3' }) })).not.toBeChecked()
    expect(screen.queryByRole('group', { name: SELECTED_PREFIX })).toBeNull()
    // Always present: a live region must exist before its content changes for the change to be announced.
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('select a few posts: the bar shows the selected count and exactly how many posts each action will change; the "select page" box is indeterminate', async () => {
    renderList()

    await click(screen.getByRole('checkbox', { name: msg('Admin.posts.list.selectRowAria', { title: 'Published post' }) }))
    await click(screen.getByRole('checkbox', { name: msg('Admin.posts.list.selectRowAria', { title: 'Draft one' }) }))

    expect(bar()).toHaveAccessibleName(msg('Admin.posts.list.selected', { count: '2' }))
    // Do not send useless work: only drafts can be published, only published posts can be unpublished.
    expect(within(bar()).getByRole('button', { name: msg('Admin.posts.list.publishN', { count: '1' }) })).toBeInTheDocument()
    expect(within(bar()).getByRole('button', { name: msg('Admin.posts.list.unpublishN', { count: '1' }) })).toBeInTheDocument()
    expect(within(bar()).getByRole('button', { name: msg('Admin.posts.list.deleteN', { count: '2' }) })).toBeInTheDocument()
    const all = screen.getByRole('checkbox', { name: msg('Admin.posts.list.selectAllAria', { count: '3' }) }) as HTMLInputElement
    expect(all.checked).toBe(false)
    expect(all.indeterminate).toBe(true)
  })

  it('only drafts selected: there is no "Unpublish" button', async () => {
    renderList()

    await click(screen.getByRole('checkbox', { name: msg('Admin.posts.list.selectRowAria', { title: 'Draft one' }) }))

    expect(within(bar()).queryByRole('button', { name: UNPUBLISH_PREFIX })).toBeNull()
    expect(within(bar()).getByRole('button', { name: msg('Admin.posts.list.publishN', { count: '1' }) })).toBeInTheDocument()
  })

  it('"select page" selects every row, pressing again clears all; "Clear selection" also clears all and moves focus to the "select page" box', async () => {
    renderList()
    const all = screen.getByRole('checkbox', { name: msg('Admin.posts.list.selectAllAria', { count: '3' }) })

    await click(all)
    expect(all).toBeChecked()
    expect(screen.getAllByRole('checkbox', { name: SELECT_ROW_PREFIX }).every((box) => (box as HTMLInputElement).checked)).toBe(
      true,
    )
    expect(bar()).toHaveAccessibleName(msg('Admin.posts.list.selected', { count: '3' }))

    await click(all)
    expect(screen.queryByRole('group', { name: SELECTED_PREFIX })).toBeNull()

    await click(all)
    await click(within(bar()).getByRole('button', { name: msg('Admin.posts.list.clearSelection') }))
    expect(screen.queryByRole('group', { name: SELECTED_PREFIX })).toBeNull()
    expect(all).toHaveFocus()
  })
})

describe('PostListActions: bulk publish and unpublish', () => {
  it('"Publish" sends only the selected drafts, once; when done it reports, clears the selection, focus goes to the notification line', async () => {
    onSetPublished.mockResolvedValue({ done: ['b', 'c'], skipped: [], failed: [] })
    renderList()
    await click(screen.getByRole('checkbox', { name: msg('Admin.posts.list.selectAllAria', { count: '3' }) }))
    const publish = within(bar()).getByRole('button', { name: msg('Admin.posts.list.publishN', { count: '2' }) })
    publish.focus()

    await click(publish)

    expect(onSetPublished).toHaveBeenCalledExactlyOnceWith(['b', 'c'], true)
    expect(screen.getByRole('status')).toHaveTextContent(msg('Admin.posts.list.doneAll.publish', { count: '2' }))
    // The changed posts leave the selection; the bar disappears with the button just pressed, focus does not fall back to <body>.
    expect(
      screen.getByRole('checkbox', { name: msg('Admin.posts.list.selectRowAria', { title: 'Draft one' }) }),
    ).not.toBeChecked()
    expect(screen.getByRole('status')).toHaveFocus()
  })

  it('pending: the buttons are aria-disabled (keeping focus), a second click is dropped', async () => {
    const answer = deferred<BulkOutcome>()
    onSetPublished.mockReturnValue(answer.promise)
    renderList()
    await click(screen.getByRole('checkbox', { name: msg('Admin.posts.list.selectRowAria', { title: 'Published post' }) }))
    const unpublish = within(bar()).getByRole('button', { name: msg('Admin.posts.list.unpublishN', { count: '1' }) })
    unpublish.focus()

    await click(unpublish)
    await click(unpublish)

    expect(onSetPublished).toHaveBeenCalledTimes(1)
    expect(onSetPublished).toHaveBeenCalledWith(['a'], false)
    expect(unpublish).toHaveAttribute('aria-disabled', 'true')
    expect(unpublish).toHaveFocus()
    await act(async () => answer.resolve({ done: ['a'], skipped: [], failed: [] }))
    expect(screen.getByRole('status')).toHaveTextContent(msg('Admin.posts.list.doneAll.unpublish', { count: '1' }))
  })

  it('partial failure: reports the changed count, lists the title of each failed post with its reason; failed posts stay selected for a retry', async () => {
    onSetPublished.mockResolvedValue({
      done: ['b'],
      skipped: [],
      failed: [{ id: 'c', error: 'Cannot publish: a saved post needs content and a category.' }],
    })
    renderList()
    await click(screen.getByRole('checkbox', { name: msg('Admin.posts.list.selectRowAria', { title: 'Draft one' }) }))
    await click(screen.getByRole('checkbox', { name: msg('Admin.posts.list.selectRowAria', { title: 'Draft two' }) }))

    await click(within(bar()).getByRole('button', { name: msg('Admin.posts.list.publishN', { count: '2' }) }))

    expect(screen.getByRole('status')).toHaveTextContent(msg('Admin.posts.list.donePartial.publish', { done: '1', total: '2' }))
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(msg('Admin.posts.list.failedHeading.publish', { count: '1' }))
    expect(within(alert).getByRole('listitem')).toHaveTextContent(
      msg('Admin.posts.list.failedItem', {
        title: 'Draft two',
        error: 'Cannot publish: a saved post needs content and a category.',
      }),
    )
    expect(screen.getByRole('checkbox', { name: msg('Admin.posts.list.selectRowAria', { title: 'Draft two' }) })).toBeChecked()
    expect(
      screen.getByRole('checkbox', { name: msg('Admin.posts.list.selectRowAria', { title: 'Draft one' }) }),
    ).not.toBeChecked()
  })

  it('a post just changed in another tab (skipped) is reported separately, not as an error', async () => {
    onSetPublished.mockResolvedValue({ done: [], skipped: ['a'], failed: [] })
    renderList()
    await click(screen.getByRole('checkbox', { name: msg('Admin.posts.list.selectRowAria', { title: 'Published post' }) }))

    await click(within(bar()).getByRole('button', { name: msg('Admin.posts.list.unpublishN', { count: '1' }) }))

    expect(screen.getByRole('status')).toHaveTextContent(msg('Admin.posts.list.skipped.unpublish', { count: '1' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('the action returns a general error or is rejected (network down): in-place error sentence, selection intact', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    onSetPublished.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    renderList()
    await click(screen.getByRole('checkbox', { name: msg('Admin.posts.list.selectRowAria', { title: 'Draft one' }) }))

    await click(within(bar()).getByRole('button', { name: msg('Admin.posts.list.publishN', { count: '1' }) }))

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Errors.admin.unreachable'))
    expect(screen.getByRole('checkbox', { name: msg('Admin.posts.list.selectRowAria', { title: 'Draft one' }) })).toBeChecked()
    log.mockRestore()
  })

  it('session expired (redirect error): the router navigates by itself, no error is shown', async () => {
    onSetPublished.mockRejectedValue(
      Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/admin/login;307;' }),
    )
    renderList()
    await click(screen.getByRole('checkbox', { name: msg('Admin.posts.list.selectRowAria', { title: 'Draft one' }) }))

    await click(within(bar()).getByRole('button', { name: msg('Admin.posts.list.publishN', { count: '1' }) }))

    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('PostListActions: bulk delete', () => {
  it('asks again in place, states the post count, each post title and that a published post will become a 404; focus on "Cancel"; Escape cancels, focus returns to "Delete"', async () => {
    renderList()
    await click(screen.getByRole('checkbox', { name: msg('Admin.posts.list.selectRowAria', { title: 'Published post' }) }))
    await click(screen.getByRole('checkbox', { name: msg('Admin.posts.list.selectRowAria', { title: 'Draft one' }) }))

    await click(within(bar()).getByRole('button', { name: msg('Admin.posts.list.deleteN', { count: '2' }) }))

    const confirm = screen.getByRole('group', { name: startsWith(msg('Admin.posts.list.confirmQuestion', { count: '2' })) })
    expect(confirm).toHaveTextContent(msg('Admin.posts.list.publishedWarning', { count: 1 }))
    expect(confirm).toHaveTextContent(msg('Admin.postImages.deleteDetails'))
    expect(
      within(confirm)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Published post', 'Draft one'])
    expect(within(confirm).getByRole('button', { name: msg('Site.comments.form.cancel') })).toHaveFocus()
    expect(onDelete).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.keyDown(within(confirm).getByRole('button', { name: msg('Site.comments.form.cancel') }), { key: 'Escape' })
    })
    expect(screen.queryByRole('group', { name: CONFIRM_PREFIX })).toBeNull()
    expect(within(bar()).getByRole('button', { name: msg('Admin.posts.list.deleteN', { count: '2' }) })).toHaveFocus()
  })

  it('an author is told the posts leave the site and their list and an administrator keeps them: no "permanently"', async () => {
    onDelete.mockResolvedValue({ done: ['b'], skipped: [], failed: [] })
    renderList(posts, true)
    await click(screen.getByRole('checkbox', { name: msg('Admin.posts.list.selectRowAria', { title: 'Draft one' }) }))
    await click(within(bar()).getByRole('button', { name: msg('Admin.posts.list.deleteN', { count: '1' }) }))

    const confirm = screen.getByRole('group', {
      name: startsWith(msg('Admin.posts.list.author.confirmQuestion', { count: '1' })),
    })
    expect(confirm).toHaveTextContent(msg('Admin.posts.list.author.consequences'))
    expect(confirm).not.toHaveTextContent(msg('Admin.posts.list.consequences'))
    expect(screen.queryByRole('button', { name: msg('Admin.posts.list.deleteForeverN', { count: '1' }) })).toBeNull()

    await click(within(confirm).getByRole('button', { name: msg('Admin.posts.list.author.confirmN', { count: '1' }) }))
    expect(onDelete).toHaveBeenCalledExactlyOnceWith(['b'])
  })

  it('confirm: calls exactly once with every selected post; rows disappear when the server redraws, focus goes to the notification line', async () => {
    onDelete.mockResolvedValue({ done: ['a', 'b'], skipped: [], failed: [] })
    const { serverRerender } = renderList()
    await click(screen.getByRole('checkbox', { name: msg('Admin.posts.list.selectRowAria', { title: 'Published post' }) }))
    await click(screen.getByRole('checkbox', { name: msg('Admin.posts.list.selectRowAria', { title: 'Draft one' }) }))
    await click(within(bar()).getByRole('button', { name: msg('Admin.posts.list.deleteN', { count: '2' }) }))

    await click(screen.getByRole('button', { name: msg('Admin.posts.list.deleteForeverN', { count: '2' }) }))
    serverRerender([posts[2]])

    expect(onDelete).toHaveBeenCalledExactlyOnceWith(['a', 'b'])
    expect(screen.getByRole('status')).toHaveTextContent(msg('Admin.posts.list.doneAll.delete', { count: '2' }))
    expect(screen.queryByRole('group', { name: SELECTED_PREFIX })).toBeNull()
    expect(screen.getByRole('status')).toHaveFocus()
    expect(screen.getByRole('checkbox', { name: msg('Admin.posts.list.selectAllAria', { count: '1' }) })).not.toBeChecked()
  })

  it('total delete failure: error in the confirmation panel, the panel stays open for a retry', async () => {
    onDelete.mockResolvedValue({ error: msg('Admin.posts.actions.bulkInvalid') })
    renderList()
    await click(screen.getByRole('checkbox', { name: msg('Admin.posts.list.selectRowAria', { title: 'Draft one' }) }))
    await click(within(bar()).getByRole('button', { name: msg('Admin.posts.list.deleteN', { count: '1' }) }))

    await click(screen.getByRole('button', { name: msg('Admin.posts.list.deleteForeverN', { count: '1' }) }))

    const confirm = screen.getByRole('group', { name: startsWith(msg('Admin.posts.list.confirmQuestion', { count: '1' })) })
    expect(within(confirm).getByRole('alert')).toHaveTextContent(msg('Admin.posts.actions.bulkInvalid'))
  })
})

describe('PostListActions: fresh data from the server', () => {
  it('a selected post no longer on the page (deleted on its row, filter changed) is no longer counted', () => {
    const { serverRerender } = renderList()
    fireEvent.click(screen.getByRole('checkbox', { name: msg('Admin.posts.list.selectRowAria', { title: 'Draft one' }) }))
    fireEvent.click(screen.getByRole('checkbox', { name: msg('Admin.posts.list.selectRowAria', { title: 'Draft two' }) }))
    expect(bar()).toHaveAccessibleName(msg('Admin.posts.list.selected', { count: '2' }))

    serverRerender([posts[0], posts[2]])

    expect(bar()).toHaveAccessibleName(msg('Admin.posts.list.selected', { count: '1' }))
  })
})
