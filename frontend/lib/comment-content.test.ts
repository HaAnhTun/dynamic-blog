// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  COMMENT_MAX_LENGTH,
  COMMENT_MIN_LENGTH,
  INVISIBLE_CODE_POINTS,
  checkCommentContent,
  cleanUserText,
  codePointCount,
} from './comment-content'

/*
 * Vectors cross-checked against UserText.clean and CommentContent.normalize in the backend.
 * Invisible characters are built with String.fromCodePoint, not written straight into the source: an invisible character
 * in a test file is something nobody can read out during review.
 */
const cp = (...points: number[]) => String.fromCodePoint(...points)

const NUL = cp(0x0)
const BELL = cp(0x7)
const DEL = cp(0x7f)
const NEL = cp(0x85) // C1
const NBSP = cp(0xa0)
const SOFT_HYPHEN = cp(0xad)
const ARABIC_LETTER_MARK = cp(0x061c)
const ZWSP = cp(0x200b)
const ZWNJ = cp(0x200c)
const ZWJ = cp(0x200d)
const LRM = cp(0x200e)
const RLO = cp(0x202e)
const WORD_JOINER = cp(0x2060)
const BOM = cp(0xfeff)
const IDEOGRAPHIC_SPACE = cp(0x3000)
const LINE_SEPARATOR = cp(0x2028)
const FIGURE_SPACE = cp(0x2007)
const NARROW_NBSP = cp(0x202f)

describe('cleanUserText: mirror of UserText.clean', () => {
  it('turns \\r\\n and \\r into \\n', () => {
    expect(cleanUserText('a\r\nb\rc')).toBe('a\nb\nc')
  })

  it('removes C0 and C1 control characters (including NUL, which Postgres rejects), keeps \\n and \\t', () => {
    expect(cleanUserText(`a${NUL}b${BELL}c${DEL}d${NEL}e`)).toBe('abcde')
    expect(cleanUserText('a\tb\nc')).toBe('a\tb\nc')
  })

  it('removes invisible and directional characters, keeps ZWJ and ZWNJ', () => {
    expect(cleanUserText(`a${ZWSP}b${LRM}c${RLO}d${WORD_JOINER}e${BOM}f${SOFT_HYPHEN}g${ARABIC_LETTER_MARK}h`)).toBe('abcdefgh')
    // ZWJ joins family emoji; ZWNJ is needed for some scripts.
    const family = `${cp(0x1f468)}${ZWJ}${cp(0x1f469)}${ZWJ}${cp(0x1f467)}`
    expect(cleanUserText(family)).toBe(family)
    expect(cleanUserText(`a${ZWNJ}b`)).toBe(`a${ZWNJ}b`)
  })

  it("the set of invisible characters is exactly the backend's", () => {
    const expected = [0x00ad, 0x061c, 0x200b, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e].concat([
      0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff,
    ])
    expect([...INVISIBLE_CODE_POINTS].sort((a, b) => a - b)).toEqual(expected.sort((a, b) => a - b))
  })

  it('strips per Java Character.isWhitespace: removes whitespace at both ends, keeps NBSP', () => {
    expect(cleanUserText(`  \t\n${IDEOGRAPHIC_SPACE}${LINE_SEPARATOR} hello there \n\t `)).toBe('hello there')
    // Java does not treat NBSP as whitespace (unlike JS String.prototype.trim).
    expect(cleanUserText(`${NBSP}ab${NBSP}`)).toBe(`${NBSP}ab${NBSP}`)
  })

  it('keeps inner indentation (pasted code), only strips both ends of the whole block', () => {
    expect(cleanUserText('open:\n    if (x) {\n        y()\n    }')).toBe('open:\n    if (x) {\n        y()\n    }')
  })

  it('collapses 3 or more blank lines into 2', () => {
    expect(cleanUserText('a\n\n\n\n\nb')).toBe('a\n\nb')
    expect(cleanUserText('a\n\nb')).toBe('a\n\nb')
    // \r\n is converted first, so three \r\n are collapsed too.
    expect(cleanUserText('a\r\n\r\n\r\nb')).toBe('a\n\nb')
  })
})

/*
 * Exactly the vectors of backend/src/test/java/com/blog/common/text/UserTextTest.java (the `clean` part),
 * copied over: change one side and forget the other and one of the two test suites goes red.
 */
describe('cleanUserText: vectors of the backend UserTextTest', () => {
  const INVISIBLE = [
    0x00ad, 0x061c, 0x200b, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064,
    0x2066, 0x2067, 0x2068, 0x2069, 0xfeff,
  ]

  it('CRLF and CR both become LF', () => {
    expect(cleanUserText('one\r\ntwo\rthree\r\n\rfour')).toBe('one\ntwo\nthree\n\nfour')
  })

  it('C0 and C1 control characters are removed including NUL, while newline and tab are kept', () => {
    const raw = `a${cp(0x00)}b${cp(0x07)}c${cp(0x1b)}d${cp(0x0b)}e${cp(0x0c)}f` + `${cp(0x7f)}g${cp(0x85)}h${cp(0x9f)}i\tj\nk`
    expect(cleanUserText(raw)).toBe('abcdefghi\tj\nk')
  })

  it('invisible characters and text direction controls are removed', () => {
    for (const point of INVISIBLE) {
      expect(cleanUserText(`a${cp(point)}b`), `U+${point.toString(16)}`).toBe('ab')
    }
    expect(cleanUserText(`see image${cp(0x202e)}gpj.exe`)).toBe('see imagegpj.exe')
  })

  it('every Unicode Bidi_Control character, including U+061C', () => {
    // Bidi_Control = U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069: missing one leaves
    // a way to reverse text direction slipping through.
    const bidiControl = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]
    for (const point of bidiControl) expect(INVISIBLE_CODE_POINTS.has(point), `U+${point.toString(16)}`).toBe(true)
  })

  it('ZWJ and ZWNJ are kept', () => {
    const family = cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467)
    expect(cleanUserText(family)).toBe(family)
    expect(cleanUserText(`a${cp(0x200c)}b`)).toBe(`a${cp(0x200c)}b`)
  })

  it('trims whitespace at both ends, including what is exposed after removing invisible characters', () => {
    expect(cleanUserText(`${cp(0xfeff)}  \n some content \t\n${cp(0x200b)}`)).toBe('some content')
    expect(cleanUserText(cp(0x200b, 0x200b))).toBe('')
  })

  it('three or more consecutive newlines collapse to two', () => {
    expect(cleanUserText('a\n\n\n\n\nb\n\nc\n\n\nd')).toBe('a\n\nb\n\nc\n\nd')
    expect(cleanUserText(`a\n${cp(0x200b)}\n\nb`)).toBe('a\n\nb')
  })

  it('indentation and inner whitespace are kept unchanged', () => {
    const code = 'example:\n    if (x) {\n        y();\n    }\n\n  all  done'
    expect(cleanUserText(code)).toBe(code)
  })

  it('characters outside the BMP and HTML are kept verbatim', () => {
    const raw = `${cp(0x1f600)} <script>alert(1)</script> <img src=x onerror=alert(1)> ${cp(0x1d11e)}`
    expect(cleanUserText(raw)).toBe(raw)
  })
})

describe('checkCommentContent: mirror of CommentContent.normalize', () => {
  it('counts code points, not UTF-16 units', () => {
    expect(codePointCount(`${cp(0x1f600)}${cp(0x1f600)}`)).toBe(2)
    expect(`${cp(0x1f600)}${cp(0x1f600)}`.length).toBe(4)
  })

  it('2 to 2000 code points after cleaning', () => {
    expect(COMMENT_MIN_LENGTH).toBe(2)
    expect(COMMENT_MAX_LENGTH).toBe(2000)
    expect(checkCommentContent('a').valid).toBe(false)
    expect(checkCommentContent('ab').valid).toBe(true)
    expect(checkCommentContent('a'.repeat(2000)).valid).toBe(true)
    expect(checkCommentContent('a'.repeat(2001)).valid).toBe(false)
    // 2000 emoji are 4000 UTF-16 units but exactly 2000 characters.
    expect(checkCommentContent(cp(0x1f600).repeat(2000)).valid).toBe(true)
  })

  it('measures the length AFTER cleaning', () => {
    const result = checkCommentContent(`  a${ZWSP}${ZWSP}${ZWSP}  `)
    expect(result).toEqual({ text: 'a', length: 1, valid: false })
    // Whitespace at both ends is not counted, so 2000 characters plus whitespace are still valid.
    expect(checkCommentContent(`   ${'a'.repeat(2000)}   `).length).toBe(2000)
  })

  it('needs at least one visible character: only ZWJ/ZWNJ or whitespace is invalid', () => {
    expect(checkCommentContent(`${ZWJ}${ZWJ}${ZWNJ}`).valid).toBe(false)
    expect(checkCommentContent(`${ZWJ}${ZWSP}${ZWJ}`).valid).toBe(false)
    expect(checkCommentContent('\n\n\t').valid).toBe(false)
    expect(checkCommentContent(`a${ZWJ}`).valid).toBe(true)
  })

  it('non-breaking spaces (U+00A0, U+2007, U+202F) are not visible characters: Character.isSpaceChar', () => {
    // Java strip() (Character.isWhitespace) leaves them alone, so the string is still length 2: it is the
    // "has a visible character" rule that blocks it, like CommentContentTest in the backend.
    expect(checkCommentContent(`${NBSP}${NBSP}`)).toEqual({ text: `${NBSP}${NBSP}`, length: 2, valid: false })
    expect(checkCommentContent(`${FIGURE_SPACE}${NARROW_NBSP}`).valid).toBe(false)
    expect(checkCommentContent(`${NBSP} ${NARROW_NBSP}\n${ZWJ}`).valid).toBe(false)
  })

  it('any Unicode whitespace (Zs, Zl, Zp) standing alone is an empty comment', () => {
    const spaces = [0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009].concat([
      0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
    ])
    for (const point of spaces) {
      expect(checkCommentContent(cp(point, point, point)).valid, `U+${point.toString(16)}`).toBe(false)
    }
  })

  it('NBSP in the middle or at the start of real text is kept and valid', () => {
    expect(checkCommentContent(`a${NBSP}b`)).toEqual({ text: `a${NBSP}b`, length: 3, valid: true })
    expect(checkCommentContent(`${NBSP}ok`)).toEqual({ text: `${NBSP}ok`, length: 3, valid: true })
  })

  it('only Arabic letter marks (U+061C) is empty: removed when cleaning', () => {
    expect(checkCommentContent(cp(0x061c, 0x061c, 0x061c))).toEqual({ text: '', length: 0, valid: false })
    expect(checkCommentContent(`a${ARABIC_LETTER_MARK}b`).text).toBe('ab')
  })

  it('HTML and Markdown are just text: nothing is removed', () => {
    const payload = '<img src=x onerror=alert(1)> **bold**'
    expect(checkCommentContent(payload).text).toBe(payload)
  })
})
