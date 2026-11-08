import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DeletePost from './DeletePost'
import { msg } from '@/test/render-intl'

const onDelete = vi.fn<() => Promise<{ error: string }>>()

afterEach(() => vi.clearAllMocks())

async function click(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })
}

describe('DeletePost', () => {
  it('one in-place confirmation step: focus on "Cancel", the question names the post; cancelling returns focus to "Delete post"', async () => {
    render(<DeletePost title="Draft post" published={false} author={false} onDelete={onDelete} />)

    await click(msg('Admin.posts.delete.heading'))
    const group = screen.getByRole('group', {
      name: (name) => name.startsWith(msg('Admin.posts.delete.question', { title: 'Draft post' })),
    })
    expect(within(group).getByRole('button', { name: msg('Site.comments.form.cancel') })).toHaveFocus()
    expect(onDelete).not.toHaveBeenCalled()

    await click(msg('Site.comments.form.cancel'))
    expect(screen.queryByRole('group')).toBeNull()
    expect(screen.getByRole('button', { name: msg('Admin.posts.delete.heading') })).toHaveFocus()
  })

  it('published post: the confirmation says the public path will become a 404', async () => {
    render(<DeletePost title="Published post" published author={false} onDelete={onDelete} />)

    await click(msg('Admin.posts.delete.heading'))

    expect(screen.getByRole('group')).toHaveTextContent(msg('Admin.posts.delete.publishedWarning'))
  })

  it('"Delete permanently" calls the action exactly once; an error shows inside the confirmation panel, focus returns to "Cancel"', async () => {
    onDelete.mockResolvedValue({ error: msg('Errors.admin.codes.POST_NOT_FOUND') })
    render(<DeletePost title="Draft post" published={false} author={false} onDelete={onDelete} />)

    await click(msg('Admin.posts.delete.heading'))
    // Pressed with the keyboard: focus is on the button itself, and the button is disabled while pending.
    screen.getByRole('button', { name: msg('Admin.posts.delete.forever') }).focus()
    await click(msg('Admin.posts.delete.forever'))

    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(within(screen.getByRole('group')).getByRole('alert')).toHaveTextContent(msg('Site.article.notFoundTitle'))
    expect(screen.getByRole('button', { name: msg('Site.comments.form.cancel') })).toHaveFocus()
  })

  it('an action redirect (delete done, or session expired) is not an error to show', async () => {
    onDelete.mockRejectedValue(Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;push;/admin;303;' }))
    render(<DeletePost title="Draft post" published={false} author={false} onDelete={onDelete} />)

    await click(msg('Admin.posts.delete.heading'))
    await click(msg('Admin.posts.delete.forever'))

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('action rejected (network down): the "cannot connect" sentence, nothing thrown', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    onDelete.mockRejectedValue(new TypeError('Failed to fetch'))
    render(<DeletePost title="Draft post" published={false} author={false} onDelete={onDelete} />)

    await click(msg('Admin.posts.delete.heading'))
    await click(msg('Admin.posts.delete.forever'))

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Errors.admin.unreachable'))
    log.mockRestore()
  })

  it('an administrator is told the delete is for good, with the permanent button', async () => {
    render(<DeletePost title="Draft post" published={false} author={false} onDelete={onDelete} />)

    expect(screen.getByText(msg('Admin.posts.delete.hintDraft'))).toBeInTheDocument()
    await click(msg('Admin.posts.delete.heading'))

    expect(screen.getByRole('group')).toHaveTextContent(msg('Admin.posts.delete.consequences'))
    expect(screen.getByRole('button', { name: msg('Admin.posts.delete.forever') })).toBeInTheDocument()
  })

  it('an author is told the post only leaves their list and the site, that an administrator keeps it, and nothing says "permanently" or "for good"', async () => {
    render(<DeletePost title="Draft post" published={false} author onDelete={onDelete} />)

    expect(screen.getByText(msg('Admin.posts.delete.author.hintDraft'))).toBeInTheDocument()
    expect(screen.queryByText(msg('Admin.posts.delete.hintDraft'))).toBeNull()
    await click(msg('Admin.posts.delete.heading'))

    const group = screen.getByRole('group')
    expect(group).toHaveTextContent(msg('Admin.posts.delete.author.consequences'))
    expect(group).not.toHaveTextContent(msg('Admin.posts.delete.consequences'))
    expect(screen.queryByRole('button', { name: msg('Admin.posts.delete.forever') })).toBeNull()
    expect(within(group).getByRole('button', { name: msg('Admin.posts.delete.author.confirm') })).toBeInTheDocument()
  })

  it('an author with a published post gets the "Unpublish keeps it in your list" hint, and the confirm button still deletes', async () => {
    onDelete.mockResolvedValue({ error: msg('Errors.admin.codes.POST_NOT_FOUND') })
    render(<DeletePost title="Published post" published author onDelete={onDelete} />)

    expect(screen.getByText(msg('Admin.posts.delete.author.hintPublished'))).toBeInTheDocument()
    await click(msg('Admin.posts.delete.heading'))
    expect(screen.getByRole('group')).toHaveTextContent(msg('Admin.posts.delete.publishedWarning'))
    await click(msg('Admin.posts.delete.author.confirm'))

    expect(onDelete).toHaveBeenCalledTimes(1)
  })
})
