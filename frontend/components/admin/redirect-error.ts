/**
 * Matches the error `redirect()` throws, by its digest. The digest's shape is fixed —
 * `NEXT_REDIRECT;<push|replace>;<url>;<status>;`, built in
 * node_modules/next/dist/client/components/redirect-error.js — and only the leading code
 * is checked here, because the rest is Next's to change. Next's own `isRedirectError`
 * would be the natural thing to call, but it is only reachable at
 * `next/dist/client/components/redirect-error`, a private path with no public re-export.
 *
 * Exported so the discrimination can be tested directly. It has to be narrow: `redirect`
 * is not the only Next control-flow error carrying a digest — `notFound()` throws
 * `NEXT_HTTP_ERROR_FALLBACK;404` (http-access-fallback.js:41) — and treating one of those
 * as a redirect would swallow it, leaving the author pressing Save and seeing nothing at
 * all happen. Measured: with the prefix test loosened to `startsWith('')`, every one of
 * the other 22 tests in this suite still passed, so nothing else pins it.
 *
 * A module of its own (it used to live in PostEditor.tsx, which still re-exports it): the editor's sub-blocks
 * (history, in-post images) need it too, and importing back from PostEditor would be an import cycle.
 */
export function isRedirectError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'digest' in error &&
    typeof (error as { digest: unknown }).digest === 'string' &&
    (error as { digest: string }).digest.startsWith('NEXT_REDIRECT;')
  )
}
