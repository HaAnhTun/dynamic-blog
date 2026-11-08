import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { msg, renderWithIntl } from '@/test/render-intl'
import EnrollFlow, { type EnrollField } from './EnrollFlow'

const BEGIN = '/begin'
const CONFIRM = '/confirm'
const SECRET = {
  secretBase32: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
  otpauthUri: 'otpauth://totp/Blog:admin?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Blog',
  issuer: 'Blog',
  account: 'admin',
}
const CODES = ['ABCD-EFGH-JKMN-PQRS-TVWX-YZ01', 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ02']

const t = (key: string, values?: Record<string, string | number>) => msg(`Admin.${key}`, values)

type Answer = { status?: number; body: unknown }

/** Answers by URL, a fresh Response each time. */
function backend(answers: { begin?: Answer; confirm?: Answer }) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const answer = String(input) === BEGIN ? answers.begin : answers.confirm
    if (answer === undefined) throw new Error(`unexpected call to ${String(input)}`)
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 })
  })
}

function flow(props: Partial<React.ComponentProps<typeof EnrollFlow>> & { fields?: readonly EnrollField[] } = {}) {
  const onDone = vi.fn()
  const view = renderWithIntl(
    <EnrollFlow
      beginUrl={BEGIN}
      confirmUrl={CONFIRM}
      fields={[]}
      doneLabel={t('login.enroll.continue')}
      onDone={onDone}
      {...props}
    />,
  )
  return { onDone, ...view }
}

const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }))
const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const jsonBody = (spy: ReturnType<typeof backend>, call: number) => JSON.parse(String(spy.mock.calls[call]![1]!.body))

afterEach(() => {
  vi.restoreAllMocks()
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
})

describe('EnrollFlow: step 1, the inputs of begin', () => {
  it('without inputs it is a button, and opening the page calls nothing', () => {
    const fetchSpy = backend({})
    flow()

    expect(screen.getByRole('button', { name: t('login.enroll.start') })).toBeEnabled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('asks for the enrollment code when told to, with the hint where to find it', async () => {
    const fetchSpy = backend({ begin: { body: { ok: true, secret: SECRET } } })
    flow({ fields: ['enrollmentCode'] })

    expect(screen.getByLabelText(t('login.enroll.enrollmentCode'))).toHaveFocus()
    expect(screen.getByText(t('login.enroll.enrollmentCodeHint'))).toBeInTheDocument()
    press(t('login.enroll.start'))
    // Nothing is sent without the code.
    expect(await screen.findByRole('alert')).toHaveTextContent(t('login.enroll.codeRequired'))
    expect(fetchSpy).not.toHaveBeenCalled()

    fill(t('login.enroll.enrollmentCode'), ' operator-code ')
    press(t('login.enroll.start'))
    await screen.findByText(t('login.enroll.step2'))
    expect(fetchSpy).toHaveBeenCalledWith(BEGIN, expect.objectContaining({ method: 'POST' }))
    expect(jsonBody(fetchSpy, 0)).toEqual({ enrollmentCode: 'operator-code' })
  })

  it('shows the enrollment code field after a refusal even when the page did not ask for it (the ?code=1 hint was wrong)', async () => {
    backend({ begin: { status: 403, body: { error: t('login.enroll.codeInvalid'), code: 'ENROLLMENT_CODE_INVALID' } } })
    flow()
    expect(screen.queryByLabelText(t('login.enroll.enrollmentCode'))).toBeNull()

    press(t('login.enroll.start'))

    expect(await screen.findByRole('alert')).toHaveTextContent(t('login.enroll.codeInvalid'))
    expect(screen.getByLabelText(t('login.enroll.enrollmentCode'))).toBeInTheDocument()
  })

  it('asks for a code and a password for a replacement, and sends both with the first call', async () => {
    const fetchSpy = backend({ begin: { body: { ok: true, secret: SECRET } } })
    flow({ fields: ['code', 'currentPassword'], lead: t('security.replaceLead') })

    expect(screen.getByText(t('security.replaceLead'))).toBeInTheDocument()
    fill(t('security.currentCode'), 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ03')
    fill(t('security.password.current'), 'correct horse battery staple')
    press(t('login.enroll.start'))

    await screen.findByText(t('login.enroll.step2'))
    expect(jsonBody(fetchSpy, 0)).toEqual({
      code: 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ03',
      currentPassword: 'correct horse battery staple',
    })
  })

  it('does not send a missing code or password', async () => {
    const fetchSpy = backend({})
    flow({ fields: ['code', 'currentPassword'] })

    press(t('login.enroll.start'))
    expect(await screen.findByRole('alert')).toHaveTextContent(t('security.codeRequired'))

    fill(t('security.currentCode'), '123456')
    press(t('login.enroll.start'))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(t('security.password.currentRequired')))
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('reports every refusal to the host, which owns the "sign in again" message: the flow does not repeat it', async () => {
    backend({
      begin: { status: 401, body: { error: t('security.reauth'), code: 'REAUTHENTICATION_REQUIRED', reauthenticate: true } },
    })
    const onRefused = vi.fn()
    flow({ onRefused })

    press(t('login.enroll.start'))

    await waitFor(() =>
      expect(onRefused).toHaveBeenCalledWith(
        expect.objectContaining({ reauthenticate: true, code: 'REAUTHENTICATION_REQUIRED' }),
      ),
    )
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('without a host that listens, a sign-in that is too old is shown as the sentence it is', async () => {
    backend({
      begin: { status: 401, body: { error: t('security.reauth'), code: 'REAUTHENTICATION_REQUIRED', reauthenticate: true } },
    })
    flow()

    press(t('login.enroll.start'))

    expect(await screen.findByRole('alert')).toHaveTextContent(t('security.reauth'))
  })

  it('offers the way back to the sign-in when the challenge is dead', async () => {
    backend({ begin: { status: 401, body: { error: msg('Admin.login.mfa.expired'), code: 'MFA_CHALLENGE_INVALID' } } })
    flow({ restartHref: '/admin/login' })

    press(t('login.enroll.start'))

    expect(await screen.findByRole('link', { name: t('login.mfa.back') })).toHaveAttribute('href', '/admin/login')
  })

  it('Cancel leaves the flow when the host allows it', () => {
    const onCancel = vi.fn()
    flow({ onCancel })

    press(t('security.cancel'))

    expect(onCancel).toHaveBeenCalled()
  })
})

describe('EnrollFlow: step 2, the secret and the first code', () => {
  async function toSecret(extra: Parameters<typeof flow>[0] = {}) {
    const fetchSpy = backend({
      begin: { body: { ok: true, secret: SECRET } },
      confirm: { body: { ok: true, recoveryCodes: CODES } },
    })
    const view = flow(extra)
    press(t('login.enroll.start'))
    await screen.findByText(t('login.enroll.step2'))
    return { fetchSpy, ...view }
  }

  it('shows the key in groups of four with an accessible name, and the otpauth link', async () => {
    await toSecret()

    const group = screen.getByRole('group', { name: t('login.enroll.secret') })
    expect(within(group).getByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: t('login.enroll.openApp') })).toHaveAttribute('href', SECRET.otpauthUri)
    expect(screen.getByRole('heading', { level: 2, name: t('login.enroll.secretTitle') })).toHaveFocus()
  })

  it('asks for the first code with the one-time-code hint, and refuses an empty one without calling the backend', async () => {
    const { fetchSpy } = await toSecret()
    const input = screen.getByLabelText(t('login.enroll.firstCode'))
    expect(input).toHaveAttribute('inputmode', 'numeric')
    expect(input).toHaveAttribute('autocomplete', 'one-time-code')

    press(t('login.enroll.confirm'))

    expect(await screen.findByRole('alert')).toHaveTextContent(t('security.codeRequired'))
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('a wrong first code keeps the step, shows the sentence and lets the person try again', async () => {
    const fetchSpy = backend({
      begin: { body: { ok: true, secret: SECRET } },
      confirm: { status: 401, body: { error: msg('Admin.login.mfa.invalid'), code: 'MFA_CODE_INVALID' } },
    })
    flow()
    press(t('login.enroll.start'))
    await screen.findByText(t('login.enroll.step2'))

    fill(t('login.enroll.firstCode'), '000000')
    press(t('login.enroll.confirm'))

    expect(await screen.findByRole('alert')).toHaveTextContent(msg('Admin.login.mfa.invalid'))
    expect(screen.getByRole('group', { name: t('login.enroll.secret') })).toBeInTheDocument()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('Copy puts the key without spaces on the clipboard and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await toSecret()

    press(t('login.enroll.copy'))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SECRET.secretBase32))
    expect(await screen.findByRole('button', { name: t('login.enroll.copied') })).toBeInTheDocument()
  })

  it('without a clipboard it selects the key for Ctrl+C and says so', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    await toSecret()

    press(t('login.enroll.copy'))

    expect(await screen.findByText(t('login.enroll.copySelected'))).toBeInTheDocument()
    expect(window.getSelection()?.toString()).toContain('JBSW')
  })
})

describe('EnrollFlow: step 3, the recovery codes', () => {
  async function toCodes(onDone = vi.fn()) {
    const fetchSpy = backend({
      begin: { body: { ok: true, secret: SECRET } },
      confirm: { body: { ok: true, recoveryCodes: CODES } },
    })
    renderWithIntl(
      <EnrollFlow beginUrl={BEGIN} confirmUrl={CONFIRM} fields={[]} doneLabel={t('login.enroll.continue')} onDone={onDone} />,
    )
    press(t('login.enroll.start'))
    await screen.findByText(t('login.enroll.step2'))
    fill(t('login.enroll.firstCode'), '123456')
    press(t('login.enroll.confirm'))
    await screen.findByRole('heading', { level: 2, name: t('login.enroll.recoveryTitle') })
    return { fetchSpy, onDone }
  }

  it('sends the first code and shows the ten codes in a list, with the heading focused', async () => {
    const { fetchSpy } = await toCodes()

    expect(fetchSpy).toHaveBeenLastCalledWith(CONFIRM, expect.objectContaining({ method: 'POST' }))
    expect(jsonBody(fetchSpy, 1)).toEqual({ code: '123456' })
    const list = screen.getByRole('list', { name: t('login.enroll.recoveryList') })
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(CODES)
    expect(screen.getByRole('heading', { level: 2, name: t('login.enroll.recoveryTitle') })).toHaveFocus()
  })

  it('the secret is gone from the page once the codes appear', async () => {
    await toCodes()

    expect(document.body.textContent).not.toContain(SECRET.secretBase32)
    expect(document.body.textContent).not.toContain('JBSW Y3DP')
    expect(document.body.innerHTML).not.toContain('otpauth://')
    expect(screen.queryByRole('group', { name: t('login.enroll.secret') })).toBeNull()
  })

  it('the Continue button works only after the box "I stored these codes somewhere safe" is ticked', async () => {
    const { onDone } = await toCodes()
    const next = screen.getByRole('button', { name: t('login.enroll.continue') })
    expect(next).toBeDisabled()

    fireEvent.click(screen.getByRole('checkbox', { name: t('login.enroll.saved') }))
    expect(next).toBeEnabled()
    fireEvent.click(next)

    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('Download hands the codes to the browser as a text file named without any account identifier', async () => {
    const created: Blob[] = []
    const createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob)
      return 'blob:codes'
    })
    const revokeObjectURL = vi.fn()
    Object.assign(URL, { createObjectURL, revokeObjectURL })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('recovery-codes.txt')
      expect(this.href).toBe('blob:codes')
    })
    await toCodes()

    press(t('login.enroll.download'))

    expect(click).toHaveBeenCalledTimes(1)
    expect(await created[0]!.text()).toBe(`${CODES.join('\n')}\n`)
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:codes'))
  })

  it('Copy puts the codes on the clipboard, one per line', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await toCodes()

    press(t('login.enroll.copyCodes'))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${CODES.join('\n')}\n`))
  })
})
