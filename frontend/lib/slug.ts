/**
 * Mirrors `SlugGenerator.slugifyOrEmpty` in the backend, which is authoritative — it runs
 * on save. This exists only so the author sees the real URL before publishing, since
 * after publishing the URL is permanent. If the two disagree, the editor displays one
 * slug and the post quietly gets another, which is worse than showing nothing.
 *
 * Returns the empty string when nothing survives normalisation. The backend's `slugify`
 * substitutes "untitled" there, and `slugify` below reproduces that, but the editor wants
 * the empty answer: it means "leave the box alone", not "/posts/untitled".
 */
export function slugifyOrEmpty(input: string): string {
  return (
    input
      .normalize('NFD')
      // Strips combining marks — this is what turns e-circumflex-acute into e. `\p{M}` rather than the range
      // [\u0300-\u036f], because `\p{M}` is exactly what the backend's DIACRITICS pattern uses
      // and the two must not diverge: the range covers only the Combining Diacritical Marks
      // block, while `\p{M}` is every Unicode mark. Measured against the compiled
      // SlugGenerator — a mark outside the block, between two alphanumerics, is DELETED by
      // Java and would have become a hyphen here: "a\u20D7b" gives `ab` in Java and `a-b`
      // under the range, so the editor would have shown a slug the post never got.
      // Unreachable from Vietnamese or Latin text, which all decomposes inside the block —
      // but "the two implementations agree" is the only reason this file exists.
      //
      // Needs the `u` flag; `\p{...}` is a syntax error without it.
      .replace(/\p{M}/gu, '')
      // Vietnamese d-with-stroke (U+0111 lower, U+0110 upper; written as escapes so no Vietnamese letter sits in source)
      // is NOT a combining form: it survives NFD as a single code point, so the strip above cannot touch it. Without these
      // two lines a name starting with the capital one slugifies without its first letter ("uong-nguyen-hue") - measured.
      .replace(/\u0111/g, 'd')
      .replace(/\u0110/g, 'D')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  )
}

/** The full backend contract, fallback included, so the pair can be tested together. */
export function slugify(input: string): string {
  const slug = slugifyOrEmpty(input)
  return slug === '' ? 'untitled' : slug
}
