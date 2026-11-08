import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { msg, renderWithIntl } from '@/test/render-intl'
import SetupForm from './SetupForm'
import { SETUP_ENDPOINT } from './namespaces'

const replace = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }))

const label = (key: string) => msg(`Setup.${key}.label`)
const PASSWORD = 'a-long-enough-password'

function respond(body: unknown, status: number) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(body), { status }))
}

function fill(values: Partial<Record<'code' | 'displayName' | 'email' | 'password' | 'confirm', string>> = {}) {
  const all = {
    code: 'the-code',
    displayName: 'Owner',
    email: 'owner@example.test',
    password: PASSWORD,
    confirm: PASSWORD,
    ...values,
  }
  for (const [key, value] of Object.entries(all)) {
    fireEvent.change(screen.getByLabelText(label(key)), { target: { value } })
  }
}

const submit = () => fireEvent.click(screen.getByRole('button', { name: msg('Setup.submit') }))

afterEach(() => {
  vi.restoreAllMocks()
  replace.mockReset()
})

describe('SetupForm', () => {
  it('posts the four fields as JSON (never the confirmation) and goes to the sign-in page', async () => {
    const spy = respond({ ok: true }, 200)

    renderWithIntl(<SetupForm />)
    fill({ code: '  the-code  ', displayName: ' Owner ' })
    submit()

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/admin/login'))
    const [url, init] = spy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(SETUP_ENDPOINT)
    expect(url).not.toContain(PASSWORD)
    expect(JSON.parse(String(init.body))).toEqual({
      setupCode: 'the-code',
      displayName: 'Owner',
      email: 'owner@example.test',
      password: PASSWORD,
    })
  })

  it('never submits the code and the password as a GET query before the script has loaded', () => {
    const { container } = renderWithIntl(<SetupForm />)

    const form = container.querySelector('form')
    expect(form).toHaveAttribute('method', 'post')
    expect(form).toHaveAttribute('action', '/setup/submit')
  })

  it('has the right input types, autocomplete attributes and a password rule hint tied to the field', () => {
    renderWithIntl(<SetupForm />)

    expect(screen.getByLabelText(label('code'))).toHaveAttribute('autocomplete', 'off')
    expect(screen.getByLabelText(label('code'))).toHaveAttribute('type', 'password')
    expect(screen.getByLabelText(label('email'))).toHaveAttribute('autocomplete', 'email')
    expect(screen.getByLabelText(label('email'))).toHaveAttribute('type', 'email')
    expect(screen.getByLabelText(label('password'))).toHaveAttribute('autocomplete', 'new-password')
    expect(screen.getByLabelText(label('confirm'))).toHaveAttribute('autocomplete', 'new-password')
    const hint = screen.getByText(msg('Setup.password.hint', { min: 12 }))
    expect(screen.getByLabelText(label('password'))).toHaveAttribute('aria-describedby', hint.id)
  })

  it('explains where the setup code comes from, naming the variable and the file but never a value', () => {
    renderWithIntl(<SetupForm />)

    const hint = document.getElementById('setupCode-hint')!
    expect(hint).toHaveTextContent('SETUP_TOKEN')
    expect(hint).toHaveTextContent('setup-code')
    expect(screen.getByLabelText(label('code'))).toHaveAttribute('aria-describedby', 'setupCode-hint')
  })

  it('validates before sending: field errors in role="alert", linked with aria-describedby, first invalid field focused', async () => {
    const spy = respond({ ok: true }, 200)

    renderWithIntl(<SetupForm />)
    fill({ code: '', displayName: '', email: 'nope', password: 'short', confirm: 'other' })
    submit()

    for (const key of ['codeRequired', 'nameRequired', 'emailInvalid', 'passwordShort', 'confirmMismatch']) {
      expect(await screen.findByText(msg(`Setup.fieldErrors.${key}`))).toHaveAttribute('role', 'alert')
    }
    const password = screen.getByLabelText(label('password'))
    expect(password).toHaveAttribute('aria-invalid', 'true')
    expect(password.getAttribute('aria-describedby')).toContain('password-error')
    expect(screen.getByLabelText(label('code'))).toHaveFocus()
    expect(spy).not.toHaveBeenCalled()
  })

  it('rejects a password over 128 characters and a mismatching confirmation without a request', async () => {
    const spy = respond({ ok: true }, 200)

    renderWithIntl(<SetupForm />)
    fill({ password: 'p'.repeat(129), confirm: 'p'.repeat(129) })
    submit()
    expect(await screen.findByText(msg('Setup.fieldErrors.passwordLong'))).toBeInTheDocument()

    fill({ confirm: `${PASSWORD}x` })
    submit()
    expect(await screen.findByText(msg('Setup.fieldErrors.confirmMismatch'))).toBeInTheDocument()
    expect(spy).not.toHaveBeenCalled()
  })

  it.each(['SETUP_CODE_INVALID', 'SETUP_CLOSED', 'VALIDATION_ERROR', 'RATE_LIMITED', 'UNAVAILABLE'])(
    'shows the catalog message for the route code %s and stays on the page',
    async (code) => {
      respond({ ok: false, error: code }, 400)

      renderWithIntl(<SetupForm />)
      fill()
      submit()

      expect(await screen.findByRole('alert')).toHaveTextContent(msg(`Setup.errors.${code}`))
      expect(replace).not.toHaveBeenCalled()
      expect(screen.getByRole('button', { name: msg('Setup.submit') })).not.toHaveAttribute('aria-disabled', 'true')
    },
  )

  it('shows the generic message for an unknown code and never echoes server text', async () => {
    respond({ ok: false, error: 'SOMETHING', message: 'server words' }, 500)

    renderWithIntl(<SetupForm />)
    fill()
    submit()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(msg('Setup.errors.GENERIC'))
    expect(alert).not.toHaveTextContent('server words')
  })

  it('treats a 200 that is not { ok: true } as a failure, and a network error as a retryable message', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('<html></html>', { status: 200 }))
    renderWithIntl(<SetupForm />)
    fill()
    submit()
    expect(await screen.findByRole('alert')).toHaveTextContent(msg('Setup.errors.GENERIC'))
    expect(replace).not.toHaveBeenCalled()

    vi.restoreAllMocks()
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))
    submit()
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(msg('Setup.errors.NETWORK')))
  })

  it('sends one request even when the button is pressed twice while pending', async () => {
    let finish: (res: Response) => void = () => {}
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((resolve) => (finish = resolve)))

    renderWithIntl(<SetupForm />)
    fill()
    submit()
    const pendingButton = await screen.findByRole('button', { name: msg('Setup.submitting') })
    expect(pendingButton).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(pendingButton)

    expect(spy).toHaveBeenCalledTimes(1)
    finish(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1))
  })

  it('renders in English too', () => {
    renderWithIntl(<SetupForm />, { locale: 'en' })

    expect(screen.getByLabelText(msg('Setup.password.label', undefined, 'en'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: msg('Setup.submit', undefined, 'en') })).toBeInTheDocument()
  })
})
