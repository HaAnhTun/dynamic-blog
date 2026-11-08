'use client'

import { useEffect } from 'react'
import { ErrorContent } from '@/components/site/ErrorContent'

/**
 * Error while rendering a public page: the API returns 5xx, the network to the backend drops, a component throws.
 *
 * It lives in the (site) group, so Next renders it INSIDE app/(site)/layout.tsx: the header, `<main
 * id="main-content">` and the footer are still there, and the reader can carry on using the site's navigation bar, like
 * app/(site)/not-found.tsx for the 404 page. That is why there is no `<main>` here. An error in the group layout itself
 * is not caught by this boundary (it sits below that layout): those errors reach app/error.tsx at the root.
 *
 * `retry` rather than `reset`: since Next 16.3, retry refreshes the data from the server and only then re-renders (Next
 * error.md), whereas reset only re-renders the very payload that broke; with a transient API error, only retry has a chance
 * of succeeding. Same choice as app/admin/(shell)/error.tsx.
 */
export default function SiteError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    // In the browser: a trace for whoever opens DevTools. Server errors are already in the Next log, by digest.
    console.error('Site page failed to render', error)
  }, [error])

  return <ErrorContent digest={error.digest} retry={retry} />
}
