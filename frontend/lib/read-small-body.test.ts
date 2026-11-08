// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { BFF_BODY_LIMIT, payloadTooLarge, readSmallBody } from './read-small-body'
import { A_DOT_BELOW, BODY_GREETING_JSON, X_A_DOT_Y } from '@/test/fixtures/vi/accented-text'

function post(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3000/api/x', { method: 'POST', body, headers })
}

/** A chunked body: no content-length, so only actually reading it tells how long it is. */
function streamed(parts: string[]): Request {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part))
      controller.close()
    },
  })
  return new Request('http://localhost:3000/api/x', { method: 'POST', body: stream, duplex: 'half' } as RequestInit)
}

describe('readSmallBody', () => {
  it('reads a small body as a UTF-8 string', async () => {
    await expect(readSmallBody(post(BODY_GREETING_JSON), 1024)).resolves.toBe(BODY_GREETING_JSON)
  })

  it('no body gives an empty string', async () => {
    await expect(readSmallBody(post(null), 1024)).resolves.toBe('')
  })

  it('exactly at the limit is still accepted', async () => {
    await expect(readSmallBody(post('a'.repeat(16)), 16)).resolves.toBe('a'.repeat(16))
  })

  it('over the limit gives null, even when content-length is not declared', async () => {
    const request = streamed(['a'.repeat(10), 'b'.repeat(10)])
    expect(request.headers.get('content-length')).toBeNull()

    await expect(readSmallBody(request, 16)).resolves.toBeNull()
  })

  it('a declared content-length over the limit gives null without reading the body', async () => {
    const request = post('ab', { 'content-length': '999999' })
    await expect(readSmallBody(request, 16)).resolves.toBeNull()
    expect(request.bodyUsed).toBe(false)
  })

  it('counts bytes, not characters: accented letters cost more bytes', async () => {
    // U+1EA1 (a with dot below) is 3 bytes in UTF-8: 6 letters = 18 bytes > 16.
    await expect(readSmallBody(post(A_DOT_BELOW.repeat(6)), 16)).resolves.toBeNull()
  })

  it('a multi-byte character split across two chunks still decodes correctly', async () => {
    const bytes = new TextEncoder().encode(X_A_DOT_Y)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 2))
        controller.enqueue(bytes.slice(2))
        controller.close()
      },
    })
    const request = new Request('http://localhost:3000/api/x', { method: 'POST', body: stream, duplex: 'half' } as RequestInit)

    await expect(readSmallBody(request, 64)).resolves.toBe(X_A_DOT_Y)
  })
})

describe('payloadTooLarge', () => {
  it('413 with code PAYLOAD_TOO_LARGE, not cached', async () => {
    const res = payloadTooLarge()

    expect(res.status).toBe(413)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } })
  })

  it('the BFF-wide limit is 16 KB', () => {
    expect(BFF_BODY_LIMIT).toBe(16 * 1024)
  })
})
