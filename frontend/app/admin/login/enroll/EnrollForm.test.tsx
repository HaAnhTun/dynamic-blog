import { fireEvent, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { msg, renderWithIntl } from '@/test/render-intl'

const replace = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }))

import EnrollForm, { ENROLL_BEGIN_ENDPOINT, ENROLL_CONFIRM_ENDPOINT } from './EnrollForm'

const t = (key: string) => msg(`Admin.login.enroll.${key}`)

afterEach(() => {
  vi.restoreAllMocks()
  replace.mockReset()
})

describe('EnrollForm', () => {
  it('posts to the two route handlers of this folder, and both are open in the proxy without a session', () => {
    expect(ENROLL_BEGIN_ENDPOINT).toBe('/admin/login/enroll/begin')
    expect(ENROLL_CONFIRM_ENDPOINT).toBe('/admin/login/enroll/confirm')
    const proxy = readFileSync('proxy.ts', 'utf8')
    for (const path of [ENROLL_BEGIN_ENDPOINT, ENROLL_CONFIRM_ENDPOINT]) expect(proxy).toContain(`'${path}'`)
  })

  it('runs the whole enrollment and then goes to the destination, replacing the history entry', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input) === ENROLL_BEGIN_ENDPOINT
        ? Response.json({
            ok: true,
            secret: {
              secretBase32: 'JBSWY3DPEHPK3PXP',
              otpauthUri: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP',
              issuer: 'Blog',
              account: 'a',
            },
          })
        : Response.json({ ok: true, recoveryCodes: ['ABCD-EFGH-JKMN-PQRS-TVWX-YZ01'] }),
    )
    renderWithIntl(<EnrollForm next="/admin/security" askEnrollmentCode={false} />)

    fireEvent.click(screen.getByRole('button', { name: t('start') }))
    fireEvent.change(await screen.findByLabelText(t('firstCode')), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: t('confirm') }))
    fireEvent.click(await screen.findByRole('checkbox', { name: t('saved') }))
    fireEvent.click(screen.getByRole('button', { name: t('continue') }))

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/admin/security'))
  })

  it('offers the way back to the sign-in with the destination when the challenge expired', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({ error: msg('Admin.login.mfa.expired'), code: 'MFA_CHALLENGE_INVALID' }, { status: 401 }),
    )
    renderWithIntl(<EnrollForm next="/admin/security" askEnrollmentCode={false} />)

    fireEvent.click(screen.getByRole('button', { name: t('start') }))

    expect(await screen.findByRole('link', { name: msg('Admin.login.mfa.back') })).toHaveAttribute(
      'href',
      '/admin/login?next=/admin/security',
    )
  })
})
