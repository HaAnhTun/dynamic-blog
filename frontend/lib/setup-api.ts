import 'server-only'
import { clientIpHeaders } from './client-ip'
import { apiBaseUrl } from '@/lib/api-base-url'

const BASE_URL = apiBaseUrl()

const STATUS_TIMEOUT_MS = 3000
/** The backend hashes the password with Argon2 before answering, so a submit gets more time than a status read. */
const SETUP_TIMEOUT_MS = 15000

/** The stable codes the setup route answers with; each has a message under `Setup.errors` in the catalogs. */
export const SETUP_ERROR_CODES = [
  'SETUP_CODE_INVALID',
  'SETUP_CLOSED',
  'VALIDATION_ERROR',
  'RATE_LIMITED',
  'UNAVAILABLE',
] as const

export type SetupErrorCode = (typeof SETUP_ERROR_CODES)[number]

export type SetupInput = { setupCode: string; email: string; password: string; displayName: string }

export type SetupResult = { ok: true } | { ok: false; code: SetupErrorCode; status: number }

/**
 * Whether the first-run setup is still open. Anything but a clear `setupRequired: true` (backend down, another status, an
 * unreadable body) is "not required", so the page answers 404 instead of offering a form it cannot back.
 */
export async function isSetupRequired(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/v1/setup/status`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    })
    if (res.status !== 200) return false
    const body = (await res.json()) as { data?: { setupRequired?: unknown } }
    return body.data?.setupRequired === true
  } catch {
    return false
  }
}

const BACKEND_CODES: Partial<Record<string, SetupErrorCode>> = {
  SETUP_CODE_INVALID: 'SETUP_CODE_INVALID',
  SETUP_CLOSED: 'SETUP_CLOSED',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
}

/**
 * Posts the setup to the backend without any auth header. The backend's `message` is never read or forwarded: the caller gets a
 * stable code only. Nothing here logs the input. `ip` is the visitor's address (lib/client-ip.ts, `null` when unknown) for the
 * backend's per-address limit.
 */
export async function postSetup(input: SetupInput, ip: string | null = null): Promise<SetupResult> {
  let res: Response
  try {
    res = await fetch(`${BASE_URL}/api/v1/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...clientIpHeaders(ip) },
      body: JSON.stringify(input),
      cache: 'no-store',
      signal: AbortSignal.timeout(SETUP_TIMEOUT_MS),
    })
  } catch {
    return { ok: false, code: 'UNAVAILABLE', status: 502 }
  }
  if (res.status === 201) return { ok: true }

  const failure = (await res.json().catch(() => null)) as { error?: { code?: unknown } } | null
  const raw = failure?.error?.code
  const mapped = typeof raw === 'string' ? BACKEND_CODES[raw] : undefined
  if (mapped === 'SETUP_CODE_INVALID') return { ok: false, code: mapped, status: 403 }
  if (mapped === 'SETUP_CLOSED') return { ok: false, code: mapped, status: 404 }
  if (mapped === 'VALIDATION_ERROR') return { ok: false, code: mapped, status: 400 }
  if (mapped === 'RATE_LIMITED') return { ok: false, code: mapped, status: 429 }
  return { ok: false, code: 'UNAVAILABLE', status: 502 }
}
