import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { callBff } = vi.hoisted(() => ({ callBff: vi.fn() }))
vi.mock('@/lib/bff-client', () => ({ callBff }))

import { msg, renderWithIntl } from '@/test/render-intl'
import { ContactForm } from './ContactForm'

const NAME = 'Reader Example'
const EMAIL = 'reader@example.test'
const MESSAGE = 'Hello, I would like to ask a question.'

function field(key: string): HTMLInputElement | HTMLTextAreaElement {
  return screen.getByLabelText(new RegExp(`^${msg(`Site.contact.form.${key}Label`)}`))
}

function fill({ name = NAME, email = EMAIL, subject = '', message = MESSAGE } = {}) {
  fireEvent.change(field('name'), { target: { value: name } })
  fireEvent.change(field('email'), { target: { value: email } })
  fireEvent.change(field('subject'), { target: { value: subject } })
  fireEvent.change(field('message'), { target: { value: message } })
}

async function send() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: msg('Site.contact.form.submit') }))
  })
}

function sentBody(): Record<string, unknown> {
  return JSON.parse(callBff.mock.calls[0]![1].body as string) as Record<string, unknown>
}

afterEach(() => vi.clearAllMocks())

describe('ContactForm', () => {
  it('renders labelled fields, required marks and the right input attributes', () => {
    const { container } = renderWithIntl(<ContactForm />)

    for (const key of ['name', 'email', 'message']) {
      expect(field(key), key).toBeRequired()
    }
    expect(field('subject')).not.toBeRequired()
    expect(field('name')).toHaveAttribute('autocomplete', 'name')
    expect(field('email')).toHaveAttribute('type', 'email')
    expect(field('email')).toHaveAttribute('autocomplete', 'email')
    expect(field('name')).toHaveAttribute('maxlength', '100')
    expect(field('email')).toHaveAttribute('maxlength', '254')
    expect(field('subject')).toHaveAttribute('maxlength', '150')
    expect(field('message')).toHaveAttribute('maxlength', '5000')
    expect(field('message')).toHaveAttribute('rows', '5')
    // The visible asterisk is decoration: the accessible name stays the label text.
    expect(container.querySelectorAll('label [aria-hidden="true"]')).toHaveLength(3)
    expect(screen.getByRole('textbox', { name: msg('Site.contact.form.nameLabel') })).toBe(field('name'))
    expect(screen.getByText(msg('Site.contact.form.requiredNote'))).toBeInTheDocument()
  })

  it('hides the honeypot from assistive technology and the tab order', () => {
    const { container } = renderWithIntl(<ContactForm />)

    const trap = container.querySelector<HTMLInputElement>('input[name="website"]')!
    expect(trap).toHaveAttribute('tabindex', '-1')
    expect(trap).toHaveAttribute('autocomplete', 'off')
    expect(trap.closest('[aria-hidden="true"]')).not.toBeNull()
    expect(screen.getAllByRole('textbox')).toHaveLength(4)
  })

  it('shows the send icon, hidden from assistive technology', () => {
    renderWithIntl(<ContactForm />)

    const svg = screen.getByRole('button', { name: msg('Site.contact.form.submit') }).querySelector('svg')!
    expect(svg).toHaveAttribute('aria-hidden', 'true')
  })

  it('posts the trimmed fields with the page locale, then clears them and confirms in a polite live region', async () => {
    callBff.mockResolvedValue({ ok: true, data: { status: 'RECEIVED' } })
    renderWithIntl(<ContactForm />, { locale: 'en' })

    fill({ name: `  ${NAME} `, subject: ' Hi ', message: `  ${MESSAGE}  ` })
    await send()

    expect(callBff).toHaveBeenCalledExactlyOnceWith('/api/contact', {
      method: 'POST',
      body: JSON.stringify({ name: NAME, email: EMAIL, subject: 'Hi', message: MESSAGE, website: '', locale: 'en' }),
    })
    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toHaveTextContent(msg('Site.contact.form.success'))
    for (const key of ['name', 'email', 'subject', 'message']) expect(field(key).value, key).toBe('')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('sends the locale of the page it is rendered in', async () => {
    callBff.mockResolvedValue({ ok: true, data: null })
    renderWithIntl(<ContactForm />, { locale: 'vi' })

    fill()
    await send()

    expect(sentBody()).toMatchObject({ locale: 'vi' })
  })

  it('disables the button and shows the sending text while the request is in flight, and blocks a second send', async () => {
    let finish: (value: unknown) => void = () => {}
    callBff.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    renderWithIntl(<ContactForm />)

    fill()
    await send()

    const button = screen.getByRole('button', { name: msg('Site.contact.form.sending') })
    expect(button).toBeDisabled()
    fireEvent.submit(button.closest('form')!)
    expect(callBff).toHaveBeenCalledTimes(1)

    await act(async () => finish({ ok: true, data: null }))
    expect(screen.getByRole('button', { name: msg('Site.contact.form.submit') })).toBeEnabled()
  })

  it.each([
    ['name of blanks', { name: '   ' }, 'errors.name'],
    ['name too long', { name: 'a'.repeat(101) }, 'errors.name'],
    ['email', { email: 'reader' }, 'errors.email'],
    ['email without a domain dot', { email: 'reader@example' }, 'errors.email'],
    ['subject too long', { subject: 'a'.repeat(151) }, 'errors.subject'],
    ['message too short', { message: 'too short' }, 'errors.message'],
    ['message of blanks', { message: ' '.repeat(20) }, 'errors.message'],
    ['message too long', { message: 'a'.repeat(5001) }, 'errors.message'],
  ])('%s: reported at the field, linked with aria-describedby, nothing sent', async (_label, values, key) => {
    renderWithIntl(<ContactForm />)

    fill(values)
    await send()

    const hint = screen.getByText(msg(`Site.contact.${key}`))
    const input = document.getElementById(hint.id.replace(/-error$/, ''))!
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAttribute('aria-describedby', hint.id)
    // Focus moves to the field with the problem, so a keyboard or screen reader user lands on it.
    expect(input).toHaveFocus()
    expect(callBff).not.toHaveBeenCalled()
  })

  it('focuses the first field with a problem when several are wrong', async () => {
    renderWithIntl(<ContactForm />)

    fill({ email: 'reader', message: 'too short' })
    await send()

    const hint = screen.getByText(msg('Site.contact.errors.email'))
    expect(document.getElementById(hint.id.replace(/-error$/, ''))).toHaveFocus()
  })

  it('accepts the limits exactly', async () => {
    callBff.mockResolvedValue({ ok: true, data: null })
    renderWithIntl(<ContactForm />)

    fill({ name: 'a'.repeat(100), subject: 'b'.repeat(150), message: 'c'.repeat(10) })
    await send()
    expect(callBff).toHaveBeenCalledTimes(1)

    fill({ message: 'c'.repeat(5000) })
    await send()
    expect(callBff).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['400', { ok: false, status: 400, code: 'VALIDATION_ERROR' }, 'errors.validation'],
    ['413', { ok: false, status: 413, code: 'PAYLOAD_TOO_LARGE' }, 'errors.validation'],
    ['429', { ok: false, status: 429, code: 'RATE_LIMITED' }, 'errors.rateLimited'],
    ['502', { ok: false, status: 502, code: 'UPSTREAM_UNAVAILABLE' }, 'errors.generic'],
    ['network failure', { ok: false, status: 0, code: 'NETWORK' }, 'errors.generic'],
  ])('%s: shows a fixed sentence, keeps what was typed and never shows server text', async (_label, result, key) => {
    callBff.mockResolvedValue({ ...result, message: 'server said: secret detail' })
    renderWithIntl(<ContactForm />)

    fill()
    await send()

    expect(screen.getByRole('alert')).toHaveTextContent(msg(`Site.contact.${key}`))
    expect(screen.queryByText(/secret detail/)).toBeNull()
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    expect(field('message').value).toBe(MESSAGE)
    expect(screen.getByRole('button', { name: msg('Site.contact.form.submit') })).toBeEnabled()
  })

  it('removes the old error when the next attempt succeeds, and the old confirmation when the next one fails', async () => {
    renderWithIntl(<ContactForm />)

    callBff.mockResolvedValueOnce({ ok: false, status: 429, code: 'RATE_LIMITED' })
    fill()
    await send()
    expect(screen.getByRole('alert')).toBeInTheDocument()

    callBff.mockResolvedValueOnce({ ok: true, data: null })
    await send()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent(msg('Site.contact.form.success'))

    callBff.mockResolvedValueOnce({ ok: false, status: 502, code: 'X' })
    fill()
    await send()
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('forwards a filled honeypot as typed, so the route can answer it without calling the backend', async () => {
    callBff.mockResolvedValue({ ok: true, data: null })
    const { container } = renderWithIntl(<ContactForm />)

    fireEvent.change(container.querySelector('input[name="website"]')!, { target: { value: 'https://spam.example' } })
    fill()
    await send()

    expect(sentBody()).toMatchObject({ website: 'https://spam.example' })
  })
})
