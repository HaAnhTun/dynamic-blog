import { join } from 'node:path'

/**
 * Runs once when the Next server starts (https://nextjs.org/docs/app/guides/instrumentation). It does one thing: in production,
 * `lib/runtime-cache.ts` removes the page entries and cached backend answers that an earlier process left on disk, and (without
 * `cache-handler.mjs`, which writes nothing to disk) keeps the page cache under `ROUTE_CACHE_MAX_MB`. Not during `next build` (which also loads this file) and not in development, where nothing is
 * persisted that way.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  if (process.env.NEXT_PHASE === 'phase-production-build') return
  if (process.env.NODE_ENV !== 'production') return
  const { startRuntimeCacheGuard } = await import('@/lib/runtime-cache')
  await startRuntimeCacheGuard(join(process.cwd(), '.next'))
}
