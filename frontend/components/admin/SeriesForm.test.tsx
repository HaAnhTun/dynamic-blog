import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SeriesForm, { type SeriesFields, type SeriesFormOutcome } from './SeriesForm'
import { msg } from '@/test/render-intl'

const onSubmit = vi.fn<(form: FormData) => Promise<SeriesFormOutcome>>()

const SAVED: SeriesFields = {
  title: 'A sample series',
  slug: 'a-sample-series',
  description: 'A few intro lines.',
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

async function submit(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })
}

/** The `redirect()` error of an action reaching the client: the promise is rejected while the router navigates by itself. */
const redirectRejection = (url = '/admin/series/5f0c2a1e-3b4d-4c6e-8f7a-9b0c1d2e3f40') =>
  Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;push;${url};307;` })

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('SeriesForm: create', () => {
  it('empty boxes, the name is required, the "Create series" button', () => {
    render(<SeriesForm series={null} onSubmit={onSubmit} />)

    expect(screen.getByLabelText(msg('Admin.series.form.titleLabel'))).toHaveValue('')
    expect(screen.getByLabelText(msg('Admin.series.form.titleLabel'))).toBeRequired()
    // Positive counterpart: the other two boxes are optional (with an empty slug the backend generates one from the name).
    expect(screen.getByLabelText(msg('Site.breadcrumb.label'))).not.toBeRequired()
    expect(screen.getByLabelText(msg('Admin.topics.manager.descriptionLabel'))).not.toBeRequired()
    expect(screen.getByRole('button', { name: msg('Admin.series.create') })).toBeEnabled()
  })

  it('sends exactly what was typed, under the field names the action reads', async () => {
    onSubmit.mockRejectedValue(redirectRejection())
    render(<SeriesForm series={null} onSubmit={onSubmit} />)

    type(msg('Admin.series.form.titleLabel'), 'A sample series')
    type(msg('Admin.topics.manager.descriptionLabel'), 'A few intro lines.')
    await submit(msg('Admin.series.create'))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    const sent = onSubmit.mock.calls[0]![0]
    expect(sent.get('title')).toBe('A sample series')
    expect(sent.get('slug')).toBe('')
    expect(sent.get('description')).toBe('A few intro lines.')
  })

  it('after creating (the action navigates to the edit page) it is not shown as an error', async () => {
    onSubmit.mockRejectedValue(redirectRejection())
    render(<SeriesForm series={null} onSubmit={onSubmit} />)

    type(msg('Admin.series.form.titleLabel'), 'A sample series')
    await submit(msg('Admin.series.create'))

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('duplicate name → the action message in role="alert", the typed text stays intact', async () => {
    onSubmit.mockResolvedValue({ error: msg('Errors.admin.codes.SERIES_ALREADY_EXISTS') })
    render(<SeriesForm series={null} onSubmit={onSubmit} />)

    type(msg('Admin.series.form.titleLabel'), 'A sample series')
    type(msg('Admin.topics.manager.descriptionLabel'), 'A few intro lines.')
    await submit(msg('Admin.series.create'))

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Errors.admin.codes.SERIES_ALREADY_EXISTS'))
    expect(screen.getByLabelText(msg('Admin.series.form.titleLabel'))).toHaveValue('A sample series')
    expect(screen.getByLabelText(msg('Admin.topics.manager.descriptionLabel'))).toHaveValue('A few intro lines.')
  })

  it('while sending: the button is locked, clicking twice sends only once; unlocked when done', async () => {
    let finish!: (value: SeriesFormOutcome) => void
    onSubmit.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    render(<SeriesForm series={null} onSubmit={onSubmit} />)

    type(msg('Admin.series.form.titleLabel'), 'A sample series')
    await submit(msg('Admin.series.create'))

    expect(screen.getByRole('button', { name: msg('Admin.series.create') })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: msg('Admin.series.create') }))
    expect(onSubmit).toHaveBeenCalledTimes(1)

    await act(async () => finish({ error: msg('Errors.admin.codes.SERIES_ALREADY_EXISTS') }))

    expect(screen.getByRole('button', { name: msg('Admin.series.create') })).toBeEnabled()
  })

  it('action rejected for another reason → there is still a message, never silent', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    onSubmit.mockRejectedValue(new TypeError('Failed to fetch'))
    render(<SeriesForm series={null} onSubmit={onSubmit} />)

    type(msg('Admin.series.form.titleLabel'), 'A sample series')
    await submit(msg('Admin.series.create'))

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Errors.admin.unreachable'))
  })
})

describe('SeriesForm: edit', () => {
  it('prefilled with the stored values; says plainly that changing the path stops the old link working', () => {
    render(<SeriesForm series={{ ...SAVED, description: null }} onSubmit={onSubmit} />)

    expect(screen.getByLabelText(msg('Admin.series.form.titleLabel'))).toHaveValue('A sample series')
    expect(screen.getByLabelText(msg('Site.breadcrumb.label'))).toHaveValue('a-sample-series')
    expect(screen.getByLabelText(msg('Admin.topics.manager.descriptionLabel'))).toHaveValue('')
    expect(screen.getByText(msg('Admin.series.form.slugHintEdit'), { exact: false })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: msg('Admin.series.form.saveInfo') })).toBeInTheDocument()
    // Negative counterpart: the create form button does not leak in here.
    expect(screen.queryByRole('button', { name: msg('Admin.series.create') })).toBeNull()
  })

  it('after saving: the boxes show exactly the values the backend saved (slug normalized), not the text just typed', async () => {
    onSubmit.mockResolvedValue({ title: 'New name', slug: 'new-name', description: null })
    render(<SeriesForm series={SAVED} onSubmit={onSubmit} />)

    type(msg('Admin.series.form.titleLabel'), '  New name ')
    type(msg('Site.breadcrumb.label'), 'New Name')
    type(msg('Admin.topics.manager.descriptionLabel'), '   ')
    await submit(msg('Admin.series.form.saveInfo'))

    expect(screen.getByLabelText(msg('Admin.series.form.titleLabel'))).toHaveValue('New name')
    expect(screen.getByLabelText(msg('Site.breadcrumb.label'))).toHaveValue('new-name')
    expect(screen.getByLabelText(msg('Admin.topics.manager.descriptionLabel'))).toHaveValue('')
    expect(screen.getByRole('status')).toHaveTextContent(msg('Admin.series.form.saved'))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('save error → role="alert", does not report "Saved."', async () => {
    onSubmit.mockResolvedValue({ error: msg('Errors.admin.codes.SERIES_ALREADY_EXISTS') })
    render(<SeriesForm series={SAVED} onSubmit={onSubmit} />)

    await submit(msg('Admin.series.form.saveInfo'))

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Errors.admin.codes.SERIES_ALREADY_EXISTS'))
    expect(screen.getByRole('status')).not.toHaveTextContent(msg('Admin.series.form.saved'))
  })
})
