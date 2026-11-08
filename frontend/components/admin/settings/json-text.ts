/*
 * Pure helpers of the JSON editor: where a syntax error is, and which line of the pretty-printed text a server problem
 * (`/entries/2/url: must be an https URL`) points at. No React, no browser API.
 */

export type JsonLocation = { line: number; column: number }

/** 1-based line and column of a character offset. */
export function locationOf(text: string, offset: number): JsonLocation {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)))
  const lines = before.split('\n')
  return { line: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 }
}

/**
 * The position of a `JSON.parse` failure, read from the engine's message ("... at position 12 (line 2 column 5)" in V8, a
 * "line N column M" form elsewhere). null when the message carries no position: the editor then shows the error without one.
 */
export function syntaxErrorLocation(text: string, error: unknown): JsonLocation | null {
  const message = error instanceof Error ? error.message : ''
  const lineColumn = /line (\d+) column (\d+)/i.exec(message)
  if (lineColumn) return { line: Number(lineColumn[1]), column: Number(lineColumn[2]) }
  const position = /position (\d+)/i.exec(message)
  if (position) return locationOf(text, Number(position[1]))
  return null
}

/** The line of each JSON pointer in valid JSON text: where the value (or the member name that holds it) starts. */
function indexLines(text: string): Map<string, number> {
  const lines = new Map<string, number>()
  let pos = 0
  let line = 1

  const skipSpace = () => {
    while (pos < text.length && /\s/.test(text[pos]!)) {
      if (text[pos] === '\n') line++
      pos++
    }
  }
  const readString = (): string => {
    const start = pos
    pos++
    while (pos < text.length && text[pos] !== '"') pos += text[pos] === '\\' ? 2 : 1
    pos++
    return JSON.parse(text.slice(start, pos)) as string
  }
  const escape = (segment: string) => segment.replace(/~/g, '~0').replace(/\//g, '~1')

  function value(pointer: string, startLine: number) {
    lines.set(pointer, startLine)
    skipSpace()
    const c = text[pos]
    if (c === '{') {
      pos++
      skipSpace()
      while (pos < text.length && text[pos] !== '}') {
        const memberLine = line
        const name = readString()
        skipSpace()
        pos++ // the colon
        skipSpace()
        value(`${pointer}/${escape(name)}`, memberLine)
        skipSpace()
        if (text[pos] === ',') pos++
        skipSpace()
      }
      pos++
    } else if (c === '[') {
      pos++
      skipSpace()
      let index = 0
      while (pos < text.length && text[pos] !== ']') {
        value(`${pointer}/${index++}`, line)
        skipSpace()
        if (text[pos] === ',') pos++
        skipSpace()
      }
      pos++
    } else if (c === '"') {
      readString()
    } else {
      while (pos < text.length && !/[\s,\]}]/.test(text[pos]!)) pos++
    }
  }

  skipSpace()
  value('', line)
  return lines
}

/**
 * The 1-based line of `pointer` (RFC 6901) in `text`, which must be valid JSON (the editor pretty-prints before it sends, so the
 * line the server reports on is the line shown). A pointer to something that is not there (a missing required member) falls back
 * to its nearest existing ancestor; unreadable text gives line 1.
 */
export function pointerToLine(text: string, pointer: string): number {
  let lines: Map<string, number>
  try {
    lines = indexLines(text)
  } catch {
    return 1
  }
  let current = pointer === '/' ? '' : pointer
  for (;;) {
    const found = lines.get(current)
    if (found !== undefined) return found
    const cut = current.lastIndexOf('/')
    if (cut < 0) return 1
    current = current.slice(0, cut)
  }
}

export type Problem = { pointer: string | null; reason: string }

/**
 * The problems of a `SITE_CONTENT_INVALID` message: up to five `<pointer>: <reason>` joined by `; `. A piece without a leading
 * pointer is kept as a reason with no pointer (the server may also say something about the whole document).
 */
export function parseProblems(message: string): Problem[] {
  return message
    .split('; ')
    .map((piece) => piece.trim())
    .filter((piece) => piece !== '')
    .map((piece) => {
      const match = /^(\/[^\s:]*|):\s*(.*)$/s.exec(piece)
      return match ? { pointer: match[1]!, reason: match[2]! } : { pointer: null, reason: piece }
    })
}
