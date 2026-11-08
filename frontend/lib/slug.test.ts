import { describe, expect, it } from 'vitest'
import { slugify, slugifyOrEmpty } from './slug'
import { HA_NOI, SLUG_CASES } from '@/test/fixtures/vi/slug-cases'

const CASES = SLUG_CASES

describe('slugifyOrEmpty', () => {
  it.each(CASES)('%s -> %s', (input, expected) => {
    expect(slugifyOrEmpty(input)).toBe(expected)
  })

  it.each([['???'], ['   '], ['']])('returns empty for %s', (input) => {
    // Empty, not "untitled": the editor reads this as "leave the slug box as it is".
    expect(slugifyOrEmpty(input)).toBe('')
  })

  it('strips the diacritic rather than the letter', () => {
    // Corrected claim. This case guards that the mark strip RUNS at all; it does not,
    // as an earlier comment here asserted, catch the character class being written with
    // literal combining marks instead of escapes. Measured: those two forms are the same
    // character class to the regex engine, and all of these tests pass either way. What
    // the literal form actually costs is legibility — invisible characters in source that
    // no reviewer can see — which is a reason to write the escape, not a correctness bug.
    expect(slugifyOrEmpty(HA_NOI)).toBe('ha-noi')
  })

  it.each([
    ['a\u20D7b', 'ab'],
    ['a\u3099b', 'ab'],
    ['a\u0654b', 'ab'],
    ['a\u1AB0b', 'ab'],
    ['Hindi\u093Ax', 'hindix'],
  ])('deletes a mark outside the combining block, like the backend: %s', (input, expected) => {
    // These five were measured against the compiled SlugGenerator: Java's \p{M} deletes
    // every Unicode mark, so each of these answers `ab` or `hindix` server-side. The
    // frontend used the narrower [\u0300-\u036f] range, which left the mark in place for
    // [^a-z0-9]+ to turn into a hyphen — `a-b` here against `ab` there, i.e. the editor
    // showing a slug the post would never get. None of these arises from Vietnamese or
    // Latin text, which is why no earlier test caught it; they are here so the two
    // implementations stay provably identical rather than identical on the cases someone
    // happened to think of.
    expect(slugifyOrEmpty(input)).toBe(expected)
  })
})

describe('slugify', () => {
  it('substitutes untitled, matching the backend', () => {
    // The backend's SlugGenerator.slugify answers "untitled" rather than "" because a
    // post with an empty slug would live at /posts/, which routes to the post list.
    expect(slugify('???')).toBe('untitled')
  })
})
