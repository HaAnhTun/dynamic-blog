/**
 * Reads a request body with a byte limit (split out of app/api/views/route.ts).
 *
 * `request.text()` reads everything into memory however long the body is, and a chunked body has no
 * `content-length` to reject it up front. This function stops as soon as it passes `limit` bytes and returns null.
 */

/** The shared body limit of the BFF routes (a comment is at most 2000 characters, many times under). */
export const BFF_BODY_LIMIT = 16 * 1024

export async function readSmallBody(request: Request, limit: number): Promise<string | null> {
  // `Number(null)` is 0 and `Number('abc')` is NaN, neither of which blocks here — the body will be
  // measured for real right below.
  if (Number(request.headers.get('content-length')) > limit) return null
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

/** `413 {"error":{"code":"PAYLOAD_TOO_LARGE"}}`, not cached. */
export function payloadTooLarge(): Response {
  return Response.json(
    { error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' } },
    { status: 413, headers: { 'cache-control': 'private, no-store' } },
  )
}
