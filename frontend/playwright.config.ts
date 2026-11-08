import { defineConfig } from '@playwright/test'
import { BASE_URL, MOCK_GITHUB_PORT, MOCK_GITHUB_URL } from './e2e/support/env'

/**
 * E2E runs against an isolated QA stack that is already running (README, the E2E section): the suite does not
 * start the frontend or backend itself. The `webServer` below only starts the fake GitHub, never the app:
 * a `next start` here would run in this very directory, where `.next` belongs to the `next dev` of the
 * main checkout.
 *
 * Environment variables (every one has a default matching the stack in the README):
 * - `E2E_BASE_URL`       the frontend production build, default http://localhost:3100
 * - `E2E_API_URL`        the backend of THAT SAME stack, default http://localhost:8081 — the tests read
 *                        before/after figures (views, ordering) and clean up temporary data through this API
 * - `E2E_ADMIN_EMAIL`, `E2E_ADMIN_PASSWORD`  the admin account, the dev environment default. Its second factor is the authenticator that
 *                        `node scripts/e2e-bootstrap.mjs` enrolled and wrote to `e2e/.auth/admin-mfa.json` (run it once per stack, before
 *                        the suite; docs/DEVELOPMENT.md, "E2E")
 * - `E2E_PHONE_PHOTO`    path to a real phone photo (portrait JPEG, EXIF Orientation 6, > 4 MB);
 *                        when empty the tests generate a photo with the same traits (e2e/support/photos.ts)
 * - `MOCK_GITHUB_PORT`   the port of the fake GitHub on 127.0.0.1, default 8089; the QA backend must point
 *                        `app.oauth.github.provider.*` at exactly this port
 * - `E2E_SEARCH_ENGINE`  `meilisearch` when the QA backend runs a real Meilisearch (enables the opt-in spec
 *                        `search-meili.spec.ts`, README Meilisearch search section); default postgres
 * - `E2E_LOCALE`        `en` runs the journeys against the English site (`/en` URLs, English copy, English browser
 *                        locale); default `vi`
 * - `E2E_PSEUDO`        `1` enables e2e/pseudo-locale.spec.ts; the stack must be built and started with `PSEUDO_LOCALE=1`
 * The variables after `E2E_BASE_URL` are read in e2e/support/env.ts and e2e/support/i18n.ts.
 */
const baseURL = BASE_URL

/** `E2E_LOCALE=en` runs the journeys against the English site (e2e/support/i18n.ts); anything else is the default Vietnamese site. */
const browserLocale = process.env.E2E_LOCALE === 'en' ? 'en-US' : 'vi-VN'

export default defineConfig({
  testDir: 'e2e',
  // Signs the administrator in once, through the real form and with a code, and keeps the sessions the specs share (e2e/global-setup.ts).
  globalSetup: './e2e/global-setup.ts',
  // Traces, failure screenshots and temporary test files live here; Playwright deletes this directory at the start of each
  // run. It is already in the root .gitignore together with playwright-report/.
  outputDir: 'test-results',
  /**
   * One worker for the whole suite, not just the admin specs. The admin specs write to the database that every other spec
   * reads: uploading a cover image, creating a series, reordering "Best posts", adding gallery photos. Run in parallel,
   * a public spec could read exactly while the data is in a temporary state (the 8th gallery photo, the
   * curated order flipped), and two projects running the same admin flow would trample each other ("the photo just uploaded
   * comes first" is only true when nobody else just uploaded). It is slower by a few tens of seconds, in return the result does not
   * depend on the scheduling order.
   */
  workers: 1,
  fullyParallel: false,
  // No retry: a test that is green only on the second attempt is a bug to read, not noise to swallow.
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  /**
   * The fake GitHub for reader login (e2e/mock-github/server.mjs): plain `node:http`
   * on 127.0.0.1, with no dependency, never in the image. The QA backend points its three provider addresses
   * at it, so E2E goes through the real Spring flow without touching github.com.
   *
   * `reuseExistingServer`: a fake that is already running (started by hand for debugging) is reused; the
   * `mockGithub` fixture checks that its callback matches `baseURL` before any test touches it. The client id, secret
   * and callback must match `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `SITE_URL` of the QA backend.
   */
  webServer: {
    name: 'Mock GitHub',
    command: 'node e2e/mock-github/server.mjs',
    url: `${MOCK_GITHUB_URL}/__e2e/health`,
    reuseExistingServer: true,
    timeout: 15_000,
    env: {
      MOCK_GITHUB_PORT: String(MOCK_GITHUB_PORT),
      MOCK_GITHUB_CLIENT_ID: process.env.MOCK_GITHUB_CLIENT_ID || 'e2emockclient',
      MOCK_GITHUB_CLIENT_SECRET: process.env.MOCK_GITHUB_CLIENT_SECRET || 'e2emocksecret',
      // As the backend builds it from SITE_URL: strip every trailing / then append the callback path.
      MOCK_GITHUB_CALLBACK: `${baseURL.replace(/\/+$/, '')}/api/auth/github/callback`,
    },
  },
  use: {
    baseURL,
    // The Chrome installed on the machine, no download of Playwright's own browser.
    channel: 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // The reader of the site: Vietnamese (English under E2E_LOCALE=en), Vietnam time. Dates on the page are formatted in UTC on the
    // server; running the browser in a timezone other than UTC is how to catch a place that reformats by machine time.
    locale: browserLocale,
    timezoneId: 'Asia/Ho_Chi_Minh',
  },
  projects: [
    {
      name: 'desktop',
      use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile',
      use: {
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
})
