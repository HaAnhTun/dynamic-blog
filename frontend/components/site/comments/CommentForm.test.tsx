import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CommentForm, type SubmitResult } from './CommentForm'
import { msg } from '@/test/render-intl'
import { currentTestLocale, translatorFor } from '@/test/intl'

const HINT_TEXT = (translatorFor(currentTestLocale(), 'Site.comments.form') as unknown as { raw(key: string): string })
  .raw('shortcutHint')
  .replace(/<\/?kbd>/g, '')
  .replace('{action}', msg('Site.comments.item.editSave').toLowerCase())

/**
 * The comment writing box (design: "Form"): the counter follows the backend's exact measurement, the submit button locks when
 * the content is certain to get a 400, double submits are blocked, the text is kept on error. The Vietnamese error sentences are chosen by
 * CommentSection (lib/interaction-errors.ts); here it only matters that the form shows the sentence it was given.
 */

const ZWSP = String.fromCodePoint(0x200b)
const RLO = String.fromCodePoint(0x202e)

function setup(props: Partial<Parameters<typeof CommentForm>[0]> = {}) {
  const onSubmit = vi.fn<(text: string) => Promise<SubmitResult>>(() => Promise.resolve({ ok: true }))
  render(
    <CommentForm
      label={msg('Site.comments.rootForm.label')}
      submitLabel={msg('Site.comments.rootForm.submit')}
      onSubmit={onSubmit}
      {...props}
    />,
  )
  const textarea = screen.getByRole('textbox', { name: msg('Site.comments.rootForm.label') })
  const submit = screen.getByRole('button', {
    name: (props.submitLabel as string | undefined) ?? msg('Site.comments.rootForm.submit'),
  })
  return { onSubmit: (props.onSubmit as typeof onSubmit | undefined) ?? onSubmit, textarea, submit }
}

function type(textarea: HTMLElement, value: string) {
  fireEvent.change(textarea, { target: { value } })
}

/** The reply of onSubmit; the test decides when it returns. */
function deferred() {
  let resolve: (result: SubmitResult) => void = () => {}
  const onSubmit = vi.fn<(text: string) => Promise<SubmitResult>>(() => new Promise<SubmitResult>((done) => (resolve = done)))
  return { onSubmit, finish: (result: SubmitResult) => act(async () => resolve(result)) }
}

describe('CommentForm: label and counter', () => {
  it('the <label> names the textarea; the counter "N/2000" is connected through aria-describedby', () => {
    const { textarea } = setup()
    type(textarea, 'Enough')

    const counter = screen.getByText('6/2000')
    expect(textarea.getAttribute('aria-describedby')?.split(' ')).toContain(counter.id)
    expect(textarea).toHaveAccessibleDescription('6/2000')
  })

  it('WCAG 3.3.2: a submit button locked for being too short has a sentence saying why, visible and in the description of the box', () => {
    const { textarea, submit } = setup()

    // Empty box: entering the box you hear the requirement, before typing.
    expect(textarea).toHaveAccessibleDescription(`0/2000 ${msg('Site.comments.form.minLength', { min: '2' })}`)

    // A thumbs-up emoji or a short letter: one code point. A `disabled` button leaves the Tab order, so this sentence is the only
    // place a keyboard user learns why it cannot be sent.
    type(textarea, '👍')
    expect(submit).toBeDisabled()
    const requirement = screen.getByText(msg('Site.comments.form.minLength', { min: '2' }))
    expect(requirement).toBeVisible()
    expect(textarea.getAttribute('aria-describedby')?.split(' ')).toContain(requirement.id)
    expect(textarea).toHaveAccessibleDescription(`1/2000 ${msg('Site.comments.form.minLength', { min: '2' })}`)

    // Two characters: the sentence goes away, the button turns on.
    type(textarea, 'Ok')
    expect(submit).toBeEnabled()
    expect(screen.queryByText(msg('Site.comments.form.minLength', { min: '2' }))).toBeNull()
    expect(textarea).toHaveAccessibleDescription('2/2000')
  })

  it('long enough but only non-breaking whitespace: the sentence says text is needed, not "at least 2 characters"', () => {
    const { textarea, submit } = setup()

    type(textarea, String.fromCodePoint(0xa0, 0xa0, 0xa0))

    expect(submit).toBeDisabled()
    expect(screen.getByText(msg('Site.comments.form.needsVisibleText'))).toBeVisible()
    expect(screen.queryByText(msg('Site.comments.form.minLength', { min: '2' }))).toBeNull()
  })

  it('over 2000 only the red counter speaks, no requirement sentence is added', () => {
    const { textarea } = setup()

    type(textarea, 'a'.repeat(2001))

    expect(screen.queryByText(msg('Site.comments.form.minLength', { min: '2' }))).toBeNull()
    expect(screen.queryByText(msg('Site.comments.form.needsVisibleText'))).toBeNull()
  })

  it('counts like the backend: after sanitizing, by code point (an emoji is 1, an invisible character is 0)', () => {
    const { textarea } = setup()

    type(textarea, `  Hi there 👋${ZWSP}  `)

    // A greeting with a wave emoji: 10 code points; both ends are stripped, the ZWSP is dropped.
    expect(screen.getByText('10/2000')).toBeInTheDocument()
  })

  it('over 2000: the counter turns red and the textarea has aria-invalid; not over, it does not', () => {
    const { textarea } = setup()

    type(textarea, 'a'.repeat(2000))
    expect(textarea).not.toHaveAttribute('aria-invalid', 'true')
    type(textarea, 'a'.repeat(2001))

    expect(screen.getByText('2001/2000').className).toMatch(/text-red-/)
    expect(textarea).toHaveAttribute('aria-invalid', 'true')
  })
})

describe('CommentForm: the submit button locks when the content is certain to be rejected', () => {
  it.each([
    ['empty', ''],
    ['one character', 'a'],
    ['only whitespace and newlines', '   \n\n\t  '],
    ['only invisible characters', `${ZWSP}${ZWSP}${RLO}${ZWSP}`],
    ['2001 characters', 'a'.repeat(2001)],
  ])('%s: disabled, and submitting (Enter on the button, form submit) calls nothing', (_label, value) => {
    const { textarea, submit, onSubmit } = setup()

    type(textarea, value)

    expect(submit).toBeDisabled()
    fireEvent.submit(textarea.closest('form')!)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it.each([
    ['2 characters', 'ab'],
    ['exactly 2000 characters', 'b'.repeat(2000)],
    ['2000 emoji (4000 UTF-16 units)', '😀'.repeat(2000)],
  ])('%s: enabled', (_label, value) => {
    const { textarea, submit } = setup()

    type(textarea, value)

    expect(submit).toBeEnabled()
  })
})

describe('CommentForm: submit', () => {
  it('submits the SANITIZED version (exactly the string the counter measured); when done with clearOnSuccess the text is cleared', async () => {
    const { textarea, submit, onSubmit } = setup({ clearOnSuccess: true })
    type(textarea, `\r\n  Line one\r\n\r\n\r\n\r\nLine two${ZWSP}  `)

    await act(async () => {
      fireEvent.click(submit)
    })

    expect(onSubmit).toHaveBeenCalledWith('Line one\n\nLine two')
    expect(textarea).toHaveValue('')
    expect(screen.getByText('0/2000')).toBeInTheDocument()
  })

  it('without clearOnSuccess (edit, reply: the form closes right after): the text is kept', async () => {
    const { textarea, submit } = setup()
    type(textarea, 'Content')

    await act(async () => {
      fireEvent.click(submit)
    })

    expect(textarea).toHaveValue('Content')
  })

  it('two quick presses: only one submit; while waiting "Sending…", aria-disabled, the textarea read-only', async () => {
    const { onSubmit, finish } = deferred()
    const { textarea, submit } = setup({ onSubmit, clearOnSuccess: true })
    type(textarea, 'First comment')

    fireEvent.click(submit)
    fireEvent.click(submit)
    fireEvent.submit(textarea.closest('form')!)

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(submit).toHaveTextContent(msg('Site.profile.author.form.sending'))
    expect(submit).toHaveAttribute('aria-disabled', 'true')
    // Not a real `disabled`: the button holding focus is not kicked back to <body>.
    expect(submit).toBeEnabled()
    expect(textarea).toHaveAttribute('readonly')

    await finish({ ok: true })

    expect(submit).toHaveTextContent(msg('Site.comments.rootForm.submit'))
    expect(submit).not.toHaveAttribute('aria-disabled', 'true')
    expect(textarea).not.toHaveAttribute('readonly')
  })

  it('error: the error sentence in role="alert", the text kept, focus stays on the submit button; submitting again makes the old sentence go', async () => {
    const { onSubmit, finish } = deferred()
    const { textarea, submit } = setup({ onSubmit, clearOnSuccess: true })
    type(textarea, 'A comment')
    submit.focus()

    fireEvent.click(submit)
    await finish({ ok: false, message: msg('Errors.interaction.byCode.RATE_LIMITED') })

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Errors.interaction.byCode.RATE_LIMITED'))
    expect(textarea).toHaveValue('A comment')
    expect(submit).toHaveFocus()
    // The error sentence is also the textarea description: going back to fix the text still lets you hear why.
    expect(textarea).toHaveAccessibleDescription(expect.stringContaining(msg('Errors.interaction.byCode.RATE_LIMITED')))

    fireEvent.click(submit)
    expect(screen.queryByRole('alert')).toBeNull()
    await finish({ ok: true })
    expect(textarea).toHaveValue('')
  })
})

/*
 * Ctrl+Enter (⌘+Enter on Mac) in the box submits right away, like GitHub, Slack, Discourse. It goes through
 * the form's own `requestSubmit()` — exactly the path of the submit button — so every guard of `submit()` still stands: text
 * that is not valid does not submit, a submit in progress does not submit a second time.
 */
describe('CommentForm: Ctrl/⌘+Enter submits', () => {
  /** keydown on the box; returns false when the handler calls preventDefault (the key was used, nothing is typed). */
  function press(target: HTMLElement, init: KeyboardEventInit & { keyCode?: number } = {}): boolean {
    return fireEvent.keyDown(target, { key: 'Enter', ...init })
  }

  it.each([
    ['Ctrl+Enter', { ctrlKey: true }],
    ['⌘+Enter', { metaKey: true }],
  ])('%s in the box: submits exactly once, the sanitized text, and the key types nothing', async (_label, modifiers) => {
    const { textarea, onSubmit } = setup({ clearOnSuccess: true })
    type(textarea, '  Sent by shortcut  ')

    let notPrevented = true
    await act(async () => {
      notPrevented = press(textarea, modifiers)
    })

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith('Sent by shortcut')
    expect(notPrevented).toBe(false)
    expect(textarea).toHaveValue('')
  })

  it('plain Enter, Shift+Enter, and Ctrl+Alt+Enter (AltGr on Windows): a normal newline, no submit', () => {
    const { textarea, onSubmit } = setup()
    type(textarea, 'Line one')

    for (const init of [{}, { shiftKey: true }, { ctrlKey: true, altKey: true }, { metaKey: true, altKey: true }]) {
      expect(press(textarea, init), JSON.stringify(init)).toBe(true)
    }
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('while composing with an input method (Telex, VNI; Safari reports keyCode 229): Enter belongs to the input method, no submit', () => {
    const { textarea, onSubmit } = setup()
    type(textarea, 'Half typed')

    expect(press(textarea, { ctrlKey: true, isComposing: true })).toBe(true)
    expect(press(textarea, { metaKey: true, keyCode: 229 })).toBe(true)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it.each([
    ['empty', ''],
    ['one character', 'a'],
    ['only whitespace', '   \n  '],
    ['2001 characters', 'a'.repeat(2001)],
  ])('text that cannot be sent yet (%s): does not submit, like the locked submit button', async (_label, value) => {
    const { textarea, submit, onSubmit } = setup()
    type(textarea, value)

    await act(async () => {
      press(textarea, { ctrlKey: true })
    })

    expect(submit).toBeDisabled()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('while submitting: Ctrl+Enter again (or a repeating held key) does not submit a second time', async () => {
    const { onSubmit, finish } = deferred()
    const { textarea, submit } = setup({ onSubmit, clearOnSuccess: true })
    type(textarea, 'A comment')

    press(textarea, { ctrlKey: true })
    press(textarea, { ctrlKey: true })
    press(textarea, { ctrlKey: true, repeat: true })

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(submit).toHaveTextContent(msg('Site.profile.author.form.sending'))
    await finish({ ok: true })
    expect(textarea).toHaveValue('')
  })

  it('a repeating held key is not a new submit', () => {
    const { textarea, onSubmit } = setup()
    type(textarea, 'Keep keys')

    press(textarea, { ctrlKey: true, repeat: true })

    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('only in the box: Ctrl+Enter while focus is on the "Cancel" button does not submit', () => {
    const onCancel = vi.fn()
    const { textarea, onSubmit } = setup({ onCancel })
    type(textarea, 'Text already written')

    press(screen.getByRole('button', { name: msg('Site.comments.form.cancel') }), { ctrlKey: true })

    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('the box declares the shortcut for screen readers (aria-keyshortcuts), the description of the box does not change', () => {
    const { textarea } = setup()

    expect(textarea).toHaveAttribute('aria-keyshortcuts', 'Control+Enter Meta+Enter')
    // The visible hint is not in aria-describedby: the description of the box is still the counter and the requirement.
    expect(textarea).toHaveAccessibleDescription(`0/2000 ${msg('Site.comments.form.minLength', { min: '2' })}`)
  })

  it("a small hint next to the submit button, matching the form's job; shown only on devices with a mouse/keyboard (pointer: fine)", () => {
    render(
      <CommentForm
        label={msg('Site.comments.item.editLabel')}
        submitLabel={msg('Site.comments.item.editSave')}
        initialText="Old content"
        onSubmit={() => Promise.resolve({ ok: true })}
      />,
    )
    const hint = screen.getByText((_content, element) => element?.tagName === 'P' && /Enter/.test(element.textContent ?? ''))

    expect(hint).toHaveTextContent(HINT_TEXT)
    expect(Array.from(hint.querySelectorAll('kbd')).map((key) => key.textContent)).toEqual(['Ctrl', '⌘', 'Enter'])
    expect(hint).toHaveClass('hidden', 'pointer-fine:block')
    // Right before the submit button, in the same group.
    expect(hint.nextElementSibling).toBe(screen.getByRole('button', { name: msg('Site.comments.item.editSave') }))
  })
})

describe('CommentForm: cancel and focus', () => {
  it('autoFocus: the textarea gets focus when the form opens, the cursor at the end of the existing text', () => {
    const { textarea } = setup({ autoFocus: true, initialText: 'Old text' })

    expect(textarea).toHaveFocus()
    expect(textarea).toHaveValue('Old text')
    expect((textarea as HTMLTextAreaElement).selectionStart).toBe('Old text'.length)
  })

  it('without autoFocus (the root form): does not take focus when the page loads', () => {
    const { textarea } = setup()

    expect(textarea).not.toHaveFocus()
  })

  it('onCancel: has a "Cancel" button, and Escape in the form also cancels', () => {
    const onCancel = vi.fn()
    const { textarea } = setup({ onCancel })

    fireEvent.click(screen.getByRole('button', { name: msg('Site.comments.form.cancel') }))
    fireEvent.keyDown(textarea, { key: 'Escape' })

    expect(onCancel).toHaveBeenCalledTimes(2)
  })

  it('Escape while an input method is composing (Telex, VNI) only cancels the composition, not the form', () => {
    const onCancel = vi.fn()
    const { textarea } = setup({ onCancel })

    fireEvent.keyDown(textarea, { key: 'Escape', isComposing: true })

    expect(onCancel).not.toHaveBeenCalled()
  })

  it('without onCancel (the root form): no "Cancel" button, Escape does nothing', () => {
    const { textarea } = setup()

    fireEvent.keyDown(textarea, { key: 'Escape' })

    expect(screen.queryByRole('button', { name: msg('Site.comments.form.cancel') })).toBeNull()
  })

  it('while submitting it cannot be cancelled: the result still has to show somewhere', async () => {
    const onCancel = vi.fn()
    const { onSubmit, finish } = deferred()
    const { textarea, submit } = setup({ onCancel, onSubmit })
    type(textarea, 'Half sent')

    fireEvent.click(submit)
    fireEvent.keyDown(textarea, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: msg('Site.comments.form.cancel') }))

    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: msg('Site.comments.form.cancel') })).toHaveAttribute('aria-disabled', 'true')
    await finish({ ok: true })
  })

  it('separate labels for each job: "Save" / "Saving…" when editing', async () => {
    const { onSubmit, finish } = deferred()
    render(
      <CommentForm
        label={msg('Site.comments.item.editLabel')}
        submitLabel={msg('Site.comments.item.editSave')}
        pendingLabel={msg('Site.comments.item.editPending')}
        initialText="Old content"
        onSubmit={onSubmit}
      />,
    )

    const save = screen.getByRole('button', { name: msg('Site.comments.item.editSave') })
    fireEvent.click(save)

    expect(save).toHaveTextContent(msg('Site.comments.item.editPending'))
    expect(onSubmit).toHaveBeenCalledWith('Old content')
    await finish({ ok: true })
  })
})

describe('CommentForm: on a phone', () => {
  it('the submit button is 44px tall below sm and 36px from sm', () => {
    const { submit } = setup()

    expect(submit).toHaveClass('h-11', 'sm:h-9')
  })
})
