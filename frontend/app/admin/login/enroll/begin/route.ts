import { NextResponse } from 'next/server'
import { runSignInStep, stringField } from '@/lib/mfa-sign-in-route'

/**
 * POST /admin/login/enroll/begin `{ enrollmentCode? }`: starts the forced enrollment of an administrator. The backend checks the
 * operator's enrollment code unless the enrollment window is open, stores a new secret as pending and answers with it once.
 * This is the one place where the secret travels to the page's JavaScript: `no-store`, and the page never writes it anywhere.
 *
 * The path must equal ENROLL_BEGIN_ENDPOINT in app/admin/login/enroll/EnrollForm.tsx and SIGN_IN_STEP_PATHS in proxy.ts.
 */
export async function POST(request: Request): Promise<Response> {
  return runSignInStep(request, {
    path: '/api/v1/auth/mfa/enroll/begin',
    fields: (body) => {
      const enrollmentCode = stringField(body, 'enrollmentCode', 512)
      if (enrollmentCode === null) return null
      const fields: Record<string, string> = {}
      if (enrollmentCode !== undefined) fields.enrollmentCode = enrollmentCode
      return fields
    },
    succeed: (data) => {
      const { secretBase32, otpauthUri, issuer, account } = data
      if (typeof secretBase32 !== 'string' || typeof otpauthUri !== 'string') return null
      return NextResponse.json(
        {
          ok: true,
          secret: {
            secretBase32,
            otpauthUri,
            issuer: typeof issuer === 'string' ? issuer : '',
            account: typeof account === 'string' ? account : '',
          },
        },
        { headers: { 'cache-control': 'private, no-store' } },
      )
    },
  })
}
