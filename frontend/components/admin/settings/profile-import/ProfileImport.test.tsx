import { act, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatDate } from '@/lib/date'
import type { ApplyResult, ImportPreview, LastImport, PreviewSection } from '@/lib/admin-site-import'
import { IntlWrapper, msg } from '@/test/intl'
import ProfileImport from './ProfileImport'

const HASH = 'c'.repeat(64)
const p = (key: string, args?: Record<string, string | number>) => msg(`Admin.settings.profileImport.${key}`, args)

const section = (over: Partial<PreviewSection> & Pick<PreviewSection, 'id' | 'heading'>): PreviewSection => ({
  key: 'profile',
  line: 5,
  present: true,
  status: 'new',
  selectable: true,
  changes: [],
  missingOptional: [],
  errors: [],
  ...over,
})

const preview = (over: Partial<ImportPreview> = {}): ImportPreview => ({
  sha256: HASH,
  bytes: 900,
  schemaVersion: '1',
  contentType: 'site-profile',
  locale: 'en',
  willWriteTo: 'en',
  errors: [],
  ignored: [],
  ignoredTotal: 0,
  sections: [
    section({
      id: 'identity',
      heading: 'Identity',
      status: 'will_change',
      changes: [
        { field: 'headline', kind: 'value', before: 'Old line', after: 'New line', added: null, removed: null, kept: null },
        { field: 'groups', kind: 'list', before: null, after: null, added: 2, removed: 1, kept: 3 },
      ],
      missingOptional: ['subline', 'location'],
    }),
    section({ id: 'skills', heading: 'Skills', key: 'skills', status: 'new' }),
    section({ id: 'contact', heading: 'Contact', key: 'contact', status: 'unchanged', line: 20 }),
    section({
      id: 'now',
      heading: 'Now',
      key: 'now',
      status: 'error',
      selectable: false,
      errors: [{ sectionId: 'now', field: 'link', line: 31, message: 'must be an https URL' }],
    }),
    section({
      id: 'timeline',
      heading: 'Timeline',
      key: 'timeline',
      status: 'missing',
      present: false,
      selectable: false,
      line: null,
    }),
  ],
  ...over,
})

const markdown = (name = 'profile.md', content = '# Identity\n') => new File([content], name, { type: 'text/markdown' })

/** The native file input: named by the drop label while no file is chosen, by its own aria-label after. */
const fileInput = () => document.querySelector<HTMLInputElement>('input[type="file"]')!

async function choose(file: File) {
  const input = fileInput()
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } })
  })
}

const click = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })
}

const setup = (
  over: { lastImport?: LastImport | null; onPreview?: unknown; onApply?: unknown; onUndo?: unknown; onStatus?: unknown } = {},
) => {
  const onPreview = vi.fn().mockResolvedValue(preview())
  const onApply = vi.fn()
  const onUndo = vi.fn()
  const onStatus = vi.fn().mockResolvedValue({ lastImport: null })
  const props = { lastImport: null, onPreview, onApply, onUndo, onStatus, ...over } as never
  render(<ProfileImport {...(props as object as Parameters<typeof ProfileImport>[0])} />)
  return { onPreview, onApply, onUndo, onStatus }
}

const applied = (over: Partial<ApplyResult> = {}): ApplyResult => ({
  importId: 9,
  locale: 'en',
  mode: 'update',
  sections: [
    { id: 'identity', key: 'profile', status: 'updated' },
    { id: 'skills', key: 'skills', status: 'created' },
  ],
  ...over,
})

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('ProfileImport idle state', () => {
  it('offers the template and the export of the chosen language and no preview or undo', () => {
    setup()

    expect(screen.getByRole('link', { name: p('template.download') })).toHaveAttribute(
      'href',
      '/admin/settings/import/template?locale=vi',
    )
    fireEvent.change(screen.getByLabelText(p('template.language')), { target: { value: 'en' } })
    expect(screen.getByRole('link', { name: p('template.download') })).toHaveAttribute(
      'href',
      '/admin/settings/import/template?locale=en',
    )
    expect(screen.getByRole('link', { name: p('template.export') })).toHaveAttribute(
      'href',
      '/admin/settings/import/export?locale=en',
    )
    // The same content with its images, as the ZIP package the import reads back.
    expect(screen.getByRole('link', { name: p('template.exportZip') })).toHaveAttribute(
      'href',
      '/admin/settings/import/export?locale=en&format=zip',
    )
    expect(screen.getByText(p('template.exportHint'))).toBeInTheDocument()
    expect(screen.getByText(p('file.dropTitle'))).toBeInTheDocument()
    expect(screen.queryByText(p('preview.heading'))).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: p('undo.button') })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('the file input is reachable by keyboard and described by its hint', () => {
    setup()
    const input = screen.getByLabelText(p('file.dropTitle'), { exact: false })
    expect(input).toBe(fileInput())
    expect(input).toHaveAttribute('accept', expect.stringContaining('.md'))
    expect(input).toHaveAttribute('accept', expect.stringContaining('.zip'))
    expect(document.getElementById(input.getAttribute('aria-describedby')!)).toHaveTextContent(p('file.hint'))
  })

  it('the drop label shows the focus ring of the input (a peer, not a descendant) and names it without an aria-label', () => {
    setup()
    const input = fileInput()
    const label = screen.getByText(p('file.dropTitle')).closest('label')!
    expect(input).toHaveClass('peer')
    expect(input.nextElementSibling).toBe(label)
    expect(label).toHaveClass('peer-focus-visible:outline-2')
    expect(input).not.toHaveAttribute('aria-label')
    expect(input).toHaveAccessibleName(expect.stringContaining(p('file.dropTitle')))
  })

  it('after a file is chosen the input is named by its own label, Replace gets the focus and Remove gives it back to the input', async () => {
    let answer!: (value: ImportPreview) => void
    setup({ onPreview: vi.fn(() => new Promise<ImportPreview>((resolve) => (answer = resolve))) })
    await choose(markdown())

    expect(fileInput()).toHaveAttribute('aria-label', p('file.inputLabel'))
    expect(screen.getByRole('button', { name: p('file.replace') })).toHaveFocus()

    await click(p('file.remove'))
    expect(fileInput()).toHaveFocus()
    await act(async () => answer(preview()))
  })

  it('Replace opens the file chooser from the keyboard and Remove clears the file', async () => {
    setup()
    await choose(markdown())
    await screen.findByRole('list', { name: p('preview.listLabel') })
    const open = vi.spyOn(fileInput(), 'click')

    await click(p('file.replace'))
    expect(open).toHaveBeenCalledTimes(1)

    await click(p('file.remove'))
    expect(screen.getByText(p('file.dropTitle'))).toBeInTheDocument()
    expect(screen.queryByText('profile.md')).not.toBeInTheDocument()
  })

  it('the highlight follows the pointer over the drop zone and does not flicker over its children', () => {
    setup()
    const label = screen.getByText(p('file.dropTitle')).closest('label')!
    const child = screen.getByText(p('file.dropTitle'))

    fireEvent.dragOver(label)
    expect(label).toHaveClass('bg-slate-100')
    // jsdom has no DragEvent, so the related target is set on the event by hand.
    const leave = (relatedTarget: EventTarget | null) => {
      const event = createEvent.dragLeave(label)
      Object.defineProperty(event, 'relatedTarget', { value: relatedTarget })
      fireEvent(label, event)
    }
    leave(child)
    expect(label).toHaveClass('bg-slate-100')
    leave(document.body)
    expect(label).not.toHaveClass('bg-slate-100')
    fireEvent.dragOver(label)
    leave(null)
    expect(label).not.toHaveClass('bg-slate-100')
  })

  it('a refusal of the file is announced by an alert that also describes the input', async () => {
    setup()
    await choose(markdown('profile.txt'))

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(p('errors.notMarkdown'))
    expect(fileInput().getAttribute('aria-describedby')).toContain(alert.parentElement!.id)
    expect(fileInput()).toHaveAccessibleDescription(`${p('file.hint')} ${p('errors.notMarkdown')}`)
  })

  it.each([
    ['a file that is not Markdown', () => markdown('profile.txt'), 'errors.notMarkdown'],
    ['an empty file', () => markdown('profile.md', ''), 'errors.noFile'],
    ['a file over 256 KiB', () => markdown('profile.md', 'x'.repeat(262_145)), 'errors.fileTooLarge'],
  ])('refuses %s on the client without calling the server', async (_name, make, key) => {
    const { onPreview } = setup()

    await choose(make())

    expect(screen.getByRole('alert')).toHaveTextContent(p(key))
    expect(onPreview).not.toHaveBeenCalled()
  })
})

describe('ProfileImport preview', () => {
  it('shows the file, then the preview with every status, the target language and nothing written', async () => {
    const { onPreview } = setup()

    await choose(markdown())

    await screen.findByText(p('preview.willWriteTo', { language: msg('Admin.settings.locales.en') }))
    expect(onPreview).toHaveBeenCalledTimes(1)
    expect((onPreview.mock.calls[0]![0] as FormData).get('file')).toBeInstanceOf(File)
    expect(screen.getByText('profile.md')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: p('file.replace') })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: p('file.remove') })).toBeInTheDocument()
    expect(screen.getByText(p('preview.nothingWritten'))).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(p('status.previewReady'))

    const list = screen.getByRole('list', { name: p('preview.listLabel') })
    const items = Array.from(list.children) as HTMLElement[]
    expect(items).toHaveLength(5)
    for (const [index, status] of ['will_change', 'new', 'unchanged', 'error', 'missing'].entries()) {
      expect(within(items[index]!).getByText(p(`preview.status.${status}`))).toBeInTheDocument()
    }
  })

  it('shows before and after, list counts, optional values left out and the error with heading, line and field', async () => {
    setup()
    await choose(markdown())
    const list = await screen.findByRole('list', { name: p('preview.listLabel') })
    const [identity, , , now] = Array.from(list.children) as HTMLElement[]

    expect(within(identity!).getByText('Old line')).toBeInTheDocument()
    expect(within(identity!).getByText('New line')).toBeInTheDocument()
    expect(
      within(identity!).getByText(p('preview.listCounts', { added: 2, removed: 1, kept: 3 }), { exact: false }),
    ).toBeInTheDocument()
    expect(within(identity!).getByText(/subline/)).toHaveTextContent(/location/)
    expect(
      within(now!).getByText(`Now, ${p('preview.lineNumber', { line: 31 })}, link: must be an https URL`),
    ).toBeInTheDocument()
  })

  it('checks new and changing sections by default and disables the rest', async () => {
    setup()
    await choose(markdown())
    await screen.findByRole('list', { name: p('preview.listLabel') })

    expect(screen.getByRole('checkbox', { name: 'Identity' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Skills' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Contact' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Contact' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Now' })).toBeDisabled()
    expect(screen.queryByRole('checkbox', { name: 'Timeline' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: p('apply', { count: 2 }) })).toBeEnabled()
  })

  it('the apply button follows the number of chosen sections and is off at zero', async () => {
    setup()
    await choose(markdown())
    await screen.findByRole('list', { name: p('preview.listLabel') })

    fireEvent.click(screen.getByRole('checkbox', { name: 'Skills' }))
    expect(screen.getByRole('button', { name: p('apply', { count: 1 }) })).toBeEnabled()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Identity' }))
    expect(screen.getByRole('button', { name: p('apply', { count: 0 }) })).toBeDisabled()
  })

  it('explains both modes with a radio group, update by default', async () => {
    setup()
    await choose(markdown())
    await screen.findByRole('list', { name: p('preview.listLabel') })

    const update = screen.getByRole('radio', { name: p('mode.update.label') })
    const createOnly = screen.getByRole('radio', { name: p('mode.create-only.label') })
    expect(update).toBeChecked()
    expect(createOnly).not.toBeChecked()
    expect(update).toHaveAccessibleDescription(p('mode.update.hint'))
    fireEvent.click(createOnly)
    expect(createOnly).toBeChecked()
  })

  it('file-level errors and the ignored list show and block the apply button', async () => {
    setup({
      onPreview: vi.fn().mockResolvedValue(
        preview({
          locale: null,
          willWriteTo: null,
          errors: [
            { sectionId: null, field: null, line: 3, message: 'unknown schema version' },
            { sectionId: 'skills', field: 'items', line: 12, message: 'a code fence is not allowed' },
          ],
          ignored: [{ kind: 'section', sectionId: null, name: 'Projects', line: 40 }],
          ignoredTotal: 3,
        }),
      ),
    })

    await choose(markdown())

    await screen.findByText(p('preview.noLanguage'))
    expect(screen.getByText(`${p('preview.lineNumber', { line: 3 })}: unknown schema version`)).toBeInTheDocument()
    expect(
      screen.getByText(`Skills, ${p('preview.lineNumber', { line: 12 })}, items: a code fence is not allowed`),
    ).toBeInTheDocument()
    expect(screen.getByText(p('preview.ignoredHeading', { count: 3 }))).toBeInTheDocument()
    expect(screen.getByText(p('preview.ignoredItem', { kind: 'section', name: 'Projects', line: 40 }))).toBeInTheDocument()
    expect(screen.getByText(p('preview.ignoredMore', { count: 2 }))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: p('apply', { count: 2 }) })).toBeDisabled()
  })

  it('moves the focus to the preview heading when the preview arrives', async () => {
    setup()
    await choose(markdown())

    expect(await screen.findByRole('heading', { name: p('preview.heading') })).toHaveFocus()
  })

  it('a file without a valid language blocks the apply button even when it has no other error', async () => {
    setup({ onPreview: vi.fn().mockResolvedValue(preview({ locale: null, willWriteTo: null })) })

    await choose(markdown())

    await screen.findByText(p('preview.noLanguage'))
    expect(screen.getByRole('button', { name: p('apply', { count: 2 }) })).toBeDisabled()
  })

  it('HTML in a value stays text', async () => {
    setup({
      onPreview: vi.fn().mockResolvedValue(
        preview({
          sections: [
            section({
              id: 'identity',
              heading: 'Identity',
              status: 'will_change',
              changes: [
                {
                  field: 'headline',
                  kind: 'value',
                  before: null,
                  after: '<img src=x onerror=alert(1)>',
                  added: null,
                  removed: null,
                  kept: null,
                },
              ],
            }),
          ],
        }),
      ),
    })
    await choose(markdown())

    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByText(p('preview.none'))).toBeInTheDocument()
  })

  it('a refused file shows the error in an alert and no preview', async () => {
    setup({ onPreview: vi.fn().mockResolvedValue({ error: 'The file is not valid UTF-8.' }) })

    await choose(markdown())

    expect(await screen.findByRole('alert')).toHaveTextContent('The file is not valid UTF-8.')
    expect(screen.queryByText(p('preview.heading'))).not.toBeInTheDocument()
  })

  it('an unreachable server shows the generic sentence and logs the cause', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setup({ onPreview: vi.fn().mockRejectedValue(new TypeError('fetch failed')) })

    await choose(markdown())

    expect(await screen.findByRole('alert')).toHaveTextContent(p('errors.unreachable'))
  })

  it('Remove returns to the empty state; a newer file wins over a slow older answer', async () => {
    let first!: (value: ImportPreview) => void
    const onPreview = vi
      .fn()
      .mockImplementationOnce(() => new Promise<ImportPreview>((resolve) => (first = resolve)))
      .mockResolvedValueOnce(preview({ sections: [section({ id: 'skills', heading: 'Skills', key: 'skills' })] }))
    setup({ onPreview })

    await choose(markdown('one.md'))
    expect(screen.getByRole('status')).toHaveTextContent(p('status.previewing'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: p('file.remove') }))
    })
    expect(screen.getByText(p('file.dropTitle'))).toBeInTheDocument()

    await choose(markdown('two.md'))
    await screen.findByRole('checkbox', { name: 'Skills' })
    await act(async () => first(preview()))
    expect(screen.queryByRole('checkbox', { name: 'Identity' })).not.toBeInTheDocument()
  })

  it('a dropped file is previewed like a chosen one', async () => {
    const { onPreview } = setup()

    await act(async () => {
      fireEvent.drop(screen.getByText(p('file.dropTitle')).closest('label')!, {
        dataTransfer: { files: [markdown('dropped.md')] },
      })
    })

    await screen.findByRole('list', { name: p('preview.listLabel') })
    expect(onPreview).toHaveBeenCalledTimes(1)
    expect(screen.getByText('dropped.md')).toBeInTheDocument()
  })
})

describe('ProfileImport apply', () => {
  it('sends the file, the previewed hash, the mode and the chosen sections, then shows the summary and the site link', async () => {
    const { onApply } = setup()
    onApply.mockResolvedValue(applied())
    await choose(markdown())
    await screen.findByRole('list', { name: p('preview.listLabel') })
    fireEvent.click(screen.getByRole('radio', { name: p('mode.create-only.label') }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Skills' }))

    await click(p('apply', { count: 1 }))

    const form = onApply.mock.calls[0]![0] as FormData
    expect(form.get('sha256')).toBe(HASH)
    expect(form.get('mode')).toBe('create-only')
    expect(form.getAll('sections')).toEqual(['identity'])
    expect(form.get('file')).toBeInstanceOf(File)
    expect(await screen.findByText(p('result.summary', { created: 1, updated: 1, unchanged: 0, skipped: 0 }))).toBeInTheDocument()
    expect(screen.getByText(p('result.section', { name: 'Identity', status: 'updated' }))).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: p('result.viewSite', { language: msg('Admin.settings.locales.en') }) }),
    ).toHaveAttribute('href', '/en')
    expect(screen.getByRole('status')).toHaveTextContent(p('status.applied'))
    expect(screen.queryByRole('button', { name: p('apply', { count: 1 }) })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: p('apply', { count: 2 }) })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: p('undo.button') })).toBeInTheDocument()
  })

  it('a refusal keeps the preview and the choices and shows the error', async () => {
    const { onApply } = setup()
    onApply.mockResolvedValue({ error: p('errors.codes.SITE_IMPORT_HASH_MISMATCH') })
    await choose(markdown())
    await screen.findByRole('list', { name: p('preview.listLabel') })

    await click(p('apply', { count: 2 }))

    expect(screen.getByRole('alert')).toHaveTextContent(p('errors.codes.SITE_IMPORT_HASH_MISMATCH'))
    expect(screen.getByRole('button', { name: p('apply', { count: 2 }) })).toBeEnabled()
    expect(screen.queryByText(p('result.heading'))).not.toBeInTheDocument()
  })

  it('an import that wrote nothing offers no undo', async () => {
    const { onApply } = setup()
    onApply.mockResolvedValue(
      applied({
        importId: null,
        sections: [
          { id: 'identity', key: 'profile', status: 'unchanged' },
          { id: 'skills', key: 'skills', status: 'skipped' },
        ],
      }),
    )
    await choose(markdown())
    await screen.findByRole('list', { name: p('preview.listLabel') })

    await click(p('apply', { count: 2 }))

    expect(await screen.findByText(p('result.summary', { created: 0, updated: 0, unchanged: 1, skipped: 1 }))).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: p('undo.button') })).not.toBeInTheDocument()
  })

  it('the apply button is disabled while the request runs, so it cannot be sent twice', async () => {
    let finish!: (value: ApplyResult) => void
    const { onApply } = setup()
    onApply.mockImplementation(() => new Promise<ApplyResult>((resolve) => (finish = resolve)))
    await choose(markdown())
    await screen.findByRole('list', { name: p('preview.listLabel') })

    await click(p('apply', { count: 2 }))
    expect(screen.getByRole('button', { name: p('apply', { count: 2 }) })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent(p('status.applying'))
    await act(async () => finish(applied()))
    expect(onApply).toHaveBeenCalledTimes(1)
  })
})

describe('ProfileImport apply, focus and repeat', () => {
  it('the file control is disabled while the apply runs', async () => {
    let finish!: (value: ApplyResult) => void
    const { onApply } = setup()
    onApply.mockImplementation(() => new Promise<ApplyResult>((resolve) => (finish = resolve)))
    await choose(markdown())
    await screen.findByRole('list', { name: p('preview.listLabel') })

    await click(p('apply', { count: 2 }))

    expect(fileInput()).toBeDisabled()
    expect(screen.getByRole('button', { name: p('file.replace') })).toBeDisabled()
    expect(screen.getByRole('button', { name: p('file.remove') })).toBeDisabled()
    await act(async () => finish(applied()))
  })

  it('moves the focus to the result heading after a success and back to the apply button after a refusal', async () => {
    const { onApply } = setup()
    onApply.mockResolvedValueOnce({ error: p('errors.codes.SITE_IMPORT_HASH_MISMATCH') }).mockResolvedValueOnce(applied())
    await choose(markdown())
    await screen.findByRole('list', { name: p('preview.listLabel') })

    await click(p('apply', { count: 2 }))
    expect(screen.getByRole('button', { name: p('apply', { count: 2 }) })).toHaveFocus()

    await click(p('apply', { count: 2 }))
    expect(await screen.findByRole('heading', { name: p('result.heading') })).toHaveFocus()
  })

  it('a second file can be previewed and applied after the first apply', async () => {
    const { onApply, onPreview } = setup()
    onApply.mockResolvedValue(applied())
    await choose(markdown('one.md'))
    await screen.findByRole('list', { name: p('preview.listLabel') })
    await click(p('apply', { count: 2 }))
    await screen.findByText(p('result.heading'))

    await choose(markdown('two.md'))
    await screen.findByRole('list', { name: p('preview.listLabel') })
    expect(screen.queryByText(p('result.heading'))).not.toBeInTheDocument()
    await click(p('apply', { count: 2 }))

    expect(onPreview).toHaveBeenCalledTimes(2)
    expect(onApply).toHaveBeenCalledTimes(2)
    expect(((onApply.mock.calls[1]![0] as FormData).get('file') as File).name).toBe('two.md')
    expect(await screen.findByText(p('result.heading'))).toBeInTheDocument()
  })
})

describe('ProfileImport undo', () => {
  const last: LastImport = {
    id: 5,
    createdAt: '2026-10-11T10:00:00Z',
    locale: 'vi',
    mode: 'update',
    undone: false,
    undoable: true,
    sections: [{ key: 'profile', status: 'updated' }],
  }

  it('shows the undo of the last import on load only when it is undoable', () => {
    const { unmount } = render(
      <ProfileImport
        lastImport={{ ...last, undoable: false }}
        onPreview={vi.fn()}
        onApply={vi.fn()}
        onUndo={vi.fn()}
        onStatus={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: p('undo.button') })).not.toBeInTheDocument()
    unmount()

    setup({ lastImport: last })
    expect(screen.getByRole('button', { name: p('undo.button') })).toBeInTheDocument()
  })

  it('asks for confirmation, cancels without calling, then undoes and reports each section', async () => {
    const { onUndo, onStatus } = setup({ lastImport: last })
    onUndo.mockResolvedValue({
      importId: 5,
      locale: 'vi',
      sections: [
        { key: 'profile', status: 'restored' },
        { key: 'skills', status: 'removed' },
      ],
    })

    await click(p('undo.button'))
    expect(screen.getByText(p('undo.confirmText'))).toBeInTheDocument()
    await click(p('undo.cancel'))
    expect(screen.queryByText(p('undo.confirmText'))).not.toBeInTheDocument()
    expect(onUndo).not.toHaveBeenCalled()

    await click(p('undo.button'))
    await click(p('undo.confirm'))

    expect(onUndo).toHaveBeenCalledTimes(1)
    expect(onUndo).toHaveBeenCalledWith(5)
    expect(await screen.findByText(p('undo.section', { key: 'profile', status: 'restored' }))).toBeInTheDocument()
    expect(onStatus).toHaveBeenCalledTimes(1)
    expect(screen.getByText(p('undo.section', { key: 'skills', status: 'removed' }))).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(p('status.undone'))
    expect(screen.queryByRole('button', { name: p('undo.button') })).not.toBeInTheDocument()
  })

  it('a refusal that is not stale shows the sentence and keeps the confirmation open so it can be retried or cancelled', async () => {
    const { onUndo, onStatus } = setup({ lastImport: last })
    onUndo.mockResolvedValue({ error: p('errors.codes.SITE_IMPORT_UNDO_CONFLICT') })

    await click(p('undo.button'))
    await click(p('undo.confirm'))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(p('errors.codes.SITE_IMPORT_UNDO_CONFLICT')))
    expect(screen.getByRole('button', { name: p('undo.confirm') })).toBeEnabled()
    expect(screen.getByRole('button', { name: p('undo.button') })).toBeInTheDocument()
    expect(onStatus).not.toHaveBeenCalled()
  })

  it('a stale refusal reloads the status, closes the confirmation and offers the newer import with its own id', async () => {
    const newer: LastImport = { ...last, id: 8, createdAt: '2026-10-11T12:00:00Z', locale: 'en' }
    const { onUndo, onStatus } = setup({ lastImport: last })
    onUndo.mockResolvedValueOnce({ error: p('errors.codes.SITE_IMPORT_UNDO_CONFLICT'), stale: true })
    onStatus.mockResolvedValue({ lastImport: newer })

    await click(p('undo.button'))
    await click(p('undo.confirm'))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(p('errors.codes.SITE_IMPORT_UNDO_CONFLICT')))
    expect(onUndo).toHaveBeenLastCalledWith(5)
    expect(onStatus).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(p('undo.confirmText'))).not.toBeInTheDocument()
    expect(
      screen.getByText(p('undo.last', { when: '19:00, 11/10/2026', language: msg('Admin.settings.locales.en') })),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: p('undo.button') })).toHaveFocus()

    onUndo.mockResolvedValueOnce({ importId: 8, locale: 'en', sections: [{ key: 'profile', status: 'restored' }] })
    await click(p('undo.button'))
    await click(p('undo.confirm'))
    expect(onUndo).toHaveBeenLastCalledWith(8)
    expect(await screen.findByText(p('undo.section', { key: 'profile', status: 'restored' }))).toBeInTheDocument()
  })

  it('a stale refusal with nothing undoable left keeps the sentence and offers no undo', async () => {
    const { onUndo, onStatus } = setup({ lastImport: last })
    onUndo.mockResolvedValue({ error: p('errors.codes.SITE_IMPORT_NOTHING_TO_UNDO'), stale: true })
    onStatus.mockResolvedValue({ lastImport: { ...last, undone: true, undoable: false } })

    await click(p('undo.button'))
    await click(p('undo.confirm'))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(p('errors.codes.SITE_IMPORT_NOTHING_TO_UNDO')))
    expect(screen.getByText(p('undo.none'))).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: p('undo.button') })).not.toBeInTheDocument()
  })

  it('a status that cannot be loaded after an undo leaves nothing to offer and still shows the result', async () => {
    const { onUndo, onStatus } = setup({ lastImport: last })
    onUndo.mockResolvedValue({ importId: 5, locale: 'vi', sections: [{ key: 'profile', status: 'restored' }] })
    onStatus.mockRejectedValue(new TypeError('fetch failed'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await click(p('undo.button'))
    await click(p('undo.confirm'))

    expect(await screen.findByText(p('undo.section', { key: 'profile', status: 'restored' }))).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: p('undo.button') })).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('undoes the import this page just wrote by its own id, not the id of the older last import', async () => {
    const { onApply, onUndo } = setup({ lastImport: last })
    onApply.mockResolvedValue(applied({ importId: 9 }))
    onUndo.mockResolvedValue({ importId: 9, locale: 'en', sections: [{ key: 'profile', status: 'restored' }] })
    await choose(markdown())
    await screen.findByRole('list', { name: p('preview.listLabel') })
    await click(p('apply', { count: 2 }))
    await screen.findByText(p('result.heading'))

    await click(p('undo.button'))
    await click(p('undo.confirm'))

    expect(onUndo).toHaveBeenCalledTimes(1)
    expect(onUndo).toHaveBeenCalledWith(9)
  })

  it('an import that wrote nothing creates no id: the undo still names the dated last import', async () => {
    const { onApply, onUndo } = setup({ lastImport: last })
    onApply.mockResolvedValue(applied({ importId: null, sections: [{ id: 'identity', key: 'profile', status: 'unchanged' }] }))
    onUndo.mockResolvedValue({ importId: 5, locale: 'vi', sections: [{ key: 'profile', status: 'restored' }] })
    await choose(markdown())
    await screen.findByRole('list', { name: p('preview.listLabel') })
    await click(p('apply', { count: 2 }))
    await screen.findByText(p('result.heading'))

    await click(p('undo.button'))
    await click(p('undo.confirm'))

    expect(onUndo).toHaveBeenCalledWith(5)
  })

  it('shows the time of the last import on the admin clock after hydration and in UTC in the server HTML', () => {
    // 20:30 UTC is 03:30 the next day at the pinned test zone (UTC+7), so UTC and local differ in time and in day.
    const late: LastImport = { ...last, createdAt: '2026-10-11T20:30:00Z' }
    const html = renderToString(
      <IntlWrapper>
        <ProfileImport lastImport={late} onPreview={vi.fn()} onApply={vi.fn()} onUndo={vi.fn()} onStatus={vi.fn()} />
      </IntlWrapper>,
    )
    expect(html).toContain(formatDate(late.createdAt, 'medium', 'vi') as string)
    expect(html).not.toContain('03:30')

    setup({ lastImport: late })
    expect(
      screen.getByText(p('undo.last', { when: '03:30, 12/10/2026', language: msg('Admin.settings.locales.vi') })),
    ).toBeInTheDocument()
  })

  it('an import that wrote nothing keeps the dated sentence of the older undoable import; one that wrote something describes the new one', async () => {
    const { onApply } = setup({ lastImport: last })
    const dated = p('undo.last', { when: '17:00, 11/10/2026', language: msg('Admin.settings.locales.vi') })
    onApply
      .mockResolvedValueOnce(applied({ importId: null, sections: [{ id: 'identity', key: 'profile', status: 'unchanged' }] }))
      .mockResolvedValueOnce(applied())
    await choose(markdown())
    await screen.findByRole('list', { name: p('preview.listLabel') })

    await click(p('apply', { count: 2 }))
    await screen.findByText(p('result.heading'))
    expect(screen.getByText(dated)).toBeInTheDocument()
    expect(screen.queryByText(p('undo.hint'))).not.toBeInTheDocument()

    await choose(markdown('again.md'))
    await screen.findByRole('list', { name: p('preview.listLabel') })
    await click(p('apply', { count: 2 }))
    await screen.findByText(p('result.heading'))
    expect(screen.getByText(p('undo.hint'))).toBeInTheDocument()
    expect(screen.queryByText(dated)).not.toBeInTheDocument()
  })

  it('keeps the focus inside the undo card: Cancel when it opens, the undo button when it closes, the result heading when done', async () => {
    const { onUndo } = setup({ lastImport: last })
    onUndo.mockResolvedValue({ importId: 5, locale: 'vi', sections: [{ key: 'profile', status: 'restored' }] })

    await click(p('undo.button'))
    expect(screen.getByRole('button', { name: p('undo.button') })).toBeEnabled()
    expect(screen.getByRole('button', { name: p('undo.button') })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: p('undo.cancel') })).toHaveFocus()

    await click(p('undo.cancel'))
    expect(screen.getByRole('button', { name: p('undo.button') })).toHaveFocus()

    await click(p('undo.button'))
    await click(p('undo.confirm'))
    expect(await screen.findByRole('heading', { name: p('undo.heading') })).toHaveFocus()
  })
})

const pack = (name = 'about.zip', bytes = 2000) => new File([new Uint8Array(bytes)], name, { type: 'application/zip' })

describe('ProfileImport with a ZIP package', () => {
  const aboutPreview = () =>
    preview({
      bytes: 2000,
      ignored: [{ kind: 'image', sectionId: 'about', name: 'assets/unused.png', line: null }],
      ignoredTotal: 1,
      sections: [
        section({
          id: 'about',
          heading: 'About',
          key: 'about',
          status: 'will_change',
          changes: [
            { field: 'photo', kind: 'value', before: null, after: 'assets/me.jpg', added: null, removed: null, kept: null },
            { field: 'body images', kind: 'list', before: null, after: null, added: 2, removed: 0, kept: 1 },
          ],
          errors: [
            { sectionId: 'about', field: 'body', line: 40, message: 'the image assets/missing.png is not in the package' },
          ],
        }),
      ],
    })

  it('accepts a package, sends it to the preview and says that its images are stored on apply', async () => {
    const onPreview = vi.fn().mockResolvedValue(aboutPreview())
    setup({ onPreview })

    await choose(pack())

    await screen.findByRole('list', { name: p('preview.listLabel') })
    expect(((onPreview.mock.calls[0]![0] as FormData).get('file') as File).name).toBe('about.zip')
    expect(screen.getByText(p('preview.packageNote'))).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows the facts of the package and a note for an image nothing uses', async () => {
    setup({
      onPreview: vi.fn().mockResolvedValue({
        ...aboutPreview(),
        pack: { entries: 5, assets: 3, assetBytes: 2048, usedAssets: 2, unusedAssets: 1, unsupportedItems: 1 },
        notes: [
          { code: 'asset_unused', key: 'assets/unused.png', line: null },
          { code: 'something_new', key: null, line: null },
        ],
      }),
    })
    await choose(pack())
    await screen.findByRole('list', { name: p('preview.listLabel') })

    expect(screen.getByText(p('preview.package.facts', { assets: 3, kib: 2, used: 2, unused: 1 }))).toBeInTheDocument()
    expect(screen.getByText(p('preview.package.unsupported', { count: 1 }))).toBeInTheDocument()
    expect(screen.getByText(p('preview.notes.asset_unused', { path: 'assets/unused.png' }))).toBeInTheDocument()
    expect(screen.getByText(p('preview.notes.other'))).toBeInTheDocument()
  })

  it('does not show the package note for a Markdown file', async () => {
    setup()
    await choose(markdown())
    await screen.findByRole('list', { name: p('preview.listLabel') })
    expect(screen.queryByText(p('preview.packageNote'))).not.toBeInTheDocument()
  })

  it('lists the photo and image changes, the problem of a missing image and an unused one with the existing cards', async () => {
    setup({ onPreview: vi.fn().mockResolvedValue(aboutPreview()) })
    await choose(pack())
    const list = await screen.findByRole('list', { name: p('preview.listLabel') })
    const [about] = Array.from(list.children) as HTMLElement[]

    expect(within(about!).getByText('photo')).toBeInTheDocument()
    expect(within(about!).getByText('assets/me.jpg')).toBeInTheDocument()
    expect(
      within(about!).getByText(p('preview.listCounts', { added: 2, removed: 0, kept: 1 }), { exact: false }),
    ).toBeInTheDocument()
    expect(
      within(about!).getByText(
        `About, ${p('preview.lineNumber', { line: 40 })}, body: the image assets/missing.png is not in the package`,
      ),
    ).toBeInTheDocument()
    expect(screen.getByText(p('preview.ignoredItem', { kind: 'image', name: 'assets/unused.png', line: 0 }))).toBeInTheDocument()
  })

  it('refuses a package over 4 MiB on the client without calling the server', async () => {
    const { onPreview } = setup()

    await choose(pack('about.zip', 4 * 1024 * 1024 + 1))

    expect(screen.getByRole('alert')).toHaveTextContent(p('errors.packageTooLarge'))
    expect(onPreview).not.toHaveBeenCalled()
  })

  it('applies the package that was previewed', async () => {
    const { onApply } = setup({ onPreview: vi.fn().mockResolvedValue(aboutPreview()) })
    onApply.mockResolvedValue(applied({ sections: [{ id: 'about', key: 'about', status: 'updated' }] }))
    await choose(pack())
    await screen.findByRole('list', { name: p('preview.listLabel') })

    await click(p('apply', { count: 1 }))

    const form = onApply.mock.calls[0]![0] as FormData
    expect((form.get('file') as File).name).toBe('about.zip')
    expect(form.get('sha256')).toBe(HASH)
  })
})
