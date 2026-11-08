import { describe, expect, it } from 'vitest'
import { locationOf, parseProblems, pointerToLine, syntaxErrorLocation } from './json-text'

const TEXT = JSON.stringify(
  {
    experienceSummary: 'x',
    entries: [
      { kind: 'education', title: 'A', org: null },
      { kind: 'experience', title: 'B', org: 'C' },
    ],
    'a/b': { 'c~d': 1 },
  },
  null,
  2,
)

describe('pointerToLine', () => {
  const lineOf = (needle: string) => TEXT.split('\n').findIndex((line) => line.includes(needle)) + 1

  it('maps a member to the line of its name and an array element to the line it starts on', () => {
    expect(pointerToLine(TEXT, '/experienceSummary')).toBe(lineOf('experienceSummary'))
    expect(pointerToLine(TEXT, '/entries/1/title')).toBe(lineOf('"B"'))
    expect(pointerToLine(TEXT, '/entries/1')).toBe(lineOf('"experience"') - 1)
  })

  it('unescapes ~0 and ~1 of RFC 6901', () => {
    expect(pointerToLine(TEXT, '/a~1b/c~0d')).toBe(lineOf('c~d'))
  })

  it('falls back to the nearest existing ancestor for a member that is missing, and to line 1 for the document', () => {
    expect(pointerToLine(TEXT, '/entries/0/summary')).toBe(lineOf('"education"') - 1)
    expect(pointerToLine(TEXT, '/nope/deeper')).toBe(1)
    expect(pointerToLine(TEXT, '')).toBe(1)
    expect(pointerToLine('{ not json', '/a')).toBe(1)
  })
})

describe('syntaxErrorLocation', () => {
  it('reads the line and column of the engine message, or derives them from a position', () => {
    expect(syntaxErrorLocation('', new SyntaxError('Unexpected token at line 3 column 7'))).toEqual({ line: 3, column: 7 })
    expect(syntaxErrorLocation('{\n  "a": x\n}', new SyntaxError('Unexpected token x at position 9'))).toEqual({
      line: 2,
      column: 8,
    })
    expect(syntaxErrorLocation('{', new SyntaxError('Unexpected end'))).toBeNull()
  })

  it('locates the failure of a real JSON.parse', () => {
    const text = '{\n  "a": 1,\n  "b": ?\n}'
    let caught: unknown
    try {
      JSON.parse(text)
    } catch (error) {
      caught = error
    }
    const where = syntaxErrorLocation(text, caught)
    // Engines differ in wording; when a position is reported it must be on the third line.
    if (where !== null) expect(where.line).toBe(3)
    expect(locationOf(text, text.indexOf('?'))).toEqual({ line: 3, column: 8 })
  })
})

describe('parseProblems', () => {
  it('splits the message into pointer and reason, keeping text without a pointer', () => {
    expect(
      parseProblems('/entries/2/url: must be an https URL; /name: size must be between 1 and 80; the document is wrong'),
    ).toEqual([
      { pointer: '/entries/2/url', reason: 'must be an https URL' },
      { pointer: '/name', reason: 'size must be between 1 and 80' },
      { pointer: null, reason: 'the document is wrong' },
    ])
    expect(parseProblems(': whole document is not an object')).toEqual([
      { pointer: '', reason: 'whole document is not an object' },
    ])
  })
})
