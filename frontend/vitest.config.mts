import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const projectRoot = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // tsconfig's `@/*` path mapping is invisible to Vite — nothing reads tsconfig
      // paths without a plugin, and adding one would mean a new dependency. Until
      // Task 5 every `@/` import in the tree was type-only (`@/lib/types`), so
      // esbuild erased it and no test ever needed the specifier resolved. app/page.tsx
      // is the first module whose `@/` imports are runtime values, and without this
      // alias any test importing it dies at load. Verified before adding, with a
      // throwaway test importing `@/lib/api`:
      //   Failed to resolve import "@/lib/api" from "lib/probe-alias.test.ts"
      '@': projectRoot,
      // `server-only` is a build-time marker that Next aliases inside its own
      // bundler; it is not a real package in node_modules. Vite therefore cannot
      // resolve it, and any test importing a module that imports it dies at load
      // with "Failed to resolve import". Pointing it at an empty module keeps the
      // guard real where it matters — the Next build — without making every
      // server-side module untestable.
      'server-only': fileURLToPath(new URL('./test/server-only.ts', import.meta.url)),
    },
  },
  test: {
    // Pinned, not incidental. PostCard formats dates with an explicit
    // `timeZone: 'UTC'`, and the test that guards that option can only detect its
    // removal by comparing UTC against a different local zone. On a UTC host — which
    // is every default CI runner and container — deleting the option changes nothing
    // and the guard passes while guarding nothing. Forcing a non-UTC zone here makes
    // the suite deterministic and the guard real everywhere. Do not use `??=`: an
    // inherited TZ=UTC would win.
    env: { TZ: 'Asia/Ho_Chi_Minh' },
    environment: 'jsdom',
    // e2e/ holds the Playwright tests (*.spec.ts), run separately with `npm run e2e` on the QA stack.
    // The Vitest default include also matches *.spec.ts, so it would run them under jsdom and they would fail.
    // Spread `configDefaults.exclude` first: overriding `exclude` and forgetting the defaults makes
    // Vitest scan node_modules too.
    exclude: [...configDefaults.exclude, 'e2e/**'],
    // Required, not stylistic: React Testing Library only registers its automatic
    // cleanup when a global afterEach exists. Without this, DOM from one test leaks
    // into the next and failures appear in innocent tests.
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    // next-intl imports `next/server` without the `.js` extension; Node's ESM loader rejects that (`next` has no `exports` map),
    // Vite resolves it. Inlining makes Vite, not Node, load the package.
    server: { deps: { inline: ['next-intl'] } },
  },
})
