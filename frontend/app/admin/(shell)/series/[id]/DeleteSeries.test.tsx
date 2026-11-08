import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DeleteSeries from './DeleteSeries'
import { msg } from '@/test/render-intl'

const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const onDelete = vi.fn<() => Promise<{ error: string }>>()

function renderDelete(postCount = 4) {
  return render(<DeleteSeries title="A test series" postCount={postCount} onDelete={onDelete} />)
}

async function click(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })
}

const redirectRejection = () => Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;push;/admin/series;307;' })

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('DeleteSeries', () => {
  it('pressing "Delete series" deletes nothing yet: shows the in-place confirmation, no window.confirm', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderDelete()

    await click(msg('Admin.series.delete.heading'))

    expect(onDelete).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
    const prompt = screen.getByRole('group', {
      name: new RegExp(esc(msg('Admin.series.delete.confirmQuestion', { title: 'A test series' }))),
    })
    // Says plainly what is lost and what stays: the posts are not deleted with it.
    expect(prompt).toHaveTextContent(msg('Admin.series.delete.postsKept', { count: '4' }))
    expect(screen.getByRole('button', { name: msg('Admin.posts.delete.forever') })).toBeInTheDocument()
  })

  it('focus goes to "Cancel" when the confirmation opens: a second Enter does not delete by mistake', async () => {
    renderDelete()

    await click(msg('Admin.series.delete.heading'))

    expect(screen.getByRole('button', { name: msg('Site.comments.form.cancel') })).toHaveFocus()
  })

  it('"Cancel" closes the confirmation and returns focus to the "Delete series" button', async () => {
    renderDelete()

    await click(msg('Admin.series.delete.heading'))
    await click(msg('Site.comments.form.cancel'))

    expect(screen.queryByRole('button', { name: msg('Admin.posts.delete.forever') })).toBeNull()
    expect(screen.getByRole('button', { name: msg('Admin.series.delete.heading') })).toHaveFocus()
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('empty series: mentions no post', async () => {
    renderDelete(0)

    await click(msg('Admin.series.delete.heading'))

    expect(screen.getByRole('group')).not.toHaveTextContent(msg('Admin.posts.row.deleteSr', { title: 'trong series' }))
    expect(screen.getByRole('group')).toHaveTextContent(msg('Admin.postImages.deleteDetails'))
  })

  it('confirm → calls onDelete exactly once; while deleting both buttons are locked', async () => {
    let finish!: (value: { error: string }) => void
    onDelete.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    renderDelete()

    await click(msg('Admin.series.delete.heading'))
    await click(msg('Admin.posts.delete.forever'))

    expect(screen.getByRole('button', { name: msg('Admin.posts.delete.forever') })).toBeDisabled()
    expect(screen.getByRole('button', { name: msg('Site.comments.form.cancel') })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: msg('Admin.posts.delete.forever') }))
    expect(onDelete).toHaveBeenCalledTimes(1)

    await act(async () => finish({ error: msg('Errors.admin.codes.SERIES_NOT_FOUND') }))
    expect(screen.getByRole('button', { name: msg('Site.comments.form.cancel') })).toBeEnabled()
  })

  it('error → role="alert", stays on the confirmation step to retry or cancel', async () => {
    onDelete.mockResolvedValue({ error: msg('Errors.admin.codes.SERIES_NOT_FOUND') })
    renderDelete()

    await click(msg('Admin.series.delete.heading'))
    await click(msg('Admin.posts.delete.forever'))

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Errors.admin.codes.SERIES_NOT_FOUND'))
    expect(screen.getByRole('button', { name: msg('Admin.posts.delete.forever') })).toBeEnabled()
  })

  it('deleted (the action redirects to the list) is not shown as an error', async () => {
    onDelete.mockRejectedValue(redirectRejection())
    renderDelete()

    await click(msg('Admin.series.delete.heading'))
    await click(msg('Admin.posts.delete.forever'))

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('action rejected for another reason → the cannot-connect message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    onDelete.mockRejectedValue(new TypeError('Failed to fetch'))
    renderDelete()

    await click(msg('Admin.series.delete.heading'))
    await click(msg('Admin.posts.delete.forever'))

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Errors.admin.unreachable'))
  })
})
