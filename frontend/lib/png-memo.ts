/**
 * One drawn picture kept in memory, for a card that is the same for every caller until the text on it changes (the site-wide share
 * card). Drawing a 1200x630 PNG with Satori and resvg costs real CPU, and the route that serves it answers every made-up post address
 * with it (docs/SECURITY.md, "Rate limits"). The key is whatever the picture is drawn from: a new key draws again.
 */
let kept: { key: string; png: Uint8Array } | undefined

export async function memoizedPng(key: string, draw: () => Promise<ArrayBuffer>): Promise<Uint8Array> {
  if (kept?.key === key) return kept.png
  const png = new Uint8Array(await draw())
  kept = { key, png }
  return png
}

/** Forgets the picture, so the next call draws it again (for tests; a running server only changes the key). */
export function forgetMemoizedPng(): void {
  kept = undefined
}
