# Architecture

How Blog Engine is put together, why the main decisions were made, and the places that break without telling you. Setup and
operations are in [INSTALL.md](INSTALL.md) and [UPGRADING.md](UPGRADING.md); the coding rules are in
[CONVENTIONS.md](CONVENTIONS.md); the endpoint list is in [the backend README](../backend/README.md).

## Contents

- [Overview](#overview)
- [Backend](#backend)
- [Frontend](#frontend)
- [Sign-in and sessions](#sign-in-and-sessions)
- [Roles and permissions](#roles-and-permissions)
- [Site content and first-run setup](#site-content-and-first-run-setup)
- [Languages and URLs](#languages-and-urls)
- [Caching, and why there is one backend and one Next](#caching-and-why-there-is-one-backend-and-one-next)
- [Search](#search)
- [Images](#images)
- [Fragile spots](#fragile-spots)

## Overview

```
Browser -> Next.js (server rendering) -> Spring Boot REST API -> PostgreSQL
                  \-> (optional) Meilisearch, called by the backend only
```

- **The browser never calls the API.** Every request to the backend is made by the Next server, including the GitHub sign-in. The
  auth tokens live in `httpOnly` cookies on the Next origin, so no client-side JavaScript can read a token, and the project needs
  no CORS configuration.
- **Compose publishes one port**: the frontend, on `127.0.0.1` by default. PostgreSQL, the backend and Meilisearch are reachable
  only inside the Compose network (Meilisearch also on `127.0.0.1:7700` for manual checks, only with the `search` profile).
  A reverse proxy on the same machine does TLS ([deploy/](../deploy)).
- **Three services** (plus one optional): `postgres`, `backend` (Java 25, Spring Boot 4), `frontend` (Node 22, Next.js 16 with
  `output: 'standalone'`), and `meilisearch` with `--profile search`.
- **Bilingual**: English and Vietnamese, in the interface and in the content (posts, categories, tags, site content, newsletter).

## Backend

`backend/src/main/java/com/blog/`, one package per feature, and inside it `controller`, `service`, `repository`, `dto`, `entity`
where the feature needs them:

| Package | What it does |
|---|---|
| `auth` (with `auth/oauth`, `auth/mfa`) | password sign-in for admins, the second step (TOTP, recovery codes, enrollment), JWT access and refresh tokens, GitHub sign-in |
| `post`, `category`, `tag`, `series`, `gallery` | the content model, the publish workflow, revisions, slug history |
| `media` | image upload, re-encoding, quota, serving |
| `comment`, `like`, `bookmark`, `notification` | reader interaction |
| `user`, `author` | accounts, roles, suspension, author applications |
| `stats`, `analytics` | all-time view counts and per-day statistics |
| `newsletter` | subscriptions, the outbox and the sending worker |
| `search` | the search endpoint, the Postgres engine, the optional Meilisearch engine and its outbox |
| `sitecontent`, `siteimport` | everything "about one person", edited in `/admin/settings`, and its Markdown import and export |
| `setup` | the first-run claim of a fresh instance |
| `samplecontent` | the admin action that loads neutral demo posts |
| `postimport` | the Markdown post import: the post file format, the ZIP package reader, preview, article preview, apply and the import log. It creates posts through the services of `post`, `category` and `tag`, and stores package images through `media` |
| `common` | shared code: configuration, error model, rate limiter, languages |

Rules enforced by ArchUnit (`ArchitectureTest`): controllers talk to services and DTOs, not to repositories or entities;
repositories are used by services; services do not depend on controllers; constructor injection only; SLF4J for logging
([CONVENTIONS.md](CONVENTIONS.md)).

**Response envelope.**

```text
{"data": ...}                                  success
{"data": [...], "pagination": {...}}           list
{"error": {"code", "message", "traceId"}}      error
```

The code is a stable machine-readable string. The frontend maps codes to its own translated text; the backend never sends text
meant for readers.

**Database.** PostgreSQL 18, Flyway migrations `V1` onward, applied in order at startup, never edited after release.
`spring.jpa.hibernate.ddl-auto` is `validate`, not `update`: the schema comes only from migrations. Migration `V23` needs the
`unaccent` extension.

**Security chains.** Three `SecurityFilterChain`s ([Security](SECURITY.md) has the model):

1. `@Order(1)` serves the endpoints that mint or retire tokens (`/auth/login`, `/auth/mfa/verify`, `/auth/mfa/enroll/*`, `/auth/refresh`, `/auth/logout`) and the first-run
   endpoints (`/setup`, `/setup/status`). It has **no resource server**, because `permitAll()` does not save a request that carries
   an expired access token: the bearer-token filter runs before authorization is asked, so logout would silently do nothing.
2. `@Order(2)` is Spring's `oauth2Login` for GitHub, only under `/api/v1/auth/oauth2/**`, stateless.
3. The last chain holds the real rules. Its fallback is `denyAll()`, not "authenticated": an endpoint nobody wrote a rule for is
   refused. `CurrentAccessJwtConverter` replaces the role claim of every token with the current role in the database, and rejects a token issued before the account's `tokens_valid_after` or bound (`sid` claim) to a session with no live refresh token.

**Background jobs** run inside the backend with `@Scheduled` on a pool of two threads: the newsletter worker (30 seconds after the
previous pass), the search outbox worker and its hourly reconciliation (only when Meilisearch is configured), and the daily
refresh-token cleanup (03:17).

## Frontend

`frontend/`, Next.js 16 (App Router), React 19, TypeScript, Tailwind 4. Next.js 16 has breaking changes against older versions: read
`frontend/node_modules/next/dist/docs/` before writing Next-specific code.

| Path | What it holds |
|---|---|
| `app/[locale]/(site)/` | the public pages (home, writing, posts, series, topics, search, about, newsletter, profile pages, ...) |
| `app/[locale]/feed.xml`, `categories/.../feed.xml`, ... | the RSS feeds |
| `app/admin/` | the admin area (no locale in the URL; its language is the `admin_locale` cookie) |
| `app/setup/` | the first-run setup page and its submit route |
| `app/api/` | route handlers: the readers' BFF (sign-in, session, comments, likes, bookmarks, notifications), views, search suggestions, newsletter, share cards |
| `app/media/[file]` | uploaded images, fetched from the backend |
| `components/` | shared components; `components/site/` public, `components/admin/` admin |
| `lib/api.ts`, `lib/series.ts`, `lib/gallery.ts`, ... | public reads, cached and `server-only`, through `lib/fetch-json.ts` |
| `lib/admin-api.ts` and `lib/admin-*.ts` | authenticated reads and writes, `cache: 'no-store'` |
| `lib/site-content.ts` | `getSiteContent(locale)`: the site content with neutral defaults and a last-good fallback |
| `lib/markdown.tsx` | the unified plus Shiki pipeline, server side; also the feed variant for RSS |
| `lib/blocks/` | the article block registry (the single source of truth), the pure `validateBlocks`, the directive step of the pipeline and the generated authoring prompt |
| `components/site/blocks/` | one native component per block type, and the dispatcher `AiBlock` |
| `i18n/` | locale list, routing, navigation helpers, catalog checks |
| `messages/en.json`, `messages/vi.json` | all interface text (English semantic keys, ICU syntax) |
| `content/defaults/<locale>/` | the neutral packaged default site content |
| `proxy.ts` | locale routing, the `/admin` gate for ADMIN and AUTHOR (navigation only), access-token rotation, and the per-address count of `/_next/image` and `/sitemap.xml` (`lib/read-limit.ts`) |
| `e2e/` | Playwright specs and the fake GitHub |

Decisions worth knowing:

- **`lib/api.ts` and `lib/admin-api.ts` are separate on purpose.** Adding an optional token parameter to the public client is exactly
  how a reader's request starts sending credentials because the cookie jar happens to hold an admin cookie.
- **Markdown is rendered on the server**, the editor's preview included, with the same `renderMarkdown`, so the preview cannot drift
  from the page it previews. Shiki never goes down to the browser. A fenced code block that names a language Shiki has not loaded
  renders as plain text with no warning; the loaded languages are in `lib/markdown.tsx` and the pre-publish check in
  `lib/post-lint.ts` lints against that list.
- **One Markdown pipeline, with article blocks.** `renderMarkdown` runs `remark-parse`, GFM, `remark-directive` and a block step that
  validates every `:::name{...}` directive against the registry in `lib/blocks/registry.ts`. A valid block becomes an `ai-block` element
  with validated attributes; an invalid one becomes plain content and a problem with its line. Then `remark-rehype`, `rehype-raw`,
  `rehype-sanitize` (which gains only `ai-block` and its registry attributes) and `toJsxRuntime`, whose `ai-block` entry is a dispatcher that
  checks the attributes again and renders the native component of `components/site/blocks/`. The public page, the admin and editor
  previews, the import's article preview and (as plain HTML) the feeds all use it, so there is no second renderer to drift. The
  article frame belongs to the page shell and a block never reaches into it. `mermaid` is a lazy, browser-only chunk. See
  [content-blocks.md](content-blocks.md).
- **The import page previews an article with a Server Action that returns JSX.** The action asks the backend for the article
  (`POST /admin/post-import/article-preview`: front matter values, body, and the images of a package as base64) and renders it with the real
  `ArticleView`; the images of the package reach the page as data URLs after the sanitizer, through the `imageSource` option of
  `renderMarkdown` that only this caller passes. Nothing is stored.
- **The post page is prerendered and contains nothing about the reader.** Comments, the like and save buttons and the account menu
  are client islands that call `no-store` route handlers after hydration. So comments, likes and moderation clear no cache tag and
  show on the next load. A comment is plain text, rendered as text: no HTML, no Markdown, no automatic links.
- **Environment.** `NEXT_PUBLIC_*` values (`NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_DEFAULT_LOCALE`) and `HSTS_MAX_AGE` are fixed at build
  time. `API_BASE_URL`, `VIEWS_TOKEN`, `CLIENT_IP_TOKEN` and `TRUSTED_PROXY_HOPS` are read at run time. See [CONFIGURATION.md](CONFIGURATION.md).

## Sign-in and sessions

Two ways in, one token model.

- **Admins** sign in with email and password at `/admin/login`. Next's own route (`/admin/login/submit`) checks that the request
  comes from the site's origin, applies a per-IP limit, and calls the backend, telling it the visitor's address (`X-Client-Ip`,
  proved by the shared `CLIENT_IP_TOKEN`) for the backend's own per-address limit.
- **Readers and authors** sign in with GitHub. It goes through Next, never straight to the backend:

```text
Browser -> Next    GET /api/auth/github/start
          Next  -> backend GET /api/v1/auth/oauth2/authorization/github
        <- Next    303 to GitHub (state, PKCE S256, scope read:user) + oauth_flow cookie (signed blob)
Browser -> GitHub  the reader consents
        <- GitHub  302 back to <SITE_URL>/api/auth/github/callback?code&state
Browser -> Next    GET /api/auth/github/callback
          Next  -> backend GET /api/v1/auth/oauth2/callback/github with the blob: checks the blob and state,
                  exchanges the code, reads GET /user, creates or updates the account, returns a JSON token pair
        <- Next    303 back to the page being read + access_token, refresh_token cookies
```

Spring's `oauth2Login` does the whole OAuth part. The pending request is an HMAC-signed blob (key derived from `JWT_SECRET`) in
Next's `oauth_flow` cookie (`__Host-oauth_flow` in production), because the backend has no session. The callback returns exactly the
same token pair as password sign-in, so tokens never sit in a URL or in JavaScript. The account is tied to GitHub's numeric id, not
to the login or the email, and the email is never requested.

**Tokens.** An access token (JWT, HS256, 15 minutes) and a refresh token (a random string; only its SHA-256 is stored; 30 days for
a reader, 7 days idle and 30 days in all for an ADMIN or AUTHOR, rotated on every use, with reuse detection). Both are `httpOnly`, `SameSite=Lax` cookies on the Next origin, with the `secure` flag
when `NODE_ENV=production`. `proxy.ts` rotates the admin's access token; the readers' routes refresh it themselves
(`lib/session-refresh.ts`).

GitHub sign-in is **off** unless `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are set; the site then still runs, readers can read
and see likes, and every sign-in link leads to a page saying that sign-in is not enabled.

## Roles and permissions

| Role | Who | Can do |
|---|---|---|
| `USER` | every account created by GitHub sign-in | comment, reply, edit and delete own comments, like, save posts, manage own notifications, apply to become an author |
| `AUTHOR` | a reader promoted by an ADMIN, or approved from an application | write, edit, publish and delete **their own** posts in `/admin`, upload images for them, create categories and tags in the editor, see statistics of their own posts |
| `ADMIN` | the owner account, and people an ADMIN promotes | everything, including moderation, users, roles, site content, newsletter, search and sample content |

`/admin` for ADMIN and AUTHOR is Next's job (`proxy.ts` and the admin layout read the role from the access token), and it decides
navigation only. **The backend is the boundary for data**: for every token it re-reads the current role and
status in the database on every request, and the database wins over the claim. A demotion takes effect on the next request; a
suspended or deleted account has no permissions (403). A role change also revokes every session of the person
(refresh tokens and, through `tokens_valid_after`, access tokens), so they sign in again.

Post authorization is `hasRole('ADMIN') or @postAccess.isOwner(#id)`. Change roles in `/admin/users`, not with SQL: the page keeps the
"at least one ADMIN" rule, the lock and the session revocation. The endpoint-by-endpoint table is in
[the backend README](../backend/README.md#endpoints).

## Site content and first-run setup

Everything about one person (site name, tagline, profile, about, skills, now, timeline, contact, blogroll, case studies) is **site
content in the database**, one row per key and language in `site_content`, edited in **Admin > Settings** with JSON import and
export, a Markdown profile import ([site-profile-format.md](site-profile-format.md)) and the last ten versions of each section.
Nothing about a person is in the code. A fresh install shows neutral placeholders from `frontend/content/defaults`.

- The public endpoint `GET /api/v1/site-content?locale=` returns the row of the locale, else the default locale, else the key is
  absent. `/api/v1/admin/site-content/**` and `/api/v1/admin/site-import/**` are ADMIN only, never AUTHOR.
- Pages read it through `getSiteContent(locale)`: per key the backend value, else the packaged default; it never throws and keeps
  the last good answer in memory when the backend is down.
- Every shape has a schema version with upgraders on read, write and import. Text is plain text rendered as escaped text; URLs must
  be `https://` or `mailto:`.
- Saving in the admin shows at once: the server action calls the backend and then clears the `site-content` cache tag.

**First run.** `app_settings.setup_completed` is false only on a provably fresh database. Then nobody can sign in with a default
password (the seeded development password is disabled at startup, `SETUP_LOCK_DEV_SEED`), and `/setup` accepts a **setup code**:
`SETUP_TOKEN` if you set it, otherwise a random code the backend writes to `<SETUP_DATA_DIR>/setup-code` (`/data/setup-code` in
Compose). The log prints the path, never the code. The claim runs in one transaction under an advisory lock, gives the seeded admin
row your name, email and password, revokes its sessions, deletes the file and closes `/setup` (404). Existing databases are migrated
as completed and can never be claimed. Walkthrough: [FIRST-RUN.md](FIRST-RUN.md); security notes: [SECURITY.md](SECURITY.md).

## Languages and URLs

The public site is served in two languages, Vietnamese (`vi`) and English (`en`), with `next-intl`.

- The **default locale has no URL prefix**; the other lives under `/<locale>` (`/en/writing`). `NEXT_PUBLIC_DEFAULT_LOCALE` (build
  time; compose passes `DEFAULT_LOCALE` from `.env`, default `en`) picks which one is unprefixed. `/<default>/...` redirects to the
  unprefixed URL; an unknown prefix is the 404 page.
- There is **no language detection** from `Accept-Language` and no locale cookie on public pages: the language is chosen by link
  (the switcher keeps the current page), so a page is the same for every visitor and stays cacheable. `hreflang` alternates come
  from page metadata and the sitemap, and only for pages that have a real published translation.
- `/admin`, `/setup`, `/api`, `/media`, `/random`, `/opengraph-image`, `robots.txt` and `sitemap.xml` have no locale in the URL.
- Messages live in `frontend/messages/<locale>.json`. A unit test fails when the two files differ in keys or ICU arguments, when a
  value is empty, or when `en.json` contains Vietnamese letters.
- `<html lang>`, the canonical URL, `og:locale`, JSON-LD `inLanguage` and the RSS `<language>` follow the locale of the page.
- **Content has one language per post** (`posts.language`), and `translation_group_id` links the translations of one article. The
  slug stays globally unique. The backend validates every language through `com.blog.common.i18n.Languages`. Details and the
  rules for adding a language: [CONTENT-AND-I18N.md](CONTENT-AND-I18N.md) and [CONVENTIONS.md](CONVENTIONS.md), sections 4 and 5.

## Caching, and why there is one backend and one Next

Public pages read the API through Next's data cache. Every read has `revalidate: 300` (search is 60) and a tag (`posts`, `series`,
`gallery`, `stats`, `site-content`, ...). Only the `/admin` server actions clear those tags at the moment of saving.

**Content written outside the admin appears within 5 minutes.** A change written straight to the backend (an API call, a script)
clears nothing. The site shows it when the cache expires, up to 5 minutes, plus one page load: the first visit after expiry still
gets the stale copy while Next refreshes in the background. For a page nobody opened for a long time, the first visit gets the stale
copy only if it is less than an hour old (`expireTime: 3600`); an older entry is rendered fresh first. So opening the site right after
loading content by API and seeing it stale is normal. To see it at once:

```bash
docker compose restart frontend
```

A restart is enough, because nothing of the cache is kept across one: the data cache and the rendered pages live in the memory of the
Next process (`frontend/cache-handler.mjs`; the application tree is read-only, so Next cannot write them to disk), and the image cache is a
tmpfs at `/app/.next/cache`, which is empty again every time the container starts (`instrumentation.ts` and `lib/runtime-cache.ts` clear what Next wrote to disk outside Docker; in the image they find nothing to remove and could not remove from the read-only tree). (Before the containers were hardened the cache sat in
the container's write layer and a restart cleared nothing; `up -d --force-recreate frontend` is the same thing now.) A page that `next build`
prerendered and that revalidates is not in the image (the build stage of `frontend/Dockerfile` removes it with `scripts/clear-prerendered-pages.mjs`: the build has no backend, so it held the neutral default content), so the first request for it after a restart is rendered against the backend. Exception: `/sitemap.xml` and every RSS feed read the backend directly each time
(`fetchCache = 'force-no-store'`), so crawlers and feed readers see changes immediately; a feed is sent with
`Cache-Control: public, max-age=0, must-revalidate` (a 503 with `no-store`), so a CDN in front of the site revalidates it on every request
([SECURITY.md](SECURITY.md#caching-and-a-cdn-in-front)). The price is a few backend requests per
read (the sitemap makes five requests plus one per hundred posts beyond the first hundred; a feed makes one or two list requests
and, for each item whose HTML the process does not remember yet, one detail request, four at a time).

**One backend, one Next.** Rate limits (comments, likes, sign-in, setup, newsletter, views), the set of already-used OAuth `state`
values, the feed HTML memory, the `site-content` fallback and the place where Next remembers a session refresh (one minute) all live
in process memory. A restart forgets them, and with two instances each one keeps its own copy: the limits double, a cache tag
cleared on one Next is not cleared on the other, and two simultaneous requests of one reader that land on two Next instances just
as the access token expires make one of them be treated as signed out until the next page load. Run one instance of each.
Scaling out needs shared state (a shared cache handler and a shared limiter), which this version does not have.

## Search

The quick-search panel and `/search` call the backend's `GET /api/v1/search`.

- **PostgreSQL (default).** Full-text search with the `vi_unaccent` configuration (`unaccent`, then `simple`): an ASCII query finds
  the same word with diacritics, and `duong` finds a word with the capital D with stroke (U+0110), while still matching whole words. It
  matches whole words only: `json.loads` is one word, `C++` and `C#` become `c`, and there is no substring search.
- **Meilisearch (optional, `SEARCH_ENGINE=meilisearch`).** Prefix matching on the last word, typo tolerance, `C++`/`C#` as tokens,
  and an excerpt from the body. Postgres stays the source of truth: changes reach the index through an outbox
  (`search_outbox`) and a worker, a reconciliation job fixes drift, and if Meilisearch fails the backend returns the PostgreSQL
  result with `degraded=true` and the page says it is using basic search. Rolling back is `SEARCH_ENGINE=postgres`. Posts by a suspended
  author do not appear in search with either engine. The runbook is in
  [the backend README](../backend/README.md#search-with-meilisearch).
- The server-side accent folding (`unaccent`) and the client-side highlighting (`lib/highlight.ts`) must fold identically; see
  [Fragile spots](#fragile-spots).

## Images

Images live in Postgres, with metadata (`media`) and bytes (`media_content`) in two tables so that listings never read bytes. The
backend decodes every upload, rejects anything over 50 million pixels from the header before decoding, re-encodes it (EXIF and GPS
gone), and stores a long side of at most 2400 px and at most 4 MiB. The browser loads images from Next's `/media/<uuid>.<ext>`, a
route that fetches the bytes from the backend, and `next/image` optimizes from that same route. The size limits at each layer are
in [SECURITY.md](SECURITY.md#upload-limits-by-layer). Backup and the cache that can still serve a deleted image:
[BACKUP-AND-RESTORE.md](BACKUP-AND-RESTORE.md).

## Fragile spots

Recorded because each one cost a search, and all of them once reported green while broken.

- **`permitAll()` does not protect an endpoint from the bearer-token filter.** A request with an expired token is rejected before
  authorization is asked; that is why the token endpoints have their own chain without a resource server.
- **A code fence that declares a Shiki language that is not loaded renders as plain text**, with no error and no warning.
- **`app/loading.tsx` turns a data-dependent `notFound()` into HTTP 200** while every unit test still passes. Do not add
  `loading.tsx` to a route that has `notFound()`.
- **A segment cannot have both `page` and `route`.** The page silently shadows the route at run time; `next build` refuses. That is
  why the login handler lives at `app/admin/login/submit/`.
- **`timeZone: 'UTC'` in `Intl.DateTimeFormat` is mandatory.** The test suite pins `TZ=Asia/Ho_Chi_Minh` so that removing the option
  is detectable; on a UTC host it changes nothing.
- **Accent-insensitive search in two places must fold identically.** The backend folds with `unaccent` in the `vi_unaccent`
  configuration (`V23`); `/search` highlights keywords with `lib/highlight.ts`, folding each character by the same rule (NFD, drop
  combining marks, d-stroke to d, lower case, like `lib/slug.ts`). Change one side and forget the other, and the results stay right
  but the highlighted text drifts from the reason the post matched, and no test goes red.
- **`.env*` is git-ignored except `.env.example`.** A list that names only `.env` lets `.env.local`, `.env.production` and the other
  variants, which both Docker Compose and Next read, slip through.
- **The callback in the OAuth App, `SITE_URL` and the host readers use must be one.** A callback mismatch makes GitHub report that
  `redirect_uri` does not belong to the app. A host mismatch (`localhost` against `127.0.0.1`, `www` against no `www`) puts the sign-in
  attempt's cookie on the other host, and every attempt ends in "The sign-in session expired or is not valid".
- **Cookies must keep `SameSite=Lax`.** The callback is a top-level GET navigation from github.com, which is cross-site; `Strict`
  would not send the cookie. For the same reason, do not copy the `sec-fetch-site: same-origin` check of `app/api/views` to the
  callback.
- **A `cookies()` call in a public layout or page turns the whole tree into a dynamic page**, and the post page loses ISR while every
  test stays green. Reader state lives only in client islands, and reader actions are route handlers, not Server Actions: setting a
  cookie in a Server Action re-renders the current route, that is the ISR post together with Shiki.
- **`proxy.ts` must not redirect or return 403 for a Server Action POST.** Next's client turns both into "cannot connect to the
  server". The proxy lets the action through; the backend returns 403 and the admin shows the proper "no permission" sentence.
- **A link to `/api/auth/github/start` is a plain `<a>`, never `<Link>`.** `<Link>` prefetches, which calls the route before anyone
  clicks: each call opens an OAuth attempt, overwrites the cookie of the attempt in progress and uses up the sign-in limit.
- **`next.config` `rewrites` freeze `API_BASE_URL` at build time.** So everything the browser calls is a route handler that reads the
  variable at run time; do not shorten the GitHub sign-in into a rewrite to the backend.
- **A header in `next.config.ts` overrides a header of the same name that a route handler sets itself.** A general frame-blocking
  CSP would silently replace `/media`'s own CSP, and a general `Referrer-Policy` would replace the `no-referrer` of the OAuth
  responses; each has its own rule after the general rule restating the route's exact value, and `next-config.test.ts` compares them.
  When adding a general header, look for routes that set a header of the same name.
- **The first entry of `X-Forwarded-For` is something the client sends itself.** Every per-IP limit reads the IP through
  `lib/client-ip.ts`, counting from the right (`TRUSTED_PROXY_HOPS`); an entry that is not an IP address means the IP is treated as
  unknown. Do not read this header directly anywhere else.
- **Spring Boot builds a `JavaMailSender` as soon as `spring.mail.host` exists, even when empty.** That is why `application.yml`
  excludes `MailSenderAutoConfiguration` and the sender is built only in the `smtp` branch of `NewsletterConfig`.
- **The statistics' "today" is computed in Java** (a `Clock` bean and `ANALYTICS_TIME_ZONE`), not with SQL `current_date`: the
  database session runs in UTC, so the date would be wrong around local midnight.
- **Headless Chrome calls itself `HeadlessChrome`, and `/api/views` treats that as a bot.** An E2E test that needs a view counted
  must change that word in the user agent.
- **Do not log exception messages in the `newsletter` package.** A SQL or JavaMail error can echo an address; the worker logs only
  the id, the error code and the exception's class name.
- **Locale-aware code takes the locale from the request.** A literal `'vi-VN'` in an `Intl` call or a hard-coded locale in a link is
  a bug on the other locale; `lib/format.ts` and `@/i18n/navigation` exist for this ([CONVENTIONS.md](CONVENTIONS.md), section 4).
