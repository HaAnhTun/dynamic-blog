/**
 * Highlights keywords in search results: splits a string into matching and
 * non-matching segments, so the search page wraps the matching segment in `<mark>`.
 *
 * Returns DATA, not HTML. The caller renders each segment as a React text node (inside
 * `<mark>` or not), so a title containing `<img onerror>` is just text — there is no
 * `dangerouslySetInnerHTML` on this path.
 *
 * No RegExp is built from the query. `new RegExp(q)` throws SyntaxError with "(" or "[" (a
 * 500 page for a query the reader typed), and ".*" would highlight the whole sentence; escaping every character is a list
 * that must stay correct forever. Here the query is only split into words, then searched with `indexOf`. The two regexes
 * in the file are constants, never containing the reader's text.
 *
 * ## Matching the way Postgres matches
 *
 * The backend searches with full-text using a diacritic-stripping configuration (`vi_unaccent`): the Postgres tokenizer
 * cuts the string at every character that is not a letter or digit, each word has its diacritics removed and is lowercased, and
 * `plainto_tsquery` compares WHOLE WORDS — "hoc" finds its accented form but not "hocthuat". Highlighting follows exactly
 * that rule: fold both sides the same way, split the query into words, and only highlight a match of a whole word.
 * A highlight that differs from the search rule tells the reader something false about why this post appeared.
 *
 * The folding is that of lib/slug.ts (and of `unaccent`): NFD, drop every combining mark `\p{M}`, d-with-stroke → d (NFD
 * cannot split that letter), lowercase. It differs from lib/slug.ts in one point: it folds EACH character and remembers its original position,
 * because the highlight must sit on the original string, not on the folded copy.
 *
 * Only titles and short descriptions are highlighted. A post may appear because of a match in the post body, where the list
 * shows nothing; then there is nothing to highlight and the row shows as usual. An excerpt around the match needs
 * the backend to return `ts_headline`, which it does not yet.
 */

export type HighlightSegment = { text: string; match: boolean }

/** Characters of a word, per the Postgres tokenizer: letters and digits. A constant, containing nobody's text. */
const WORD = /^[\p{L}\p{N}]$/u

/** Combining marks, which are dropped when folding. */
const MARKS = /\p{M}/gu

/** Folds a code point (or a string): NFD, drop marks, d-with-stroke → d, lowercase. */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(MARKS, '')
    .replace(/[\u0111\u0110]/g, 'd')
    .toLowerCase()
}

/** Whether the code point starting at `index` (including a surrogate pair) is a character of a word. */
function isWordAt(text: string, index: number): boolean {
  const code = text.codePointAt(index)
  return code !== undefined && WORD.test(String.fromCodePoint(code))
}

/** Whether the code point ending right before `index` is a character of a word. */
function isWordBefore(text: string, index: number): boolean {
  if (index <= 0) return false
  const low = text.charCodeAt(index - 1)
  // The second half of a surrogate pair: the code point starts at index - 2.
  const start = low >= 0xdc00 && low <= 0xdfff && index >= 2 ? index - 2 : index - 1
  return isWordAt(text, start)
}

/**
 * The folded words of the query, without repeats: what `plainto_tsquery` would AND together. Fold
 * each code point like the side being highlighted (foldWithOrigin), not the whole string at once:
 * `toLowerCase` on a whole string has context-dependent rules (the Greek final sigma), and two sides
 * folded differently are two sides that never match.
 */
function termsOf(query: string): string[] {
  const terms = new Set<string>()
  let current = ''
  for (const original of query) {
    for (const char of fold(original)) {
      if (WORD.test(char)) {
        current += char
      } else {
        if (current !== '') terms.add(current)
        current = ''
      }
    }
  }
  if (current !== '') terms.add(current)
  return [...terms]
}

/**
 * The folded string, with for each of its code units: the start (`from`) and end (`to`) position in the
 * original string of the code point that produced it. A code point may fold into nothing (the combining mark of an
 * NFD string), one or several code units.
 */
function foldWithOrigin(text: string): { folded: string; from: number[]; to: number[] } {
  let folded = ''
  const from: number[] = []
  const to: number[] = []
  let offset = 0
  for (const char of text) {
    const piece = fold(char)
    for (let i = 0; i < piece.length; i += 1) {
      from.push(offset)
      to.push(offset + char.length)
    }
    folded += piece
    offset += char.length
  }
  return { folded, from, to }
}

/**
 * Match regions on the folded string, [start, end), in order. Whole-word by default (like `plainto_tsquery`);
 * with `prefix` it only needs to start a word — for a filter source that matches as you type (the quick search palette), where
 * "spri" must find "Spring Boot". The highlighted region is then the typed part, not the whole word.
 */
function rangesOf(folded: string, terms: string[], prefix: boolean): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  for (const term of terms) {
    for (let at = folded.indexOf(term); at !== -1; at = folded.indexOf(term, at + 1)) {
      const end = at + term.length
      if (!isWordBefore(folded, at) && (prefix || !isWordAt(folded, end))) ranges.push([at, end])
    }
  }
  return ranges.sort((a, b) => a[0] - b[0])
}

export type MatchOptions = { prefix?: boolean }

/** Every word of `query` matches somewhere in `text` (AND, like `plainto_tsquery`). No words: no match. */
export function matchesQuery(text: string, query: string, options: MatchOptions = {}): boolean {
  const terms = termsOf(query)
  if (terms.length === 0) return false
  const { folded } = foldWithOrigin(text)
  return terms.every((term) => rangesOf(folded, [term], options.prefix ?? false).length > 0)
}

/**
 * `text` split into adjacent segments, in order; joined back it is exactly `text`. A `match` segment is a
 * word matching a whole word of `query` after folding (with `prefix`: the start of a word matching a word of `query`).
 * A query with no words (empty, only punctuation) makes the whole string one non-matching segment; an empty string
 * has no segments.
 */
export function highlightSegments(text: string, query: string, options: MatchOptions = {}): HighlightSegment[] {
  if (text === '') return []

  const terms = termsOf(query)
  if (terms.length === 0) return [{ text, match: false }]

  const { folded, from, to } = foldWithOrigin(text)

  // Prefix matching allows two overlapping keywords ("sp", "spring"): the overlap is dropped at `origStart < cursor`.
  const ranges = rangesOf(folded, terms, options.prefix ?? false)
  if (ranges.length === 0) return [{ text, match: false }]

  const segments: HighlightSegment[] = []
  let cursor = 0
  for (const [start, end] of ranges) {
    const origStart = from[start]!
    // The highlight extends right up to the start of the next folded character: the code points in between are the combining marks (NFD
    // string) of the last letter of the matched region, and leaving them outside `<mark>` makes an orphan mark. At the end of the
    // string, to the end of the string, for the same reason.
    const origEnd = end < folded.length ? Math.max(to[end - 1]!, from[end]!) : text.length
    if (origStart < cursor) continue
    if (origStart > cursor) segments.push({ text: text.slice(cursor, origStart), match: false })
    segments.push({ text: text.slice(origStart, origEnd), match: true })
    cursor = origEnd
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false })
  return segments
}
