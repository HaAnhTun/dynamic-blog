import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TopicManager, { type TopicItem } from './TopicManager'
import { msg } from '@/test/render-intl'
import { LANGUAGE_NAMES } from '@/components/site/language-names'
import { COLLATION_CATEGORY_FIRST, COLLATION_CATEGORY_SECOND, COLLATION_CATEGORY_THIRD } from '@/test/fixtures/vi/topic-manager'

const onCreate = vi.fn()
const onSave = vi.fn()
const onDelete = vi.fn()
const onMerge = vi.fn()

afterEach(() => vi.clearAllMocks())

const t = (key: string, args?: Record<string, string | number>) => msg(`Admin.topics.manager.${key}`, args)
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const startsWith = (text: string) => new RegExp(`^${escapeRegExp(text)}`)
const editName = (kind: 'category' | 'tag', name: string) => `${t('edit')} ${t(`${kind}.subject`, { name })}`
const deleteName = (kind: 'category' | 'tag', name: string) => `${t('delete')} ${t(`${kind}.subject`, { name })}`
const mergeName = (name: string) => `${t('merge')} ${t('tag.mergeSr', { name })}`

const item = (over: Partial<TopicItem> = {}): TopicItem => ({
  id: 'c1',
  name: 'Infrastructure',
  slug: 'infrastructure',
  description: null,
  posts: 0,
  published: 0,
  ...over,
})

function renderManager(kind: 'category' | 'tag', items: TopicItem[]) {
  const view = render(
    <TopicManager kind={kind} items={items} onCreate={onCreate} onSave={onSave} onDelete={onDelete} onMerge={onMerge} />,
  )
  return {
    ...view,
    /** The server redraws the page after updateTag: the new list (right post counts) enters the SAME tree. */
    serverRerender: (next: TopicItem[]) =>
      view.rerender(
        <TopicManager kind={kind} items={next} onCreate={onCreate} onSave={onSave} onDelete={onDelete} onMerge={onMerge} />,
      ),
  }
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element)
  })
}

function rowNames(): string[] {
  return within(screen.getByRole('list'))
    .getAllByRole('listitem')
    .map((row) => row.querySelector('p')!.textContent ?? '')
}

describe('TopicManager', () => {
  it('lists by name in Vietnamese collation order, with the public path and the number of posts using it', () => {
    renderManager('category', [
      item({ id: 'b', name: COLLATION_CATEGORY_THIRD, posts: 3, published: 2 }),
      item({ id: 'a', name: COLLATION_CATEGORY_FIRST, slug: 'backend', posts: 1, published: 1 }),
      item({ id: 'c', name: COLLATION_CATEGORY_SECOND, slug: 'life' }),
    ])

    expect(rowNames()).toEqual([COLLATION_CATEGORY_FIRST, COLLATION_CATEGORY_SECOND, COLLATION_CATEGORY_THIRD])
    // The section name (and the heading) has a space between the label and the number, not a glued-together word.
    expect(screen.getByRole('region', { name: `${t('category.title')} 3` })).toBeInTheDocument()
    const rows = within(screen.getByRole('list', { name: msg('Admin.topics.manager.category.listLabel') })).getAllByRole(
      'listitem',
    )
    expect(rows[2]).toHaveTextContent('/categories/infrastructure')
    expect(rows[2]).toHaveTextContent(msg('Admin.topics.manager.usagePartly', { count: '3', published: '2' }))
    expect(rows[1]).toHaveTextContent(msg('Admin.topics.manager.usageNone'))
  })

  // Pinned on purpose: before, a category that still had posts had ONLY links to those posts, because the only
  // way was moving each post in the editor. Now there is also the move-posts-then-delete button — still no direct
  // delete button: deleting a category that still has posts is a 409 in the backend, and a published post must have a category.
  it('category that still has posts: cannot be deleted directly; has links to exactly those posts and "Move posts then delete"', () => {
    renderManager('category', [item({ posts: 3, published: 3 }), item({ id: 'c2', name: 'Backend', slug: 'backend' })])

    const used = within(screen.getByRole('list')).getAllByRole('listitem')[1]
    expect(within(used).queryByRole('button', { name: startsWith(t('delete')) })).toBeNull()
    expect(
      within(used).getByRole('link', { name: `${t('viewPosts', { count: 3 })} ${t('viewPostsSr', { name: 'Infrastructure' })}` }),
    ).toHaveAttribute('href', '/admin?cat=infrastructure')
    expect(
      within(used).getByRole('button', { name: msg('Admin.topics.manager.category.mergeTitle', { name: 'Infrastructure' }) }),
    ).toBeInTheDocument()
  })

  it('only one category, or no merge function: no "Move posts then delete" (there is no target)', () => {
    renderManager('category', [item({ posts: 3, published: 3 })])
    expect(screen.queryByRole('button', { name: startsWith(t('moveAndDelete')) })).toBeNull()

    render(
      <TopicManager
        kind="tag"
        items={[item({ id: 't1', name: 'AWS', posts: 2 }), item({ id: 't2', name: 'Java' })]}
        onCreate={onCreate}
        onSave={onSave}
        onDelete={onDelete}
      />,
    )
    expect(screen.queryByRole('button', { name: startsWith(t('merge')) })).toBeNull()
  })

  it('edit in place: focus on the name box; after saving shows the name the backend saved, reports, focus returns to the "Edit" button', async () => {
    onSave.mockResolvedValue({
      id: 'c1',
      name: 'Systems infrastructure',
      slug: 'kien-truc',
      description: msg('Admin.topics.manager.descriptionLabel'),
    })
    renderManager('category', [item()])

    await click(screen.getByRole('button', { name: editName('category', 'Infrastructure') }))
    const name = screen.getByLabelText(msg('Admin.editor.categoryName'))
    expect(name).toHaveFocus()
    fireEvent.change(name, { target: { value: 'Systems infrastructure' } })
    fireEvent.change(screen.getByLabelText(msg('Admin.topics.manager.descriptionLabel')), {
      target: { value: msg('Admin.topics.manager.descriptionLabel') },
    })
    await act(async () => {
      fireEvent.submit(name.closest('form')!)
    })

    expect(onSave).toHaveBeenCalledWith('c1', 'Systems infrastructure', msg('Admin.topics.manager.descriptionLabel'), {})
    expect(rowNames()).toEqual(['Systems infrastructure'])
    expect(screen.getByRole('status')).toHaveTextContent(msg('Admin.topics.manager.renamed', { name: 'Systems infrastructure' }))
    expect(screen.getByRole('button', { name: editName('category', 'Systems infrastructure') })).toHaveFocus()
  })

  it('category edit: the English name and description sit next to the base ones and are saved as translations, keeping the other stored languages', async () => {
    onSave.mockResolvedValue({ id: 'c1', name: 'Infrastructure', slug: 'infrastructure', description: null })
    renderManager('category', [
      item({ translations: { en: { name: 'Old name', description: 'Old text' }, fr: { name: 'Infra' } } }),
    ])

    await click(screen.getByRole('button', { name: editName('category', 'Infrastructure') }))
    const language = LANGUAGE_NAMES.en
    const name = screen.getByLabelText(t('translatedNameLabel', { language }))
    const description = screen.getByLabelText(t('translatedDescriptionLabel', { language }))
    expect(name).toHaveValue('Old name')
    expect(description).toHaveValue('Old text')
    fireEvent.change(name, { target: { value: '  Systems  ' } })
    fireEvent.change(description, { target: { value: '' } })
    await act(async () => {
      fireEvent.submit(name.closest('form')!)
    })

    expect(onSave).toHaveBeenCalledWith('c1', 'Infrastructure', '', {
      en: { name: 'Systems', description: null },
      fr: { name: 'Infra' },
    })
  })

  it('clearing both English fields drops the language from the map', async () => {
    onSave.mockResolvedValue({ id: 'c1', name: 'Infrastructure', slug: 'infrastructure', description: null })
    renderManager('category', [item({ translations: { en: { name: 'Systems', description: null } } })])

    await click(screen.getByRole('button', { name: editName('category', 'Infrastructure') }))
    const name = screen.getByLabelText(t('translatedNameLabel', { language: LANGUAGE_NAMES.en }))
    fireEvent.change(name, { target: { value: '' } })
    await act(async () => {
      fireEvent.submit(name.closest('form')!)
    })

    expect(onSave).toHaveBeenCalledWith('c1', 'Infrastructure', '', {})
  })

  it('tag edit: only the English name (a tag has no description) is offered and sent', async () => {
    onSave.mockResolvedValue({ id: 't1', name: 'AWS', slug: 'aws', description: null })
    renderManager('tag', [item({ id: 't1', name: 'AWS', slug: 'aws' })])

    await click(screen.getByRole('button', { name: editName('tag', 'AWS') }))
    expect(screen.queryByLabelText(t('translatedDescriptionLabel', { language: LANGUAGE_NAMES.en }))).toBeNull()
    const name = screen.getByLabelText(t('translatedNameLabel', { language: LANGUAGE_NAMES.en }))
    fireEvent.change(name, { target: { value: 'Amazon Web Services' } })
    await act(async () => {
      fireEvent.submit(name.closest('form')!)
    })

    expect(onSave).toHaveBeenCalledWith('t1', 'AWS', null, { en: { name: 'Amazon Web Services', description: null } })
  })

  it('a stored English text is shown on the row in view mode', () => {
    renderManager('category', [item({ translations: { en: { name: 'Systems', description: 'About systems' } } })])

    expect(screen.getByRole('listitem')).toHaveTextContent(`${LANGUAGE_NAMES.en}: Systems`)
    expect(screen.getByRole('listitem')).toHaveTextContent('About systems')
  })

  it('save fails (duplicate name): error in the edit box, typed text intact, focus returns to the name box', async () => {
    onSave.mockResolvedValue({ error: msg('Errors.admin.codes.TAG_ALREADY_EXISTS') })
    renderManager('tag', [item({ id: 't1', name: 'AWS', slug: 'aws' })])

    await click(screen.getByRole('button', { name: editName('tag', 'AWS') }))
    const name = screen.getByLabelText(msg('Admin.editor.tagName'))
    fireEvent.change(name, { target: { value: 'Java' } })
    // Pressing the save button with the keyboard: focus is on the button, and the button is disabled while pending.
    const save = screen.getByRole('button', { name: msg('Site.comments.item.editSave') })
    save.focus()
    await click(save)

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Errors.admin.codes.TAG_ALREADY_EXISTS'))
    expect(screen.getByLabelText(msg('Admin.editor.tagName'))).toHaveValue('Java')
    expect(screen.getByLabelText(msg('Admin.editor.tagName'))).toHaveFocus()
  })

  it('delete tag: in-place confirmation says how many posts will lose the tag; after deleting it disappears from the list, focus goes to the heading', async () => {
    onDelete.mockResolvedValue(null)
    renderManager('tag', [item({ id: 't1', name: 'AWS', slug: 'aws', posts: 2, published: 2 })])

    await click(screen.getByRole('button', { name: deleteName('tag', 'AWS') }))
    const group = screen.getByRole('group', { name: startsWith(t('tag.deleteQuestion', { name: 'AWS' })) })
    expect(group).toHaveTextContent(msg('Admin.topics.manager.tag.deleteLeavesPosts', { count: '2' }))
    expect(within(group).getByRole('button', { name: msg('Site.comments.form.cancel') })).toHaveFocus()

    await click(within(group).getByRole('button', { name: msg('Admin.posts.delete.forever') }))

    expect(onDelete).toHaveBeenCalledWith('t1')
    expect(screen.getByText(msg('Admin.editor.noTags'))).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: startsWith(t('tag.title')) })).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent(msg('Admin.topics.manager.tag.deleted', { name: 'AWS' }))
  })

  it('cancelling the delete step (also with Escape): focus returns to the "Delete" button', async () => {
    renderManager('tag', [item({ id: 't1', name: 'AWS', slug: 'aws' })])
    const remove = screen.getByRole('button', { name: deleteName('tag', 'AWS') })

    await click(remove)
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('button', { name: msg('Site.comments.form.cancel') }), { key: 'Escape' })
    })

    expect(screen.queryByRole('group')).toBeNull()
    expect(screen.getByRole('button', { name: deleteName('tag', 'AWS') })).toHaveFocus()
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('add new: the new row goes in the right place by name; the text is only cleared on success', async () => {
    onCreate.mockResolvedValueOnce({ error: msg('Errors.admin.codes.TAG_ALREADY_EXISTS') })
    onCreate.mockResolvedValueOnce({ id: 't2', name: 'Docker', slug: 'docker', description: null })
    renderManager('tag', [item({ id: 't1', name: 'AWS', slug: 'aws' })])
    const name = screen.getByLabelText(msg('Admin.topics.manager.tag.newNameLabel'))

    fireEvent.change(name, { target: { value: 'AWS' } })
    await act(async () => {
      fireEvent.submit(name.closest('form')!)
    })
    expect(screen.getByRole('alert')).toHaveTextContent(msg('Errors.admin.codes.TAG_ALREADY_EXISTS'))
    expect(name).toHaveValue('AWS')
    expect(name).toHaveFocus()

    fireEvent.change(name, { target: { value: 'Docker' } })
    const add = screen.getByRole('button', { name: msg('Admin.editor.addTag') })
    add.focus()
    await click(add)
    expect(onCreate).toHaveBeenLastCalledWith('Docker', null)
    expect(rowNames()).toEqual(['AWS', 'Docker'])
    expect(name).toHaveValue('')
    expect(screen.getByRole('status')).toHaveTextContent(msg('Admin.topics.manager.tag.added', { name: 'Docker' }))
    // After adding, focus returns to the name box to keep typing, not staying on the button that is now disabled (empty box).
    expect(name).toHaveFocus()
  })

  it('action rejected (network down): the "could not reach the server" sentence in place, nothing thrown; focus returns to "Cancel"', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    onDelete.mockRejectedValue(new TypeError('Failed to fetch'))
    renderManager('tag', [item({ id: 't1', name: 'AWS', slug: 'aws' })])

    await click(screen.getByRole('button', { name: deleteName('tag', 'AWS') }))
    const confirm = screen.getByRole('button', { name: msg('Admin.posts.delete.forever') })
    confirm.focus()
    await click(confirm)

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Errors.admin.unreachable'))
    expect(screen.getByRole('button', { name: msg('Site.comments.form.cancel') })).toHaveFocus()
    log.mockRestore()
  })

  it('empty list: says why and what to do next', () => {
    renderManager('category', [])

    expect(screen.getByText(msg('Admin.topics.manager.category.empty'))).toBeInTheDocument()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('server redraws after an action: the server post counts replace the old ones, no row is lost', () => {
    const { serverRerender } = renderManager('tag', [item({ id: 't1', name: 'AWS', slug: 'aws', posts: 1, published: 1 })])

    serverRerender([item({ id: 't1', name: 'AWS', slug: 'aws', posts: 4, published: 2 })])

    expect(within(screen.getByRole('list')).getByRole('listitem')).toHaveTextContent(
      msg('Admin.topics.manager.usagePartly', { count: '4', published: '2' }),
    )
  })
})

describe('TopicManager: merge', () => {
  const aws = item({ id: 't1', name: 'AWS', slug: 'aws', posts: 3, published: 2 })
  const amazon = item({ id: 't2', name: 'Amazon', slug: 'amazon', posts: 1, published: 1 })
  const java = item({ id: 't3', name: 'Java', slug: 'java' })

  it('a tag with posts: "Merge into…" opens the target choice panel (focus on the select), listing only OTHER tags', async () => {
    renderManager('tag', [aws, amazon, java])

    // A tag with no posts only needs delete: there is no merge button.
    expect(screen.queryByRole('button', { name: mergeName('Java') })).toBeNull()
    await click(screen.getByRole('button', { name: mergeName('AWS') }))

    const select = screen.getByLabelText(msg('Admin.topics.manager.tag.mergeLabel', { name: 'AWS' }))
    expect(select).toHaveFocus()
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      msg('Admin.topics.manager.tag.mergePlaceholder'),
      t('targetOption', { name: 'Amazon', count: 1 }),
      t('targetOption', { name: 'Java', count: 0 }),
    ])
    // Without a target chosen the merge cannot happen yet.
    expect(screen.getByRole('button', { name: startsWith(t('tag.mergeSubmit').replace('…', '')) })).toBeDisabled()
  })

  it('choose a target: the confirmation sentence names both and the post count, attached to the button; confirming calls merge with source and target', async () => {
    onMerge.mockResolvedValue({ target: { id: 't2', name: 'Amazon', slug: 'amazon', description: null }, moved: 3 })
    const { serverRerender } = renderManager('tag', [aws, amazon, java])
    await click(screen.getByRole('button', { name: mergeName('AWS') }))

    fireEvent.change(screen.getByLabelText(msg('Admin.topics.manager.tag.mergeLabel', { name: 'AWS' })), {
      target: { value: 't2' },
    })
    const submit = screen.getByRole('button', { name: msg('Admin.topics.manager.tag.mergeSubmitInto', { target: 'Amazon' }) })
    expect(submit).toHaveAccessibleDescription(
      msg('Admin.topics.manager.tag.consequence', { count: 3, name: 'AWS', target: 'Amazon', path: '/tags/aws' }),
    )
    await click(submit)

    expect(onMerge).toHaveBeenCalledExactlyOnceWith('t1', 't2')
    // The source tag disappears; reports; focus goes to the list heading (the button just pressed left the page with its row).
    expect(rowNames()).toEqual(['Amazon', 'Java'])
    expect(screen.getByRole('status')).toHaveTextContent(
      msg('Admin.topics.manager.tag.merged', { name: 'AWS', target: 'Amazon', moved: '3' }),
    )
    expect(screen.getByRole('heading', { name: startsWith(t('tag.title')) })).toHaveFocus()

    // The target tag correct post count arrives with the same server redraw (a post carrying both is counted once).
    serverRerender([{ ...amazon, posts: 3, published: 2 }, java])
    expect(within(screen.getByRole('list')).getAllByRole('listitem')[0]).toHaveTextContent(
      msg('Admin.topics.manager.usagePartly', { count: '3', published: '2' }),
    )
  })

  it('category that still has posts: "Move posts then delete" — the sentence states the post count, the published count and the paths that will 404', async () => {
    onMerge.mockResolvedValue({ target: { id: 'c2', name: 'Backend', slug: 'backend', description: null }, moved: 3 })
    renderManager('category', [
      item({ id: 'c1', name: 'Infrastructure', slug: 'infrastructure', posts: 3, published: 2 }),
      item({ id: 'c2', name: 'Backend', slug: 'backend', posts: 1, published: 1 }),
    ])

    await click(screen.getByRole('button', { name: msg('Admin.topics.manager.category.mergeTitle', { name: 'Infrastructure' }) }))
    fireEvent.change(
      screen.getByLabelText(msg('Admin.topics.manager.category.mergeLabel', { count: '3', name: 'Infrastructure' })),
      {
        target: { value: 'c2' },
      },
    )
    const submit = screen.getByRole('button', {
      name: msg('Admin.topics.manager.category.mergeSubmit', { name: 'Infrastructure' }),
    })
    expect(submit).toHaveAccessibleDescription(
      t('category.consequence', {
        count: 3,
        partial: 'yes',
        published: 2,
        name: 'Infrastructure',
        target: 'Backend',
        path: '/categories/infrastructure',
      }),
    )
    await click(submit)

    expect(onMerge).toHaveBeenCalledExactlyOnceWith('c1', 'c2')
    expect(rowNames()).toEqual(['Backend'])
    expect(screen.getByRole('status')).toHaveTextContent(
      msg('Admin.topics.manager.category.merged', { moved: '3', target: 'Backend', name: 'Infrastructure' }),
    )
  })

  it('failure (target was just deleted): error in the panel, the panel stays open, focus goes to the select; Cancel (or Escape) returns focus to the merge button', async () => {
    onMerge.mockResolvedValue({ error: msg('Errors.admin.codes.TAG_NOT_FOUND') })
    renderManager('tag', [aws, amazon])
    await click(screen.getByRole('button', { name: mergeName('AWS') }))
    fireEvent.change(screen.getByLabelText(msg('Admin.topics.manager.tag.mergeLabel', { name: 'AWS' })), {
      target: { value: 't2' },
    })

    await click(screen.getByRole('button', { name: msg('Admin.topics.manager.tag.mergeSubmitInto', { target: 'Amazon' }) }))

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Errors.admin.codes.TAG_NOT_FOUND'))
    expect(screen.getByLabelText(msg('Admin.topics.manager.tag.mergeLabel', { name: 'AWS' }))).toHaveFocus()
    expect(rowNames()).toEqual(['Amazon', 'AWS'])

    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText(msg('Admin.topics.manager.tag.mergeLabel', { name: 'AWS' })), { key: 'Escape' })
    })
    expect(screen.queryByLabelText(msg('Admin.topics.manager.tag.mergeLabel', { name: 'AWS' }))).toBeNull()
    expect(screen.getByRole('button', { name: mergeName('AWS') })).toHaveFocus()
  })
})
