// eslint-config-next@16.3.7 ships real flat configs; both subpaths export an array
// (verified: core-web-vitals has 4 entries, typescript has 5), so they spread.
// Do NOT reach for FlatCompat from @eslint/eslintrc — it is unnecessary here, and it
// is only present in node_modules as a transitive dependency of eslint itself.
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
import nextTypeScript from 'eslint-config-next/typescript'
import prettier from 'eslint-config-prettier/flat'

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    // Generated output: the build, and what a Playwright run leaves behind (its HTML report holds minified scripts). Prettier skips the same folders.
    ignores: ['.next/**', 'node_modules/**', 'playwright-report/**', 'test-results/**'],
  },
  // `@next/next/no-html-link-for-pages` compares every <a href="/x"> with the page routes. Under `app/[locale]` the home page is the
  // route `/[locale]`, which matches ANY one-segment href (`/admin`, `/random`, a test fixture), so the rule only reports false
  // positives. What it protected, links going through the router instead of a full page load, now also has to carry the locale:
  // the block below enforces that with the locale-aware `Link`, `usePathname`, `useRouter` and `redirect` of `i18n/navigation`.
  {
    rules: { '@next/next/no-html-link-for-pages': 'off' },
  },
  {
    files: ['app/[[]locale]/**/*.{ts,tsx}', 'components/site/**/*.{ts,tsx}', 'components/Pagination.tsx'],
    ignores: ['**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'next/link', message: "Public pages use the locale-aware Link: import { Link } from '@/i18n/navigation'." },
            {
              name: 'next/navigation',
              importNames: ['usePathname', 'useRouter', 'redirect', 'permanentRedirect'],
              message:
                "Public pages use the locale-aware helpers of '@/i18n/navigation' (notFound and useSearchParams stay in next/navigation).",
            },
          ],
        },
      ],
    },
  },
  // Last: turns off the stylistic ESLint rules that would fight Prettier.
  prettier,
]

export default eslintConfig
