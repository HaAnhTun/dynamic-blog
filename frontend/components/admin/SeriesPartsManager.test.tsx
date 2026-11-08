import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SeriesPartsManager, { type PartsOutcome, type SeriesPart } from './SeriesPartsManager'
import { msg } from '@/test/render-intl'

const part = (id: string, over: Partial<SeriesPart> = {}): SeriesPart => ({
  id,
  title: `Post ${id.toUpperCase()}`,
  status: 'PUBLISHED',
  otherSeries: null,
  ...over,
})

const A = part('a')
const B = part('b')
const C = part('c')
const D = part('d')
const OTHER_SERIES = 'Neighbour series'
const E = part('e', { otherSeries: OTHER_SERIES })
const DRAFT_LABEL = msg('Admin.statuses.post.DRAFT')
const IN_OTHER_SERIES = msg('Admin.series.parts.optionOtherSeries', { name: OTHER_SERIES })

const onSave = vi.fn<(postIds: string[]) => Promise<PartsOutcome>>()

function renderManager(parts: SeriesPart[] = [A, B, C], candidates: SeriesPart[] = [D, E]) {
  return render(<SeriesPartsManager parts={parts} candidates={candidates} onSave={onSave} />)
}

const rows = () => within(screen.getByRole('list', { name: msg('Admin.series.parts.orderLabel') })).getAllByRole('listitem')

/** The titles of the parts in the order on screen. */
const listedTitles = () => rows().map((li) => li.querySelector('[data-title]')?.textContent)

/** The text of the options in the add-post select box, without the choose-prompt line. */
const candidateOptions = () =>
  within(screen.getByLabelText(msg('Admin.series.parts.addLabel')))
    .getAllByRole('option')
    .filter((o) => (o as HTMLOptionElement).value !== '')
    .map((o) => o.textContent)

async function click(name: RegExp | string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })
}

async function add(id: string) {
  fireEvent.change(screen.getByLabelText(msg('Admin.series.parts.addLabel')), { target: { value: id } })
  await click(msg('Admin.editor.inlineCreate.add'))
}

const redirectRejection = () => Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;push;/admin/login;307;' })

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('SeriesPartsManager: parts list', () => {
  it('lists the parts in the order received; a draft carries a not-yet-shown label on the page', () => {
    renderManager([A, part('n', { status: 'DRAFT' }), B])

    expect(listedTitles()).toEqual(['Post A', 'Post N', 'Post B'])
    expect(rows()[1]).toHaveTextContent(msg('Admin.series.parts.notShown', { status: DRAFT_LABEL }))
    expect(rows()[0]).not.toHaveTextContent(DRAFT_LABEL)
  })

  it('↑↓ reorder in place, no server call yet, report an unsaved change', async () => {
    renderManager()
    expect(screen.queryByText(msg('Admin.series.parts.unsaved'))).toBeNull()

    await click(msg('Admin.series.parts.moveUpLabel', { title: 'Post B' }))
    expect(listedTitles()).toEqual(['Post B', 'Post A', 'Post C'])

    await click(msg('Admin.series.parts.moveDownLabel', { title: 'Post B' }))
    await click(msg('Admin.series.parts.moveDownLabel', { title: 'Post B' }))
    expect(listedTitles()).toEqual(['Post A', 'Post C', 'Post B'])

    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText(msg('Admin.series.parts.unsaved'))).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(msg('Admin.series.parts.movedTo', { title: 'Post B', position: '3' }))
  })

  it('the first part cannot move up, the last part cannot move down', async () => {
    renderManager()

    const up = screen.getByRole('button', { name: msg('Admin.series.parts.moveUpLabel', { title: 'Post A' }) })
    const down = screen.getByRole('button', { name: msg('Admin.series.parts.moveDownLabel', { title: 'Post C' }) })
    expect(up).toHaveAttribute('aria-disabled', 'true')
    expect(down).toHaveAttribute('aria-disabled', 'true')
    expect(
      screen.getByRole('button', { name: msg('Admin.series.parts.moveDownLabel', { title: 'Post A' }) }),
    ).not.toHaveAttribute('aria-disabled')

    await act(async () => fireEvent.click(up))
    await act(async () => fireEvent.click(down))
    expect(listedTitles()).toEqual(['Post A', 'Post B', 'Post C'])
  })

  it('✕ removes a part in place: it leaves the list, returns to the "Add a post" box, no server call yet', async () => {
    renderManager()

    await click(msg('Admin.series.parts.removeLabel', { title: 'Post B' }))

    expect(listedTitles()).toEqual(['Post A', 'Post C'])
    expect(candidateOptions()).toEqual(['Post B', 'Post D', `Post E ${IN_OTHER_SERIES}`])
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText(msg('Admin.series.parts.unsaved'))).toBeInTheDocument()
  })

  it('a series with no parts: says so plainly, parts can still be added', async () => {
    renderManager([], [D])

    expect(screen.getByText(msg('Admin.series.parts.emptyTitle'))).toBeInTheDocument()
    await add('d')
    expect(listedTitles()).toEqual(['Post D'])
  })

  it('empty series and no posts left to add: does not say "add from the box below" when there is no box', () => {
    renderManager([], [])

    expect(screen.getByText(msg('Admin.series.parts.emptyTitle'))).toBeInTheDocument()
    expect(screen.getByText(msg('Admin.series.parts.noCandidates'))).toBeInTheDocument()
    expect(screen.queryByText(msg('Admin.series.parts.emptyBodyAdd'), { exact: false })).toBeNull()
  })

  it('the number column follows the visible position, not the post when swapped', async () => {
    renderManager()
    const numbers = () => rows().map((li) => li.querySelector('[aria-hidden="true"]')?.textContent)

    expect(numbers()).toEqual(['1', '2', '3'])
    await click(msg('Admin.series.parts.moveUpLabel', { title: 'Post C' }))
    expect(listedTitles()).toEqual(['Post A', 'Post C', 'Post B'])
    expect(numbers()).toEqual(['1', '2', '3'])
  })
})

describe('SeriesPartsManager: add a post', () => {
  it('a post that is in another series carries the label "(currently in series X)"; a post in no series does not', () => {
    renderManager()

    expect(candidateOptions()).toEqual(['Post D', `Post E ${IN_OTHER_SERIES}`])
  })

  it('a draft in the select box is also named', () => {
    renderManager([A], [part('n', { status: 'DRAFT' })])

    expect(candidateOptions()).toEqual([`Post N (${DRAFT_LABEL.toLowerCase()})`])
  })

  it('add: the post goes to the end of the list, leaves the "Add a post" box, no server call yet; the old series label stays until saving', async () => {
    renderManager()

    await add('e')

    expect(listedTitles()).toEqual(['Post A', 'Post B', 'Post C', 'Post E'])
    expect(candidateOptions()).toEqual(['Post D'])
    // Saving will move the post out of the other series: it must be said right on that row.
    expect(rows()[3]).toHaveTextContent(IN_OTHER_SERIES)
    expect(rows()[0]).not.toHaveTextContent(IN_OTHER_SERIES)
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('status')).toHaveTextContent(msg('Admin.series.parts.added', { title: 'Post E' }))
  })

  it('no post chosen in the box: the "Add" button cannot be pressed yet', () => {
    renderManager()

    expect(screen.getByRole('button', { name: msg('Admin.editor.inlineCreate.add') })).toBeDisabled()
    fireEvent.change(screen.getByLabelText(msg('Admin.series.parts.addLabel')), { target: { value: 'd' } })
    expect(screen.getByRole('button', { name: msg('Admin.editor.inlineCreate.add') })).toBeEnabled()
  })

  it('no post left to add: says so plainly instead of an empty select box', () => {
    renderManager([A], [])

    expect(screen.queryByLabelText(msg('Admin.series.parts.addLabel'))).toBeNull()
    expect(screen.getByText(msg('Admin.series.parts.noCandidates'))).toBeInTheDocument()
  })

  it('at 100 parts (the backend limit) nothing more can be added, and it says why', () => {
    const hundred = Array.from({ length: 100 }, (_, i) => part(`p${i}`))
    renderManager(hundred, [D])

    fireEvent.change(screen.getByLabelText(msg('Admin.series.parts.addLabel')), { target: { value: 'd' } })
    expect(screen.getByRole('button', { name: msg('Admin.editor.inlineCreate.add') })).toBeDisabled()
    expect(screen.getByText(msg('Admin.series.parts.fullHint', { max: '100' }))).toBeInTheDocument()
  })
})

describe('SeriesPartsManager: save', () => {
  it('"Save order" sends exactly the id array in on-screen order, after adding, removing and swapping', async () => {
    onSave.mockResolvedValue([C, A, D])
    renderManager()

    await click(msg('Admin.series.parts.removeLabel', { title: 'Post B' }))
    await add('d')
    await click(msg('Admin.series.parts.moveUpLabel', { title: 'Post C' }))
    await click(msg('Admin.series.parts.save'))

    expect(onSave).toHaveBeenCalledWith(['c', 'a', 'd'])
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('after saving: shows the list the backend returned, the unsaved note is gone, the old series label disappears', async () => {
    onSave.mockResolvedValue([A, B, C, { ...E, otherSeries: null }])
    renderManager()

    await add('e')
    await click(msg('Admin.series.parts.save'))

    expect(listedTitles()).toEqual(['Post A', 'Post B', 'Post C', 'Post E'])
    expect(rows()[3]).not.toHaveTextContent(IN_OTHER_SERIES)
    expect(screen.queryByText(msg('Admin.series.parts.unsaved'))).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent(msg('Admin.series.parts.orderSaved'))
  })

  it('save error (stale list) → message in role="alert", the screen stays as it is for a retry', async () => {
    onSave.mockResolvedValue({ error: msg('Errors.admin.staleList') })
    renderManager()

    await click(msg('Admin.series.parts.moveUpLabel', { title: 'Post C' }))
    await click(msg('Admin.series.parts.save'))

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Errors.admin.staleList'))
    expect(listedTitles()).toEqual(['Post A', 'Post C', 'Post B'])
    expect(screen.getByText(msg('Admin.series.parts.unsaved'))).toBeInTheDocument()
  })

  it('while saving: every button and select is locked (clicking twice does not send twice), unlocked when done', async () => {
    let finish!: (value: PartsOutcome) => void
    onSave.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    renderManager()

    await click(msg('Admin.series.parts.save'))

    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled()
    expect(screen.getByLabelText(msg('Admin.series.parts.addLabel'))).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: msg('Admin.series.parts.save') }))
    expect(onSave).toHaveBeenCalledTimes(1)

    await act(async () => finish([A, B, C]))

    expect(screen.getByRole('button', { name: msg('Admin.series.parts.save') })).toBeEnabled()
  })

  it('session expired (redirect action) is not shown as an error', async () => {
    onSave.mockRejectedValue(redirectRejection())
    renderManager()

    await click(msg('Admin.series.parts.save'))

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('action rejected for another reason → there is still a message, never silent', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    onSave.mockRejectedValue(new TypeError('Failed to fetch'))
    renderManager()

    await click(msg('Admin.series.parts.save'))

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Errors.admin.unreachable'))
    expect(screen.getByRole('button', { name: msg('Admin.series.parts.save') })).toBeEnabled()
  })
})

describe('SeriesPartsManager: focus after removing a part', () => {
  // The remove button holding focus leaves the page with its row: with nothing to catch it focus falls back to <body>
  // and keyboard users have to Tab again from the top of the page (QA, as already fixed in GalleryManager).
  const removeButton = (title: string) => screen.getByRole('button', { name: msg('Admin.series.parts.removeLabel', { title }) })

  it('removing a middle part: focus goes to the "Remove from series" button of the part that took its place', async () => {
    renderManager()

    await click(msg('Admin.series.parts.removeLabel', { title: 'Post B' }))

    expect(listedTitles()).toEqual(['Post A', 'Post C'])
    expect(removeButton('Post C')).toHaveFocus()
  })

  it('removing the last part: focus goes to the part before it', async () => {
    renderManager()

    await click(msg('Admin.series.parts.removeLabel', { title: 'Post C' }))

    expect(removeButton('Post B')).toHaveFocus()
  })

  it('removing the only remaining part: focus goes to the "The series has no parts yet." line', async () => {
    renderManager([A])

    await click(msg('Admin.series.parts.removeLabel', { title: 'Post A' }))

    expect(screen.getByText(msg('Admin.series.parts.emptyTitle'))).toHaveFocus()
  })

  it('swapping (↑↓) does not move focus: the button just pressed keeps focus', async () => {
    renderManager()
    const down = screen.getByRole('button', { name: msg('Admin.series.parts.moveDownLabel', { title: 'Post A' }) })
    down.focus()

    await click(msg('Admin.series.parts.moveDownLabel', { title: 'Post A' }))

    expect(listedTitles()).toEqual(['Post B', 'Post A', 'Post C'])
    expect(down).toHaveFocus()
  })

  it('the number has enough contrast on a white background: slate-500, not slate-400 (2.63:1)', () => {
    renderManager()

    const number = rows()[0].querySelector('[aria-hidden="true"]')
    expect(number).toHaveTextContent('1')
    expect(number).toHaveClass('text-slate-500')
    expect(number).not.toHaveClass('text-slate-400')
  })
})
