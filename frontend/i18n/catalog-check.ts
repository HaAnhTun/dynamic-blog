/**
 * Checks on the message catalogs (`messages/<locale>.json`): same keys, same ICU arguments, no empty value, no Vietnamese in
 * the English catalog. Pure functions, run by `catalog-check.test.ts` on the real files and on fixtures.
 */
export type Catalog = { [key: string]: string | Catalog }

/** `Area.sub.key` for every leaf. A leaf that is not a string (a number, an array, null) is reported by `checkCatalogs`. */
export function flatten(catalog: Catalog, prefix = ''): Map<string, unknown> {
  const out = new Map<string, unknown>()
  for (const [key, value] of Object.entries(catalog)) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [inner, leaf] of flatten(value as Catalog, path)) out.set(inner, leaf)
    } else {
      out.set(path, value)
    }
  }
  return out
}

const COMPLEX = new Set(['plural', 'select', 'selectordinal'])

/** An ICU quote: an apostrophe that directly precedes a brace opens literal text up to the next apostrophe. */
function startsQuote(text: string, i: number): boolean {
  return text[i] === "'" && (text[i + 1] === '{' || text[i + 1] === '}')
}

/** The index of the `}` that closes the `{` at `open`, ICU quoting respected; -1 when unbalanced. */
function closingBrace(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    if (startsQuote(text, i)) {
      const end = text.indexOf("'", i + 1)
      if (end === -1) return -1
      i = end
    } else if (text[i] === '{') {
      depth += 1
    } else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/** The sub-messages of a plural or select: the text of every top-level `{...}` group. */
function branches(text: string): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '{') continue
    const close = closingBrace(text, i)
    if (close === -1) break
    out.push(text.slice(i + 1, close))
    i = close
  }
  return out
}

function collect(text: string, out: Set<string>): void {
  for (let i = 0; i < text.length; i += 1) {
    if (startsQuote(text, i)) {
      const end = text.indexOf("'", i + 1)
      if (end === -1) return
      i = end
    } else if (text[i] === '{') {
      const close = closingBrace(text, i)
      if (close === -1) {
        out.add('<unbalanced>')
        return
      }
      const inner = text.slice(i + 1, close)
      const firstComma = inner.indexOf(',')
      if (firstComma === -1) {
        out.add(inner.trim())
      } else {
        out.add(inner.slice(0, firstComma).trim())
        const rest = inner.slice(firstComma + 1)
        const secondComma = rest.indexOf(',')
        const kind = (secondComma === -1 ? rest : rest.slice(0, secondComma)).trim()
        if (COMPLEX.has(kind) && secondComma !== -1)
          for (const branch of branches(rest.slice(secondComma + 1))) collect(branch, out)
      }
      i = close
    } else if (text[i] === '<') {
      const tag = /^<\/?([A-Za-z][\w-]*)\s*\/?>/.exec(text.slice(i))
      if (tag) out.add(`<${tag[1]}>`)
    }
  }
}

/** The names a message needs at format time: `{name}`, the argument of a plural or select (and of its branches), and rich-text tags as `<tag>`. */
export function argsOf(message: string): string[] {
  const out = new Set<string>()
  collect(message, out)
  return [...out].sort()
}

/** The Vietnamese-only letters: every tone-marked letter (U+1EA0 to U+1EF9) and the ones with a breve, horn or stroke. */
export function hasVietnameseLetters(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) as number
    if ((code >= 0x1ea0 && code <= 0x1ef9) || [0x102, 0x103, 0x110, 0x111, 0x1a0, 0x1a1, 0x1af, 0x1b0].includes(code)) return true
  }
  return false
}

/** Every problem found, as a sentence naming the key; empty when the catalogs agree. */
export function checkCatalogs(vi: Catalog, en: Catalog): string[] {
  const problems: string[] = []
  const viFlat = flatten(vi)
  const enFlat = flatten(en)
  for (const [name, flat] of [
    ['vi', viFlat],
    ['en', enFlat],
  ] as const) {
    for (const [key, value] of flat) {
      if (typeof value !== 'string') problems.push(`${name}: ${key} is not a string`)
      else if (value.trim() === '') problems.push(`${name}: ${key} is empty`)
      else if (argsOf(value).includes('<unbalanced>')) problems.push(`${name}: ${key} has unbalanced braces`)
    }
  }
  for (const key of viFlat.keys()) if (!enFlat.has(key)) problems.push(`en: missing ${key}`)
  for (const key of enFlat.keys()) if (!viFlat.has(key)) problems.push(`vi: missing ${key}`)
  for (const [key, enValue] of enFlat) {
    const viValue = viFlat.get(key)
    if (typeof enValue !== 'string' || typeof viValue !== 'string') continue
    if (hasVietnameseLetters(enValue)) problems.push(`en: ${key} contains Vietnamese letters`)
    const enArgs = argsOf(enValue).join(',')
    const viArgs = argsOf(viValue).join(',')
    if (enArgs !== viArgs) problems.push(`${key}: ICU arguments differ (en: ${enArgs || 'none'}, vi: ${viArgs || 'none'})`)
  }
  return problems
}
