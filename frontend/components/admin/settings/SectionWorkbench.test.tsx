import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { msg } from '@/test/render-intl'
import ImportForm from './ImportForm'
import JsonEditor from './JsonEditor'
import SectionWorkbench from './SectionWorkbench'
import type { SaveSection } from './fields'

const SAVED = { saved: true as const, payload: {}, updatedAt: '2026-10-11T00:00:00Z' }
const onSave = vi.fn<SaveSection>()

const press = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })
}

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('JsonEditor', () => {
  const area = () => screen.getByLabelText(msg('Admin.settings.json.label')) as HTMLTextAreaElement
  const change = (text: string) => fireEvent.change(area(), { target: { value: text } })

  it('shows a syntax error in an alert and does not call the action', async () => {
    render(<JsonEditor value={{ entries: [] }} onSave={onSave} />)

    change('{\n  "entries": [,\n}')
    await press(msg('Admin.settings.save'))

    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('refuses JSON that is not an object', async () => {
    render(<JsonEditor value={{}} onSave={onSave} />)

    change('[1, 2]')
    await press(msg('Admin.settings.save'))

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Admin.settings.json.notObject'))
    expect(onSave).not.toHaveBeenCalled()
  })

  it('formats on request and sends the parsed object, pretty-printed in the box', async () => {
    onSave.mockResolvedValue(SAVED)
    render(<JsonEditor value={{}} onSave={onSave} />)

    change('{"entries":[{"name":"A"}]}')
    await press(msg('Admin.settings.json.format'))
    expect(area().value).toBe('{\n  "entries": [\n    {\n      "name": "A"\n    }\n  ]\n}')
    await press(msg('Admin.settings.save'))

    expect(onSave).toHaveBeenCalledWith({ entries: [{ name: 'A' }] })
  })

  it('maps a server problem to the line of the pretty-printed text and selects it on request', async () => {
    onSave.mockResolvedValue({
      error: msg('Admin.settings.errors.invalid'),
      problems: [{ pointer: '/entries/1/url', reason: 'must be an https URL' }],
    })
    render(<JsonEditor value={{}} onSave={onSave} />)

    change('{"entries":[{"url":"https://a.example"},{"url":"http://b.example"}]}')
    await press(msg('Admin.settings.save'))

    // Pretty text: line 1 "{", 2 "entries", 3 "{", 4 url, 5 "}," 6 "{", 7 url ...
    const goTo = screen.getByRole('button', { name: msg('Admin.settings.json.line', { line: 7 }) })
    expect(screen.getByText('must be an https URL', { exact: false })).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(goTo)
    })
    const [start, end] = [area().selectionStart, area().selectionEnd]
    expect(area().value.slice(start, end)).toBe('      "url": "http://b.example"')
  })
})

describe('SectionWorkbench', () => {
  const revisions = [{ id: 9, schemaVersion: 1, createdAt: '2026-10-10T08:30:00Z' }]
  const site = { name: 'Saved name', tagline: '', positioning: '' }

  it('restoring a version puts its values into the form and announces it', async () => {
    const onRestore = vi.fn(async () => ({ ...SAVED, payload: { ...site, name: 'Restored name' } }))
    render(
      <SectionWorkbench
        sectionKey="site"
        payload={site}
        revisions={revisions}
        onSave={onSave}
        onRestore={onRestore}
        onUploadAvatar={vi.fn()}
      />,
    )
    expect(screen.getByLabelText(msg('Admin.settings.site.name'))).toHaveValue('Saved name')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(msg('Admin.settings.revisions.restore')) }))
    })

    expect(onRestore).toHaveBeenCalledWith(9)
    expect(screen.getByLabelText(msg('Admin.settings.site.name'))).toHaveValue('Restored name')
    expect(screen.getByText(msg('Admin.settings.revisions.restored'))).toBeInTheDocument()
  })

  it('a failed restore keeps the form and shows the error', async () => {
    const onRestore = vi.fn(async () => ({ error: 'That earlier version no longer exists.' }))
    render(
      <SectionWorkbench
        sectionKey="site"
        payload={site}
        revisions={revisions}
        onSave={onSave}
        onRestore={onRestore}
        onUploadAvatar={vi.fn()}
      />,
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(msg('Admin.settings.revisions.restore')) }))
    })

    expect(screen.getByRole('alert')).toHaveTextContent('That earlier version no longer exists.')
    expect(screen.getByLabelText(msg('Admin.settings.site.name'))).toHaveValue('Saved name')
  })

  it('uses the JSON editor for a key without a form and tells when there is no history', () => {
    render(
      <SectionWorkbench
        sectionKey="blogroll"
        payload={{ entries: [] }}
        revisions={[]}
        onSave={onSave}
        onRestore={vi.fn()}
        onUploadAvatar={vi.fn()}
      />,
    )

    expect(screen.getByLabelText(msg('Admin.settings.json.label'))).toBeInTheDocument()
    expect(screen.getByText(msg('Admin.settings.revisions.empty'))).toBeInTheDocument()
  })

  it('the timeline has a real form, not the JSON editor', () => {
    render(
      <SectionWorkbench
        sectionKey="timeline"
        payload={{ experienceSummary: '', entries: [] }}
        revisions={[]}
        onSave={onSave}
        onRestore={vi.fn()}
        onUploadAvatar={vi.fn()}
      />,
    )

    expect(screen.queryByLabelText(msg('Admin.settings.json.label'))).not.toBeInTheDocument()
    expect(screen.getByLabelText(msg('Admin.settings.timeline.summary'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: msg('Admin.settings.timeline.addEntry') })).toBeInTheDocument()
  })
})

describe('ImportForm', () => {
  it('sends the chosen file and lists what happened to each section', async () => {
    const onImport = vi.fn(async (form: FormData) => {
      expect(form.get('file')).toBeInstanceOf(File)
      return { locale: 'en' as const, sections: [{ key: 'site' as const, status: 'created' as const }] }
    })
    render(<ImportForm onImport={onImport} />)

    expect(screen.getByRole('button', { name: msg('Admin.settings.import.submit') })).toBeDisabled()
    fireEvent.change(screen.getByLabelText(msg('Admin.settings.import.file')), {
      target: { files: [new File(['{}'], 'site-content-en.json', { type: 'application/json' })] },
    })
    await press(msg('Admin.settings.import.submit'))

    expect(onImport).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status')).toHaveTextContent(msg('Admin.settings.import.done'))
    expect(
      screen.getByText(
        msg('Admin.settings.import.sectionResult', { name: msg('Admin.settings.sections.site.title'), status: 'created' }),
      ),
    ).toBeInTheDocument()
  })

  it('shows a refused document with its problems', async () => {
    const onImport = vi.fn(async () => ({
      error: msg('Admin.settings.errors.invalid'),
      problems: [{ pointer: '/sections/site/payload/name', reason: 'must not be blank' }],
    }))
    render(<ImportForm onImport={onImport} />)

    fireEvent.change(screen.getByLabelText(msg('Admin.settings.import.file')), {
      target: { files: [new File(['{}'], 'x.json', { type: 'application/json' })] },
    })
    await press(msg('Admin.settings.import.submit'))

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Admin.settings.errors.invalid'))
    expect(screen.getByText('/sections/site/payload/name')).toBeInTheDocument()
  })
})
