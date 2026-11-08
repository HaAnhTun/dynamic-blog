/**
 * Vietnamese results of the search page: the engine matches without diacritics ("hoc duong") and returns the spots to highlight
 * with their diacritics, so the page must render exactly those spots.
 */
export const FIRST_RESULT = {
  title: 'Học cách dùng hàng đợi',
  excerpt: 'Một bài học ngắn về queue.',
  titleParts: ['Học', ' cách dùng hàng đợi'] as const,
  bodyParts: ['…một bài ', 'học', ' trong thân bài…'] as const,
}

export const SECOND_RESULT = {
  title: 'Con đường của một request',
  titleParts: ['Con ', 'đường', ' của một request'] as const,
}

export const HIGHLIGHTED_TEXTS = ['Học', 'học', 'đường']

export const BODY_END_PATTERN = /trong thân bài…$/

/** A word of the removed "check your diacritics" advice: it must not come back, search now ignores diacritics. */
export const DIACRITICS_ADVICE_WORD = /dấu/
