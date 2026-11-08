/**
 * Fixed ids of the public pages: the targets of the skip links and the ids the scripts of the page look up with `getElementById`.
 * Plain data, so the server-side Markdown pipeline can read it (a constant imported from a `'use client'` module is a reference, not a
 * value).
 *
 * `renderMarkdown` keeps an article heading off these (`lib/markdown.tsx`, `reserveHeadingIds`): a heading `## search q` would otherwise
 * be given `id="search-q"`, and the "/" shortcut of the header would find the heading instead of opening the palette.
 * `lib/page-ids.test.ts` fails when one of these ids is no longer in the code, so the list cannot drift from the pages.
 */
export const RESERVED_PAGE_IDS: readonly string[] = [
  // The single `<main>` (skip link target, `BackToTop`).
  'main-content',
  // The keyword field of the search page (`Header` "/" shortcut).
  'search-q',
  // The article and its body on a post page (skip links of the left rail).
  'post-article',
  'post-body',
  // The content column of a browse page (skip link of the sidebar).
  'page-content',
]
