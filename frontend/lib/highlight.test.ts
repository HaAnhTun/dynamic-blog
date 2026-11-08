import { describe, expect, it } from 'vitest'
import { highlightSegments, matchesQuery, type HighlightSegment } from './highlight'
import { VI_HL } from '@/test/fixtures/vi/highlight'

/** Only the highlighted parts, in order: enough to read an assert without counting segments. */
const marked = (segments: HighlightSegment[]) => segments.filter((s) => s.match).map((s) => s.text)

/** Joined back it must give exactly the original string, code unit by code unit: highlighting must not add, remove or change any character. */
const joined = (segments: HighlightSegment[]) => segments.map((s) => s.text).join('')

describe('highlightSegments', () => {
  it('matches without diacritics and case-insensitively: a query without diacritics highlights the same word written with them', () => {
    const segments = highlightSegments(VI_HL.learnJava, 'hoc')

    expect(segments).toEqual([
      { text: VI_HL.hocCap, match: true },
      { text: VI_HL.javaTail, match: false },
    ])
  })

  it('the d-with-stroke letter is a letter of its own, not d with a mark, so it must be folded by hand: "duong" highlights the word with a capital U+0110 and with a lowercase U+0111 (d with stroke)', () => {
    // NFD cannot split the d-with-stroke letter (U+0111) into d + a mark — like lib/slug.ts and Postgres unaccent, it
    // has to be mapped separately. Without that step "duong" would match nothing here.
    expect(marked(highlightSegments(VI_HL.roadText, 'duong'))).toEqual([VI_HL.roadCap, VI_HL.roadLow])
  })

  it('a query with diacritics still matches the same word in another case or with other diacritics', () => {
    expect(marked(highlightSegments(VI_HL.queueText, VI_HL.queueQuery))).toEqual([
      VI_HL.queueUpperHang,
      VI_HL.queueUpperDoi,
      VI_HL.queueLowHang,
      VI_HL.queueLowDoi,
    ])
  })

  it('NFD string: the highlighted part includes the combining mark of the last letter, joined back it is still the original string', () => {
    // A decomposed (NFD) Vietnamese word is h, o, U+0323, c: the mark sits INSIDE the matched word. Another word is the d-with-stroke capital, a, U+0323, U+0306, t.
    const text = VI_HL.lessonDat.normalize('NFD')
    const segments = highlightSegments(text, 'hoc dat')

    expect(joined(segments)).toBe(text)
    expect(marked(segments)).toEqual([VI_HL.hoc.normalize('NFD'), VI_HL.dat.normalize('NFD')])
    // No combining mark is left outside the <mark> at the start of the next segment: it would show as an orphan mark.
    for (const segment of segments.filter((s) => !s.match)) {
      expect(/^\p{M}/u.test(segment.text), JSON.stringify(segment.text)).toBe(false)
    }
  })

  it('the last letter of the highlighted region carries a combining mark (in the middle or at the end of the string): the mark goes with the highlight', () => {
    // A decomposed word is h, o, U+0323: the last letter of the matched region is "o", the mark sits AFTER it. Stopping the highlight at "o" makes
    // the dot-below fall into the next segment and show as an orphan mark outside the <mark>.
    const middle = VI_HL.hoDocText.normalize('NFD')
    const inMiddle = highlightSegments(middle, 'ho')
    expect(marked(inMiddle)).toEqual([VI_HL.hoCap.normalize('NFD')])
    expect(inMiddle[1]?.text).toBe(VI_HL.docTail.normalize('NFD'))
    expect(joined(inMiddle)).toBe(middle)

    const end = VI_HL.docThem.normalize('NFD')
    const atEnd = highlightSegments(end, 'ho')
    expect(marked(atEnd)).toEqual([VI_HL.ho.normalize('NFD')])
    expect(joined(atEnd)).toBe(end)
  })

  it('an NFD query matches NFC text, and vice versa', () => {
    expect(marked(highlightSegments(VI_HL.lesson, VI_HL.hoc.normalize('NFD')))).toEqual([VI_HL.hoc])
    expect(marked(highlightSegments(VI_HL.lesson.normalize('NFD'), VI_HL.hoc))).toEqual([VI_HL.hoc.normalize('NFD')])
  })

  it('matches whole words only, like Postgres: no highlighting part of a word', () => {
    // plainto_tsquery compares whole words: "hoc" does not find "hocthuat", "queue" does not find
    // "queues". Highlighting half a word tells the reader something the search result does not say.
    expect(marked(highlightSegments(VI_HL.hocthuat, 'hoc queue'))).toEqual([])
    expect(marked(highlightSegments(VI_HL.studentsText, 'hoc'))).toEqual([VI_HL.hocCap, VI_HL.hoc])
    expect(marked(highlightSegments(VI_HL.hoHoc, 'ho'))).toEqual([VI_HL.hoCap])
    // A failed match (in the middle of a word) does not block a correct match right after it.
    expect(marked(highlightSegments('aab ab', 'ab'))).toEqual(['ab'])
  })

  it('punctuation and hyphens are word boundaries, like the Postgres tokenizer', () => {
    const segments = highlightSegments(VI_HL.commaText, 'hoc')

    expect(marked(segments)).toEqual([VI_HL.hoc, VI_HL.hoc, VI_HL.hoc])
    expect(joined(segments)).toBe(VI_HL.commaText)
  })

  it('several keywords: highlights every word, in sentence order, not query order', () => {
    const segments = highlightSegments(VI_HL.hangDoiSqs, 'queue aws hang')

    expect(segments).toEqual([
      { text: VI_HL.hangCap, match: true },
      { text: VI_HL.doiTail, match: false },
      { text: 'AWS', match: true },
      { text: VI_HL.khiNao, match: false },
      { text: 'queue', match: true },
    ])
  })

  it('a keyword repeated in the query does not highlight twice', () => {
    expect(highlightSegments('queue queue', 'queue QUEUE queue')).toEqual([
      { text: 'queue', match: true },
      { text: ' ', match: false },
      { text: 'queue', match: true },
    ])
  })

  it.each([['c++'], ['('], ['['], ['$'], ['\\'], ['.*'], ['a.*b'], ['(?<x>'], ['[^]'], ['\\b'], ['|'], ['^$']])(
    'regex special characters in query %j: does not throw, does not match broadly',
    (query) => {
      // No RegExp is built from the query: a `new RegExp(query)` throws SyntaxError with "(" or
      // "[" (a 500 page), and ".*" would highlight the whole sentence.
      const text = VI_HL.cppText
      let segments: HighlightSegment[] = []
      expect(() => {
        segments = highlightSegments(text, query)
      }).not.toThrow()
      expect(joined(segments)).toBe(text)
      // Only letters and digits are keywords: "c++" is the word "c", as plainto_tsquery reads it.
      for (const part of marked(segments)) expect(part).toMatch(/^[\p{L}\p{N}]+$/u)
    },
  )

  it('"c++" is the keyword "c": highlights a standalone C, not the c inside other words', () => {
    expect(highlightSegments(VI_HL.cppText2, 'c++')).toEqual([
      { text: VI_HL.viet, match: false },
      { text: 'C', match: true },
      { text: VI_HL.cppTail, match: false },
    ])
  })

  it('an empty query, only whitespace or only punctuation: one unhighlighted segment', () => {
    for (const query of ['', '   ', '!@#$%^&*()', '—']) {
      expect(highlightSegments(VI_HL.lesson, query), JSON.stringify(query)).toEqual([{ text: VI_HL.lesson, match: false }])
    }
  })

  it('empty string: no segment', () => {
    expect(highlightSegments('', 'hoc')).toEqual([])
  })

  it('a digit is part of a word: "v6" highlights "V6", not "V60"', () => {
    expect(marked(highlightSegments(VI_HL.v6Text, 'v6'))).toEqual(['V6'])
  })

  it('a character outside the BMP (surrogate pair) does not shift positions', () => {
    const text = VI_HL.rocketText
    const segments = highlightSegments(text, 'hoc')

    expect(marked(segments)).toEqual([VI_HL.hocCap, VI_HL.hoc])
    expect(joined(segments)).toBe(text)
  })

  it('keeps the original string verbatim including HTML: highlighting is data for React, not markup', () => {
    // A title containing "<img onerror>" must come out as exactly that text in a segment; React escapes it when rendering.
    const text = VI_HL.imgText
    const segments = highlightSegments(text, 'hoc img')

    expect(joined(segments)).toBe(text)
    expect(marked(segments)).toEqual(['img', VI_HL.hoc])
  })
})

describe('prefix matching (quick search palette)', () => {
  it('"spri" highlights the typed part of "Spring", only at the start of a word; by default it still matches the whole word', () => {
    expect(marked(highlightSegments(VI_HL.springText, 'spri', { prefix: true }))).toEqual(['Spri'])
    expect(marked(highlightSegments('Spring Boot', 'spri'))).toEqual([])
  })

  it('no diacritics, d-with-stroke and NFD strings behave like whole-word matching', () => {
    const segments = highlightSegments(VI_HL.duongHoc.normalize('NFD'), 'duo ho', { prefix: true })
    expect(joined(segments)).toBe(VI_HL.duongHoc.normalize('NFD'))
    expect(marked(segments).map((t) => t.normalize('NFC'))).toEqual([VI_HL.duoPrefix, VI_HL.ho])
  })

  it('two overlapping keywords ("sp", "spring") do not highlight twice, joined back it is still the original string', () => {
    const segments = highlightSegments('Spring', 'sp spring', { prefix: true })
    expect(joined(segments)).toBe('Spring')
    expect(marked(segments)).toEqual(['Sp'])
  })

  it('matchesQuery: every word must match (AND), a query with no words does not match', () => {
    expect(matchesQuery(VI_HL.kienTrucHeThong, 'kien he', { prefix: true })).toBe(true)
    expect(matchesQuery(VI_HL.kienTrucHeThong, 'kien mang', { prefix: true })).toBe(false)
    expect(matchesQuery(VI_HL.kienTruc, 'kie')).toBe(false)
    expect(matchesQuery(VI_HL.kienTruc, 'kien')).toBe(true)
    expect(matchesQuery(VI_HL.kienTruc, ' ,. ', { prefix: true })).toBe(false)
  })
})
