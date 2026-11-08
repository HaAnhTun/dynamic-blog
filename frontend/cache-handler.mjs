// The incremental cache of the production server: the output of the ISR pages (`revalidate = 300`: posts, writing, tags, ...) and the
// data cache of `fetch(..., { next: { revalidate, tags } })`, kept in memory only.
//
// Why: in the container the application tree (`.next/server`, `.next/static`, `server.js`) is owned by root and the root file system is
// read-only (docker-compose.yml, docs/SECURITY.md "Containers"), so a process that is taken over cannot rewrite the code it runs. The
// built-in cache writes every regenerated page next to the prerendered ones, under `.next/server/app`, and every write fails there
// ("Failed to update prerender cache for ..."): the page is still served, but the warning repeats for every render and every
// revalidation. This class is the built-in one with its disk writes turned off:
//
// - what is in the build is still read from the read-only tree: the pages that never revalidate, and the route handlers' bodies. The
//   pages that revalidate are not there: the build has no backend, so they hold the neutral default site content and Next would serve
//   such a copy once after every start. The build stage of the Dockerfile removes them (scripts/clear-prerendered-pages.mjs), so the
//   first request for each is a render against the backend;
// - what is rendered later is kept in the memory cache of Next (`cacheMaxMemorySize`, 50 MB by default, least recently used first), and a
//   page that was dropped is rendered again on the next request;
// - the tag handling is Next's own (`updateTag` of the admin actions expires `posts`, `post:<slug>`, ... the same way).
//
// The optimized images (`/_next/image`) are not affected: they have their own cache on disk, `.next/cache/images`, a tmpfs in the
// container whose size `images.maximumDiskCacheSize` in next.config.ts is kept under. `experimental.isrFlushToDisk: false` would be the
// flag for this but it also turns that image cache off (image-optimizer.js), so every image request would be encoded again.
//
// While `next build` runs the class behaves like the built-in one (the build may write its own cache).
//
// It extends a class of `next/dist`, which is not a public API: cache-handler.test.ts runs it against the installed Next, so an upgrade
// that moves or changes the class fails a test, not a deployment.
import fileSystemCache from 'next/dist/server/lib/incremental-cache/file-system-cache.js'

// The module is CommonJS with `exports.default`; a default import of it is `module.exports` in Node and may already be the class under a bundler.
/** @type {typeof import('next/dist/server/lib/incremental-cache/file-system-cache').default} */
const FileSystemCache = fileSystemCache.default ?? fileSystemCache

export default class MemoryOnlyIncrementalCache extends FileSystemCache {
  /** @param {ConstructorParameters<typeof FileSystemCache>[0]} context */
  constructor(context) {
    const building = process.env.NEXT_PHASE === 'phase-production-build'
    super(building ? context : { ...context, flushToDisk: false })
  }
}
