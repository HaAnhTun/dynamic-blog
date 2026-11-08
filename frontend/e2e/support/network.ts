import { randomBytes } from 'node:crypto'
import type { BrowserContext } from '@playwright/test'
import { applyLocale } from './i18n'

/**
 * The network of a browser context in E2E: requests blocked or replaced right in the browser, and
 * a client address of its own for the sign-in limiter, the language of the run (`admin_locale` cookie). The default context (fixtures.ts) and the context of
 * each reader (github.ts, newUserContext) install the same set.
 */

/** The view beacon gets a fake 204 and never reaches the server (the reason is at the `context` fixture in fixtures.ts). */
export async function stubViewBeacon(context: BrowserContext): Promise<void> {
  await context.route('**/api/views', (route) => route.fulfill({ status: 204 }))
}

/**
 * The fake avatar for every fake user: a 64×64 single-color blue-gray PNG, embedded here so as not to
 * add a binary file to the repo and not to make every spec load `sharp`.
 */
const AVATAR_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PsQkAAAgDsP6Pq7OveoKzEMgDSfW8FgEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGBK7CW+gGlzvSULAAAAABJRU5ErkJggg==',
  'base64',
)

/** github.com and all its subdomains (api., gist., …); not githubusercontent.com. */
const REAL_GITHUB = /^https?:\/\/(?:[^/?#]+\.)?github\.com(?::\d+)?(?:[/?#]|$)/i

/**
 * The real GitHub must never be touched:
 * - avatars at avatars.githubusercontent.com (components/site/Avatar.tsx loads them directly, not through
 *   Next's image optimizer) become the fake PNG above, so the header, profile and comments still have a picture;
 * - requests to github.com are blocked: a QA backend that forgot to point its provider at the fake GitHub fails at once
 *   in the browser (loginWithGitHub reports it clearly), instead of taking a fake reader to the real GitHub.
 */
export async function stubGithub(context: BrowserContext): Promise<void> {
  await context.route('**/avatars.githubusercontent.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: AVATAR_PNG }),
  )
  await context.route(REAL_GITHUB, (route) => route.abort('blockedbyclient'))
}

const withOwnAddress = new WeakSet<BrowserContext>()

/**
 * A client address of its own for this context, sent in the X-Forwarded-For of every request.
 *
 * Next gives each IP 20 GitHub sign-in attempts per 10 minutes, start and callback counted together
 * (lib/rate-limit.ts), and every E2E browser comes from 127.0.0.1: sharing one IP, after about
 * ten sign-ins every later one goes to /login?error=rate. The QA stack runs `next start` with no
 * proxy, and Next only fills in X-Forwarded-For when the request does not carry it ("Next exposed
 * directly"), so the browser's header is the limiter's key: one address per context is
 * one quota per context, while the limiter still runs just like the real thing. The address is random in the range reserved
 * for documentation 2001:db8::/32, never a real machine.
 *
 * Three places read this header, the same way (lib/client-ip.ts): the OAuth limiter, the admin password
 * sign-in limiter (10 attempts per 10 minutes, a successful sign-in clears the counter — each `adminPage` is
 * one correct attempt, far from the threshold), and the views route (blocked by stubViewBeacon; the views spec goes the real way
 * with 30 beacons per minute per address). Overrides any other `extraHTTPHeaders` of the context: the E2E suite
 * uses none.
 */
export async function ownClientAddress(context: BrowserContext): Promise<void> {
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': randomClientAddress() })
  withOwnAddress.add(context)
}

/**
 * A random address in 2001:db8::/32 (the range reserved for documentation). Also used for the API client of
 * tests (`playwright.request.newContext`) going through Next's OAuth route: without it, every such client
 * shares one quota at 127.0.0.1 and a few runs in a row hit the ceiling.
 */
export function randomClientAddress(): string {
  const groups = randomBytes(12).toString('hex').match(/.{4}/g) ?? []
  return `2001:db8:${groups.join(':')}`
}

/** Whether the context already has its own address: loginWithGitHub gives one to a hand-made context that has none. */
export function hasOwnClientAddress(context: BrowserContext): boolean {
  return withOwnAddress.has(context)
}

/**
 * The whole set for one context: view beacon, real GitHub and avatar, its own client address, the language of the run. The `context`
 * fixture (fixtures.ts) and newUserContext (github.ts) call it; a spec that creates its own context (a second
 * anonymous reader, for example) should call it too.
 */
export async function prepareContext(context: BrowserContext): Promise<void> {
  await stubViewBeacon(context)
  await stubGithub(context)
  await ownClientAddress(context)
  await applyLocale(context)
}
