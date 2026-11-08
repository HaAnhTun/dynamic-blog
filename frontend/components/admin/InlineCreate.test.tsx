import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import InlineCreate from './InlineCreate'
import { msg } from '@/test/render-intl'

async function open() {
  await act(async () => fireEvent.click(screen.getByRole('button', { name: msg('Admin.editor.addTag') })))
  return screen.getByLabelText(msg('Admin.editor.tagName'))
}

describe('InlineCreate', () => {
  it('opening focuses the box; Enter creates with the trimmed name then closes, focus returns to the open button', async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined)
    render(<InlineCreate label={msg('Admin.editor.addTag')} fieldLabel={msg('Admin.editor.tagName')} onCreate={onCreate} />)

    const input = await open()
    expect(input).toHaveFocus()
    fireEvent.change(input, { target: { value: '  Testcontainers ' } })
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }))

    expect(onCreate).toHaveBeenCalledWith('Testcontainers')
    expect(screen.queryByLabelText(msg('Admin.editor.tagName'))).toBeNull()
    expect(screen.getByRole('button', { name: msg('Admin.editor.addTag') })).toHaveFocus()
  })

  it('Escape cancels, creates nothing', async () => {
    const onCreate = vi.fn()
    render(<InlineCreate label={msg('Admin.editor.addTag')} fieldLabel={msg('Admin.editor.tagName')} onCreate={onCreate} />)

    const input = await open()
    fireEvent.change(input, { target: { value: 'AWS' } })
    await act(async () => fireEvent.keyDown(input, { key: 'Escape' }))

    expect(onCreate).not.toHaveBeenCalled()
    expect(screen.queryByLabelText(msg('Admin.editor.tagName'))).toBeNull()
  })

  it('empty name: Enter and the "Add" button both do nothing', async () => {
    const onCreate = vi.fn()
    render(<InlineCreate label={msg('Admin.editor.addTag')} fieldLabel={msg('Admin.editor.tagName')} onCreate={onCreate} />)

    const input = await open()
    fireEvent.change(input, { target: { value: '   ' } })
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }))

    expect(onCreate).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: msg('Admin.editor.inlineCreate.add') })).toBeDisabled()
  })

  it('Enter while composing (IME is composing text) does not create', async () => {
    const onCreate = vi.fn()
    render(<InlineCreate label={msg('Admin.editor.addTag')} fieldLabel={msg('Admin.editor.tagName')} onCreate={onCreate} />)

    const input = await open()
    fireEvent.change(input, { target: { value: 'Cafe' } })
    await act(async () => fireEvent.keyDown(input, { key: 'Enter', isComposing: true }))

    expect(onCreate).not.toHaveBeenCalled()
  })
})
