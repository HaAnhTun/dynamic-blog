/**
 * Users of the fake GitHub. One source for both sides: the fake (server.mjs)
 * returns profiles from here, and the test helper (e2e/support/github.ts) picks the login and the name to wait for from here.
 *
 * The GitHub id is the blog's immutable identifier: the same id is the same `users` row, changing the login
 * does not change the account. So each id here is FIXED per login, not generated in order: the QA database
 * lives across many runs, and a login given a different id on a later run would become a second account with the same
 * login (the admin searching by login would see two rows).
 *
 * - Readers per Playwright project (`alice-desktop`, `alice-mobile`, …): the two projects run one
 *   after the other on the same backend, so likes, rate limits and the suspended state of
 *   one project must not leak into the other.
 * - Five special users, shared by every project: an id above 2^31, no public email, an email equal to the
 *   admin email, a name containing the bidi override character U+202E, and the site owner (id = the QA stack's `ADMIN_GITHUB_ID`).
 *
 * The email is only there to make the profile look like real GitHub: the blog does not ask for, read or store emails. The
 * {@link MOCK_EMAIL_DOMAIN} suffix is what the log is scanned for after a run: it must appear in no log.
 *
 * Plain ESM, no dependencies: `node e2e/mock-github/server.mjs` loads this file directly, and
 * Playwright loads it through github.ts. No `import.meta` or top-level await: Playwright compiles
 * this file to CommonJS when a TypeScript test file imports it.
 */

/**
 * @typedef {'alice' | 'bob' | 'carol' | 'mallory' | 'spammer' | 'dave' | 'erin' | 'frank'} ReaderName
 */

/**
 * A fake GitHub account.
 *
 * @typedef {object} MockUser
 * @property {number} id                 the GitHub id: the immutable identifier
 * @property {string} login              the GitHub username
 * @property {string | null} name        the public name (`name` of `GET /user`); null when unset
 * @property {string | null} email       the public email; null when the user hides it
 * @property {string} avatarUrl          the avatar, on avatars.githubusercontent.com like the real thing
 * @property {string | null} displayName the blog name that will be shown: `name` after the backend sanitizes it (or the login
 *                                       when there is no name); null when the blog keeps the CMS-managed name
 *                                       (the site owner is linked to the admin account)
 */

/**
 * The projects of playwright.config.ts, in exactly the order ids were issued. Add a new project at the END:
 * changing positions changes the ids of every reader after it.
 */
export const PROJECTS = /** @type {const} */ (['desktop', 'mobile'])

/**
 * Add a new person at the END, like PROJECTS: the id follows the position. `dave` is used only by the author spec, because that spec
 * promotes and then demotes that person's role. `erin` (promoted to administrator) and `frank` (promoted to author) are used only by the
 * two-step verification spec (e2e/admin/mfa.spec.ts), which sets up and removes an authenticator for them.
 *
 * @type {readonly ReaderName[]}
 */
export const READER_NAMES = ['alice', 'bob', 'carol', 'mallory', 'spammer', 'dave', 'erin', 'frank']

/**
 * The public name of each reader; the blog name appends the project, so an admin searching by name
 * does not meet two people of the same name from two projects.
 *
 * @type {Record<ReaderName, string>}
 */
const READER_DISPLAY = {
  alice: 'Alice Nguyen',
  bob: 'Bob Tran',
  carol: 'Carol Lee',
  mallory: 'Mallory Pham',
  spammer: 'Spammer Dorr',
  dave: 'Dave Voss',
  erin: 'Erin Moss',
  frank: 'Frank Hale',
}

/** The backend QA's `ADMIN_GITHUB_ID`: AdminGithubLink ties the admin account to this id. */
export const OWNER_GITHUB_ID = 7_999_999

/** The email suffix of every fake user (except `adminmail`): the `.invalid` domain never exists for real. */
export const MOCK_EMAIL_DOMAIN = 'e2e-mock.invalid'

/** The admin's email on the QA stack (the default of E2E_ADMIN_EMAIL): `adminmail` carries exactly this email. */
const ADMIN_EMAIL = 'admin@blog.local'

/** The id of the first reader of the first project; each project takes a range of 100 ids. */
const READER_ID_BASE = 7_100_001

/** @param {number} id */
function avatarUrlFor(id) {
  return `https://avatars.githubusercontent.com/u/${id}?v=4`
}

/**
 * The login of a reader in a Playwright project, for example `alice-desktop`.
 *
 * @param {ReaderName} name
 * @param {string} project the project name (`testInfo.project.name`)
 * @returns {string}
 */
export function readerLogin(name, project) {
  if (!READER_NAMES.includes(name)) throw new Error(`The fake GitHub has no reader "${name}"`)
  if (!(/** @type {readonly string[]} */ (PROJECTS).includes(project))) {
    throw new Error(`Project "${project}" is not in e2e/mock-github/users.mjs (PROJECTS): add it at the end of the list`)
  }
  return `${name}-${project}`
}

/**
 * Every fake user, each call a fresh copy (the fake edits its own copy when renaming).
 *
 * @returns {MockUser[]}
 */
export function buildRoster() {
  /** @type {MockUser[]} */
  const users = []
  PROJECTS.forEach((project, projectIndex) => {
    READER_NAMES.forEach((name, readerIndex) => {
      const id = READER_ID_BASE + projectIndex * 100 + readerIndex
      const login = `${name}-${project}`
      const display = `${READER_DISPLAY[name]} (${project})`
      users.push({
        id,
        login,
        name: display,
        email: `${login}@${MOCK_EMAIL_DOMAIN}`,
        avatarUrl: avatarUrlFor(id),
        displayName: display,
      })
    })
  })

  /** @param {number} id @param {string} login @param {string | null} name @param {string | null} email @param {string | null} displayName */
  const special = (id, login, name, email, displayName) => ({
    id,
    login,
    name,
    email,
    avatarUrl: avatarUrlFor(id),
    displayName,
  })
  users.push(
    // Above 2^31: Jackson reads it as a Long, not an Integer (GithubProfile.requireId).
    special(3_000_000_001, 'bigid', 'Big Id', `bigid@${MOCK_EMAIL_DOMAIN}`, 'Big Id'),
    // Hidden public email: GitHub returns `email: null`.
    special(7_300_001, 'noemail', 'No Email', null, 'No Email'),
    // Email equal to the admin's: still a separate USER, never linked to the admin by email.
    special(7_300_002, 'adminmail', 'Admin Email Clash', ADMIN_EMAIL, 'Admin Email Clash'),
    // U+202E (RIGHT-TO-LEFT OVERRIDE) in the middle of the name: the backend drops it (UserText.cleanName), the UI puts the name
    // in <bdi>. Written as an escape: the real character is invisible and reverses this very line of code.
    special(7_300_003, 'bidi', 'Bidi \u202Enimda', `bidi@${MOCK_EMAIL_DOMAIN}`, 'Bidi nimda'),
    // The site owner: the GitHub login hits the admin row (ON CONFLICT github_id), gets an ADMIN token; the displayed name
    // is still the CMS name of the admin account, not the GitHub name.
    special(OWNER_GITHUB_ID, 'owner', 'Blog Owner', `owner@${MOCK_EMAIL_DOMAIN}`, null),
  )
  return users
}

/**
 * The fake user with this login (case-insensitive, like GitHub), from the original list: a rename
 * through `PATCH /__e2e/users/:id` exists only in the running fake.
 *
 * @param {string} login
 * @returns {MockUser | undefined}
 */
export function findUserByLogin(login) {
  const wanted = login.toLowerCase()
  return buildRoster().find((user) => user.login.toLowerCase() === wanted)
}

/**
 * The `GET /user` profile as GitHub returns it (a subset of fields, similar enough for Spring and GithubProfile to read it like
 * the real thing). It includes `email` too: the blog must ignore it.
 *
 * @param {MockUser} user
 */
export function githubProfile(user) {
  return {
    login: user.login,
    id: user.id,
    node_id: `U_e2e${user.id}`,
    avatar_url: user.avatarUrl,
    gravatar_id: '',
    type: 'User',
    site_admin: false,
    name: user.name,
    company: null,
    blog: '',
    location: null,
    email: user.email,
    hireable: null,
    bio: null,
    twitter_username: null,
    public_repos: 0,
    public_gists: 0,
    followers: 0,
    following: 0,
    created_at: '2020-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }
}
