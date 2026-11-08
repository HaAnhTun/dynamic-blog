/**
 * Pseudo-localization for layout checks: every letter gets an accent and the text is about 30 percent longer, so a layout that
 * only fits the shortest language shows up as overflow. ICU arguments (`{name}`, plural branches' structure) and rich-text tags
 * are left alone. Enabled by `PSEUDO_LOCALE=1` (build and start) in `request.ts`; never in production.
 */
const ACCENTED: Record<string, string> = {
  a: '\u00e0',
  b: '\u0180',
  c: '\u00e7',
  d: '\u00f0',
  e: '\u00e9',
  f: '\u0192',
  g: '\u011d',
  h: '\u0125',
  i: '\u00ee',
  j: '\u0135',
  k: '\u0137',
  l: '\u013c',
  m: '\u0271',
  n: '\u00f1',
  o: '\u00f6',
  p: '\u00fe',
  q: '\u024b',
  r: '\u0155',
  s: '\u0161',
  t: '\u0163',
  u: '\u00fc',
  v: '\u1e7d',
  w: '\u0175',
  x: '\u1e8b',
  y: '\u00fd',
  z: '\u017e',
}

function accent(text: string): string {
  let out = ''
  for (const ch of text) {
    const lower = ch.toLowerCase()
    const mapped = ACCENTED[lower]
    out += mapped === undefined ? ch : ch === lower ? mapped : mapped.toUpperCase()
  }
  return out
}

/** Splits a message into literal text and "protected" pieces (`{...}` groups with nesting, `<tag>`), accenting the text only. */
export function pseudoMessage(message: string): string {
  let out = ''
  let text = ''
  let depth = 0
  const flush = () => {
    if (text !== '') out += accent(text)
    text = ''
  }
  for (let i = 0; i < message.length; i += 1) {
    const ch = message[i]
    if (ch === '{') {
      if (depth === 0) flush()
      depth += 1
      out += ch
    } else if (ch === '}' && depth > 0) {
      depth -= 1
      out += ch
    } else if (depth > 0) {
      // Inside an ICU group: keep the argument and keyword names, accent only the branch text after an opening brace.
      out += ch
    } else if (ch === '<') {
      const close = message.indexOf('>', i)
      if (close === -1) text += ch
      else {
        flush()
        out += message.slice(i, close + 1)
        i = close
      }
    } else {
      text += ch
    }
  }
  flush()
  const extra = Math.ceil(message.replace(/[{}<>]/g, '').length * 0.3)
  return extra < 3 ? out : `${out} ${'ẋẋ '.repeat(Math.ceil(extra / 3)).trim()}`
}

export function pseudoMessages<T>(value: T): T {
  if (typeof value === 'string') return pseudoMessage(value) as T
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, pseudoMessages(inner)])) as T
  return value
}
