/**
 * The shape of the newsletter confirm-link and unsubscribe-link token: base64url. Only the shape is checked, before building the
 * backend call; whether it is right or wrong, expired or used is the backend's business. Both token pages use this same function so they never
 * show a button for a token the BFF route would refuse.
 */
const TOKEN = /^[A-Za-z0-9_-]{20,200}$/

export function newsletterToken(value: unknown): string | null {
  return typeof value === 'string' && TOKEN.test(value) ? value : null
}
