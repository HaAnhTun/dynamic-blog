# Agent instructions

Bilingual blog engine, Spring Boot backend plus Next.js frontend. Read `docs/CONVENTIONS.md` for the reasoning behind these rules and
`README.md` for the overview, `docs/INSTALL.md` and `docs/CONFIGURATION.md` for setup and environment variables, and
`docs/DEVELOPMENT.md` for the test and E2E procedures. This file is the short form for people and AI agents.

## Layout

- `backend/` Spring Boot 4, Java 25, PostgreSQL, Flyway. Package by feature under `com.blog` (`post`, `auth`, `comment`, ...),
  each with `controller`, `service`, `repository`, `dto`, `entity` where it needs them. `common` holds shared code.
- `frontend/` Next.js 16 (App Router), React 19, TypeScript, Tailwind 4. Next.js here has breaking changes: read the guides in
  `frontend/node_modules/next/dist/docs/` before writing Next-specific code.
- `scripts/` repository tooling (the English guard, the proof tools). `docs/` product docs.

## Commands (run from the folder shown)

| Task | Command |
|---|---|
| Backend tests | `cd backend && mvn -B -ntp clean test` (Docker is needed: Testcontainers) |
| Backend full check | `cd backend && mvn -B -ntp clean verify` (tests, Spotless, Checkstyle, architecture tests) |
| Backend format | `cd backend && mvn -B -ntp spotless:apply` |
| Frontend checks | `cd frontend && npm run lint && npm run typecheck && npm test` |
| Install scripts | `npm ci --ignore-scripts` is the install of CI and of `frontend/Dockerfile`; `frontend/lib/supply-chain/lockfile-install-scripts.test.ts` (in `npm test`) holds the reviewed list of packages with an install script (`docs/CONVENTIONS.md`, section 9) |
| Frontend format | `cd frontend && npm run format` (check with `npm run format:check`) |
| Frontend build | `cd frontend && npm run build` |
| English guard | `python scripts/validate-english.py check --strict` (tool tests: `python scripts/test_validate_english.py`) |
| Personal data guard | `python scripts/check-personal-data.py` (reads a private blocklist, skips without it; tool tests: `python scripts/test_check_personal_data.py`) |
| Dependency scan | `cd frontend && npm audit --omit=dev --audit-level=high`, and Trivy as in the CI `scan` job (`docs/DEVELOPMENT.md`, "CI"); exceptions only in `.trivyignore`, with reason and review date |
| Workflow pins | `python scripts/test_workflow_pinning.py` (every action in `.github/workflows` by commit SHA with a `# vX.Y.Z` comment, every CI image by `@sha256:` digest; `docs/CONVENTIONS.md`, section 9) |
| Image pins | `python scripts/test_image_pinning.py` (every `FROM` of the Dockerfiles, every compose `image:`, the helper images of the QEMU, buildx and SBOM steps and the images of `export-clean-snapshot.py` by `name:tag@sha256:`; scanner mounts read-only; one digest per scanner and for PostgreSQL; `docs/CONVENTIONS.md`, section 9) |
| Maven policy | `python scripts/test_maven_policy.py` (`backend/pom.xml` keeps the enforcer rules and no repository but Maven Central, `backend/.mvn/maven.config` has `--strict-checksums`, the Dockerfile copies `.mvn`; the scratch-project cases need `mvn`, `REQUIRE_MAVEN=1` fails instead of skipping; `docs/CONVENTIONS.md`, section 9) |
| Secret scanner config | `python scripts/test_gitleaks_config.py` (`.gitleaks.toml` allows exact invented values only, never a file or a path; CI scans the files and the history; the scanner cases need Docker, `REQUIRE_DOCKER=1` fails instead of skipping; `docs/CONVENTIONS.md`, section 9) |
| Dependabot coverage | `python scripts/test_dependabot_coverage.py` (every Dockerfile, compose file, `pom.xml` and `package.json` folder has an entry in `.github/dependabot.yml`, each entry a `cooldown`; the compose entries ignore PostgreSQL majors; the Meilisearch version in scripts, tests and docs equals the `docker-compose.yml` pin; files come from `git ls-files`; `docs/CONVENTIONS.md`, section 9) |
| Workflow expressions | `python scripts/test_workflow_expressions.py` (no `${{ github.* }}`, `inputs.*`, `steps.*` or other context expression inside a `run:` command: pass it through `env:`; `docs/CONVENTIONS.md`, section 9) |
| Backup script | `python scripts/test_backup_script.py` (the cron script in `docs/BACKUP-AND-RESTORE.md` is extracted and run under umask 022; the modes are checked on Linux with `rsync`, elsewhere only its text) |
| Release workflow | `python scripts/test_release_workflow.py` (`release.yml` keeps a read-only `scan` job (master check, a successful `ci.yml` push run for the tagged commit, amd64 archive, Trivy) that the `images` job needs, the same matrix in both, the approval environment, the master check, provenance plus SBOM, and the cosign signature and verification of the pushed digest; `id-token: write` on the `images` job only; the repository settings are an owner checklist in `docs/DEVELOPMENT.md`, "Release") |
| Proxy guidance | `python scripts/test_proxy_guidance.py` (every place that recommends `TRUSTED_PROXY_HOPS=2` says the origin must accept Cloudflare alone; `deploy/nginx.conf.example` keeps the commented `set_real_ip_from` form; `docs/SECURITY.md`, "Reverse proxy and the client address") |
| Proxy examples | `python scripts/test_proxy_availability.py` (`deploy/nginx.conf.example` and `deploy/Caddyfile.example` keep the 405 for TRACE, the request limits and the picture cache; `docs/INSTALL.md`, "Limit the rate of requests") |
| Containers | `python scripts/test_container_hardening.py` (compose: no-new-privileges, cap_drop ALL, read-only root with tmpfs, pids limit, the database on an internal network the frontend does not join, the image cache limit under its tmpfs, the three-role variables required together by the postgres entrypoint, no `${X:?}` nested in another variable (older Compose v2 evaluates it eagerly), the file renders with an older Compose v2; Dockerfiles: root-owned code; with `CONTAINER_STACK_DOCKER=1` it builds and starts the stack, renders a post and an optimized image and inspects the containers) |
| Content sync | `python scripts/test_content_sync.py` (runs `scripts/content-sync/unittest.ps1`: the HMAC signature of a package, its ZIP entries and the `pg_restore -l` allow-list; needs `pwsh`; files travel on stdin and stdout, never `docker cp` (the postgres container is read-only); the end-to-end proof is `selftest.ps1`, which starts a hardened throw-away container with the three roles and needs Docker) |
| init-env | `python scripts/test_init_env.py` (`scripts/init-env.sh` keeps secrets out of every argument list and writes `.env` with mode 600; `init-env.ps1` makes it owner-only; the PowerShell cases run where PowerShell is) |
| Deploy examples | `python scripts/test_deploy_examples.py` (`deploy/nginx.conf.example` and `deploy/Caddyfile.example`: access logs without query strings, the nginx TLS floor; `DEPLOY_EXAMPLES_DOCKER=1` also runs them on a real nginx and Caddy in Docker) |
| Repository scans | `python scripts/release/scan-generic.py` (emails, home paths, secrets, foreign GitHub URLs) and `python scripts/release/collect-licenses.py --check` (dependency licenses) |
| Block docs | `cd frontend && UPDATE_BLOCK_DOCS=1 npx vitest run lib/blocks/content-blocks-doc.test.ts` refreshes the generated reference of `docs/content-blocks.md` and the rules list of `docs/ai-article-authoring.md` after a registry change |
| Loopback recipes | `python scripts/docs-as-tests.py --check-loopback docs/*.md README.md backend/README.md` (a `docker run -p`, `next start`/`next dev` or backend command in the docs must listen on 127.0.0.1 only; tool tests: `python scripts/test_docs_as_tests.py`) |
| Docs as tests | `python scripts/docs-as-tests.py --list docs/INSTALL.md docs/FIRST-RUN.md` lists the runnable blocks (`--run DIR` runs them) |
| E2E | see `docs/DEVELOPMENT.md`, "E2E (Playwright)" (needs a dedicated database and free ports; `cd frontend && node scripts/e2e-bootstrap.mjs` enrolls the stack's administrator once, before the suite) |

Run the formatters, the static checks and the tests that cover your change before you report the work done.

## Rules

1. Do not change the architecture, add a dependency or add a framework without a documented reason in the change.
2. Reuse what exists. Do not create DTOs, entities or helpers that duplicate existing ones.
3. Never edit an applied Flyway migration (not even a comment): Flyway validates checksums and the backend refuses to start.
   Add a new migration with the next free number instead.
4. Every behavior change comes with a test at the lowest layer that proves it. Bugs get a regression test.
5. Never disable a rule, a check or a test, and never delete or weaken a test, to make a build green. Fix the cause.
6. Authorization is enforced in the backend; the frontend only hides things. Never return a draft or private data in a public
   response. `/api/v1/admin/**` is ADMIN only by default: an AUTHOR tree is listed by name in `SecurityConfig` and every handler in
   it is decided (`AdminRouteAuthorizationCoverageIT`); what an AUTHOR may write is bounded (`docs/CONVENTIONS.md`, section 3).
7. No secrets, tokens, passwords, emails or other personal data in code, logs, fixtures, docs or test output. Never log search
   queries, uploaded file contents or tokens. A record with a secret-named `String` component writes its own `toString` without
   it (ArchUnit enforces it); a log line names an account by its id, never by its address.
8. English only in code, comments, identifiers, test titles, commit messages and product docs. The guard enforces it.
9. Layering (enforced by ArchUnit): controllers talk to services and DTOs, not to repositories or entities; repositories are used
   by services; services do not depend on controllers; constructor injection only; log through SLF4J.
10. Formatting is the formatter's job (palantir-java-format through Spotless, Prettier). Do not hand-format and do not mix a
    reformat with a behavior change in one commit.
11. Public frontend code is locale-aware: routes under `app/[locale]/(site)`, links and navigation from `@/i18n/navigation`, copy in
    `frontend/messages/*.json`, no hard-coded locale in `Intl` calls (`docs/CONVENTIONS.md`, section 4). Tests use `msg` and
    `renderWithIntl`, not translated literals. No literal user-facing text in components (a test enforces it). Every `<form>` of the public area, the login (both steps) and the Security page says `method`; a form with a password or personal data is `method="post"` with the route its script posts to as `action`, never a GET before hydration (a test enforces it). The English guard runs
    in strict mode: Vietnamese letters only in `messages/vi.json`, `frontend/content/`, `docs/vi/`, `README.vi.md`, `fixtures/vi/` and the packaged Vietnamese examples `backend/src/main/resources/site-import/defaults-vi.json` and `backend/src/main/resources/sample-content/vi/`.
12. Keep this file and `docs/CONVENTIONS.md` current in the same commit that changes a convention, a command or an enforced check.
13. Content is bilingual (`docs/CONVENTIONS.md`, section 5): validate languages through `Languages`, send the page locale as `lang` from
    public pages, never fill a post's `translations` from anything but published siblings, and take `lockTranslationWrites()` first in a
    transaction that writes translation groups.
14. Everything "about one person" is site content in the database, edited in `/admin/settings` per language (`docs/CONVENTIONS.md`,
    section 6): never put a real owner's name, employer, link or text into code, defaults, tests or fixtures; defaults are neutral
    (`frontend/content/defaults`). Pages read it through `getSiteContent(locale)`. A fresh install has no usable credential: the
    first-run `/setup` claims the instance with a setup code that is never logged.
15. Article blocks (`docs/CONVENTIONS.md`, section 7): a block is an entry of `frontend/lib/blocks/registry.ts` plus a component named after it in
    `frontend/components/site/blocks/`; `renderMarkdown` stays the only Markdown renderer; blocks are width-agnostic (the page shell owns the
    frame); invalid blocks render as plain content and are reported by `validateBlocks`, never dropped. Every parser of an article asks
    `readingOf` first (`lib/blocks/reading.ts`: an article over the parse budget is read as plain text, `too-heavy`, `lib/blocks/parse-budget.ts`; blocks left open past the limit are read as plain text, `too-deep`, `lib/blocks/nesting.ts`). Code highlighting is bounded per article: `renderMarkdown` gives Shiki only `boundHighlighter(highlighter)` (`lib/blocks/highlight-budget.ts`), never the shared highlighter. The sanitize schema gives an author no `class`
    beyond the exact values the renderer needs, and keeps the `user-content-` prefix on the `id` and `name` an author writes; heading slugs stay unprefixed except
    one that starts with `_` or equals a fixed page id (`RESERVED_PAGE_IDS`, `lib/page-ids.ts`: add the id of every new skip-link target or `getElementById` lookup) (`docs/SECURITY.md`; `lib/markdown.test.tsx` holds it).
16. Sessions and the second step (`docs/CONVENTIONS.md`, section 10): start a session only through `AuthService.issueSession` (ArchUnit
    enforces the callers; tests use the `AuthTestSupport` helpers), encrypt TOTP secrets only with `MfaSecretCipher`, and never let a TOTP
    code, a secret, a recovery code, a challenge or an enrollment code reach a log, an exception message or test output. An access token
    must name a live session of its own account (tests get one from `AuthTestSupport.bearerFor`, never a token without a session). The
    session cookies are `__Host-` prefixed in production: read, set and clear them only through `accessCookieName()`, `refreshCookieName()`
    and `setSessionCookies` (never a literal name). ADMIN and AUTHOR sessions end after an idle timeout and an absolute lifetime. A role
    change to or from ADMIN, or one that makes a reader an AUTHOR, is a step-up (`RoleChangeStepUp`: a recent sign-in and the acting
    administrator's own code).
17. Browser storage (`docs/CONVENTIONS.md`, section 10; `docs/SECURITY.md`, "In the browser"): whatever the browser stores about a person is
    cleared by `clearClientSessionData` on every sign-out, editor drafts are keyed by the signed-in account (`lib/draft-storage.ts`), and the
    admin client builds a backend path only from a UUID (`segment()` in `lib/admin-api.ts`). A route handler under `app/admin/(shell)` asks the
    backend (`routes-ask-the-backend.test.ts`), and a notice never repeats text from the URL.
18. Post lists (`docs/CONVENTIONS.md`, section 3): a list reads `PostCard` (the row without the body) through `PostCardRepository`, never
    `Post`; a native list statement selects `PostCard.COLUMNS`, not `p.*`. The reading time is stored with the post (`Post.setContent`).
    The one exception is the Meilisearch result page (`SearchVisibility.check` loads at most 50 posts whole to compare the snippet); do not copy it.

## Git

Commit messages: short imperative English summary, optionally a prefix such as `fix:` or `feat:`. One logical change per commit.
Reformat-only commits are listed in `.git-blame-ignore-revs`.
