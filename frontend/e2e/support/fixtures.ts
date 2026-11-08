import { test as base, type BrowserContext, type Page } from '@playwright/test'
import { loginAsAdmin } from './admin'
import { Backend } from './backend'
import { API_URL, MOCK_GITHUB_URL } from './env'
import { GITHUB_CALLBACK_PATH, MockGithub, newUserContext, readerLogin, type ReaderName, type UserSession } from './github'
import { prepareContext } from './network'

/**
 * `backend`: the QA stack's API client, one per worker (the admin token is reused between tests).
 * `adminPage`: a page already signed in as admin, both steps (password and code), with the session the global setup made
 * through the real form (loginAsAdmin in admin.ts says how it is kept alive). Not through GitHub.
 * `context` (overridden): blocks the view beacon — see below — and the real GitHub, and gives each test its own
 * client address (e2e/support/network.ts).
 * `mockGithub`: controls the fake GitHub (install failures, rename); the fake is reset after each test that uses it.
 * `reader`: the fake GitHub login of a reader, specific to the running project: `reader('alice')` is
 * `alice-desktop` or `alice-mobile`.
 * `userContext`: opens a new context already signed in with the fake GitHub (newUserContext); closes itself at the end of the test.
 *
 * The second parameter of a fixture is named `provide`, not `use` as in the Playwright docs: the
 * react-hooks rule of eslint-config-next treats any function named `use` as a React hook and reports an error when it is
 * called inside a callback.
 */
type TestFixtures = {
  adminPage: Page
  mockGithub: MockGithub
  reader: (name: ReaderName) => string
  userContext: (login: string, options?: { path?: string }) => Promise<UserSession>
}

type WorkerFixtures = {
  backend: Backend
  /** Internal to `mockGithub`: one client per worker. Tests use `mockGithub`. */
  mockGithubWorker: MockGithub
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  /**
   * Opening a post to check the UI is not a read: if not blocked, each run adds
   * views to a dozen posts on the shared stack (measured: total 1 → 22 after two runs), and enough
   * runs would push posts past the threshold that shows "N views" (>= 10). The beacon gets a fake 204 right in the
   * browser; the views test (article.spec.ts) opens its own context so it still goes the real way.
   *
   * In the same place: the GitHub avatar becomes a fake image, the real github.com is blocked, and each test gets its own client
   * address so GitHub sign-ins do not pile onto one shared quota.
   */
  context: async ({ context }, provide) => {
    await prepareContext(context)
    await provide(context)
  },
  backend: [
    async ({ playwright }, provide) => {
      const http = await playwright.request.newContext({ baseURL: API_URL })
      await provide(new Backend(http))
      await http.dispose()
    },
    { scope: 'worker' },
  ],
  adminPage: async ({ page }, provide) => {
    await loginAsAdmin(page)
    await provide(page)
  },
  mockGithubWorker: [
    async ({ playwright }, provide, workerInfo) => {
      const http = await playwright.request.newContext({ baseURL: MOCK_GITHUB_URL })
      const mock = new MockGithub(http)
      // A reused fake (reuseExistingServer) may have been started for a different site.
      const site = workerInfo.project.use.baseURL
      if (site) await mock.expectCallback(`${site.replace(/\/+$/, '')}${GITHUB_CALLBACK_PATH}`)
      await mock.reset()
      await provide(mock)
      await http.dispose()
    },
    { scope: 'worker' },
  ],
  mockGithub: async ({ mockGithubWorker }, provide) => {
    await provide(mockGithubWorker)
    // An installed failure that was not used up, or a fake user whose login was changed, must not carry over to the next test.
    await mockGithubWorker.reset()
  },
  reader: async ({}, provide, testInfo) => {
    await provide((name) => readerLogin(name, testInfo.project.name))
  },
  userContext: async ({ browser }, provide, testInfo) => {
    const opened: BrowserContext[] = []
    await provide(async (login, options) => {
      const session = await newUserContext(browser, login, testInfo, options)
      opened.push(session.context)
      return session
    })
    for (const context of opened) await context.close()
  },
})

export { expect } from '@playwright/test'
