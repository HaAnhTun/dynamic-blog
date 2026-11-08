import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { msg, renderWithIntl } from '@/test/render-intl'

const replace = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }))

import MfaForm, { MFA_ENDPOINT } from './MfaForm'

const t = (key: string, values?: Record<string, string | number>) => msg(`Admin.login.mfa.${key}`, values)

/** A fresh Response per call: a single instance's body can only be read once. */
function respond(body: unknown, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(body), { status }))
}

const field = () => screen.getByLabelText(t('code')) as HTMLInputElement
const submit = () => fireEvent.click(screen.getByRole('button', { name: t('submit') }))
const type = (value: string, input: HTMLElement = field()) => fireEvent.change(input, { target: { value } })

afterEach(() => {
  vi.restoreAllMocks()
  replace.mockReset()
})

describe('MfaForm: the authenticator code', () => {
  it('asks for the 6-digit code with a numeric keyboard and the one-time-code hint, focused, at most seven characters', () => {
    renderWithIntl(<MfaForm next="/admin" />)

    expect(screen.getByText(t('lead'))).toBeInTheDocument()
    expect(field()).toHaveAttribute('inputmode', 'numeric')
    expect(field()).toHaveAttribute('autocomplete', 'one-time-code')
    expect(field()).toHaveAttribute('maxlength', '7')
    expect(field()).toHaveFocus()
  })

  it('posts only the code to the route handler and goes to the destination; the page holds no challenge to send', async () => {
    const fetchSpy = respond({ ok: true, recoveryCodesRemaining: 10, usedRecoveryCode: false })
    renderWithIntl(<MfaForm next="/admin/security" />)

    type('482913')
    submit()

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/admin/security'))
    expect(fetchSpy).toHaveBeenCalledWith(MFA_ENDPOINT, expect.objectContaining({ method: 'POST' }))
    expect(JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body))).toEqual({ code: '482913' })
  })

  it('locks the button while the code is being checked', async () => {
    let finish: (value: Response) => void = () => {}
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise<Response>((resolve) => (finish = resolve)))
    renderWithIntl(<MfaForm next="/admin" />)

    type('482913')
    submit()

    expect(await screen.findByRole('button', { name: t('submitting') })).toBeDisabled()
    finish(Response.json({ ok: true, recoveryCodesRemaining: 10, usedRecoveryCode: false }))
    await waitFor(() => expect(replace).toHaveBeenCalled())
  })
})

describe('MfaForm: the recovery code', () => {
  it('the link swaps the label, the keyboard and the length, clears the field and keeps focus on it', () => {
    renderWithIntl(<MfaForm next="/admin" />)
    type('123')

    fireEvent.click(screen.getByRole('button', { name: t('useRecovery') }))

    const input = screen.getByLabelText(t('recoveryLabel')) as HTMLInputElement
    expect(screen.getByText(t('leadRecovery'))).toBeInTheDocument()
    expect(input.value).toBe('')
    expect(input).toHaveAttribute('maxlength', '40')
    expect(input).toHaveAttribute('inputmode', 'text')
    expect(input).toHaveAttribute('autocomplete', 'off')
    expect(input).toHaveFocus()
    // And back.
    fireEvent.click(screen.getByRole('button', { name: t('useApp') }))
    expect(screen.getByLabelText(t('code'))).toHaveAttribute('maxlength', '7')
  })

  it('sends a recovery code the same way, and after it says how many remain instead of leaving at once', async () => {
    const fetchSpy = respond({ ok: true, recoveryCodesRemaining: 7, usedRecoveryCode: true })
    renderWithIntl(<MfaForm next="/admin/posts" />)
    fireEvent.click(screen.getByRole('button', { name: t('useRecovery') }))

    type('ABCD-EFGH-JKMN-PQRS-TVWX-YZ01', screen.getByLabelText(t('recoveryLabel')))
    submit()

    expect(await screen.findByText(t('recoveryUsed'))).toBeInTheDocument()
    expect(JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body))).toEqual({ code: 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ01' })
    expect(screen.getByText(t('recoveryLeft', { count: 7 }))).toBeInTheDocument()
    expect(screen.getByText(t('replaceHint'))).toBeInTheDocument()
    expect(screen.getByRole('link', { name: t('openSecurity') })).toHaveAttribute('href', '/admin/security')
    expect(screen.queryByText(t('recoveryLow'))).toBeNull()
    expect(replace).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: t('continue') }))
    expect(replace).toHaveBeenCalledWith('/admin/posts')
  })

  it.each([2, 1, 0])('with %i codes left it asks for new ones', async (left) => {
    respond({ ok: true, recoveryCodesRemaining: left, usedRecoveryCode: true })
    renderWithIntl(<MfaForm next="/admin" />)

    type('ABCD-EFGH-JKMN-PQRS-TVWX-YZ01')
    submit()

    expect(await screen.findByText(t('recoveryLow'))).toBeInTheDocument()
  })
})

describe('MfaForm: the refusals', () => {
  it('shows the sentence the route handler sent, keeps the form and the typed digits out of the log, and lets the person try again', async () => {
    respond({ error: t('invalid'), code: 'MFA_CODE_INVALID' }, 401)
    renderWithIntl(<MfaForm next="/admin" />)

    type('000000')
    submit()

    expect(await screen.findByRole('alert')).toHaveTextContent(t('invalid'))
    expect(replace).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: t('submit') })).toBeEnabled()
  })

  it.each([
    ['too many tries', 429, { error: msg('Admin.login.mfa.tooMany', { minutes: 2 }), code: 'MFA_RATE_LIMITED', retryAfter: 95 }],
    ['the second step frozen', 403, { error: msg('Admin.login.mfa.frozen'), code: 'MFA_FROZEN' }],
    ['an expired challenge', 401, { error: msg('Admin.login.mfa.expired'), code: 'MFA_CHALLENGE_INVALID' }],
  ])('shows %s as the handler wrote it', async (_name, status, body) => {
    respond(body, status)
    renderWithIntl(<MfaForm next="/admin" />)

    type('000000')
    submit()

    expect(await screen.findByRole('alert')).toHaveTextContent(body.error)
  })

  it('a request that does not arrive says so', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))
    renderWithIntl(<MfaForm next="/admin" />)

    type('000000')
    submit()

    expect(await screen.findByRole('alert')).toHaveTextContent(msg('Admin.login.network'))
  })

  it('a 200 that is not the handler answer (a redirect fetch followed) is not a success', async () => {
    respond({ something: 'else' })
    renderWithIntl(<MfaForm next="/admin" />)

    type('000000')
    submit()

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(replace).not.toHaveBeenCalled()
  })

  it('offers the way back to the beginning, keeping the destination', () => {
    renderWithIntl(<MfaForm next="/admin/security" />)

    expect(screen.getByRole('link', { name: t('back') })).toHaveAttribute('href', '/admin/login?next=/admin/security')
  })
})
