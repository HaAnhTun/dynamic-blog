import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Timeline } from '@/lib/site-content-types'
import { msg } from '@/test/render-intl'
import type { SaveSection } from './fields'
import TimelineForm from './TimelineForm'

const SAVED = { saved: true as const, payload: {}, updatedAt: '2026-10-11T00:00:00Z' }
const onSave = vi.fn<SaveSection>()
const m = (key: string, values?: Record<string, string | number>) => msg(`Admin.settings.timeline.${key}`, values)

const type = (label: string, value: string, index = 0) =>
  fireEvent.change(screen.getAllByLabelText(label)[index]!, { target: { value } })
const press = async (name: string, index = 0) => {
  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name })[index]!)
  })
}
const save = () => press(msg('Admin.settings.save'))
const sent = () => onSave.mock.calls[0]![0] as Timeline

const LOGO = '/media/0b8d6b2e-1d3f-4a52-9a8e-3f7a5b0f2c11.png'

/** An entry stored before the optional fields existed: it has none of them. */
const OLD: Timeline['entries'][number] = {
  kind: 'education',
  title: 'Example degree',
  org: null,
  period: null,
  summary: 'What was studied.',
}
const FULL: Timeline['entries'][number] = {
  kind: 'experience',
  title: 'Software engineer',
  org: 'Example Org',
  period: '09/2023 - Present',
  summary: 'A short blurb.',
  url: 'https://example.org',
  location: 'Example City',
  department: 'Platform team',
  highlights: ['Built the first thing.', 'Improved the second thing.'],
  tech: ['Java', 'PostgreSQL'],
  logo: LOGO,
}
const value = (...entries: Timeline['entries']): Timeline => ({ experienceSummary: 'Summary.', entries })

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('TimelineForm', () => {
  it('an entry stored without the optional fields is sent back exactly as it was', async () => {
    onSave.mockResolvedValue(SAVED)
    render(<TimelineForm value={value(OLD)} onSave={onSave} />)

    await save()

    expect(sent()).toEqual({ experienceSummary: 'Summary.', entries: [OLD] })
    expect(screen.getByRole('status')).toHaveTextContent(msg('Admin.settings.saved'))
  })

  it('shows every field of an entry and sends all of them, the lists as trimmed lines without blanks', async () => {
    onSave.mockResolvedValue(SAVED)
    render(<TimelineForm value={value(FULL)} onSave={onSave} />)

    expect(screen.getByLabelText(m('title'))).toHaveValue('Software engineer')
    expect(screen.getByLabelText(m('org'))).toHaveValue('Example Org')
    expect(screen.getByLabelText(m('period'))).toHaveValue('09/2023 - Present')
    expect(screen.getByLabelText(m('url'))).toHaveValue('https://example.org')
    expect(screen.getByLabelText(m('location'))).toHaveValue('Example City')
    expect(screen.getByLabelText(m('department'))).toHaveValue('Platform team')
    expect(screen.getByLabelText(m('highlights'))).toHaveValue('Built the first thing.\nImproved the second thing.')
    expect(screen.getByLabelText(m('tech'))).toHaveValue('Java\nPostgreSQL')

    type(m('highlights'), '  First  \n\n  Second\n  ')
    type(m('tech'), 'Go\n  Rust ')
    await save()

    expect(sent().entries[0]).toEqual({ ...FULL, highlights: ['First', 'Second'], tech: ['Go', 'Rust'] })
  })

  it('leaves out an optional field that was emptied: no empty string, no empty list', async () => {
    onSave.mockResolvedValue(SAVED)
    render(<TimelineForm value={value(FULL)} onSave={onSave} />)

    for (const label of ['url', 'location', 'department', 'highlights', 'tech', 'org', 'period']) type(m(label), '  ')
    await save()

    expect(sent().entries[0]).toEqual({
      kind: 'experience',
      title: 'Software engineer',
      org: null,
      period: null,
      summary: 'A short blurb.',
      logo: LOGO,
    })
  })

  it('adds an entry, which starts as an experience, and sends what was typed', async () => {
    onSave.mockResolvedValue(SAVED)
    render(<TimelineForm value={value()} onSave={onSave} />)

    await press(m('addEntry'))
    expect(screen.getByLabelText(m('kind'))).toHaveValue('experience')
    type(m('title'), 'New role')
    type(m('org'), 'New Org')
    type(m('entrySummary'), 'Line one\nline two')
    fireEvent.change(screen.getByLabelText(m('kind')), { target: { value: 'education' } })
    await save()

    expect(sent().entries).toEqual([
      { kind: 'education', title: 'New role', org: 'New Org', period: null, summary: 'Line one line two' },
    ])
  })

  it('removes an entry from the middle and keeps the others in order', async () => {
    onSave.mockResolvedValue(SAVED)
    const entries = ['One', 'Two', 'Three'].map((title) => ({ ...OLD, title }))
    render(<TimelineForm value={value(...entries)} onSave={onSave} />)

    await press(msg('Admin.settings.removeAria', { title: m('entryTitle', { n: 2 }) }))
    await save()

    expect(sent().entries.map((entry) => entry.title)).toEqual(['One', 'Three'])
  })

  it('moves an entry up and down; the first cannot go up and the last cannot go down', async () => {
    onSave.mockResolvedValue(SAVED)
    const entries = ['One', 'Two', 'Three'].map((title) => ({ ...OLD, title }))
    render(<TimelineForm value={value(...entries)} onSave={onSave} />)

    expect(screen.getByRole('button', { name: m('moveUpAria', { title: 'One' }) })).toBeDisabled()
    expect(screen.getByRole('button', { name: m('moveDownAria', { title: 'Three' }) })).toBeDisabled()

    await press(m('moveDownAria', { title: 'One' }))
    await press(m('moveUpAria', { title: 'Three' }))
    await save()

    expect(sent().entries.map((entry) => entry.title)).toEqual(['Two', 'Three', 'One'])
  })

  it('keeps the focus on a move button of the entry that moved', async () => {
    const entries = ['One', 'Two'].map((title) => ({ ...OLD, title }))
    render(<TimelineForm value={value(...entries)} onSave={onSave} />)

    await press(m('moveDownAria', { title: 'One' }))

    // "One" is now last, so its down button is disabled and the focus goes to the up button of the same entry.
    expect(screen.getByRole('button', { name: m('moveUpAria', { title: 'One' }) })).toHaveFocus()
  })

  it('shows the stored logo and sends it again; Remove logo drops it from the payload', async () => {
    onSave.mockResolvedValue(SAVED)
    const { container } = render(<TimelineForm value={value(FULL)} onSave={onSave} />)

    expect(container.querySelector('img')?.getAttribute('src')).toContain('0b8d6b2e-1d3f-4a52-9a8e-3f7a5b0f2c11.png')
    await save()
    expect(sent().entries[0]!.logo).toBe(LOGO)

    onSave.mockClear()
    await press(m('logoRemove'))
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText(m('logoNone'))).toBeInTheDocument()
    await save()
    expect(sent().entries[0]).not.toHaveProperty('logo')
  })

  it('has no way to set a logo here: only the hint that it comes with the ZIP package', () => {
    render(<TimelineForm value={value(OLD)} onSave={onSave} />)

    expect(document.querySelector('input[type="file"]')).toBeNull()
    expect(screen.getByText(m('logoHint'))).toBeInTheDocument()
  })

  it('refuses too many highlight lines before sending, names the problem and disables Save', () => {
    render(<TimelineForm value={value(OLD)} onSave={onSave} />)

    type(m('highlights'), Array.from({ length: 13 }, (_, i) => `Point ${i}`).join('\n'))

    expect(screen.getByText(m('tooMany', { max: 12 }))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: msg('Admin.settings.save') })).toBeDisabled()

    type(m('highlights'), 'Point')
    expect(screen.queryByText(m('tooMany', { max: 12 }))).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: msg('Admin.settings.save') })).toBeEnabled()
  })

  it('refuses a technology line that is too long', () => {
    render(<TimelineForm value={value(OLD)} onSave={onSave} />)

    type(m('tech'), `Fine\n${'x'.repeat(41)}`)

    expect(screen.getByText(m('tooLong', { length: 40 }))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: msg('Admin.settings.save') })).toBeDisabled()
  })

  it('shows the fields the backend refused, in an alert, and keeps what was typed', async () => {
    onSave.mockResolvedValue({
      error: msg('Admin.settings.errors.invalid'),
      problems: [{ pointer: '/entries/0/url', reason: 'must be an https address' }],
    })
    render(<TimelineForm value={value(FULL)} onSave={onSave} />)

    type(m('url'), 'https://typed.example')
    await save()

    expect(within(screen.getByRole('alert')).getByText(msg('Admin.settings.errors.invalid'))).toBeInTheDocument()
    expect(screen.getByText('/entries/0/url')).toBeInTheDocument()
    expect(screen.getByLabelText(m('url'))).toHaveValue('https://typed.example')
  })

  it('labels the summary and sends it trimmed', async () => {
    onSave.mockResolvedValue(SAVED)
    render(<TimelineForm value={value(OLD)} onSave={onSave} />)

    type(m('summary'), ' Three years. ')
    await save()

    expect(sent().experienceSummary).toBe('Three years.')
  })
})
