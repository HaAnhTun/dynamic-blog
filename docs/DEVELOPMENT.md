# Development

How to run the project on your machine, run its checks, and run the end-to-end suite. For the rules your change must follow, read
[AGENTS.md](../AGENTS.md) and [CONVENTIONS.md](CONVENTIONS.md); for the design, [ARCHITECTURE.md](ARCHITECTURE.md); for how to
contribute, [CONTRIBUTING.md](../CONTRIBUTING.md).

## Contents

- [Requirements](#requirements)
- [Run locally](#run-locally)
- [Sign in locally](#sign-in-locally)
- [GitHub sign-in on your machine](#github-sign-in-on-your-machine)
- [Testing](#testing)
- [Guards](#guards)
- [Example article packages](#example-article-packages)
- [CI](#ci)
- [E2E (Playwright)](#e2e-playwright)
- [Ports](#ports)

## Requirements

| | Version |
|---|---|
| JDK | 25 (the project targets Java 25) |
| Maven | 3.9.0 or newer (the build refuses an older one); there is no wrapper, use `mvn` from the `PATH`. Maven Central is the only repository the build accepts, and a checksum mismatch fails it ([SECURITY.md](SECURITY.md#supply-chain-what-the-build-trusts)) |
| Node.js | 20.9 or newer (the Dockerfile and CI use 22) |
| Docker | for PostgreSQL and for Testcontainers |
| Python | 3.12 or newer for the tooling in `scripts/` (standard library only) |
| Google Chrome | for the E2E suite only (`channel: 'chrome'`, no browser is downloaded) |

On Windows use Git Bash or PowerShell; the commands below are written for a POSIX shell and PowerShell notes are given where they
differ.

## Run locally

Three terminals. PostgreSQL runs in Docker; the backend and the frontend run from your shell with hot reload. This is **not** the
production Compose file: `backend/docker-compose.yml` starts only PostgreSQL. For the full stack, see [INSTALL.md](INSTALL.md).

```bash
# 1 - database (from backend/)
cd backend && docker compose up -d

# 2 - backend, http://localhost:8080
cd backend && mvn spring-boot:run

# 3 - frontend, http://localhost:3000 (listens on the loopback only; see the note below)
cd frontend && npm ci && npm run dev -- -H localhost
```

> **Port 5432 may be blocked on Windows.** The port ranges Hyper-V reserves often cover it, and the error reads
> `bind: An attempt was made to access a socket in a way forbidden by its access permissions`. Use another port:
>
> ```bash
> cd backend && DB_PORT=55432 docker compose up -d
> cd backend && DB_PORT=55432 mvn spring-boot:run
> ```
>
> In PowerShell set the variable first: `$env:DB_PORT = 55432; docker compose up -d`, then `mvn spring-boot:run` in the same session.
> Spring Boot does not read `.env` files; export the variables into the shell that runs `mvn`.

Notes:

- **Everything listens on loopback only.** The database port is published on `127.0.0.1`, `mvn spring-boot:run` binds the backend to
  `127.0.0.1` (the `dev` profile sets `server.address`; `SERVER_ADDRESS=0.0.0.0` opens it on purpose) and `-H localhost` does the same
  for the Next dev server. Write `-H localhost`, **not** `-H 127.0.0.1`: with a literal loopback address Next's locale middleware answers
  `/` with a redirect to `/` for ever (measured on Next 16: HTTP 307 to the same URL, "too many redirects" in the browser), while
  `localhost` works, listens on the loopback only, and every client of this stack (browsers, curl, Playwright, Node) tries both IPv4 and
  IPv6. A development stack has the database user `blog`/`blog`, the seeded admin password and a committed JWT
  secret, so it must not be reachable from the network: Docker opens a published port with its own firewall rules, which `ufw` does not
  block, so `-p 5432:5432` would put the database on the office or coffee-shop network. `python scripts/docs-as-tests.py --check-loopback
  docs/*.md` (run by the Python tests) fails on a recipe in these docs that forgets it.
- `mvn spring-boot:run` uses the Spring profile `dev` (set by `pom.xml` for the Maven plugin only): Swagger UI at
  `http://localhost:8080/swagger-ui.html` and `/v3/api-docs` are on there, and off everywhere else. `SPRINGDOC_ENABLED` overrides it.
  The `dev` profile is also the explicit opt-in to development defaults (the development `JWT_SECRET` from `application-dev.yml`, the
  seeded admin password, an empty `VIEWS_TOKEN` or `CLIENT_IP_TOKEN`). Any other way of starting the backend (the jar, the Docker image) is
  production and refuses them; a throw-away stack can opt in with `APP_ALLOW_DEV_DEFAULTS=true` (see E2E below).
- **Per-address limits on your machine.** The backend limits the contact form, newsletter, sign-in, refresh, setup and search per
  client address. Without `CLIENT_IP_TOKEN` it counts the socket address, which on your machine is always `127.0.0.1`, so everything you
  try shares one count (the numbers are `app.rate-limit.*`, [CONFIGURATION.md](CONFIGURATION.md#rate-limits)). To try the forwarded
  address, give the backend and the frontend the same random value (`CLIENT_IP_TOKEN=$(openssl rand -hex 32)`); Next then sends the
  address it derives from `X-Forwarded-For`, and the backend believes it only with that value.
- The backend runs Flyway at startup, so an empty database gets its schema by itself.
- The frontend finds the backend at `API_BASE_URL` (default `http://localhost:8080`).
- **Default language.** With nothing set, both the backend (`DEFAULT_LOCALE`) and the frontend (`NEXT_PUBLIC_DEFAULT_LOCALE`) default
  to `vi`, while the Compose file defaults to `en`. Set the same value on both sides when you develop (for example
  `NEXT_PUBLIC_DEFAULT_LOCALE=en npm run dev` and `DEFAULT_LOCALE=en mvn spring-boot:run`). The E2E suite expects the defaults (`vi`).
- Read the Next.js guides in `frontend/node_modules/next/dist/docs/` before writing Next-specific code: this version has breaking
  changes against what most tutorials show.
- Format before you commit: `cd backend && mvn -B -ntp spotless:apply` and `cd frontend && npm run format`.

## Sign in locally

A new database is "unclaimed": there is **no usable credential**. The seeded development password (`admin12345`) is disabled until
the first-run setup completes, so it cannot be used by accident.

1. Start the backend. It writes a setup code to `backend/data/setup-code` (`SETUP_DATA_DIR` defaults to `./data` in the directory
   the backend runs from; git ignores it). The log prints the path, never the code.
2. Open `http://localhost:3000/setup`, enter the code from that file, a display name, an email and a password of at least 12
   characters. `/setup` closes and the file is deleted ([FIRST-RUN.md](FIRST-RUN.md)).
3. Sign in at `http://localhost:3000/admin/login`. The first sign-in of an admin enrols an authenticator app (any TOTP app; keep the
   ten recovery codes). On a `dev` run the enrollment window is always open, so no enrollment code is asked; the backend has a
   development `MFA_ENCRYPTION_KEY` in `application-dev.yml` ([Security](SECURITY.md#two-step-verification-and-recovery)). If you
   lose the authenticator of a development database, reset it with the SQL in [Security](SECURITY.md#when-the-phone-or-the-codes-are-lost)
   or start with a new database.

Shortcuts for a database you can throw away:

- `ADMIN_PASSWORD=<at least 12 characters> mvn spring-boot:run` claims the instance through the environment: no `/setup`; sign in as
  `ADMIN_EMAIL` (default `admin@blog.local`).
- `SETUP_LOCK_DEV_SEED=false` keeps the old behavior of a fresh database: `admin@blog.local` with the development password
  `admin12345`, and `/setup` stays open. The backend logs a warning at every start while that password is in place, and **refuses to
  start when it is not an opted-in dev run (`dev` profile or `APP_ALLOW_DEV_DEFAULTS=true`) or `SITE_URL` is a public address**; on such a
  run the switch is ignored and the development password is locked anyway. This is what the E2E stack uses. Never use it on a reachable machine.
- **Sample content**: as ADMIN, open **Admin > Settings** and load the sample content for a few posts in both languages.

## GitHub sign-in on your machine

Off by default. Without `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` the backend and the site run normally; only the sign-in links
lead to a page that says sign-in is not enabled. Admins always sign in with email and password.

To try the reader flow:

1. Create an **OAuth App** (not a GitHub App) at <https://github.com/settings/developers>. Homepage URL `http://localhost:3000`;
   Authorization callback URL exactly `http://localhost:3000/api/auth/github/callback`. Copy the client secret at once: GitHub shows
   it only once.
2. Start the backend with the id, the secret and `SITE_URL`. With an id and a secret but no `SITE_URL` (and no `GITHUB_REDIRECT_URI`)
   the backend refuses to start.

   ```bash
   # Git Bash
   cd backend && GITHUB_CLIENT_ID=<client id> GITHUB_CLIENT_SECRET=<client secret> \
     SITE_URL=http://localhost:3000 mvn spring-boot:run
   ```

   ```powershell
   # PowerShell
   cd backend
   $env:GITHUB_CLIENT_ID = '<client id>'; $env:GITHUB_CLIENT_SECRET = '<client secret>'
   $env:SITE_URL = 'http://localhost:3000'; mvn spring-boot:run
   ```

3. Open the site at `http://localhost:3000`, **not** `http://127.0.0.1:3000`. Cookies are per host, and a sign-in that starts at
   `127.0.0.1` and returns to `localhost` ends in "The sign-in session expired or is not valid".

No HTTPS is needed locally: GitHub and the backend accept an `http` callback to localhost, and the cookies carry `Secure` only when
`NODE_ENV=production`. Only one sign-in can be in progress per browser, and the dev stack (`:3000`) and the E2E stack (`:3100`) share
cookies because cookies are scoped by host, not port: use a separate browser profile for each. To make a GitHub sign-in land on
the admin account, set `ADMIN_GITHUB_ID` ([CONFIGURATION.md](CONFIGURATION.md)).

## Testing

Run what covers your change before you report the work done; run everything before a pull request. These are the same commands as
in [AGENTS.md](../AGENTS.md).

```bash
# backend - needs Docker running (Testcontainers)
cd backend && mvn -B -ntp clean test
cd backend && mvn -B -ntp clean verify      # tests, Spotless, Checkstyle, architecture tests
cd backend && mvn -B -ntp spotless:apply    # fix the layout

# frontend - run all of them
cd frontend
npm run format:check   # prettier --check (fix with `npm run format`)
npm run lint           # eslint . --max-warnings=0: one warning is a failure
npm run typecheck      # next typegen, then tsc --noEmit
npm test               # vitest
npm run build          # next build, then scripts/verify-css.mjs
```

- **`clean test`, not `test`.** A run without `clean` once read a stale `target/classes` and reported green for code that no longer
  compiled.
- **`npm run build` ends with `scripts/verify-css.mjs`, and it is not decoration.** A Tailwind regression once passed every other
  gate and served a site with no CSS. The script fails the build if the compiled CSS lacks the utilities the pages use.
- **Mermaid must stay a lazy chunk.** After `npx next build --webpack` (the build of the E2E stack) run
  `node scripts/verify-lazy-mermaid.mjs` in `frontend/`: it reads `.next/react-loadable-manifest.json`, takes the chunks of the
  `import('mermaid')` of the diagram block and fails when a prerendered page, a route manifest or the build manifest lists one, that is
  when a page without a diagram would download the library. It is not part of `npm run build` (a Turbopack build lays its manifests out
  differently); `scripts/verify-lazy-mermaid.test.ts` tests the script itself.
- **The frontend build needs no running backend, but it needs internet access** to download the Inter font files
  ([ASSETS.md](ASSETS.md)).
- **Measuring the Markdown parse budget.** `frontend/lib/blocks/parse-budget.ts` prices the shapes that make the Markdown parser, or the
  stages after it, slower than linear, and its prices come from measurements. After an upgrade of `remark`, `micromark`, `remark-directive`
  or `rehype`, run the probe from `frontend/`: `PARSE_PROBE=1 PARSE_PROBE_OUT=probe.txt npx vitest run lib/blocks/parse-budget.probe.test.ts`
  (a quarter of an hour, one core; skipped without the variable; `PARSE_PROBE_SHAPE='links|emphasis'` runs only the shapes whose name matches).
  For each of about 75 shapes it builds the biggest text the budget admits and
  times the real parser, the feed pipeline and the page pipeline on it, the fastest of two runs each. The shapes include constructs spread
  over many short paragraphs (emphasis, links, images, code spans, footnote references, 10 to 50 to a paragraph), which the squared price of
  one paragraph's markers cannot see and the linear price of every marker character has to. Every line must stay near the budget
  (1,500 ms on a loaded laptop, a quiet machine is faster); a line well above it means the price of its counter is too low. The numbers
  depend on the machine, so compare them with the budget, not with each other. Two lessons from the first version of the prices: measure the
  **whole pipeline with `remark-directive`** (a parser run without the plugin and without the stages after it missed text directives, link
  literals and table cells, which cost seconds at a size the estimate called free), and **sweep in fresh processes** (one process that
  parses thousands of texts slowed down tenfold after an hour, and its slow lines were not the shapes' own; a flagged shape is timed again
  alone, the fastest of three runs).
- **Measuring the image allowance.** `/_next/image` fetches `/media/<id>` for itself with a request that has no headers, on the socket of the
  reader's request, and Next writes the address of that socket (the proxy's) into `x-forwarded-for` (`fetchInternalImage` in
  `next/dist/server/image-optimizer.js`). Counted per address, those fetches would share one key and the allowance would be the whole site's, so
  `/media` does not count them (`isOptimizerFetch` in `frontend/lib/read-limit.ts`, told by the missing `Host` header) and `frontend/proxy.ts`
  counts the reader's own `/_next/image` request instead. After an upgrade of Next, check on a production build (`npm run build`, then
  `node .next/standalone/server.js` with `API_BASE_URL` pointing at a stub that answers 200 with a PNG for one known id and 404 for every
  other): 1,250 requests for `/_next/image?url=%2Fmedia%2F<random uuid>.png&w=640&q=75`, each with another last entry of `X-Forwarded-For`,
  must all answer 404 and none 429; a new address must then get 200 for the known picture through `/_next/image` and directly through
  `/media`; and 1,250 requests from one address must answer 1,200 times 404 and then 429, with another new address still served. On Next
  16.4.2 that is 1,250 times 404; 200 and 200; 1,200 times 404 and 50 times 429; 200. Counted in `/media` the way the first version did, the
  same probe answered 429 to every new reader after 1,200 misses from anybody. The same server answers the 61st `/sitemap.xml` request of an
  address with 429 (`frontend/proxy.ts`).
- **Measuring the production page cache.** Pages rendered on demand and the data cache are kept in the in-memory LRU of Next
  (`cacheMaxMemorySize`, 50 MB) by `frontend/cache-handler.mjs`; Next 16.4 without it writes them to
  `.next/server/route-cache/APP_PAGE/<hash>/$/...` (`html`, `rsc`, `meta` and a `segments` folder, about 250 KB for one page), not to
  `.next/server/app`, which holds the pages prerendered by `next build`. After an upgrade of Next, check on a production build
  (`npm run build`, then `npx next start -p 3100` with a backend or a stub that answers 404 for unknown posts): request 24 addresses like
  `/posts/made-up-<n>` and see that `.next/server/route-cache` is not created (the handler works). `ROUTE_CACHE_MAX_MB` has no effect while
  the handler is configured; to measure the prune of `frontend/lib/runtime-cache.ts`, run the same steps with `cacheHandler` removed from
  `next.config.ts` and `ROUTE_CACHE_MAX_MB=2`, see the folder grow by about 250 KB per address and come back under 2 MB within 30
  seconds with a `[cache] route cache over 2 MB: removed N files` line in the log. Then unpublish a post at the backend, restart the
  server, and `GET /posts/<slug>` must answer 404 (`x-nextjs-cache: MISS`), not 200 `STALE`. In the image,
  `CONTAINER_STACK_DOCKER=1 python scripts/test_container_hardening.py` checks that no prerendered page that revalidates is left in
  `.next/standalone` (the Dockerfile removes them after the build) and that the first request for `/bookmarks`, `/newsletter` and
  `/case-studies` after a restart is rendered, not served from the build.
- **Do not run two `vitest` processes in the same directory.** They fight over `node_modules/.vite` and fail in ways that look like
  flaky tests. The tests set `TZ=Asia/Ho_Chi_Minh` themselves.
- **Tests do not hard-code translated text.** Use `msg('Key')` and `renderWithIntl` from `frontend/test/render-intl.tsx`
  ([CONVENTIONS.md](CONVENTIONS.md), section 4). Backend integration tests use Testcontainers PostgreSQL, a GitHub stand-in inside
  the test JVM, and never send mail.
- **Every behavior change comes with a test at the lowest layer that proves it**, and a bug gets a regression test (AGENTS.md rules
  4 and 5). Never disable or weaken a test to make a build green.

## Guards

Small scripts in `scripts/`, standard library only. They run in CI.

| Task | Command |
|---|---|
| English guard (code, comments, test titles, docs) | `python scripts/validate-english.py check --strict` |
| Guard tool tests | `python scripts/test_validate_english.py` |
| Applied Flyway migrations unchanged since a base | `python scripts/validate-english.py migrations --base origin/master` |
| Personal data guard (reads a private blocklist, skips without one) | `python scripts/check-personal-data.py` |
| Personal data tool tests | `python scripts/test_check_personal_data.py` |
| Workflow pins (every action by SHA, every CI image by digest) | `python scripts/test_workflow_pinning.py` |
| Dependabot covers every Dockerfile, compose file, pom.xml, package.json; Meilisearch version equal everywhere | `python scripts/test_dependabot_coverage.py` |
| Maven build policy (enforcer rules, Central only, strict checksums, `.mvn` in the image; the scratch cases need `mvn` and Maven Central) | `python scripts/test_maven_policy.py` |
| Secret scanner config (exact-value allowlist; a token added then removed is found in the history; needs Docker for the scanner cases) | `python scripts/test_gitleaks_config.py` |
| Image pins (Dockerfile bases, compose images, build helper images, scanner mounts) | `python scripts/test_image_pinning.py` |
| No `${{ }}` expression inside a workflow `run:` command | `python scripts/test_workflow_expressions.py` |
| Release workflow gate (environment, tag on master, green CI run, scan before the push, provenance, SBOM, signature) | `python scripts/test_release_workflow.py` |
| Proxy guidance (every `TRUSTED_PROXY_HOPS=2` names the origin restriction; the nginx example has the Cloudflare real-IP form) | `python scripts/test_proxy_guidance.py` |
| Proxy examples (TRACE answered 405, request limits per address, one-hour cache of pictures and share cards; text check, the behavior was run against nginx 1.27 and Caddy 2) | `python scripts/test_proxy_availability.py` |
| Container hardening of the compose file and the images (static; with `CONTAINER_STACK_DOCKER=1` it builds the stack, starts it, renders a post and an optimized image and inspects the containers, minutes and about 2 GB of RAM) | `python scripts/test_container_hardening.py` |
| Content sync trust checks (package signature, ZIP entries, restore list; needs `pwsh`) | `python scripts/test_content_sync.py` (end-to-end: `scripts/content-sync/selftest.ps1`, needs Docker; it starts its own read-only postgres container with the three roles) |
| `init-env` scripts (no secret on a command line, `.env` private to the owner) | `python scripts/test_init_env.py` |
| Reverse proxy examples (access logs without query strings, TLS floor; with `DEPLOY_EXAMPLES_DOCKER=1` also run on a real nginx and Caddy in Docker) | `python scripts/test_deploy_examples.py` |
| Backup script of the docs (modes of the folder, the dumps and the copies; the run needs Linux with `rsync`, else only the text is checked) | `python scripts/test_backup_script.py` |
| Generic leak scan (emails, home paths, tokens, PEM blocks) | `python scripts/release/scan-generic.py` |
| Third-party license check | `python scripts/release/collect-licenses.py --check` |
| Dev and E2E recipes in the docs listen on loopback only (also run by `python scripts/test_docs_as_tests.py`) | `python scripts/docs-as-tests.py --check-loopback docs/*.md README.md backend/README.md` |
| Runnable shell blocks of the install docs | `python scripts/docs-as-tests.py --list docs/INSTALL.md docs/FIRST-RUN.md` (tool tests: `python scripts/test_docs_as_tests.py`) |

The English guard runs in strict mode: Vietnamese letters are allowed only in `frontend/messages/vi.json`, `frontend/content/`,
`docs/vi/`, `fixtures/vi/` folders, the sample posts in `backend/src/main/resources/sample-content/vi/` and the packaged template
example `backend/src/main/resources/site-import/defaults-vi.json` ([CONVENTIONS.md](CONVENTIONS.md), section 4). The frontend
catalog tests (`i18n/catalog-check.test.ts` and friends) run inside `npm test`.

`scripts/docs-as-tests.py` runs, in a clean clone, every shell block in the install docs that is preceded by the line
`<!-- docs-test: run -->`. Blocks with placeholders, `sudo` or real domains carry no marker.

## Example article packages

`fixtures/article-packages/` holds example articles written with the article blocks (`docs/content-blocks.md`): an architecture deep dive,
a step-by-step tutorial, a conceptual explainer, a case study and a plain article of headings, prose and a table, plus `f-variants`, a
reference article that uses every variant and attribute value the others leave out (a test keeps every value of the registry in at
least one example), and `g-postmortem`, an incident review with key figures, a timeline, a file tree, tabs, an accordion and two kinds
of highlighted code (it ships no images). Each folder is one package: `article.md` and the images under `assets/`. They are neutral and fictional, and the tests keep them valid (`npm test` runs
`frontend/lib/blocks/article-fixtures.test.ts`, the backend runs `PostPackageFixturesTest`).

`series-queues-part-1`, `-part-2` and `-part-3` are three small parts of one demo series (the same `series` name and `series_description`, `series_part` 1 to 3),
to import in any order and see one series with one description come out right (`frontend/lib/blocks/series-fixtures.test.ts`, `PostPackageSeriesFixturesTest`).
`fixtures/vi/article-packages/series-queues-accents` is a fourth part whose series name has accents, to see that the import finds the
same series by its web address; it lives under `fixtures/vi/` because the English guard allows such letters only there, and the build
script writes its ZIP too.

```bash
# redraw the images (deterministic: the same bytes on every run; the test fails when they drift from the script)
node scripts/fixtures/make-article-assets.mjs
# write one ZIP per folder (also the one under fixtures/vi/), ready to upload on the post import page
node scripts/fixtures/build-article-zips.mjs ./article-zips
```

Both scripts use Node's built-in modules only. Change an article or an image in its folder, never in a ZIP.

## CI

`.github/workflows/ci.yml` (GitHub Actions) runs on every push to `master` or `feat/**` and on every pull request, as parallel jobs
(a newer push to the same ref cancels the older run). Every action is pinned to a commit SHA and every CI image to a digest
([CONVENTIONS.md](CONVENTIONS.md), section 9):

- **frontend**: Node 22, `npm ci --ignore-scripts` and `npm audit signatures` (the registry signatures and provenance of every
  installed package), then `format:check`, `lint`, `typecheck`, `test`, `build`. No backend is needed. Every install of CI and of the
  frontend image skips package install scripts, so a new dependency cannot run code while it is installed; the four packages of the
  lock that have such a script are named in `frontend/lib/supply-chain/lockfile-install-scripts.test.ts`, which fails when a fifth
  appears (read its script, then add it there or run `npm rebuild <package>` after the install). Your own `npm ci` may keep the scripts.
- **backend**: Temurin 25, `mvn -B -ntp clean verify` (the build policy of `maven-enforcer-plugin` first: Maven and Java versions, Maven
  Central as the only repository; then tests with Testcontainers, Spotless, Checkstyle, ArchUnit). `backend/.mvn/maven.config` makes a
  checksum mismatch fail the build.
- **python**: the standard-library tool tests that exist in the checkout, the workflow pin check, the image pin check (Dockerfiles,
  compose files, helper images, scanner mounts) and the check that no `run:` command holds a `${{ }}` expression (values go through
  `env:`).
- **english**: the guard tool tests, the migration check on pull requests, and the strict English guard.
- **guards**: the strict English guard, the generic leak scan, two secret scans with gitleaks (the files of the checkout, and the
  commits: a pull request from its merge base, a push the whole history, so a secret that was added and removed again is still
  found), and the third-party license check (which has no network of its own and reads the POMs of the local Maven repository, so the job
  installs Java and runs `mvn dependency:resolve` first; without it every backend dependency is reported as `unknown`). `.gitleaks.toml` allows only a list of exact invented test values, never a file. A push
  scans every branch that the checkout holds (`--all`, not only the pushed one), so a secret-shaped fixture on any branch turns the
  push build of every branch red until its exact value is allowlisted or the commit is gone; build such values at run time, as
  `scripts/test_gitleaks_config.py` does. To run both locally, from the repository root (`<image>` is the one in `ci.yml`):

  ```bash
  docker run --rm -v "$PWD:/repo:ro" <image> dir /repo --no-banner --redact
  docker run --rm -v "$PWD:/repo:ro" <image> git /repo --no-banner --redact --log-opts="origin/master..HEAD"
  ```
- **scan**: `npm audit --omit=dev --audit-level=high` in `frontend/` and a Trivy filesystem scan (image pinned by digest) of
  `pom.xml`, `package-lock.json` and the Dockerfiles for HIGH and CRITICAL findings that have a fix. Reviewed exceptions live in
  `.trivyignore` (reason and review date each). To run it locally, after `cd backend && mvn dependency:resolve`:

  ```bash
  docker run --rm -v "$PWD:/src:ro" -v "$HOME/.m2:/root/.m2:ro" aquasec/trivy:0.76.0@sha256:2416d1f74045b57274df1a340eee6b510cacd73c66a6ccb8da092b117eb7d222     fs --scanners vuln,misconfig --severity HIGH,CRITICAL --ignore-unfixed --offline-scan --ignorefile /src/.trivyignore --skip-dirs node_modules /src
  ```

  The same digest is in `ci.yml`, and the gitleaks image (`ghcr.io/gitleaks/gitleaks`) is named in `ci.yml` and in
  `scripts/release/export-clean-snapshot.py`; Dependabot does not bump a `docker run` line, so update every copy together
  (`scripts/test_image_pinning.py` fails when two copies disagree). To refresh one: `docker buildx imagetools inspect <image>:<tag>`
  prints the digest of the tag.
- **images**: builds both images with compose, starts the whole stack (with the `search` profile), waits for every healthcheck and
  checks the hardening of the real containers, renders a post and an optimized image and fails on a logged failed cache write
  (`CONTAINER_STACK_DOCKER=1 python scripts/test_container_hardening.py`).
- **e2e**: the Playwright suite against a stack started on the runner ([E2E](#e2e-playwright)).

Other workflows: `codeql.yml` (CodeQL for Java and TypeScript, weekly and on pull requests to `master`) and `release.yml` (a tag
`v*` builds and publishes the backend image to `ghcr.io` and creates the GitHub release from the matching section of
[CHANGELOG.md](../CHANGELOG.md); see "Release" below).

`dependabot.yml` proposes dependency updates every week for Maven, npm, both Dockerfiles, both compose files and the workflow actions.
A release must be public for 7 days (`cooldown`) before it is proposed; security updates skip the wait. The Markdown, HTML and diagram
packages, the image parsers, BouncyCastle and the framework parents are kept out of the catch-all groups, so each gets a pull request
a person can read. What Dependabot cannot see is refreshed by hand: the images of `docker run` lines and of `with:` inputs in the
workflows (the scanners, the QEMU and BuildKit images, the SBOM scanner), and the PostgreSQL image of the CI `e2e` job (a `docker run` step), which
must carry the digest of the compose files (`scripts/test_image_pinning.py` fails when it does not). The compose entries ignore the
major versions of `postgres`, because a new major needs a data migration ([UPGRADING.md](UPGRADING.md)): minor and patch releases
arrive as pull requests, a major upgrade is made by hand. The Meilisearch version is named in the compose file, the dev script, the
tests and the docs; `scripts/test_dependabot_coverage.py` fails when a copy differs from the compose pin, when a Dockerfile, compose
file, `pom.xml` or `package.json` folder has no entry, and when a compose entry for PostgreSQL lacks the major-version `ignore`. It
lists the files with `git ls-files`, so a gitignored folder (the local tooling of a developer) is never a finding.

### Release

Push a tag such as `v1.2.3` or `v1.0.0-rc.1` on a commit that is on `master`. `release.yml` has three jobs, one after the other:

1. **`scan`** (read-only token, no registry login, no OIDC token, no environment: it cannot publish or sign). For the backend image:
   1. stops unless the tagged commit is an ancestor of `origin/master` (`git merge-base --is-ancestor`), so a tag on a branch nobody
      reviewed, or one pushed by mistake, builds and publishes nothing;
   2. stops unless `ci.yml` has a successful **push** run on `master` for exactly the tagged commit (`gh api` on the runs of the
      workflow, with the read-only `actions: read` of the job): a commit whose CI is red, still running or cancelled is refused before
      anything is built or approved, so tag only after the CI of the merge commit on `master` is green (CI cancels a run that a newer
      push on the same branch replaces, then tag the newer commit). The check is a number: an answer that is not one fails the step.
      It covers `ci.yml`; CodeQL is not read by the workflow, make it a required status check in the master ruleset below;
   3. builds the image once for `linux/amd64` into an archive on the runner (nothing is pushed, no tag exists) and scans it with Trivy
      (the pinned image of the CI `scan` job; HIGH and CRITICAL findings that have a fix fail the job, reviewed exceptions are in
      `.trivyignore`). The Alpine packages are the same on `arm64`, which is not scanned separately.
2. **`images`**, which `needs: scan`: nothing is pushed unless the scan passed, so a finding stops the release before any image, tag or
   GitHub release is public (a scan inside the push job would run after the approval and could leave a half-published release).
   Because of that order the reviewers of the `release` environment are asked only about a release that is clean. The job:
   1. waits for the approval of the `release` environment (once the settings below exist) and checks the master ancestry again;
   2. installs cosign, then builds the backend image for `linux/amd64` and `linux/arm64` and pushes it with the version tags, with
      build provenance (`provenance: mode=max`) and an SBOM attached in the registry (`docker buildx imagetools inspect <image>:<tag>
      --format '{{ json .Provenance }}'` prints it). These are attestations, not signatures. The pushed image is a second build of
      the same pinned inputs from the build cache that `scan` filled, not the archive that was scanned, so the digest that is
      pushed is not the digest that was scanned. There is no frontend image: its site address, language and HSTS are compiled in at
      build time, so every site builds its own from its checkout;
   3. signs the pushed digest (not a tag) with `cosign` keyless, using the OIDC token of the job (`id-token: write`, on this job only),
      and verifies the signature at once against the identity of `release.yml` on a `v*` tag. Users run the same check
      ([INSTALL.md](INSTALL.md#prebuilt-backend-image-or-build-from-source)). The certificate and the signature are recorded in the
      public Sigstore transparency log, so the run that signed an image can be found;
3. **`release`**, which `needs: images`: creates the GitHub release from the matching section of `CHANGELOG.md`.

A scan finding is cured by taking the fixed base image (a Dependabot `docker` pull request) or, when nothing fixes it and it cannot be
reached, by a `.trivyignore` entry with its reason and a review date; then tag again (with a new version number when the tag ruleset
below forbids deleting or moving a tag).

`python scripts/test_release_workflow.py` (CI `python` job) fails when the file loses one of these guards: the three jobs and their
order, the read-only `scan` job with the Trivy step, the same matrix in `scan` and `images`, the approval environment, the master
check, the CI gate, the provenance and SBOM, and the signature and its verification. It reads the text of `release.yml`; it cannot check GitHub's
settings, and only a real tag push exercises the workflow, so **watch the first release run after any change to `release.yml`** (the
scan, the push, `cosign sign` and `cosign verify` are the steps no test can run). The QEMU, BuildKit and SBOM images of the workflow,
the scanner image and the cosign installer are pinned ([CONVENTIONS.md](CONVENTIONS.md), section 9); refresh the `with:` inputs by
hand, Dependabot proposes the actions. The cosign version is the default of the pinned installer (cosign 3 at v4.1.2); when a new
installer changes it, check the wording about the cosign version in [INSTALL.md](INSTALL.md).

**Repository settings the workflow cannot enforce (owner checklist).** Anyone who can push a branch with a changed `release.yml`
and then a tag could remove a step of the file, and anyone who can change `release.yml` on `master` can delete the master check and
the CI gate (the `environment: release` line is skipped by a tagged commit with an edited file, too). So the gate that matters lives
on GitHub:

- [ ] Settings, Environments, `release`: required reviewers (when there is more than one maintainer, not the person who pushes the
  tag) and a deployment rule that allows only `v*` tags. Until this is done `environment: release` approves nothing.
- [ ] Settings, Rules, Rulesets: a tag ruleset for `v*` that limits creating, updating and deleting those tags to maintainers and
  blocks moving or deleting a published tag, so a version cannot be re-pointed at other code.
- [ ] Settings, Rules, Rulesets: a branch ruleset for `master`: require a pull request, require the CI jobs and CodeQL as status
  checks, block force pushes and deletion. The master check and the CI gate of `release.yml` (and the environment gate) are only as
  strong as this: without it, whoever can push to `master` can edit the workflow and remove them. Turn on required reviews for
  changes to `.github/workflows/` (a `CODEOWNERS` entry) if there is more than one maintainer.
- [ ] Settings, Advanced Security: turn on Dependabot alerts and **Dependabot security updates** (they open their own ungrouped pull
  request for a vulnerable dependency, also for the hand-pinned image parsers and BouncyCastle, and skip the 7-day cooldown of
  `dependabot.yml`).
- [ ] Settings, Advanced Security: when the repository is public, turn on secret scanning and **push protection**. The CI history scan
  finds a secret after the push; push protection refuses it before.
- [ ] Packages (after the first release): link the `blog-engine-backend` package to the repository and set the visibility you want. A private
  package cannot be pulled, or verified with `cosign verify`, by anyone without a token; make it public to publish it.
- [ ] After the first release: run `cosign verify` as written in [INSTALL.md](INSTALL.md#prebuilt-backend-image-or-build-from-source) from a
  machine that is not the runner, and note the first verified digest in the release notes.
- [ ] Settings, Code security, **Private vulnerability reporting**: enabled, before the repository is announced. `SECURITY.md` sends
  reporters to the "Report a vulnerability" button of the Security tab and names no email address, so without this switch there is no
  private channel (the fallback is a public issue without details that asks for one). Check that the button shows when you are
  signed out, and that the maintainers who should receive the reports are watching the repository's security advisories.

A reader who pulls the backend image should check the signature and pin a digest ([INSTALL.md](INSTALL.md)). A signature proves that the
release workflow of this repository built the digest; it does not prove the code in it is free of bugs.

## E2E (Playwright)

The suite lives in `frontend/e2e/` and runs with `npm run e2e`. `@playwright/test` is pinned to one exact version with
`channel: 'chrome'`: it uses the Chrome installed on the machine and downloads no browser. `npm test` does not run it (Vitest
excludes `e2e/**`).

**Only run it against an isolated stack**, never against a real site or a dev stack in use. The suite signs in as admin, writes,
publishes, unpublishes and deletes temporary posts, uploads images, creates series, categories and tags, signs readers in through a
fake GitHub, comments, likes, saves, hides comments, suspends a reader, promotes and demotes a sample user, and subscribes to the
newsletter with an `example.com` address (the default transport is `log`, so no mail is sent). It writes to the database of the
backend the frontend points to. An isolated stack is a separate checkout (or at least a separate build directory), a separate
PostgreSQL, and separate ports. This is the exact stack the CI `e2e` job starts.

```bash
# Separate checkout: next build writes .next/, a directory a next dev in the main checkout also uses.
git worktree add --detach ../blog-e2e HEAD
cd ../blog-e2e

# Separate PostgreSQL, separate port.
docker run -d --name blog-pg-e2e -e POSTGRES_DB=blog -e POSTGRES_USER=blog \
  -e POSTGRES_PASSWORD=blog -p 127.0.0.1:15433:5432 postgres:18

# Terminal 1, from ../blog-e2e: the backend on :8081. Flyway builds the schema at startup.
cd backend && mvn -q -DskipTests package
DB_PORT=15433 SERVER_PORT=8081 SERVER_ADDRESS=127.0.0.1 SITE_URL=http://localhost:3100 SETUP_LOCK_DEV_SEED=false \
  APP_ALLOW_DEV_DEFAULTS=true JWT_SECRET="$(openssl rand -base64 48)" MFA_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  GITHUB_CLIENT_ID=e2emockclient GITHUB_CLIENT_SECRET=e2emocksecret ADMIN_GITHUB_ID=7999999 \
  CLIENT_IP_TOKEN=e2e-throw-away-client-ip-token \
  java -Duser.timezone=UTC -jar target/blog-backend-1.0.0-rc.1.jar \
  --app.oauth.github.provider.authorization-uri=http://127.0.0.1:8089/login/oauth/authorize \
  --app.oauth.github.provider.token-uri=http://127.0.0.1:8089/login/oauth/access_token \
  --app.oauth.github.provider.user-info-uri=http://127.0.0.1:8089/user \
  --app.rate-limit.comment.per-minute=20 \
  --app.rate-limit.comment.per-hour=1000 \
  --app.rate-limit.comment-edit.per-ten-minutes=200 \
  --app.rate-limit.like.per-minute=200 \
  --app.rate-limit.login-client.per-ten-minutes=1000 \
  --app.rate-limit.mfa-client.per-ten-minutes=1000 \
  --app.rate-limit.refresh-client.per-ten-minutes=1000 \
  --app.rate-limit.search-client.per-minute=1000 \
  --app.rate-limit.setup-client.per-minute=100

# Terminal 2, from ../blog-e2e: the frontend on :3100, production build.
cd frontend && npm ci
export API_BASE_URL=http://localhost:8081 NEXT_PUBLIC_SITE_URL=http://localhost:3100
export CLIENT_IP_TOKEN=e2e-throw-away-client-ip-token
npx next build && npx next start -p 3100 -H localhost

# Terminal 3, from ../blog-e2e/frontend: Playwright's base URL points at http://localhost:3100
# (the variable is named in frontend/playwright.config.ts).
npm run e2e
```

Before `npm run e2e`, prepare the stack once. In this repository the CI `e2e` job does exactly this: enroll the administrator, then
push the bootstrap articles of `seed/` (twelve posts and two series, with the "Best posts" order):

```bash
cd frontend && node scripts/e2e-bootstrap.mjs
BLOG_TOTP="$(node scripts/e2e-bootstrap.mjs --code)" python ../seed/push.py --base-url http://localhost:8081
```

The specs listed in `scripts/release/e2e-excluded.txt` read those articles: their slugs and titles (`admin/cover.spec.ts` opens one
post by slug), counts, and posts that belong to no series (`admin/series.spec.ts` needs two; the packaged sample content has four posts,
all in one series). On a stack loaded with the packaged sample content instead, they fail on missing data and say nothing about the
code. The published product has no `seed/` and drops those specs from its export; its CI job starts from the sample content:
`node scripts/e2e-bootstrap.mjs --sample-content`.
`e2e/site-frame.spec.ts` (the shared frame, the BROWSE sidebar and the text measure of the site pages) and `e2e/post-layout.spec.ts` (the
three columns, the sticky rails, the skip links and the focus rings of the post page) belong to the same group: they open the owner's own
bootstrap posts and series by slug, so they live in the private repository the product was published from and are not in this one. A
neutral dataset (a post with a table of contents and a series description in the packaged sample content) is what would let them run here.

The administrator cannot sign in with a password alone: two-step verification is mandatory, and the first sign-in of a new stack is
an enrollment. The script signs in through the API as the development admin (a `202` with a challenge), enrolls an authenticator
(`mfa/enroll/begin`, then `mfa/enroll/confirm` with a code it computes itself), loads the packaged sample content with the token it
gets, and records what the suite needs in `frontend/e2e/.auth/admin-mfa.json`: the key, the ten recovery codes and the last 30 second
period of the stack it used. Those are throw-away values of a throw-away stack, but they are credentials: the directory is ignored by
git and left out of the Docker build context (`frontend/test/e2e-auth-ignore.test.ts` keeps both entries). No enrollment code is
asked, because this stack opts in to development defaults with a loopback `SITE_URL` (`E2E_MFA_ENROLLMENT_CODE` supplies one for a
stack that asks).

- On a stack that is already enrolled it reuses the file, signs in with a code, and makes new recovery codes when fewer than eight are
  left (what a full run of the suite can spend; the global setup also tops them up). If the stack is enrolled but the file is gone, it stops with "reset the stack or run the SQL reset in
  [SECURITY.md](SECURITY.md#when-the-phone-or-the-codes-are-lost)": the database of an E2E stack is meant to be thrown away.
- `node scripts/e2e-bootstrap.mjs --code` prints a fresh code of that authenticator and does nothing else. The seed tool needs one:
  `BLOG_TOTP="$(node frontend/scripts/e2e-bootstrap.mjs --code)" python seed/push.py --base-url http://localhost:8081` (a code works
  once; `--totp` is the same as `BLOG_TOTP`, and a recovery code works too).
- **How the suite signs in as the administrator.** Playwright's global setup (`e2e/global-setup.ts`) signs in once through the real
  form, with a code, and keeps that session in `e2e/.auth/admin-session.json` (Playwright's storageState shape); it signs in a second
  time through the API with a recovery code for `support/backend.ts` (`admin-api-session.json`). `loginAsAdmin` gives every browser
  context the cookies of the saved session, refreshing it through `/auth/refresh` when it is near its end and signing in again with a
  recovery code if a spec ended it (`restoreAdminSession()` does the same in a `finally`). A code works once per 30 second period
  (replay protection), so the only place the suite waits is for the next period when a sign-in needs a code and the current one was used
  (`freshAdminCode`, at most 30 seconds). A session older than ten minutes cannot change the security settings, so the specs that do sign
  in through the form themselves (`signInAsAdminThroughForm`). The specs that cover the form are `e2e/admin/login.spec.ts`,
  `e2e/admin/mfa.spec.ts` (a wrong code, a used code, a new administrator enrolling through the pages, an author turning it on and off,
  Sign out everywhere) and the owner's GitHub sign-in in `e2e/auth.spec.ts`, which ends on `/admin/login/mfa`, not `/admin`.
- The stack must not set `ADMIN_PASSWORD`: the Security page refuses a password change while it is set (409), and the variable would
  re-apply the password at every start.
- A role change to or from ADMIN, or a reader becoming an author, asks for the administrator's own code and a sign-in from the last 10
  minutes. `Backend.asAdmin().setUserRole` tries the change plain first (most want nothing, and a recovery code spent for a change
  that did not need one would leave the suite's file one short of the server); a change that answers for the proof is repeated with
  an API session of its own (kept for 8 minutes) and a recovery code of the suite's authenticator, and new recovery codes are made
  with that session when fewer than two are left (`roleChangeProof`, `e2e/support/admin-session.ts`).
- `e2e/admin/mfa.spec.ts` and `e2e/admin/author.spec.ts` promote and demote fake GitHub readers: a full run makes 12 role changes, and the
  backend allows 20 per 10 minutes per admin (`app.rate-limit.role-change.per-ten-minutes`). Running them again within ten minutes
  answers 429; wait, or start the stack's backend with `--app.rate-limit.role-change.per-ten-minutes=100`.

Why those flags:

- Loopback only: the database is published on `127.0.0.1`, the backend gets `SERVER_ADDRESS=127.0.0.1` (the jar listens on every
  interface by default, which a container needs and a throw-away stack does not) and Next gets `-H localhost` (not `-H 127.0.0.1`, see "Run locally"). This stack has the
  database user `blog`/`blog`, `APP_ALLOW_DEV_DEFAULTS` and the seeded admin password with the lock switched off, so anyone who can
  reach its ports can sign in as the administrator.
- `-Duser.timezone=UTC`: PostgreSQL 18 rejects the old time zone aliases the JVM may send on connect (surefire and the Docker image
  set it for the same reason).
- `APP_ALLOW_DEV_DEFAULTS=true`: the backend is fail-closed, it behaves as production unless something opts in to development
  defaults. This stack is a jar with no `dev` profile, so it opts in with this flag: the seeded admin password and an empty
  `VIEWS_TOKEN` are accepted. A public `SITE_URL` is still refused. `JWT_SECRET` has no default: give the stack a random one
  (`openssl rand -base64 48`; in PowerShell use any random string of 32 or more characters). `MFA_ENCRYPTION_KEY` has no default
  either, in any mode: give the stack a random one (`openssl rand -base64 32`; in PowerShell
  `[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))`). Never use the flag on a stack other people can
  reach.
- `SETUP_LOCK_DEV_SEED=false`: a fresh database disables the development password until `/setup`, and the suite's admin signs in with
  it. Never do this on a stack other people can reach.
- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and the three `--app.oauth.github.provider.*` parameters point GitHub sign-in at the
  suite's fake GitHub (`127.0.0.1:8089`, started by Playwright itself). `7999999` is the fake GitHub's "owner" user, so there is an
  admin who signs in through GitHub.
- Four rate limits are relaxed because the suite builds data faster than a real reader: the defaults are 5 comments per minute, 30
  per hour, 20 edits or deletes per 10 minutes and 30 likes per minute. The `spammer` spec still hits 429 on purpose.
- Five per-client-address limits of the backend are relaxed too (`login-client`, `mfa-client`, `refresh-client`, `search-client`,
  `setup-client`): the suite signs in (and completes the second step), refreshes, searches and claims the instance from one machine, much faster than one reader would, and the helpers
  that call the backend directly count under the same address as the browser. The contact and newsletter limits stay at their
  defaults, as Next's own limits for the same routes always have.
- `CLIENT_IP_TOKEN` is the same throw-away value on the backend (Terminal 1) and the frontend (Terminal 2), so the suite exercises the
  forwarded address: Next sends the address it derives in `X-Client-Ip` with this value in `X-Client-Ip-Token`. Without it the opted-in
  backend would accept an empty value and count the socket address. Use a value of your own on any stack other people can reach.
- `next start` prints a warning that it is not running with `output: 'standalone'`; for this test stack it still serves normally.

**Both languages.** `npm run e2e` exercises the default (Vietnamese) site. The main journeys also run against the English site (`/en`
URLs, English text from `messages/en.json`, the admin in English through its `admin_locale` cookie):

```bash
E2E_LOCALE=en npx playwright test e2e/auth.spec.ts e2e/comments.spec.ts e2e/bookmarks.spec.ts \
  e2e/newsletter.spec.ts e2e/admin/posts.spec.ts e2e/translations.spec.ts
```

Every list of the English site shows English posts only. If your database has posts in the default language and the specs need
English ones, run `E2E_API_URL=http://localhost:8081 node frontend/scripts/e2e-seed-english.mjs` against the backend **before** the
frontend build (the pages prerender from this data; it signs in with the authenticator that `e2e-bootstrap.mjs` recorded, so run the bootstrap first). `e2e/translations.spec.ts` is the bilingual journey (create a translation in
the admin, publish it, follow the alternate, unpublish) and runs in both modes. Specs never hard-code text: they ask the catalog
(`msg` in `e2e/support/i18n.ts`) and build public paths with `localePath`. Run the default suite on a database **without** the
English seed.

**Pseudo-locale layout check.** Build and start the frontend with `PSEUDO_LOCALE=1` (every message accented and about 30 percent
longer, `i18n/pseudo.ts`; never in production), then run `E2E_PSEUDO=1 npx playwright test e2e/pseudo-locale.spec.ts --project=mobile`.
The main pages in both locales and the admin sign-in page must not scroll horizontally at 320 and 390 px. The global setup does not sign in
through the form under `E2E_PSEUDO=1` (the pseudo build accents the labels of the form, which the suite finds by their catalog text), so
this run cannot use the admin specs. Rebuild without the variable afterwards.

**Views in E2E.** `/api/views` treats `HeadlessChrome` in the user agent as a bot, so a spec that needs a view counted replaces
that word with `Chrome` before it opens the post.

**Search on Meilisearch (opt-in).** The main suite runs with `SEARCH_ENGINE=postgres` and skips `e2e/search-meili.spec.ts` by
itself (where that spec exists). To run it: start a dedicated Meilisearch for the run (the image pinned in `docker-compose.yml`,
only on `127.0.0.1:7700`, `--memory 512m`, a random master key of at least 32 characters), start the E2E backend with the extra
`SEARCH_ENGINE=meilisearch MEILI_URL=http://127.0.0.1:7700 MEILI_MASTER_KEY=<that key> MEILI_INDEX_NAME=content_e2e_v1` (never use the
development index), then `E2E_SEARCH_ENGINE=meilisearch npm run e2e -- e2e/search-meili.spec.ts`. The spec builds the index through
`POST /api/v1/admin/search/reindex`; that is limited to 3 per 10 minutes per admin, so restart the backend to run again sooner, or
add `--app.rate-limit.search-reindex.per-ten-minutes=20`. Remove the container when done.

**The fake GitHub.** The suite never calls the real GitHub. `frontend/e2e/mock-github/` (only `node:http`, no dependencies) plays
GitHub at `127.0.0.1:8089`: the authorize page (pick a sample user or deny), the code-for-token exchange (it checks the client
secret, `redirect_uri` and PKCE, a code works once, and a wrong code gets HTTP 200 with an `error`, exactly like GitHub), and
`GET /user`. `playwright.config.ts` starts it. The backend still runs Spring's real OAuth flow; only GitHub's three addresses are
pointed at the mock. The site is at `localhost` and the mock at `127.0.0.1`, two different sites, so the sign-in is cross-site as
with the real GitHub: always open the site with `localhost`. The backend's `SITE_URL` must be exactly the origin Playwright opens
(`E2E_BASE_URL`, default `http://localhost:3100`), or the mock answers `redirect_uri_mismatch`.

The mock cannot leak into production: those three parameters are not in `application.yml`, Compose or `.env.example`; the backend
accepts only `https` or `http` loopback addresses for them and prints a WARN at startup when they do not point at GitHub; an
authorize page on loopback cannot be opened by a browser on another machine; and the frontend image copies only the build, without
`e2e/`.

**Environment variables of the suite** (all have defaults that match the stack above; they are read in `frontend/playwright.config.ts`
and `frontend/e2e/support/env.ts`): `E2E_BASE_URL`, `E2E_API_URL`, `E2E_ADMIN_EMAIL`, `E2E_ADMIN_PASSWORD`, `MOCK_GITHUB_PORT`,
`E2E_LOCALE`, `E2E_PSEUDO`, `E2E_SEARCH_ENGINE`.

**Stable specs.** The suite runs the same journeys on a 1440px window (`desktop`) and on a 390px phone emulation (`mobile`), with `retries: 0`,
so a spec that is right only on a good day is a bug to fix. A spec sets a caret, a selection or a value by script only after
`waitForHydration(locator)` (`e2e/support/page.ts`: React has taken the node over; before that it can overwrite what the script did). A post
is measured after `openPost` (`e2e/support/reader.ts`), which also waits for the like and save buttons to leave their inert placeholders: the
right column grows by about 60px when the session answers. An admin page is ready when its loading outline (`aria-busy` inside `main`) is
gone, and a Tab pressed before that leaves the document. A case that compares a position with a stated page width (a "320px" header or layout case, the width of the "Copy link" failure
sentence) sets its window with `setLayoutWidth`: the site reserves the scrollbar gutter and the desktop project's Chrome draws a classic
15px scrollbar, so a 320px window holds a 305px page, which no phone has. It is for widths far from a breakpoint: media queries test the
window, so a case at a breakpoint (639 or 767px) sets the window itself. The overflow sweeps compare the page with its own `clientWidth` and
do not need it.
A spec compares like with like: a wider window can have a narrower column (the BROWSE grid and its padding change at 1280px), so a
count read at two windows, such as the photos on the first row of `/gallery`, is not compared between them; the spec asserts the rule that
makes the count inside each window (the first photo of the next row would not have fitted). What a phone shows differently is in [CONVENTIONS.md](CONVENTIONS.md#8-phone-layout-frontend-below-sm): from `sm` the post hero has the
Subscribe link and the right column has the share icon row; on a phone the hero has the author name alone and the Share menus (hero and
toolbar) stand in for the row, and the specs assert both (a project that has no such element asserts that it is absent).

## Ports

| What | Port | Notes |
|---|---|---|
| Development frontend | 3000 | `npm run dev` |
| Development backend | 8080 | `mvn spring-boot:run` |
| Development PostgreSQL | 5432 | `backend/docker-compose.yml`, bound to `127.0.0.1`; change with `DB_PORT` |
| Development Meilisearch (optional) | 7700 | `127.0.0.1` only |
| E2E frontend | 3100 | production build |
| E2E backend | 8081 | |
| E2E PostgreSQL | 15433 | a separate container |
| Fake GitHub | 8089 | `127.0.0.1`, started by Playwright |
| Production Compose | 3000 on `127.0.0.1` | `SITE_PORT` and `SITE_BIND`; nothing else is published |

Every development and E2E port above listens on `127.0.0.1` only.

Keep the development stack on 3000 and 8080 and the E2E stack on its own ports, so the two never write to the same database.
