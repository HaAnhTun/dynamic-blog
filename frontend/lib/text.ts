/**
 * Route params arrive percent-encoded (unlike searchParams, which Next decodes),
 * and the same Vietnamese text can arrive composed or decomposed. Both have to be
 * settled before a slug is compared with anything or put into an API URL.
 */
export function normalizeSlug(raw: string): string {
  let decoded = raw
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    // A lone '%' makes decodeURIComponent throw, so treat the value as already decoded.
    //
    // The original comment here claimed this stops a malformed URL becoming a server
    // error. That is false for a route param, and measured: `/posts/%`, `/posts/%zz` and
    // `/posts/%E0%A4%A` all return HTTP 500 from Next before any page code runs — the
    // stub API logs no request at all for them. A page cannot intercept that; only
    // middleware could. What this catch actually protects is every non-HTTP caller —
    // tests, `generateStaticParams`, anything handing in a slug from the database — for
    // which a throw here would be a crash rather than a 500.
  }
  return decoded.normalize('NFC')
}

/** The longest slug a post can have (PostCreateRequest, `@Size(max = 255)`). */
const MAX_SLUG_LENGTH = 255

/**
 * Whether a slug taken from a URL could possibly be a post's slug, so that the page can answer 404 without asking the backend
 * (issue 106). Nothing the backend stores contains a slash, a backslash or a control character (NUL, line breaks, DEL and the C1
 * controls included), is empty or is longer than 255 characters; the backend answers 400 to such a value, which the page would
 * otherwise rethrow as a 500 with a stack trace in the log. Apply it to the value `normalizeSlug` returns. Accented letters are
 * fine: slugs keep Vietnamese text.
 *
 * What this does NOT do: keep every long value out of the prerender cache. Next writes `<slug>.html`, `.rsc`, `.meta` and a
 * `.segments` folder (nine more bytes at most) as file names, which most file systems limit to 255 BYTES, and the limit here is 255
 * characters, so a slug of about 247 to 255 ASCII characters, or a shorter one with accents (three bytes each), still makes Next log an
 * ENAMETOOLONG on the cache write while the page answers as usual. That is left alone on purpose: the backend accepts a slug of 255
 * characters, so refusing at a smaller size would make a real post unreachable to hide a log line, and the line is not a security event.
 */
export function isPlausibleSlug(slug: string): boolean {
  if (slug.length === 0 || slug.length > MAX_SLUG_LENGTH) return false
  for (let i = 0; i < slug.length; i++) {
    const code = slug.charCodeAt(i)
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2f || code === 0x5c) return false
  }
  return true
}
