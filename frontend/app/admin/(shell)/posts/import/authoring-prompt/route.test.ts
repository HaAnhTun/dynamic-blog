// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

const cookieStore = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('next/headers', () => ({ cookies: async () => cookieStore }))

import { authoringPrompt } from '@/lib/blocks/authoring-prompt'
import { msg } from '@/test/render-intl'
import { GET } from './route'

const REQUEST = new Request('http://localhost:3000/admin/posts/import/authoring-prompt')

/** A token as `proxy.ts` and the shell read it: an unsigned payload. The signature is garbage on purpose. */
function claim(role: string | null): { value: string } {
  const payload = Buffer.from(JSON.stringify({ sub: 'u', exp: Math.floor(Date.now() / 1000) + 900, role })).toString('base64url')
  return { value: `e30.${payload}.not-a-signature` }
}

/** What the backend answers to `GET /auth/me` with that token. */
function backendSays(status: number, body: unknown) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(
      async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    )
}

afterEach(() => {
  vi.restoreAllMocks()
  cookieStore.get.mockReset()
})

describe('GET /admin/posts/import/authoring-prompt', () => {
  it.each(['ADMIN', 'AUTHOR'])(
    'serves the generated prompt as a Markdown attachment, never cached, to an %s the backend confirms',
    async (role) => {
      cookieStore.get.mockReturnValue(claim(role))
      const fetchSpy = backendSays(200, { data: { role } })

      const res = await GET(REQUEST)

      expect(new URL(fetchSpy.mock.calls[0]![0] as string).pathname).toBe('/api/v1/auth/me')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
      expect(res.headers.get('content-disposition')).toBe('attachment; filename="article-authoring-prompt.md"')
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(await res.text()).toBe(authoringPrompt())
    },
  )

  it('gives nothing for a forged, unsigned ADMIN claim: the backend refuses the token, so the visitor goes to the sign-in', async () => {
    cookieStore.get.mockReturnValue(claim('ADMIN'))
    backendSays(401, { error: { code: 'UNAUTHENTICATED', message: 'Unauthorized' } })

    const res = await GET(REQUEST)

    expect(res.status).toBe(307)
    expect(new URL(res.headers.get('location') ?? '').pathname).toBe('/admin/login')
    expect(res.headers.get('content-disposition')).toBeNull()
    expect(await res.text()).not.toContain(authoringPrompt().slice(0, 40))
  })

  it('gives nothing without a cookie, and does not ask the backend', async () => {
    cookieStore.get.mockReturnValue(undefined)
    const fetchSpy = backendSays(200, { data: { role: 'ADMIN' } })

    const res = await GET(REQUEST)

    expect(res.status).toBe(307)
    expect(res.headers.get('content-disposition')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each([
    ['a reader the backend knows', 200, { data: { role: 'USER' } }],
    ['a suspended account', 403, { error: { code: 'USER_SUSPENDED', message: 'Suspended' } }],
  ])('gives nothing to %s', async (_label, status, body) => {
    cookieStore.get.mockReturnValue(claim('ADMIN'))
    backendSays(status, body)

    const res = await GET(REQUEST)

    expect(res.status).toBe(403)
    expect(res.headers.get('content-disposition')).toBeNull()
    expect(await res.text()).toBe(msg('Admin.posts.import.route.forbidden'))
  })

  it('cannot confirm the role while the backend is down: a 502 with no internal text, and no prompt', async () => {
    cookieStore.get.mockReturnValue(claim('ADMIN'))
    backendSays(503, { error: { code: 'UNAVAILABLE', message: 'secret internal detail' } })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const res = await GET(REQUEST)

    expect(res.status).toBe(502)
    expect(res.headers.get('content-disposition')).toBeNull()
    const text = await res.text()
    expect(text).toBe(msg('Admin.posts.import.route.unavailable'))
    expect(text).not.toContain('secret internal detail')
  })
})
