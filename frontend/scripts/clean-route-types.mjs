// `next typegen` rewrites the generated route types it still owns, but it does not
// remove ones it has stopped writing. Verified: with `typedRoutes` deleted from
// next.config.ts, a `.next/types/link.d.ts` left over from when the option was on
// survives typegen and keeps `tsc` reporting three route errors for a configuration
// that is no longer in effect. Only clearing the directory cleared them.
//
// Scope, so nobody widens this on a guess: `routes.d.ts` does NOT go stale — delete
// a route and typegen correctly rewrites `AppRoutes` without it. The problem is
// specifically files typegen stops writing. Also verified, and useful to know:
// typegen alone registers a newly added route, so `PageProps<'/posts/[slug]'>`
// typechecks without a full build.
import { rmSync } from 'node:fs'

for (const dir of ['.next/types', '.next/dev/types']) {
  rmSync(dir, { recursive: true, force: true })
}
