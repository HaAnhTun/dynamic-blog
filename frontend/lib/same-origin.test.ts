// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { assertSameOriginRequest } from './same-origin'

const ORIGIN = 'http://localhost:3000'

function mutation(method: string, headers: Record<string, string>): Request {
  return new Request(`${ORIGIN}/api/posts/bai-viet/comments`, {
    method,
    headers: { host: 'localhost:3000', ...headers },
    body: method === 'DELETE' ? undefined : '{}',
  })
}

const JSON_SAME_ORIGIN = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: ORIGIN }

describe('assertSameOriginRequest', () => {
  it('same-origin fetch, JSON body: allowed', () => {
    expect(assertSameOriginRequest(mutation('POST', JSON_SAME_ORIGIN))).toBeNull()
    expect(assertSameOriginRequest(mutation('PUT', JSON_SAME_ORIGIN))).toBeNull()
  })

  it.each(['cross-site', 'same-site', 'none'])('Sec-Fetch-Site: %s gives 403', async (site) => {
    const res = assertSameOriginRequest(mutation('POST', { ...JSON_SAME_ORIGIN, 'sec-fetch-site': site }))

    expect(res?.status).toBe(403)
    await expect(res?.json()).resolves.toMatchObject({ error: { code: 'FORBIDDEN' } })
    expect(res?.headers.get('cache-control')).toBe('private, no-store')
  })

  it('an Origin different from the host gives 403, even when the browser does not send Sec-Fetch-Site', () => {
    const res = assertSameOriginRequest(mutation('POST', { 'content-type': 'application/json', origin: 'https://evil.example' }))
    expect(res?.status).toBe(403)
  })

  it('Origin "null" (sandboxed iframe, cross redirect) gives 403', () => {
    const res = assertSameOriginRequest(mutation('POST', { 'content-type': 'application/json', origin: 'null' }))
    expect(res?.status).toBe(403)
  })

  it('with both headers missing (old browser, curl) it relies on SameSite=Lax and the content-type', () => {
    expect(assertSameOriginRequest(mutation('POST', { 'content-type': 'application/json' }))).toBeNull()
  })

  it.each(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x'])(
    'POST with content-type %s gives 415: a form from another site can only send these types',
    async (type) => {
      const res = assertSameOriginRequest(mutation('POST', { ...JSON_SAME_ORIGIN, 'content-type': type }))

      expect(res?.status).toBe(415)
      await expect(res?.json()).resolves.toMatchObject({ error: { code: 'UNSUPPORTED_MEDIA_TYPE' } })
    },
  )

  it('PUT without a content-type gives 415', () => {
    const headers: Record<string, string> = { ...JSON_SAME_ORIGIN, host: 'localhost:3000' }
    delete headers['content-type']
    const request = new Request(`${ORIGIN}/api/posts/bai-viet/like`, { method: 'PUT', headers })
    expect(assertSameOriginRequest(request)?.status).toBe(415)
  })

  it('accepts application/json with a charset, case-insensitive', () => {
    const headers = { ...JSON_SAME_ORIGIN, 'content-type': 'Application/JSON; charset=utf-8' }
    expect(assertSameOriginRequest(mutation('POST', headers))).toBeNull()
  })

  it('DELETE needs no content-type, but must still be same-origin', () => {
    expect(assertSameOriginRequest(mutation('DELETE', { 'sec-fetch-site': 'same-origin' }))).toBeNull()
    expect(assertSameOriginRequest(mutation('DELETE', { 'sec-fetch-site': 'cross-site' }))?.status).toBe(403)
  })

  it('requireJson: false (admin logout, a bare POST) checks only the origin', () => {
    const bare = new Request(`${ORIGIN}/admin/logout`, {
      method: 'POST',
      headers: { host: 'localhost:3000', 'sec-fetch-site': 'same-origin' },
    })
    expect(assertSameOriginRequest(bare, { requireJson: false })).toBeNull()

    const forged = new Request(`${ORIGIN}/admin/logout`, {
      method: 'POST',
      headers: { host: 'localhost:3000', origin: 'https://evil.example' },
    })
    expect(assertSameOriginRequest(forged, { requireJson: false })?.status).toBe(403)
  })
})
