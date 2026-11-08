import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CuratedPost } from './curated'
import CuratedManager from './CuratedManager'
import { msg } from '@/test/render-intl'

const rx = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')

const item = (id: string, over: Partial<CuratedPost> = {}): CuratedPost => ({
  id,
  title: `Post ${id.toUpperCase()}`,
  slug: `bai-${id}`,
  status: 'PUBLISHED',
  publishedAt: '2026-10-03T02:00:00Z',
  featuredRank: null,
  ...over,
})

const A = item('a', { featuredRank: 1 })
const B = item('b', { featuredRank: 2 })
const C = item('c', { featuredRank: 3 })
const D = item('d', { publishedAt: '2026-10-02T02:00:00Z' })
const E = item('e', { publishedAt: '2026-10-01T02:00:00Z' })

type Outcome<T> = T | { error: string }
const onSave = vi.fn<(postIds: string[]) => Promise<Outcome<CuratedPost[]>>>()
const onFeature = vi.fn<(postId: string) => Promise<Outcome<CuratedPost>>>()
const onUnfeature = vi.fn<(postId: string) => Promise<Outcome<CuratedPost>>>()

function renderManager(featured: CuratedPost[] = [A, B, C], candidates: CuratedPost[] = [D, E]) {
  return render(
    <CuratedManager
      featured={featured}
      candidates={candidates}
      onSave={onSave}
      onFeature={onFeature}
      onUnfeature={onUnfeature}
    />,
  )
}

/** Titles of the posts in the picked list, in on-screen order. */
const listedTitles = () =>
  within(screen.getByRole('list', { name: msg('Admin.curated.orderLabel') }))
    .getAllByRole('listitem')
    .map((li) => li.querySelector('[data-title]')?.textContent)

/** Titles of the posts in the "Add a post" box, without the prompt line. */
const candidateTitles = () =>
  within(screen.getByLabelText(msg('Admin.series.parts.addLabel')))
    .getAllByRole('option')
    .filter((o) => (o as HTMLOptionElement).value !== '')
    .map((o) => o.textContent)

async function click(name: RegExp | string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })
}

const redirectRejection = () => Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;push;/admin/login;307;' })

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('CuratedManager: reordering', () => {
  it('lists the picked posts in the order received, numbered, a draft labelled', () => {
    renderManager([A, item('n', { status: 'DRAFT', publishedAt: null }), B])

    expect(listedTitles()).toEqual(['Post A', 'Post N', 'Post B'])
    const rows = within(screen.getByRole('list', { name: msg('Admin.curated.orderLabel') })).getAllByRole('listitem')
    // A picked draft still has a place in the order, but shows up nowhere yet: it must say so.
    expect(rows[1]).toHaveTextContent(rx(msg('Admin.statuses.post.DRAFT')))
    expect(rows[0]).not.toHaveTextContent(rx(msg('Admin.statuses.post.DRAFT')))
  })

  it('↑↓ reorder in place, without calling the server yet', async () => {
    renderManager()

    await click(msg('Admin.series.parts.moveUpLabel', { title: 'Post B' }))
    expect(listedTitles()).toEqual(['Post B', 'Post A', 'Post C'])

    await click(msg('Admin.series.parts.moveDownLabel', { title: 'Post B' }))
    await click(msg('Admin.series.parts.moveDownLabel', { title: 'Post B' }))
    expect(listedTitles()).toEqual(['Post A', 'Post C', 'Post B'])

    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText(rx(msg('Admin.curated.unsaved')))).toBeInTheDocument()
  })

  it('the first post cannot move up, the last cannot move down', async () => {
    renderManager()

    const up = screen.getByRole('button', { name: msg('Admin.series.parts.moveUpLabel', { title: 'Post A' }) })
    const down = screen.getByRole('button', { name: msg('Admin.series.parts.moveDownLabel', { title: 'Post C' }) })
    expect(up).toHaveAttribute('aria-disabled', 'true')
    expect(down).toHaveAttribute('aria-disabled', 'true')
    // The "present" counterpart: a button in the middle is usable.
    expect(
      screen.getByRole('button', { name: msg('Admin.series.parts.moveDownLabel', { title: 'Post A' }) }),
    ).not.toHaveAttribute('aria-disabled')

    await act(async () => fireEvent.click(up))
    await act(async () => fireEvent.click(down))
    expect(listedTitles()).toEqual(['Post A', 'Post B', 'Post C'])
  })

  it('"Save order" sends the exact id array in on-screen order', async () => {
    onSave.mockResolvedValue([B, A, C])
    renderManager()

    await click(msg('Admin.series.parts.moveUpLabel', { title: 'Post B' }))
    await click(msg('Admin.series.parts.save'))

    expect(onSave).toHaveBeenCalledWith(['b', 'a', 'c'])
    expect(screen.getByRole('status')).toHaveTextContent(rx(msg('Admin.curated.orderSaved')))
    expect(screen.queryByText(rx(msg('Admin.curated.unsaved')))).toBeNull()
  })

  it('after saving, shows the list the backend returned (including posts picked elsewhere)', async () => {
    const elsewhere = item('x', { title: 'Post picked from another tab' })
    onSave.mockResolvedValue([A, B, C, elsewhere])
    renderManager()

    await click(msg('Admin.series.parts.save'))

    expect(listedTitles()).toEqual(['Post A', 'Post B', 'Post C', 'Post picked from another tab'])
  })

  it('a post picked in another tab leaves the "Add post" box when the saved list contains it', async () => {
    // D is still in this screen's "Add a post" box, but another tab just picked it: the list the backend
    // returned has D. Leaving it in the box means "Add" again would only push D to the bottom of the list.
    onSave.mockResolvedValue([A, B, C, { ...D }])
    renderManager()

    await click(msg('Admin.series.parts.save'))

    expect(listedTitles()).toEqual(['Post A', 'Post B', 'Post C', 'Post D'])
    expect(candidateTitles()).toEqual(['Post E'])
  })

  it('save error → the action message in role="alert", the on-screen order kept to retry', async () => {
    onSave.mockResolvedValue({ error: msg('Admin.curated.missingPost') })
    renderManager()

    await click(msg('Admin.series.parts.moveUpLabel', { title: 'Post C' }))
    await click(msg('Admin.series.parts.save'))

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Admin.curated.missingPost'))
    expect(listedTitles()).toEqual(['Post A', 'Post C', 'Post B'])
    expect(screen.getByText(rx(msg('Admin.curated.unsaved')))).toBeInTheDocument()
  })

  it('while saving: every button is locked (a double press does not send twice), reopened when done', async () => {
    let finish!: (value: CuratedPost[]) => void
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

  it('no post picked: says so plainly, nothing to save', () => {
    renderManager([], [D])

    expect(screen.getByText(msg('Site.startHere.empty'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: msg('Admin.series.parts.save') })).toBeDisabled()
  })
})

describe('CuratedManager: add and remove', () => {
  it('"Add a post" lists exactly the candidates received', () => {
    renderManager()

    expect(candidateTitles()).toEqual(['Post D', 'Post E'])
  })

  it('add: calls feature for the chosen post, the post goes to the end of the list and leaves the "Add post" box', async () => {
    onFeature.mockResolvedValue({ ...D })
    renderManager()

    fireEvent.change(screen.getByLabelText(msg('Admin.series.parts.addLabel')), { target: { value: 'd' } })
    await click(msg('Admin.editor.inlineCreate.add'))

    expect(onFeature).toHaveBeenCalledWith('d')
    expect(listedTitles()).toEqual(['Post A', 'Post B', 'Post C', 'Post D'])
    expect(candidateTitles()).toEqual(['Post E'])
    expect(screen.getByRole('status')).toHaveTextContent(rx(msg('Admin.curated.added', { title: 'Post D' })))
  })

  it('with no post chosen in the box the "Add" button cannot be pressed yet', () => {
    renderManager()

    expect(screen.getByRole('button', { name: msg('Admin.editor.inlineCreate.add') })).toBeDisabled()
    fireEvent.change(screen.getByLabelText(msg('Admin.series.parts.addLabel')), { target: { value: 'e' } })
    expect(screen.getByRole('button', { name: msg('Admin.editor.inlineCreate.add') })).toBeEnabled()
  })

  it('remove: calls unfeature, the post leaves the list and returns to the "Add a post" box in newest-first order', async () => {
    onUnfeature.mockResolvedValue({ ...B, featuredRank: null, publishedAt: '2026-10-02T12:00:00Z' })
    renderManager()

    await click(msg('Admin.curated.removeLabel', { title: 'Post B' }))

    expect(onUnfeature).toHaveBeenCalledWith('b')
    expect(listedTitles()).toEqual(['Post A', 'Post C'])
    // D 2026-10-02T02:00, B 2026-10-02T12:00, E 2026-10-01: B slots in between, not appended at the end.
    expect(candidateTitles()).toEqual(['Post B', 'Post D', 'Post E'])
  })

  it('removing a draft: it leaves the list, does NOT enter the "Add a post" box (which only takes published posts)', async () => {
    const draft = item('n', { status: 'DRAFT', publishedAt: null })
    onUnfeature.mockResolvedValue({ ...draft })
    renderManager([A, draft], [D])

    await click(msg('Admin.curated.removeLabel', { title: 'Post N' }))

    expect(listedTitles()).toEqual(['Post A'])
    expect(candidateTitles()).toEqual(['Post D'])
  })

  it('no candidates left: says so instead of an empty picker', () => {
    renderManager([A], [])

    expect(screen.queryByLabelText(msg('Admin.series.parts.addLabel'))).toBeNull()
    expect(screen.getByText(rx(msg('Admin.curated.noCandidates')))).toBeInTheDocument()
  })

  it('add/remove error → a message in place, the list unchanged', async () => {
    onUnfeature.mockResolvedValue({ error: msg('Errors.admin.codes.POST_NOT_FOUND') })
    renderManager()

    await click(msg('Admin.curated.removeLabel', { title: 'Post A' }))

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Errors.admin.codes.POST_NOT_FOUND'))
    expect(listedTitles()).toEqual(['Post A', 'Post B', 'Post C'])
  })
})

describe('CuratedManager: errors outside the action', () => {
  it('expired session (the action redirects) is not shown as an error', async () => {
    onSave.mockRejectedValue(redirectRejection())
    renderManager()

    await click(msg('Admin.series.parts.save'))

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('action rejected for another reason → still a message, not silent', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    onFeature.mockRejectedValue(new TypeError('Failed to fetch'))
    renderManager()

    fireEvent.change(screen.getByLabelText(msg('Admin.series.parts.addLabel')), { target: { value: 'd' } })
    await click(msg('Admin.editor.inlineCreate.add'))

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Errors.admin.unreachable'))
    expect(screen.getByRole('button', { name: msg('Admin.editor.inlineCreate.add') })).toBeEnabled()
  })
})

describe('CuratedManager: focus after removing a post', () => {
  // The "Remove" button holding focus leaves the page along with its row: without a fallback focus falls back to <body>
  // and a keyboard user must Tab again from the top of the page (QA, as GalleryManager already fixed).
  const removeButton = (title: string) => screen.getByRole('button', { name: msg('Admin.curated.removeLabel', { title }) })

  it('removing a middle row: focus goes to the "Remove" button of the row that took its place', async () => {
    onUnfeature.mockResolvedValue({ ...B, featuredRank: null })
    renderManager()

    await click(msg('Admin.curated.removeLabel', { title: 'Post B' }))

    expect(listedTitles()).toEqual(['Post A', 'Post C'])
    expect(removeButton('Post C')).toHaveFocus()
  })

  it('removing the last row: focus goes to the row before it', async () => {
    onUnfeature.mockResolvedValue({ ...C, featuredRank: null })
    renderManager()

    await click(msg('Admin.curated.removeLabel', { title: 'Post C' }))

    expect(removeButton('Post B')).toHaveFocus()
  })

  it('removing the last remaining post: focus goes to the line "No posts picked yet."', async () => {
    onUnfeature.mockResolvedValue({ ...A, featuredRank: null })
    renderManager([A])

    await click(msg('Admin.curated.removeLabel', { title: 'Post A' }))

    expect(screen.getByText(msg('Site.startHere.empty'))).toHaveFocus()
  })

  it('failed remove: the row stays, no focus move is carried over to the next paint', async () => {
    onUnfeature.mockResolvedValue({ error: msg('Errors.admin.codes.POST_NOT_FOUND') })
    renderManager()

    await click(msg('Admin.curated.removeLabel', { title: 'Post B' }))
    // A later list change (↑) must not drag focus away because of that failed remove.
    const up = screen.getByRole('button', { name: msg('Admin.series.parts.moveUpLabel', { title: 'Post C' }) })
    up.focus()
    await click(msg('Admin.series.parts.moveUpLabel', { title: 'Post C' }))

    expect(listedTitles()).toEqual(['Post A', 'Post C', 'Post B'])
    expect(up).toHaveFocus()
  })

  it('the ordinal has enough contrast on white: slate-500, not slate-400 (2.63:1)', () => {
    renderManager()

    const number = within(screen.getByRole('list', { name: msg('Admin.curated.orderLabel') }))
      .getAllByRole('listitem')[0]
      .querySelector('[aria-hidden="true"]')
    expect(number).toHaveTextContent('1')
    expect(number).toHaveClass('text-slate-500')
    expect(number).not.toHaveClass('text-slate-400')
  })
})

describe('CuratedManager: list structure is readable', () => {
  /** Titles of the rows carrying the home label, in on-screen order. */
  const homeTitles = () =>
    within(screen.getByRole('list', { name: msg('Admin.curated.orderLabel') }))
      .getAllByRole('listitem')
      .filter((li) => within(li).queryByText(msg('Admin.curated.onHome')) !== null)
      .map((li) => li.querySelector('[data-title]')?.textContent)

  it('the first three PUBLISHED posts carry the label "Shown on the home page"; a draft takes no slot; the label follows ↑↓', async () => {
    // The home page asks the public API, where only published posts exist, then takes the first three by rank (e2e
    // curated.spec.ts: `published(swapped).slice(0, 3)`). Labelling "the first three rows" would let a draft
    // at position 2 take the label of the fourth post, the one that really reaches the home page.
    renderManager([A, item('n', { status: 'DRAFT', publishedAt: null }), B, C, D])

    expect(homeTitles()).toEqual(['Post A', 'Post B', 'Post C'])

    await click(msg('Admin.series.parts.moveUpLabel', { title: 'Post D' }))
    expect(homeTitles()).toEqual(['Post A', 'Post B', 'Post D'])
  })

  it('every row, including one with a status dot: the first aria-hidden element is the slate-500 ordinal', () => {
    // The contrast test above only looks at the first row, a published one. The dot of "Draft" and the icons of the
    // buttons are also aria-hidden: they must come after the number, otherwise that test measures the wrong element.
    renderManager([A, item('n', { status: 'DRAFT', publishedAt: null }), B])

    const rows = within(screen.getByRole('list', { name: msg('Admin.curated.orderLabel') })).getAllByRole('listitem')
    rows.forEach((row, index) => {
      const number = row.querySelector('[aria-hidden="true"]')
      expect(number).toHaveTextContent(String(index + 1))
      expect(number).toHaveClass('text-slate-500')
    })
  })

  it('the "Add post" box has an explanatory sentence, linked through aria-describedby', () => {
    renderManager()

    expect(screen.getByLabelText(msg('Admin.series.parts.addLabel'))).toHaveAccessibleDescription(
      rx(msg('Admin.curated.addHint')),
    )
  })

  it('empty list: points to the box below only when that box has posts to pick', () => {
    // No candidate means no published post exists: telling the user "add from the box below" while
    // that box only says "no posts left" leads them into a dead end.
    const { unmount } = renderManager([], [D])
    expect(screen.getByText(rx(msg('Admin.curated.emptyBodyAdd')))).toBeInTheDocument()
    unmount()

    renderManager([], [])
    expect(screen.queryByText(rx(msg('Admin.curated.emptyBodyAdd')))).toBeNull()
    expect(screen.getByText(msg('Site.startHere.empty'))).toBeInTheDocument()
  })
})
