'use client'

import { useEffect } from 'react'
import { ErrorContent } from '@/components/site/ErrorContent'

/**
 * The root error boundary. An error of a public page goes to app/(site)/error.tsx, inside the
 * group frame; this file also catches what that boundary cannot reach — errors of
 * app/(site)/layout.tsx itself (header, footer), and routes outside the group with no boundary of their own
 * (/admin/login). Same wording as the group error page: components/site/ErrorContent.tsx.
 *
 * Deliberately has no header or footer, unlike not-found.tsx which renders both.
 *
 * An error boundary must be a client component — Next requires it — and a client component
 * cannot render a server component as a child. Footer is a server component on purpose (it
 * reads the year without risking a hydration mismatch at midnight), so it cannot appear here.
 * Importing Header would work, since that one is already a client component, but a half-chrome
 * page is worse than none: it would look like the site with a broken middle rather than like a
 * degraded state. And the most likely reason to be HERE rather than in the group's boundary is
 * that the chrome itself failed.
 *
 * So this page carries its own exits instead, and keeps `id="main-content"` so the landmark
 * exists even without a skip link pointing at it: the layout that owns `<main>` is the one this
 * boundary replaced.
 *
 * `retry`, not `reset`: Next 16.3 made it stable and recommended — it re-fetches before
 * re-rendering (see app/(site)/error.tsx).
 */
export default function RootError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error('Site layout failed to render', error)
  }, [error])

  return (
    <main id="main-content" className="flex-1">
      <ErrorContent digest={error.digest} retry={retry} />
    </main>
  )
}
