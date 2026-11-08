/**
 * Calls the JSON route handlers of the second step and of the security page from the browser. Never throws: every outcome is a
 * value, so a component needs one `if (!reply.ok)` branch.
 *
 * The handlers answer `{ ok: true, ...fields }` on success and `{ error, code, ... }` otherwise, where `error` is already a sentence
 * in the admin's language (the backend's English text is never passed on). Success means exactly that body: a 200 of something else
 * (a proxy redirect that fetch followed back to a page) is not one.
 */

export type MfaReply =
  | { ok: true; body: Record<string, unknown> }
  | {
      ok: false
      status: number
      /** The translated sentence, when the handler sent one. */
      error: string | undefined
      /** The backend's stable error code, when there was one. `NETWORK` for a request that did not arrive. */
      code: string | undefined
      /** The session is too old for a change of the security settings: the page offers "sign in again". */
      reauthenticate: boolean
      /** The session itself is gone: the page goes to the sign-in. */
      sessionExpired: boolean
      /** Seconds to wait, for a 429. */
      retryAfter: number | undefined
    }

const NETWORK: MfaReply = {
  ok: false,
  status: 0,
  error: undefined,
  code: 'NETWORK',
  reauthenticate: false,
  sessionExpired: false,
  retryAfter: undefined,
}

export async function postMfa(url: string, body: Record<string, unknown>): Promise<MfaReply> {
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      credentials: 'same-origin',
    })
  } catch {
    return NETWORK
  }

  const parsed = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (res.ok && parsed !== null && parsed.ok === true) return { ok: true, body: parsed }
  return {
    ok: false,
    status: res.status,
    error: typeof parsed?.error === 'string' ? parsed.error : undefined,
    code: typeof parsed?.code === 'string' ? parsed.code : undefined,
    reauthenticate: parsed?.reauthenticate === true,
    sessionExpired: parsed?.sessionExpired === true,
    retryAfter: typeof parsed?.retryAfter === 'number' ? parsed.retryAfter : undefined,
  }
}

/** The shown form of an authenticator key: groups of four (`ABCD EFGH ...`). */
export function groupsOfFour(key: string): string {
  return key.replace(/\s+/g, '').replace(/(.{4})(?=.)/g, '$1 ')
}

/** The ten recovery codes as the text file the page offers: one per line, nothing that identifies the account. */
export function recoveryCodesFile(codes: readonly string[]): string {
  return `${codes.join('\n')}\n`
}

export type EnrollmentSecret = { secretBase32: string; otpauthUri: string; issuer: string; account: string }

/** The secret of a begin answer, or null when the body does not carry one. */
export function secretOf(body: Record<string, unknown>): EnrollmentSecret | null {
  const raw = body.secret
  if (raw === null || typeof raw !== 'object') return null
  const secret = raw as Record<string, unknown>
  if (typeof secret.secretBase32 !== 'string' || typeof secret.otpauthUri !== 'string') return null
  return {
    secretBase32: secret.secretBase32,
    otpauthUri: secret.otpauthUri,
    issuer: typeof secret.issuer === 'string' ? secret.issuer : '',
    account: typeof secret.account === 'string' ? secret.account : '',
  }
}

/** The recovery codes of an answer, or null when it carries none. */
export function recoveryCodesOf(body: Record<string, unknown>): string[] | null {
  const codes = body.recoveryCodes
  return Array.isArray(codes) && codes.length > 0 && codes.every((code) => typeof code === 'string') ? (codes as string[]) : null
}

/** Puts text on the clipboard; false when the browser refuses or has no clipboard (an insecure origin), so the caller can fall back. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** Hands a small text file to the browser as a download. The name never identifies the account. */
export function downloadTextFile(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.rel = 'noopener'
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** The file name of the recovery codes download. */
export const RECOVERY_CODES_FILE = 'recovery-codes.txt'
