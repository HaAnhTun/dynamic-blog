/**
 * Client-side mirror of the backend's `UserText.clean` and `CommentContent.normalize`:
 * the "N/2000" counter and the send button use exactly the length the backend will measure, so the writer does not
 * click send on a comment that is certain to get a 400.
 *
 * The backend still decides; this is only a copy to warn in advance. Runs in the browser and on the
 * server alike, with no dependencies.
 *
 * Characters are named by code point, not by an escape sequence in the source: an invisible character written
 * straight into the file is something nobody can read out during review.
 */

export const COMMENT_MIN_LENGTH = 2
export const COMMENT_MAX_LENGTH = 2000

/**
 * Invisible and directional characters are removed — exactly the backend's set: U+00AD, U+061C (the Arabic letter mark,
 * a text direction mark like U+200F), U+200B, U+200E, U+200F, U+202A–U+202E, U+2060–U+2064,
 * U+2066–U+2069, U+FEFF; i.e. every Unicode Bidi_Control character. U+200C and U+200D (ZWNJ, ZWJ)
 * are kept: emoji sequences and some scripts need them.
 */
export const INVISIBLE_CODE_POINTS: ReadonlySet<number> = new Set([
  0x00ad, 0x061c, 0x200b, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x2066,
  0x2067, 0x2068, 0x2069, 0xfeff,
])

/** C0 except `\t` and `\n`, DEL, and C1. `\r` has already been converted to `\n` before this step. */
function isStrippedControl(point: number): boolean {
  if (point === 0x09 || point === 0x0a) return false
  return point <= 0x1f || (point >= 0x7f && point <= 0x9f)
}

/**
 * Java's `Character.isWhitespace`, which `String.strip()` uses. It DIFFERS from JS `trim()` in that it does not
 * treat non-breaking spaces (U+00A0, U+2007, U+202F) as whitespace.
 */
function isJavaWhitespace(point: number): boolean {
  return (
    (point >= 0x09 && point <= 0x0d) ||
    (point >= 0x1c && point <= 0x20) ||
    point === 0x1680 ||
    (point >= 0x2000 && point <= 0x2006) ||
    (point >= 0x2008 && point <= 0x200a) ||
    point === 0x2028 ||
    point === 0x2029 ||
    point === 0x205f ||
    point === 0x3000
  )
}

/**
 * Java's `Character.isSpaceChar`: Zs, Zl, Zp. Compared with `isJavaWhitespace` it adds exactly the three non-breaking
 * spaces U+00A0, U+2007, U+202F, which `strip()` leaves alone but which show no glyph.
 */
const SPACE_CHAR = /^\p{Z}$/u

/** `Character.FORMAT` (Cf): ZWJ, ZWNJ, directional characters… */
const FORMAT = /^\p{Cf}$/u

function javaStrip(chars: string[]): string[] {
  let start = 0
  let end = chars.length
  while (start < end && isJavaWhitespace(chars[start]!.codePointAt(0)!)) start++
  while (end > start && isJavaWhitespace(chars[end - 1]!.codePointAt(0)!)) end--
  return chars.slice(start, end)
}

/**
 * In exactly the backend's order: `\r\n`/`\r` → `\n`; remove control characters (except `\n`, `\t`); remove
 * invisible characters; strip both ends; collapse 3 or more consecutive newlines into 2.
 */
export function cleanUserText(raw: string): string {
  const kept: string[] = []
  for (const char of raw.replace(/\r\n?/g, '\n')) {
    const point = char.codePointAt(0)!
    if (isStrippedControl(point) || INVISIBLE_CODE_POINTS.has(point)) continue
    kept.push(char)
  }
  return javaStrip(kept)
    .join('')
    .replace(/\n{3,}/g, '\n\n')
}

/** Number of code points, like Java's `String.codePointCount`: one emoji is 1, not 2. */
export function codePointCount(text: string): number {
  // JS string iteration goes by code point (a surrogate pair is one step), exactly the count needed.
  return Array.from(text).length
}

/**
 * Has at least one code point that is not whitespace (`Character.isWhitespace` or
 * `Character.isSpaceChar`, like `CommentContent.hasVisibleCharacter`) and not Cf: a comment
 * made only of NBSP is an empty comment.
 */
function hasVisibleCharacter(text: string): boolean {
  for (const char of text) {
    if (!isJavaWhitespace(char.codePointAt(0)!) && !SPACE_CHAR.test(char) && !FORMAT.test(char)) return true
  }
  return false
}

export type CommentCheck = {
  /** The cleaned version: exactly the string the backend will store. */
  text: string
  /** Number of code points of `text`, for the "N/2000" counter. */
  length: number
  valid: boolean
}

export function checkCommentContent(raw: string): CommentCheck {
  const text = cleanUserText(raw)
  const length = codePointCount(text)
  const valid = length >= COMMENT_MIN_LENGTH && length <= COMMENT_MAX_LENGTH && hasVisibleCharacter(text)
  return { text, length, valid }
}
