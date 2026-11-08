import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MfaStatus } from '@/lib/types'
import { msg, renderWithIntl } from '@/test/render-intl'

const { router, clearClientSessionData } = vi.hoisted(() => ({
  router: { refresh: vi.fn(), replace: vi.fn() },
  clearClientSessionData: vi.fn(),
}))
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/admin/security' }))
vi.mock('@/lib/client-session-data', () => ({ clearClientSessionData }))

import { ENDPOINTS } from './endpoints'
import SecurityPanel from './SecurityPanel'

const t = (key: string, values?: Record<string, string | number>) => msg(`Admin.security.${key}`, values)
const enroll = (key: string) => msg(`Admin.login.enroll.${key}`)

const SECRET = {
  secretBase32: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
  otpauthUri: 'otpauth://totp/Blog:a?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Blog',
  issuer: 'Blog',
  account: 'a',
}
const CODES = ['ABCD-EFGH-JKMN-PQRS-TVWX-YZ01', 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ02']

const status = (over: Partial<MfaStatus> = {}): MfaStatus => ({
  enrolled: true,
  required: true,
  recoveryCodesRemaining: 8,
  hasPassword: true,
  passwordManagedByEnvironment: false,
  ...over,
})

type Answer = { status?: number; body: unknown }

/** Answers by URL path, a fresh Response each time; an unlisted call fails the test. */
function backend(answers: Record<string, Answer>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const answer = answers[String(input)]
    if (answer === undefined) throw new Error(`unexpected call to ${String(input)}`)
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 })
  })
}

const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }))
const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
/** The two-step verification card: the step-up form of an action shares labels with the password form below it. */
const mfaCard = () => within(screen.getByRole('region', { name: t('mfaTitle') }))
const fillCard = (label: string, value: string) => fireEvent.change(mfaCard().getByLabelText(label), { target: { value } })
const pressCard = (name: string) => fireEvent.click(mfaCard().getByRole('button', { name }))
const bodyOf = (spy: ReturnType<typeof backend>, url: string) => {
  const call = spy.mock.calls.find(([input]) => String(input) === url)
  return call === undefined ? undefined : JSON.parse(String(call[1]!.body))
}

afterEach(() => {
  vi.restoreAllMocks()
  router.refresh.mockReset()
  router.replace.mockReset()
  clearClientSessionData.mockReset()
})

describe('SecurityPanel: the status', () => {
  it('shows on, and the recovery codes left', () => {
    renderWithIntl(<SecurityPanel status={status()} role="ADMIN" />)

    expect(screen.getByRole('heading', { level: 2, name: t('mfaTitle') })).toBeInTheDocument()
    expect(screen.getByText(t('status.on'))).toBeInTheDocument()
    expect(screen.getByText(t('recoveryLeft', { count: 8 }))).toBeInTheDocument()
    expect(screen.queryByText(new RegExp(t('recoveryLowHint')))).toBeNull()
  })

  it.each([2, 1, 0])('with %i recovery codes left it warns and says to generate new ones', (left) => {
    renderWithIntl(<SecurityPanel status={status({ recoveryCodesRemaining: left })} role="ADMIN" />)

    expect(screen.getByText(`${t('recoveryLeft', { count: left })} ${t('recoveryLowHint')}`)).toBeInTheDocument()
  })

  it('an administrator has no "Turn off", and a sentence says why', () => {
    renderWithIntl(<SecurityPanel status={status()} role="ADMIN" />)

    expect(screen.queryByRole('button', { name: t('turnOff') })).toBeNull()
    expect(screen.getByText(t('adminRequired'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('regenerate') })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('replace') })).toBeInTheDocument()
  })

  it('an enrolled author has "Turn off", and no administrator sentence', () => {
    renderWithIntl(<SecurityPanel status={status()} role="AUTHOR" />)

    expect(screen.getByRole('button', { name: t('turnOff') })).toBeInTheDocument()
    expect(screen.queryByText(t('adminRequired'))).toBeNull()
  })

  it('an author with it off sees off, the hint and "Turn on" only', () => {
    renderWithIntl(<SecurityPanel status={status({ enrolled: false, required: false, hasPassword: false })} role="AUTHOR" />)

    expect(screen.getByText(t('status.off'))).toBeInTheDocument()
    expect(screen.getByText(t('offHint'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('turnOn') })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: t('regenerate') })).toBeNull()
    expect(screen.queryByText(t('recoveryLeft', { count: 0 }))).toBeNull()
  })
})

describe('SecurityPanel: turn on (an author)', () => {
  it('runs the setup without asking for a password (an author has none), then shows the codes and refreshes the page data', async () => {
    const fetchSpy = backend({
      [ENDPOINTS.enrollBegin]: { body: { ok: true, secret: SECRET } },
      [ENDPOINTS.enrollConfirm]: { body: { ok: true, recoveryCodes: CODES } },
    })
    renderWithIntl(<SecurityPanel status={status({ enrolled: false, required: false, hasPassword: false })} role="AUTHOR" />)

    press(t('turnOn'))
    press(enroll('start'))
    fill(enroll('firstCode'), await screen.findByText(enroll('step2')).then(() => '123456'))
    press(enroll('confirm'))
    fireEvent.click(await screen.findByRole('checkbox', { name: enroll('saved') }))
    expect(router.refresh).not.toHaveBeenCalled()
    press(t('done'))

    expect(bodyOf(fetchSpy, ENDPOINTS.enrollBegin)).toEqual({})
    expect(bodyOf(fetchSpy, ENDPOINTS.enrollConfirm)).toEqual({ code: '123456' })
    expect(router.refresh).toHaveBeenCalledTimes(1)
    expect(mfaCard().getByRole('status')).toHaveTextContent(t('notice.turnedOn'))
  })

  it('Cancel before the first code leaves everything as it was', () => {
    renderWithIntl(<SecurityPanel status={status({ enrolled: false, required: false, hasPassword: false })} role="AUTHOR" />)

    press(t('turnOn'))
    press(t('cancel'))

    expect(screen.getByRole('button', { name: t('turnOn') })).toBeInTheDocument()
    expect(router.refresh).not.toHaveBeenCalled()
  })
})

describe('SecurityPanel: replace the authenticator', () => {
  it('asks for a code and the password, shows the NEW key, takes its first code and gives ten new recovery codes', async () => {
    const fetchSpy = backend({
      [ENDPOINTS.replaceBegin]: { body: { ok: true, secret: SECRET } },
      [ENDPOINTS.replaceConfirm]: { body: { ok: true, recoveryCodes: CODES } },
    })
    renderWithIntl(<SecurityPanel status={status()} role="ADMIN" />)

    press(t('replace'))
    expect(screen.getByText(t('replaceLead'))).toBeInTheDocument()
    fillCard(t('currentCode'), 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ09')
    fillCard(t('password.current'), 'correct horse battery')
    press(enroll('start'))
    await screen.findByText(enroll('step2'))
    fill(enroll('firstCode'), '654321')
    press(enroll('confirm'))
    await screen.findByRole('list', { name: enroll('recoveryList') })
    fireEvent.click(screen.getByRole('checkbox', { name: enroll('saved') }))
    press(t('done'))

    // A recovery code is accepted as the proof (the phone is what was lost).
    expect(bodyOf(fetchSpy, ENDPOINTS.replaceBegin)).toEqual({
      code: 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ09',
      currentPassword: 'correct horse battery',
    })
    expect(bodyOf(fetchSpy, ENDPOINTS.replaceConfirm)).toEqual({ code: '654321' })
    expect(mfaCard().getByRole('status')).toHaveTextContent(t('notice.replaced'))
    expect(router.refresh).toHaveBeenCalledTimes(1)
  })

  it('an account without a password is not asked for one', () => {
    renderWithIntl(<SecurityPanel status={status({ hasPassword: false })} role="AUTHOR" />)

    press(t('replace'))

    expect(screen.getByLabelText(t('currentCode'))).toBeInTheDocument()
    expect(screen.queryByLabelText(t('password.current'))).toBeNull()
  })
})

describe('SecurityPanel: generate new recovery codes', () => {
  it('asks for a code, shows the new codes once behind the checkbox and refreshes the count', async () => {
    const fetchSpy = backend({ [ENDPOINTS.recoveryCodes]: { body: { ok: true, recoveryCodes: CODES } } })
    renderWithIntl(<SecurityPanel status={status({ hasPassword: false })} role="AUTHOR" />)

    press(t('regenerate'))
    expect(screen.getByText(t('regenerateLead'))).toBeInTheDocument()
    fill(t('currentCode'), '123456')
    press(t('regenerate'))

    const list = await screen.findByRole('list', { name: enroll('recoveryList') })
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(CODES)
    expect(bodyOf(fetchSpy, ENDPOINTS.recoveryCodes)).toEqual({ code: '123456' })
    expect(screen.getByRole('button', { name: t('done') })).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: enroll('saved') }))
    press(t('done'))
    expect(router.refresh).toHaveBeenCalledTimes(1)
    expect(mfaCard().getByRole('status')).toHaveTextContent(t('notice.regenerated'))
  })

  it('a wrong code shows the sentence in place and keeps the form', async () => {
    backend({ [ENDPOINTS.recoveryCodes]: { status: 401, body: { error: t('errors.codeInvalid'), code: 'MFA_CODE_INVALID' } } })
    renderWithIntl(<SecurityPanel status={status({ hasPassword: false })} role="ADMIN" />)

    press(t('regenerate'))
    fill(t('currentCode'), '000000')
    press(t('regenerate'))

    expect(await screen.findByRole('alert')).toHaveTextContent(t('errors.codeInvalid'))
    expect(screen.getByLabelText(t('currentCode'))).toBeInTheDocument()
    expect(router.refresh).not.toHaveBeenCalled()
  })

  it('sends nothing without a code, or without the password when the account has one', async () => {
    const fetchSpy = backend({})
    renderWithIntl(<SecurityPanel status={status()} role="ADMIN" />)

    press(t('regenerate'))
    pressCard(t('regenerate'))
    expect(await screen.findByRole('alert')).toHaveTextContent(t('codeRequired'))
    fillCard(t('currentCode'), '123456')
    pressCard(t('regenerate'))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(t('password.currentRequired')))
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('SecurityPanel: turn off (an author)', () => {
  it('asks for a code with the consequences stated, turns it off and refreshes', async () => {
    const fetchSpy = backend({ [ENDPOINTS.disable]: { body: { ok: true } } })
    renderWithIntl(<SecurityPanel status={status({ hasPassword: false })} role="AUTHOR" />)

    press(t('turnOff'))
    expect(screen.getByText(t('turnOffLead'))).toBeInTheDocument()
    fill(t('currentCode'), '123456')
    press(t('turnOffConfirm'))

    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1))
    expect(bodyOf(fetchSpy, ENDPOINTS.disable)).toEqual({ code: '123456' })
    expect(mfaCard().getByRole('status')).toHaveTextContent(t('notice.turnedOff'))
  })
})

describe('SecurityPanel: sign in again', () => {
  const reauth = { status: 401, body: { error: t('reauth'), code: 'REAUTHENTICATION_REQUIRED', reauthenticate: true } }

  it('a sign-in that is too old shows ONE banner with a link that returns here (a password account signs in with its password)', async () => {
    backend({ [ENDPOINTS.recoveryCodes]: reauth })
    renderWithIntl(<SecurityPanel status={status()} role="ADMIN" />)

    press(t('regenerate'))
    fillCard(t('currentCode'), '123456')
    fillCard(t('password.current'), 'pw')
    pressCard(t('regenerate'))

    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent(t('reauth'))
    expect(within(banner).getByRole('link', { name: t('reauthAction') })).toHaveAttribute(
      'href',
      '/admin/login?next=/admin/security',
    )
    // The sentence is not repeated in the form, and what was typed is kept.
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(mfaCard().getByLabelText(t('currentCode'))).toHaveValue('123456')
    expect(router.replace).not.toHaveBeenCalled()
  })

  it('a GitHub account (no password) signs in again with GitHub, returning here', async () => {
    backend({ [ENDPOINTS.recoveryCodes]: reauth })
    renderWithIntl(<SecurityPanel status={status({ hasPassword: false })} role="AUTHOR" />)

    press(t('regenerate'))
    fill(t('currentCode'), '123456')
    press(t('regenerate'))

    const banner = await screen.findByRole('alert')
    expect(within(banner).getByRole('link', { name: t('reauthAction') })).toHaveAttribute(
      'href',
      '/api/auth/github/start?returnTo=%2Fadmin%2Fsecurity',
    )
  })

  it('a session that is gone altogether goes to the sign-in', async () => {
    backend({
      [ENDPOINTS.recoveryCodes]: {
        status: 401,
        body: { error: t('errors.sessionExpired'), code: 'UNAUTHENTICATED', sessionExpired: true },
      },
    })
    renderWithIntl(<SecurityPanel status={status({ hasPassword: false })} role="ADMIN" />)

    press(t('regenerate'))
    fill(t('currentCode'), '123456')
    press(t('regenerate'))

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/admin/login'))
  })
})

describe('SecurityPanel: change password', () => {
  const fillAll = (over: { current?: string; next?: string; repeat?: string; code?: string } = {}) => {
    fill(t('password.current'), over.current ?? 'old password 123')
    fill(t('password.new'), over.next ?? 'a much longer new password')
    fill(t('password.repeat'), over.repeat ?? over.next ?? 'a much longer new password')
    if (over.code !== undefined) fill(t('currentCode'), over.code)
  }
  const submit = () => press(t('password.submit'))

  it('is not offered to an account without a password (an author)', () => {
    renderWithIntl(<SecurityPanel status={status({ hasPassword: false })} role="AUTHOR" />)

    expect(screen.queryByRole('heading', { name: t('password.title') })).toBeNull()
  })

  it('is replaced by the sentence about the server setting when ADMIN_PASSWORD sets the password', () => {
    renderWithIntl(<SecurityPanel status={status({ passwordManagedByEnvironment: true })} role="ADMIN" />)

    expect(screen.getByRole('heading', { level: 2, name: t('password.title') })).toBeInTheDocument()
    expect(screen.getByText(t('password.managedByEnvironment'))).toBeInTheDocument()
    expect(screen.queryByLabelText(t('password.current'))).toBeNull()
  })

  it('asks for the code of an enrolled account only', () => {
    const { unmount } = renderWithIntl(<SecurityPanel status={status()} role="ADMIN" />)
    const form = screen.getByRole('heading', { name: t('password.title') }).closest('section')!
    expect(within(form).getByLabelText(t('currentCode'))).toBeInTheDocument()
    unmount()

    renderWithIntl(<SecurityPanel status={status({ enrolled: false, required: false })} role="AUTHOR" />)
    const plain = screen.getByRole('heading', { name: t('password.title') }).closest('section')!
    expect(within(plain).queryByLabelText(t('currentCode'))).toBeNull()
  })

  it.each([
    ['a new password that is too short', { next: 'short' }, () => t('password.tooShort', { min: 12 })],
    ['a new password that is too long', { next: 'x'.repeat(129) }, () => t('password.tooLong', { max: 128 })],
    [
      'two copies that differ',
      { next: 'a much longer new password', repeat: 'a much longer new passwordX' },
      () => t('password.mismatch'),
    ],
    [
      'a new password equal to the current one',
      { current: 'the very same password', next: 'the very same password' },
      () => t('password.same'),
    ],
    ['no code for an enrolled account', { code: '' }, () => t('codeRequired')],
    ['no current password', { current: '' }, () => t('password.currentRequired')],
  ])('%s is refused here, without a round trip', async (_name, fields, expected) => {
    const fetchSpy = backend({})
    renderWithIntl(<SecurityPanel status={status()} role="ADMIN" />)

    fillAll(fields)
    submit()

    expect(await screen.findByRole('alert')).toHaveTextContent(expected())
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('sends the passwords as typed and the code, then empties the fields, says other devices were signed out and refreshes', async () => {
    const fetchSpy = backend({ [ENDPOINTS.password]: { body: { ok: true } } })
    renderWithIntl(<SecurityPanel status={status()} role="ADMIN" />)

    fillAll({ current: ' old password 123 ', next: ' a much longer new password ', code: ' 123456 ' })
    submit()

    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1))
    expect(bodyOf(fetchSpy, ENDPOINTS.password)).toEqual({
      currentPassword: ' old password 123 ',
      newPassword: ' a much longer new password ',
      code: '123456',
    })
    expect(screen.getByLabelText(t('password.current'))).toHaveValue('')
    expect(screen.getByLabelText(t('password.new'))).toHaveValue('')
    expect(screen.getByLabelText(t('password.repeat'))).toHaveValue('')
    expect(screen.getByText(t('password.done'))).toBeInTheDocument()
  })

  it('does not send a code for an account without two-step verification', async () => {
    const fetchSpy = backend({ [ENDPOINTS.password]: { body: { ok: true } } })
    renderWithIntl(<SecurityPanel status={status({ enrolled: false, required: false })} role="AUTHOR" />)

    fillAll()
    submit()

    await waitFor(() => expect(router.refresh).toHaveBeenCalled())
    expect(bodyOf(fetchSpy, ENDPOINTS.password)).toEqual({
      currentPassword: 'old password 123',
      newPassword: 'a much longer new password',
    })
  })

  it.each([
    ['a password on the common list', 'password.weak'],
    ['the wrong current password', 'errors.passwordInvalid'],
    ['a wrong code', 'errors.codeInvalid'],
  ])('shows the backend refusal for %s as the handler wrote it and keeps what was typed', async (_name, key) => {
    backend({ [ENDPOINTS.password]: { status: 400, body: { error: t(key), code: 'X' } } })
    renderWithIntl(<SecurityPanel status={status({ enrolled: false, required: false })} role="AUTHOR" />)

    fillAll()
    submit()

    expect(await screen.findByRole('alert')).toHaveTextContent(t(key))
    expect(screen.getByLabelText(t('password.new'))).toHaveValue('a much longer new password')
    expect(router.refresh).not.toHaveBeenCalled()
    expect(screen.queryByText(t('password.done'))).toBeNull()
  })
})

describe('SecurityPanel: sign out everywhere', () => {
  it('asks first, then calls the handler, empties what the browser keeps for the writer and goes to the sign-in it names', async () => {
    const fetchSpy = backend({ [ENDPOINTS.signOutEverywhere]: { body: { ok: true, next: '/admin/login' } } })
    renderWithIntl(<SecurityPanel status={status()} role="ADMIN" />)

    press(t('signOutEverywhere'))
    expect(fetchSpy).not.toHaveBeenCalled()
    const confirmation = screen.getByRole('group', { name: t('signOutConfirm') })
    fireEvent.click(within(confirmation).getByRole('button', { name: t('signOutEverywhere') }))

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/admin/login'))
    expect(fetchSpy).toHaveBeenCalledWith(ENDPOINTS.signOutEverywhere, expect.objectContaining({ method: 'POST' }))
    expect(clearClientSessionData).toHaveBeenCalledTimes(1)
  })

  it('Cancel returns to the button', () => {
    renderWithIntl(<SecurityPanel status={status()} role="ADMIN" />)

    press(t('signOutEverywhere'))
    press(t('cancel'))

    expect(screen.queryByRole('group', { name: t('signOutConfirm') })).toBeNull()
    expect(screen.getByRole('button', { name: t('signOutEverywhere') })).toBeInTheDocument()
  })

  it('a failure keeps the person on the page, signed in, with the sentence', async () => {
    backend({ [ENDPOINTS.signOutEverywhere]: { status: 502, body: { error: t('errors.failed'), code: 'FAILED' } } })
    renderWithIntl(<SecurityPanel status={status()} role="ADMIN" />)

    press(t('signOutEverywhere'))
    fireEvent.click(
      within(screen.getByRole('group', { name: t('signOutConfirm') })).getByRole('button', { name: t('signOutEverywhere') }),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(t('errors.failed'))
    expect(router.replace).not.toHaveBeenCalled()
    expect(clearClientSessionData).not.toHaveBeenCalled()
  })
})
