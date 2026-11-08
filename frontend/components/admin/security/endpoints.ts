/**
 * The route handlers of the Security page, in one place. Each value must equal the folder of its `route.ts` under
 * `app/admin/(shell)/security/` (endpoints.test.ts checks that every path has one), and none is listed in proxy.ts: they need a session,
 * and they are JSON `fetch` calls, because `proxy.ts` answers 403 to a plain form post.
 */
export const ENDPOINTS = {
  enrollBegin: '/admin/security/enroll/begin',
  enrollConfirm: '/admin/security/enroll/confirm',
  recoveryCodes: '/admin/security/recovery-codes',
  replaceBegin: '/admin/security/replace/begin',
  replaceConfirm: '/admin/security/replace/confirm',
  disable: '/admin/security/disable',
  password: '/admin/security/password',
  signOutEverywhere: '/admin/security/sign-out-everywhere',
} as const
