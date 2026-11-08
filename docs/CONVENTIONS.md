# Coding conventions

Three layers, from cheapest to enforce to hardest. Whatever a machine can check is checked in CI; the rest is review.

## 1. Style (formatters decide)

- **Java**: [palantir-java-format](https://github.com/palantir/palantir-java-format) 2.102.0 through Spotless. Four-space
  indent, 120 columns, LF line endings. Deviation from the Google Java Style Guide: Google's default is two spaces and 100
  columns. We measured both on the existing code: Google style would have rewritten 80% of the lines, palantir 13%, so the
  existing four-space layout was kept. Run `mvn spotless:apply`; `mvn verify` fails on unformatted code.
- **TypeScript, CSS**: Prettier 3.9.10: no semicolons, single quotes, `printWidth` 130, trailing commas everywhere. ESLint keeps
  its rules (`--max-warnings=0`); `eslint-config-prettier` stops the two from fighting. Run `npm run format`.
- `.editorconfig` mirrors both formatters for editors. `.gitattributes` forces LF in the working tree.
- Naming: Java classes `PascalCase`, methods and fields `camelCase`, constants `UPPER_SNAKE_CASE` (loggers are named `log`),
  packages lower case. Test methods may be descriptive snake_case sentences. TypeScript components `PascalCase.tsx`,
  everything else `kebab-case.ts`.

## 2. Quality rules (curated, zero baseline)

Checkstyle (`backend/config/checkstyle/checkstyle.xml`) runs in `mvn verify` over main and test code: no tabs, no star or unused
imports, modifier order, no empty catch blocks, naming patterns, no `System.out`/`System.err`/`printStackTrace`. The set is
small on purpose: a rule is added only once the code passes it. Candidates for later: `NeedBraces`, `MissingSwitchDefault`,
Javadoc rules.

## 3. Architecture (ArchUnit, `com.blog.architecture.ArchitectureTest`)

- Controllers use services and DTOs, never repositories or entities. Services do not depend on controllers.
- Repositories are used by services (and mappers or specifications), not by controllers or config.
- DTOs and JPA entities are separate types; entities live in `entity` packages. Nothing outside a controller package depends on a
  controller.
- Constructor injection only; no `java.util.logging`; no standard streams.
- A record with a `String` component named like a secret (`password`, `token`, `secret`, `challenge`, `credential`, `jwt`,
  `masterKey`, `encryptionKey`) writes its own `toString` that leaves the value out (`SecretRecordRules`, proved on records of its
  own in `SecretRecordRulesTest`): the generated one prints every component, and Spring MVC, an error message and an assertion all
  print records. `LoginRequest`, `RefreshRequest`, `TokenResponse`, `SecurityProperties` and `AdminAccountProperties` do.
- A feature package may use another feature's **services** (and their DTOs), never its repositories or entities. `com.blog.postimport`
  creates posts through `PostService`, `CategoryService` and `TagService` so that the editor's rules (slugs, indexing, limits) apply
  to an import. It reads posts through `PostRepository` only from its own service, like any service does. Reuse that pattern for a
  feature that writes another feature's data; do not copy its rules.
- **A list of posts reads `PostCard`, never `Post`.** `PostCard` is the row of `posts` without its body (`Post` and `PostCard` both
  extend `PostHead`, and `PostHead` has no `getContent`). `PostCardRepository` holds the list statements (public lists, popular,
  featured, series, bookmarks, the admin list), `PostMapper.toSummary` takes a `PostHead`, and a native statement selects
  `PostCard.COLUMNS`, never `p.*`. The reading time is a column that `Post.setContent` sets together with the body (migration `V47`, filled
  for older rows at startup by `PostReadingMinutesBackfill`). A column added to `posts` goes into `PostHead` and `PostCard.COLUMNS`:
  `PostCardIT` fails otherwise, and it also captures the SQL of the list endpoints and fails if one selects the body. **One exception,
  on purpose:** the Meilisearch provider re-validates the posts of a result page on PostgreSQL (`SearchVisibility.check`,
  `PostRepository.findSearchableByIdIn`) and reads each `Post` whole, because it compares the snippet of the index with the current
  text (`VisiblePost.content`). That is at most 50 posts per request (`MAX_POST_PAGE_SIZE`) behind the search limits, and it is the only
  such read; the PostgreSQL search and every other list read `PostCard`. Do not copy the pattern.
- Existing violations are frozen in `backend/src/test/resources/archunit_store` and may only shrink; a new violation fails the
  build. Do not add to the store by hand. Current frozen debt: 6 uses of an entity type by 4 admin or media controllers
  (`AdminAuthorApplicationController`, `AdminCommentController`, `AdminUserController`, `MediaController`) and 21 direct
  repository uses outside the service layer (`GithubLoginSuccessHandler`, `AdminPasswordFromEnvironment`,
  `CurrentAccessJwtConverter`, `DevCredentialWarning`, `PostAccessPolicy`).

## Design guidance (reviewed, not enforced)

- **Packages**: by feature, then by layer inside the feature. Shared code in `common` only when two features need it.
- **Errors**: one `@ControllerAdvice`; responses carry a stable machine-readable code, never a stack trace or an internal message.
- **Validation**: Jakarta Validation on request DTOs; business rules in services.
- **Transactions**: at the service method; read-only where possible; no transaction around remote calls.
- **Logging**: SLF4J. Never log tokens, passwords, personal data, uploaded content or search queries. The log rotates (3 x 10 MB with
  Compose), so a line that anonymous traffic can cause without limit must not be WARN (issue 089): an expected client error (404, 400,
  409, a request with no credential, a firewall refusal) is DEBUG with the error code and the trace id and never the message; a line
  that a crowd can repeat once it is past a limit (a 429) goes through `LogThrottle`; a request path in a line goes through `LogText`
  (a prefix of 120 characters, no query, no control character). Security events (a refused token, a wrong password, refresh-token
  reuse) stay WARN: they are the audit trail, and the rotation is bounded by shipping the logs off the machine, not by dropping them. A value that a caller typed (an exception message that repeats a name, a slug, a title) goes through
  `UserText.forLog` first, so that it cannot forge a second line; a name that an AUTHOR may create is `@SingleLine`.
- **Anonymous endpoints and the client address**: an endpoint that needs no sign-in and can write, send mail, hash a password or search is
  limited per client address, and for the whole site when it can flood mail or the engine. The controller takes the address from
  `ClientAddressResolver` (never from `X-Forwarded-For`, never from a header read by hand), hands the `ClientAddress` to the service, and the
  service checks `RateLimiter`; the address is never logged or returned. The frontend sends the address it derived with
  `clientIpHeaders(ip)` (`lib/client-ip.ts`) on every backend call that has such a limit. A bucket keyed by something the caller chooses is
  created with `capped(...)` in `RateLimiter`, so its map is bounded. `docs/SECURITY.md` ("Rate limits") lists every limit.
- **Admin API and the AUTHOR**: everything under `/api/v1/admin` is ADMIN only by default. A tree an AUTHOR may use is listed by name
  in `SecurityConfig` (posts, post-import, tags, categories, analytics) and each handler in it is narrowed by `@PreAuthorize`
  (owner or ADMIN, ADMIN only) or in the service; `AdminRouteAuthorizationCoverageIT` fails for a handler that has no reviewed
  decision, so a new controller is closed until someone decides.
- **What an AUTHOR may write is bounded**: a path that lets an AUTHOR create rows or bytes (posts, tags, categories, images) is held to
  `AuthorQuotaProperties` (`app.author-quota.*`, environment variables `AUTHOR_*`) and to the burst limits `post-write`,
  `taxonomy-create` and `media-upload` in `RateLimiter`; an ADMIN is exempt, decided by the role of the account the write is for (read
  from the user row or the token, never a flag a caller can leave out). The create limits live in one method, `PostService.requireAuthorMayCreatePost` (the editor, an import and a translation draft call it). A new write path takes the same limits and a row in
  `docs/SECURITY.md` ("What an author may write") and `docs/CONFIGURATION.md` ("Author limits").
- **An approval covers what the administrator read**: an AUTHOR can keep editing while an ADMIN reads, so a decision on author text (the
  release of a held newsletter) carries the `version` of the row that was shown, and the service recomputes it from the stored text
  under the lock of the row and refuses with 409 when it differs (`NewsletterService.reviewVersion`, `NEWSLETTER_ISSUE_CHANGED`). The
  approved values are stored with the decision. A new approval screen does the same.
- **Tests**: unit tests for business logic, integration tests (Testcontainers) for database and API behavior. Test security,
  authorization, concurrency, migrations and every fixed bug. Prefer a few representative tests over one per state.
- **Size**: avoid very long methods and deep nesting. Do not add an abstraction that only wraps one line. Javadoc is not required
  on private methods; a comment explains a non-obvious *why*, in at most a few lines.
- **Migrations**: never edit an applied one; add the next number.

## 4. Internationalization (frontend, `next-intl`)

- **Routing**: public pages live under `app/[locale]/(site)`; `/admin`, `/api`, `/media` and the metadata files stay outside. The
  default locale (`NEXT_PUBLIC_DEFAULT_LOCALE`, build time) has no URL prefix. Every page and layout under `[locale]` starts with
  `setPageLocale(params)` (`i18n/page-locale.ts`): segments render in parallel, and a static page that renders a locale-aware
  component fails the build otherwise.
- **Links and navigation**: in public code import `Link`, `usePathname`, `useRouter`, `redirect` from `@/i18n/navigation`, never from
  `next/link` or `next/navigation` (ESLint `no-restricted-imports` enforces it). That is also why `no-html-link-for-pages` is off: under
  `[locale]` it matches every one-segment href.
- **Text**: all user-facing copy (JSX text, `aria-label`, `alt`, `title`, `placeholder`, metadata, toasts, validation and error text)
  belongs in `messages/<locale>.json`, with English semantic keys (`Site.footer.contact`) and ICU for plurals and arguments; never
  build a sentence from translated fragments. One term per concept in each language (post, category, tag, saved posts, Best
  posts, sign in, ...): the table is `docs/vi/glossary.md`. Read it with `useTranslations` (client or non-async code) or `getTranslations` (async
  server code). A helper that is not a component takes a `Translator` (`i18n/translator.ts`) or returns keys; server actions translate
  with `getTranslations`. The backend returns stable machine codes, the frontend maps them to catalog text (`Errors.*`).
  Layouts hand the client provider only the namespaces it needs (`i18n/client-messages.ts`).
- **Checks**: `i18n/catalog-check.test.ts` (same keys and ICU arguments in both files, no empty value, no Vietnamese in `en.json`),
  `i18n/catalog-usage.test.ts` (no missing and no unreachable key; keys must be reachable through literals or template literals),
  `i18n/no-literal-text.test.tsx` (no literal text in components; exceptions: a path, GitHub, RSS, or an `i18n-ok: <reason>` comment),
  and the strict English guard (`python scripts/validate-english.py check --strict`, CI blocking). Vietnamese letters are allowed only
  in `messages/vi.json`, `frontend/content/`, `docs/vi/`, `README.vi.md`, `fixtures/vi/` directories, `backend/src/main/resources/sample-content/vi/` (the Vietnamese demo posts) and `backend/src/main/resources/site-import/defaults-vi.json` (the template example, tested against `frontend/content/defaults/vi`). Strict mode also
  flags Vietnamese inside quotes in comments, test titles and Markdown: a comment or a title names the English text or the key
  (`"Best posts"`, `Site.nav.writing`), not the Vietnamese label. A Markdown line that genuinely needs Vietnamese letters (a
  proper noun) carries `<!-- validate-english: allow-vi -->`.
- **Tests** do not hard-code translated copy: use `msg('Key', args)` and `renderWithIntl(ui, { locale })` from `test/render-intl.tsx`
  (E2E: `msg` and `localePath` from `e2e/support/i18n.ts`, locale from `E2E_LOCALE`, default `vi`). A test that needs Vietnamese
  letters on purpose (accent folding, slugs) keeps them in a `fixtures/vi/` file. Layout under long text: run the stack with
  `PSEUDO_LOCALE=1` (build and start) to render every message accented and 30 percent longer (`i18n/pseudo.ts`) and run
  `e2e/pseudo-locale.spec.ts` with `E2E_PSEUDO=1`. The main E2E journeys run in both locales (`E2E_LOCALE=en`, `docs/DEVELOPMENT.md` "E2E").
- **Numbers, dates, collation, case mapping**: never a literal locale (`'vi-VN'`, `'vi'`); use `lib/format.ts` with the locale of the
  request (`useLocale()`, `getLocale()`, or a parameter).
- **Forms**: every `<form>` of the public area, the admin login (both steps), the setup page and the Security page says `method` (`components/forms-native-submit.test.tsx`
  reads the source and fails for one that does not). A form that holds personal data or a password is `method="post"` with, as `action`,
  the route its script posts to, so that a submit before hydration is a POST that route refuses (JSON only) and not a GET that puts
  the fields in the URL, the history and the access log. A deliberate GET (the search form) says `method="get"`.
- **Public URLs are stable**: a change that moves or removes a public URL needs an explicit decision and a redirect from the old path.
- The owner's own content (`frontend/content/*.ts`) is not catalog text; it is handled by the site content model (part D1).

## 5. Content language (posts, taxonomy, newsletter)

- **One language per post** (`posts.language`, CHECK on the enabled set) and `translation_group_id` linking the translations of one
  article, unique per `(group, language)`. The slug stays globally unique, so slug history and redirects are untouched. Enabling another
  locale needs a migration that replaces the CHECK constraints (V35) plus the frontend `LOCALES`.
- **Backend languages** come from `app.i18n.locales` and `app.i18n.default-locale` (`DEFAULT_LOCALE`, also the Flyway placeholder
  `defaultLocale`). Validate every `lang` parameter and every body field through `com.blog.common.i18n.Languages`; never compare
  language codes by hand.
- **The `lang` parameter** is optional on the public list endpoints; absent means "no language filter" (older clients keep working),
  an unknown code is a 400. Public pages always send the page locale. Taxonomy lists with `lang` return only rows that have a
  published post in that language, detail endpoints any language, so a page can show the "no posts in this language yet" fallback.
- **`translations` in a post response** is built from published siblings only (one query for a whole page, `findPublishedTranslations`);
  nothing else may fill it. The admin panel uses the dedicated admin endpoint, which applies the caller's visibility.
- **Group writes** (create, link, unlink, delete, language change) take `PostRepository.lockTranslationWrites()` first. An AUTHOR may
  only change a group made of their own posts; an AUTHOR's translation draft does not join a series (series are ADMIN-curated). `SeriesService.setPosts`, `delete` and
  `placeByPart` take it first too, before the series row.
- **Taxonomy names** are JSON `translations` per locale with fallback to the base text (`LocalizedText`); a post response localizes
  its category and tags to the post's language.
- **Newsletter text** lives in `backend/src/main/resources/i18n/newsletter_<locale>.properties` (UTF-8); a subscriber gets mail in
  their `locale` only for posts of that language.
- **Post URLs and SEO**: a post's canonical is its own language URL; `hreflang` alternates, sitemap alternates and the "Read in
  another language" link exist only between real published siblings. E2E for the English site needs
  `frontend/scripts/e2e-seed-english.mjs` (`docs/DEVELOPMENT.md` "E2E").

## 6. Site content and first-run setup (per-owner data)

- **What it is.** The owner's profile, about, skills, now, timeline, contact (and social links), blogroll and case studies, plus the
  site name, tagline and positioning, are rows of `site_content(key, locale, schema_version, data)` (`site`, `profile`, `about`,
  `skills`, `now`, `timeline`, `contact`, `blogroll`, `case_studies`), not code. Each key has typed records with Bean Validation in
  `com.blog.sitecontent.schema`; unknown properties, control characters, over-long text and any URL that is not `https://` or
  `mailto:` are rejected. Text is plain text and rendered as escaped React text; nothing in this data is HTML. No field can carry a
  role, permission or credential. Case-study measurements need a `source`.
- **Versions.** Every key has a schema version. Older versions are upgraded through `SiteContentUpgrades` on read, write and import;
  unknown versions are rejected. Changing a shape means: raise the current version, register the upgrader, update
  `lib/site-content-types.ts`, the defaults and the tests.
- **API.** `GET /api/v1/site-content?locale=` is public (the row of the locale, else the default locale, else the key is absent).
  `/api/v1/admin/site-content/**` is ADMIN only (never AUTHOR): get, put, revisions (last 10 per key and locale), restore, export,
  import, avatar upload. Writes are rate limited per admin.
- **Frontend.** Read it with `getSiteContent(locale)` (`lib/site-content.ts`, server only): per key the backend value, else the
  packaged neutral default in `frontend/content/defaults/<locale>/<key>.json`; it never throws and keeps the last good answer in
  memory when the backend is down. Client components get what they need as props. The admin saves through a server action that
  calls the backend and then `updateTag('site-content')`; a direct API write shows after the 300 s revalidate window. This assumes
  one backend and one Next process.
- **No personal data in the repository.** Defaults, tests and fixtures use fictional values (`Your Name`, `example.test`).
  `python scripts/check-personal-data.py` scans tracked files against a private blocklist (kept outside the repository).
- **Locales** are deployment settings (`DEFAULT_LOCALE`, build-time `NEXT_PUBLIC_DEFAULT_LOCALE`, the CHECK constraints), shown
  read-only in the admin.
- **First-run `/setup`.** `app_settings.setup_completed` is false only on a provably fresh database (V36); existing deployments are
  migrated as completed and can never be claimed. While it is false, `POST /api/v1/setup` claims the seeded admin row with the
  setup code (`SETUP_TOKEN`, or the file `setup-code` in `SETUP_DATA_DIR`; the log prints the path, never the value), in one
  transaction under an advisory lock; afterwards `/setup` is a 404 and the file is deleted. The seeded development password is
  locked on a fresh install (`SETUP_LOCK_DEV_SEED`, default true); `ADMIN_PASSWORD` or `ADMIN_GITHUB_ID` applied at startup close
  setup too. Never log, return or echo the code or a password.
- **Markdown profile import (D2).** `com.blog.siteimport`: one definition per section (`SectionRegistry`: heading, fields, required or
  optional, the site content key it writes) drives the strict line parser (`ProfileMarkdownParser`, no YAML, linear time), the
  validation messages (the typed records of section 6 stay the only validator), the template, the export and the generated block of
  `docs/site-profile-format.md`. A new section means one new descriptor. `/api/v1/admin/site-import/**` is ADMIN only: preview writes
  nothing; apply re-parses the file, checks its SHA-256 against the previewed one and writes in one transaction under an advisory
  lock (previous versions are revisions, the import log `site_import_log` holds hashes and counts, never content); undo restores them
  unless a section changed since. A missing or empty value never deletes; list parts replace the whole list. Never log file content.

### Markdown post import

- **Package and format.** `com.blog.postimport`: `format` holds the pure, Spring-free post file code (`PostFile` decoding, `PostMarkdownParser`,
  `PostMarkdownWriter`, `PostNormalForm`, `PostTemplateGenerator`), `service` the preview and apply, `repository` the import log.
  The keys are the enum `PostKey`; `docs/post-file-format.md` lists them and the limits, and `PostFileFormatDocTest` fails when the
  document and the parser differ. A new key means a new `PostKey` value, a row in the document, the template notes and the writer (the three series keys are
  the exception: a download carries none, so that an unedited download leaves the series as it is).
- **Reuse, do not copy.** The strict decoding is `ProfileFile` (the profile import); the editor's rules for a new post are
  `PostService.create`. The frontend writer `frontend/lib/post-markdown.ts` and `PostMarkdownWriter` share one dialect and one normal
  form (`PostNormalForm`): change them together.
- **Preview writes nothing; apply re-reads.** Preview runs in a read-only transaction. Apply re-parses every file, checks its SHA-256 and
  the previewed state of every post it would write, and writes all or nothing under `lockTranslationWrites()` and then the import
  lock. An import never publishes, never changes an author, `featured` or a rank, and never overwrites a value the file leaves out.
- **Series from an import (ADMIN only).** The keys `series`, `series_part`, `series_description` create a series by name and join the post
  at its declared part (`posts.series_part`, V41: unique per series and language; `series_position` stays the order key). The service
  resolves the name with `SeriesResolver` (slug or title, the attached series first, ambiguity is a problem), takes the touched series
  rows in id order after the import lock and before the post rows, and places the post with `SeriesService.placeByPart` (a post that is already a member keeps its place while the declared parts agree
  with it, so declaring a part never reorders a series an admin ordered by hand); `PostService.changeLanguage` refuses, with 409
  `SERIES_PART_CONFLICT`, a language in which another post of the series already has the part; an AUTHOR's
  keys are parsed and ignored with a note and no series is read. `PostStateHash` and the preview state cover series, position and
  part, so an apply that would join something else than the preview said is refused. The log item holds ids and numbers, never a name.
- **No content in answers, logs or the import log.** A problem names a file by position, a key by its name in the format and a place by
  a line number, never a value. Unknown keys are echoed only when they are plain words. `post_import_log` holds ids, hashes and counts.
  Any new message or log line must keep to that, and a test captures the log to prove it.
- **Rate limit.** Previews, applies and undos count against one bucket, `post-import-write` (`app.rate-limit.post-import-write.per-ten-minutes`,
  default 60), apart from the site content writes. The article preview of the import page (one call per importable file) has its own
  bucket, `article-preview` (`app.rate-limit.article-preview.per-ten-minutes`, default 300), so that checking many files never uses
  up the previews and applies. The bucket list in `RateLimiter` is positional: `RateLimitConfigTest` and
  `RateLimiterTest` list it, so a new bucket needs both.
- **Access.** `/api/v1/admin/post-import/**` is for ADMIN and AUTHOR: it is one of the AUTHOR trees that `SecurityConfig` lists by name
  (everything else under `/api/v1/admin` is ADMIN only by default); ownership is decided in the service. `SecurityMatrixIT` has a row
  for every route.

## 7. Article blocks (frontend, `lib/blocks`, `components/site/blocks`)

An article body is Markdown plus container directives (`:::callout{type="tip"}` ... `:::`, `::figure{...}` on one line). The rules that
keep it safe and the same everywhere:

- **One registry, one pipeline.** `frontend/lib/blocks/registry.ts` lists every block (type, attributes, variants, allowed children,
  body rule, description, accessibility notes); `validateBlocks(markdown)` (`lib/blocks/validate.ts`) is the pure check, shared by the
  renderer, the import validation and the pre-publish lint. `renderMarkdown` in `lib/markdown.tsx` stays the only renderer: the public
  page, the admin preview, the editor preview and the feed all run it, so there is never a second parser to drift from the first.
  `renderMarkdown` returns `{content, toc, problems}`.
- **A block is a registry entry plus a component.** Each type has one component named after it in PascalCase under
  `components/site/blocks/` and an entry in `BLOCK_COMPONENTS` (`index.ts`); `components/site/blocks/blocks.test.tsx` fails when either
  side is missing. A new attribute is a row in the registry (its type is derived), and the sanitize schema picks up the name from there.
- **Invalid is plain, never lost.** A block that does not pass the registry (unknown name, bad attribute, bad nesting, a heading inside,
  never closed) is drawn as its inner Markdown, and listed as a problem with a 1-based line and a message that names the block and the
  alternatives. Text such as `10:30` or `Note:this` is not a directive: the parser's text directives without attributes are given back
  as the text they were. A document with no directives renders exactly as before.
- **Nesting is bounded.** `nestingProblem` (`lib/blocks/nesting.ts`) counts the blocks an article leaves open before anything is parsed:
  more than 8 at once, or more than 16 written behind a quote, a list marker or a footnote definition, or blocks kept open across so
  many lines that the sum over the lines of the blocks open at each passes 100 000 (`MAX_BLOCK_WORK`), and the article is parsed
  WITHOUT `remark-directive` (the blocks show as plain text, nothing is lost) and one `too-deep` problem is reported. The directive
  parser re-checks every open block for each line, so the cost is (blocks open) x (lines): unclosed blocks cost far more than their
  size (28 KB took 38 s on the one Node process), and so do a few blocks over a long run of short lines, which is why the depth limits
  alone are not enough (`docs/SECURITY.md`, "Markdown in posts", has the measurements: at most about 0.6 s per parse is admitted). The count is an upper bound on purpose and not a copy of the parser: it counts every line the
  parser might open a block on (a name may start with a digit, a letter outside ASCII, an emoji or a tab; text after the name; the colons
  behind any prefix or in the middle of a line), and a fence takes blocks off only from the top of the count, so a line that is counted
  and opens nothing can never hide a block that is open. A change to the scan must keep the differential test of
  `lib/blocks/nesting.test.ts` green: it parses generated texts with the real parser and fails when the count is lower than the nesting
  the parser builds. Every parser built with `remark-directive` asks first (`renderMarkdown`, `renderMarkdownToFeedHtml`,
  `validateBlocks`, `countBlocks`) through `readingOf` (`lib/blocks/reading.ts`); a new one must do the same.
- **Parse work is bounded.** `readingOf` asks `parseBudgetProblem` (`lib/blocks/parse-budget.ts`) before `nestingProblem`: one pass over the
  lines prices the shapes that make the Markdown parser, or the stages after it, slower than linear (markers, each and squared per paragraph, quotes,
  underlined headings, container levels, HTML tags, the length of a word, plain lines, and everything that makes a node: link literals,
  colons, table cells; unclosed `<!--` times the paragraph) in milliseconds, and an article above `PARSE_BUDGET` (1,500) is read as plain text
  (`plainTextReader`: at most 400 paragraphs of one text node each, every character as text) with one `too-heavy` problem. A change to the scan or to a price must
  keep `lib/blocks/parse-budget.test.ts` green and be measured again with `PARSE_PROBE=1` (`docs/DEVELOPMENT.md`, "Measuring the Markdown
  parse budget"): the estimate must stay above the real cost of the shapes the probe lists. Measure the **whole page pipeline with
  `remark-directive`**, one shape per fresh process when a sweep is long (the prices of the first version missed whole families because the
  parser alone was timed), and add a shape to the probe and to the cases of `parse-budget.test.ts` for every construct you price. `renderMarkdown` and `renderMarkdownToFeedHtml`
  also catch a `RangeError` (a stack overflow on thousands of open tags) and read the article as plain text; nothing else is caught there.
  **Highlighting is bounded too, by a clock:** `renderMarkdown` gives the Shiki plugin `boundHighlighter(highlighter)` (`lib/blocks/highlight-budget.ts`),
  one per article, never a shared or module-level highlighter. It caps the line length, the characters and lines highlighted and the
  milliseconds, and draws a block past a limit as plain text. Do not call `highlighter.codeToHast` for article text any other way.
- **A `pre` holds text.** The "Copy code" button copies the `textContent` of the `pre`, and Shiki rewrites only a `pre` that starts with a
  `code` with a language. `plainPre` (`lib/markdown.tsx`, after the sanitizer, so the page and the feed alike) turns every other `pre` that
  holds elements into its text (a `<br>` as a line break), keeping a leading `code` element; a fence passes through unchanged. What the
  button copies is therefore what the page shows. A new component that copies or reads the text of an author's HTML must not rely on
  `textContent` of markup it did not build (`docs/SECURITY.md`, "Markdown in posts").
- **Nothing executable, no author CSS.** The sanitize schema gains one tag, `ai-block`, with the registry's attribute names, and `dataTitle`
  on `pre` and `code` (a fence's `title="..."`), and `dataHighlight` on the same two (its `highlight="2,5-7"`, checked again by
  `parseHighlightValue` before it is used); nothing else loosens. A raw `<ai-block>` typed by an author is turned into literal text and
  reported, and the dispatcher (`AiBlock.tsx`) checks every attribute against the registry again, so the tag could not do more than a
  directive anyway. `class` and `id` are not block attributes, and the schema gives an author none: it allows only the exact classes the
  renderer needs (`language-*` on `code`, the GFM task list and footnote classes) and keeps the `user-content-` prefix on the `id` and `name`
  an author writes. Heading ids are lowercase slugs of the heading text and are left unprefixed so that links stay stable, except a slug that
  starts with `_` or equals a reserved page id (`RESERVED_PAGE_IDS` in `lib/page-ids.ts`, kept in step with the pages by its test), which gets the
  prefix too (`docs/SECURITY.md`, "Markdown in posts"; `lib/markdown.test.tsx` holds it). A new fixed id that a script looks up or a skip link
  targets goes into that list.
- **Blocks are width-agnostic.** The article frame (header, columns, rails) belongs to the page shell; a block fills the article body column
  (`w-full min-w-0 max-w-full`, `not-prose`), lays itself out with container queries and Tailwind utilities, and never sets a fixed pixel
  width, a negative-margin breakout or global CSS. Variants such as `wide` mean the full body width, never wider.
- **Search text (known limit).** `MarkdownText` (the Meilisearch document text) and the reading time leave out block marker lines and
  diagram sources (`BlockMarkers`). The default PostgreSQL search does not: `search_vector` (V23) is generated from the raw body, so the
  syntax of blocks is indexed there like other raw Markdown. Do not edit V23 for it; a fix is a new migration (see `backend/README.md`,
  "Search") and its own decision.
- **Text patterns must stay cheap on hostile input.** An author writes the Markdown, and a Java regex cannot be interrupted. In
  `MarkdownText` (and `BlockMarkers`) a loop over a group is possessive (a backtracking loop recurses once per iteration and ends in a
  `StackOverflowError` on a long run), a run that can start at every position has a bound (link text 300 characters, an autolink
  1,000, an inline code opening run 8), and a line longer than 10,000 characters is kept as text without stripping any syntax
  (hidden comments, `<script>` and `<style>` are still dropped from it). `MarkdownTextTest` runs hostile lines through it with a time
  limit; add the new input there when you touch a pattern.
- **Package scan is a lint.** The unsafe-content scan of ZIP packages (`PostPackageRefs`) works line by line and is a best-effort help for
  the author, not a security boundary, and plain `.md` files are not scanned. The barrier is `rehype-sanitize` in `renderMarkdown`; never
  rely on the scan for safety.
- **The shell boundary.** The article page frame (the header, the columns, the rails, the table of contents) is the page shell's:
  `ArticleView`, the reader components and `globals.css`. A block never reaches into it, and a change to the frame never needs a
  change to a block. The import page renders the article preview through the real `ArticleView`, unchanged, with `renderMarkdown`'s
  `imageSource` option for the images of a package; no other caller passes that option.
- **ZIP packages (backend).** `PostPackageReader` reads a package with `java.util.zip` only and enforces the limits of `PostFileLimits`
  (4 MiB per package, 40 entries, an article of 256 KiB, an image of 4 MiB, 16 MiB unpacked in all packages of one request,
  compression ratio 100) with bounded reads; `docs/post-file-format.md` lists them and `PostFileFormatDocTest` fails when they
  differ. A message names an entry by its position and never echoes a name or content (a test captures the log). Images are
  prepared before the transaction and stored with the post inside it, so a rollback removes them. A new limit is a constant, a row in
  that document and a row in `docs/SECURITY.md`.
- **Fence languages and line highlights.** The languages a code fence is highlighted in are the list `CODE_LANGUAGES`
  (`frontend/lib/blocks/code-languages.ts`), with one literal grammar import each in `LANGUAGE_LOADERS` (`lib/markdown.tsx`; the type of the
  table and `code-languages.test.ts` keep the two in step). `highlight="2,5-7"` after the language is checked by `parseFenceHighlight`
  (`validateBlocks` reports `bad-fence-highlight`), carried by `carryCodeMeta` and marked as `data-highlighted` on the lines by a Shiki line
  transformer; the code panel draws them. The feed drops it.
- **Nesting costs colons.** A container needs more colons than the deepest block it may hold, so a child that holds blocks raises the
  count of every block above it (`colonsOf` in `authoring-prompt.ts` computes it from the registry and prints it in the authoring
  prompt). `authoring-prompt.test.ts` keeps every block at seven or fewer, which is what `tabs` costs because a `tab` may hold `steps`:
  a `file-tree` may stand in a `step`, a `tab` or `details`, while `tabs`, `timeline` and `metrics` stay at the top level.
- **Documentation follows the registry.** The block reference of `docs/content-blocks.md` between its markers is generated from the
  registry and checked by `content-blocks-doc.test.ts`; the authoring prompt is generated from the same data. After a registry change
  run `UPDATE_BLOCK_DOCS=1 npx vitest run lib/blocks/content-blocks-doc.test.ts` in `frontend/` and commit the page.
- **Dependencies, with the reason (rule 1).** `remark-directive` (MIT) parses `:::` containers, attributes and the code-fence awareness; hand
  parsing nested directives is error prone and security relevant. The diagram block adds `mermaid` (MIT; loaded lazily in the browser only, with
  `securityLevel: 'strict'`) because no other mechanism draws diagrams. Pinned to an exact version. Only `components/site/blocks/DiagramView.tsx`
  imports it, through a dynamic `import('mermaid')` that runs in the browser after the diagram block mounts, so a page without a diagram never
  downloads it; `DiagramView.test.tsx` fails when a second file imports it, and `scripts/verify-lazy-mermaid.mjs` checks a webpack build
  (`docs/DEVELOPMENT.md`). The labels a diagram draws are author-controlled HTML: `components/site/blocks/diagram-safety.ts` holds the
  allowlists that clean them (`docs/SECURITY.md`, "Article blocks and ZIP packages"); widen those, never add a blocklist. The package pulls in `khroma`, whose package.json has no
  license field (its shipped license file is MIT): the one entry added to `scripts/release/license-exceptions.txt`.

## 8. Phone layout (frontend, below `sm`)

The phone is the main reader (430 x 932 and 390 x 844 are the reference windows), and the 1440px layout must not move when the phone is
changed: every phone rule is an unprefixed utility that an `sm:` utility overrides, or a `max-sm:` utility. A phone change is checked at 430,
390, 320 (no horizontal scroll: `clientWidth == scrollWidth`) and 1440 (unchanged), in both themes.

- **Spacing.** 16px gutter, 20px card padding (`p-5`, `p-4` in an entry card), `py-8` between bands, `py-5` between list rows, `my-6` between
  blocks. Never a card inside a card, never a rail beside a card on a phone (the About timeline rail is from `sm`).
- **Type.** An article is 17px at 1.7 on a phone (`.prose` in `app/globals.css`; 18px at 1.8 from `sm`), h2 24px, h3 20px, h1 30px at 1.2.
  UI text and bullets that carry content are 15px, metadata 14px, only uppercase labels and chips 12 to 13px. Code is 13px everywhere.
- **Touch.** Every control is a 44px target (`min-h-11`, `h-11 w-11`; an inline link in running text is exempt). Icon-only buttons keep their
  label as `sr-only` text (`HERO_ICON_ONLY`, `HERO_LABEL` in `components/site/reader/hero-button.ts`).
- **Long content.** A horizontally scrolling box (a diagram, the tab row) fades its edge while it scrolls (`use-scroll-cue.ts`, no scrollbar on
  a phone). A long list of bullets shows three and a button for the rest (`CollapsibleList`, the whole text stays in the HTML). A diagram is
  never drawn below 75% of its size and scales to a phone column instead of being cut. A row that is a flex box on a phone (the 44px link
  rows of the discovery lists) wraps a long unbroken title with `overflow-wrap: anywhere`; `break-words` does not lower the minimum width of
  the anonymous text item of a flex box, and the whole page scrolls sideways.
- **Shared phone constants.** `BAND` (`reader-layout.ts`, a page band is `py-8` on a phone) and `TOUCH_ROW`, `ICON_SLOT`, `PHONE_BUTTON`,
  `PHONE_PRIMARY`, `PHONE_SECONDARY` (`SectionHeading.tsx`: a text link that is alone on its line, the 44px header icon slot, a call to action
  that is a button on a phone and a link from `sm`) are the one spelling of those rules; use them instead of retyping the classes.
- **Chrome and lists.** Below `md` the header is two rows (the name and one group of four 44px controls, then the four sections as tabs with
  the current one underlined; the name takes the room the controls leave, whatever their width (they are wider from `sm`: sign-in text,
  language chevron, bell, account name), with no constant for it: `flex-1` with `min-w-0` and `max-w-max`, and an ellipsis when it is longer,
  so a long name never pushes the controls to a row of their own) and from `md` it is the one row it always was. Footer links are 44px rows, post and series rows have a 112px
  thumbnail, a two line excerpt and no tag chips, and tag, category and year chips are 36px pills with a 4px hit area above and below.
  The closed `details` card of the browse pages stays a card (the e2e specs measure it); it reads as a sentence, not as a code.
- **Server components and constants.** A constant exported by a `'use client'` module is a reference, not a value, when a server component
  imports it (a count compared with it is always false). Keep shared constants in a module without the directive.
- **Tests** pin the class that carries the rule (`max-sm:min-h-11`, `sm:text-sm`) at the lowest layer that proves it; jsdom has no layout.

## 9. CI supply chain (pins and scans)

- Every `uses:` in `.github/workflows/*.yml` is pinned to the full 40-character commit SHA with the version in a comment
  (`uses: actions/checkout@<sha> # v7.0.1`). Container images used by CI (`docker run`, `services`) are pinned by `@sha256:` digest. A
  mutable tag lets a hijacked upstream run code with the job token, most dangerous in `release.yml` (`packages: write`). The Dependabot
  `github-actions` entry keeps pins and comments current. `python scripts/test_workflow_pinning.py` (CI `python` job) fails on any
  unpinned reference, `:latest` or tag-only image, and on a ` #` comment inside a multi-line `run:` block that holds `docker run`
  (in a folded scalar the shell would read it as the start of a comment and drop the rest of the command, so the step would pass
  without scanning). Put such comments on their own YAML line above `run:`.
- Every image the repository builds from or runs is pinned by `name:tag@sha256:<digest>`: the `FROM` lines of both Dockerfiles (they
  decide what the published images contain), the `image:` lines of the compose files, the images that `docker/setup-qemu-action`,
  `docker/setup-buildx-action` and the SBOM generator of `docker/build-push-action` pull on their own (`image:`, `driver-opts:
  image=...`, `sbom: generator=...`), and the images of `scripts/release/export-clean-snapshot.py`. The tag says which version the
  digest is. Dependabot (`docker` for the Dockerfiles, `docker-compose` for the compose files) proposes new pairs; it cannot update a
  `with:` input or a `docker run` line, so those are refreshed by hand (`docker buildx imagetools inspect <name>:<tag>`) and a scanner
  image has one digest wherever it is named. A scanner container mounts the checkout read-only (`-v "$GITHUB_WORKSPACE:/src:ro"`).
  `python scripts/test_image_pinning.py` (CI `python` job) fails on any of them.
- Every folder with a Dockerfile, a compose file, a `pom.xml` or a `package.json` has an entry in `.github/dependabot.yml` (and the
  workflows one for `github-actions`), each with a `cooldown` of 7 days. Packages that read untrusted input stay out of the catch-all
  groups. The Meilisearch version is written in about ten places no tool can derive from one source; the compose pin is the reference
  and `python scripts/test_dependabot_coverage.py` (CI `python` job) fails when a copy of it, in the scripts, tests or docs, differs.
  The `docker-compose` entries ignore the major versions of `postgres` (a new major needs a data migration, so it is a hand-made change,
  not a bump), and the PostgreSQL image of the CI `e2e` service has the digest of the compose files like every other copy.
  The check lists the files with `git ls-files` (a gitignored folder is never a finding); only a tree without a checkout is walked.
- Dependency currency. The libraries that Spring Boot does not manage (BouncyCastle, springdoc, TwelveMonkeys, metadata-extractor, ArchUnit)
  are listed in a comment of `backend/pom.xml`: a Boot upgrade never moves them, Dependabot (the `maven` entry, one pull request each,
  after the 7-day cooldown) and Dependabot security updates do. Bump them by patch or minor version only, with the media tests
  (`ImageProcessorTest` and the others) green. A direct frontend dependency that the registry marks deprecated is replaced or listed in
  `frontend/lib/supply-chain/deprecated-dependencies.test.ts` with its reason and the packages that block it; the test fails again when
  a blocker accepts the next major version (today: ESLint 9, blocked by the React, import and a11y plugins of `eslint-config-next`).
  A HIGH or CRITICAL advisory with a fix in `npm audit --omit=dev` or in the Trivy scan fails CI: upgrade, do not ignore.
- The Maven build takes code from Maven Central only: `maven-enforcer-plugin` (validate phase) refuses any other repository or plugin
  repository and an older Maven or Java, and `backend/.mvn/maven.config` (`--strict-checksums`, copied into the image build) makes a
  checksum mismatch fail. Do not add a `<repositories>` or `<pluginRepositories>` block, a mirror, `-Denforcer.skip` or a lax checksum
  flag. Signatures of the artifacts are not verified (the reason is in `docs/SECURITY.md`, "Supply chain").
  `python scripts/test_maven_policy.py` (CI `python` job) holds it, with a scratch project that must fail on a foreign repository.
- Secrets are scanned twice in the CI `guards` job with a pinned gitleaks image: `dir` over the files and `git` over the commits (a pull
  request from its merge base, a push the whole history), because a secret that was added and removed again is in no file but still
  in the history that gets published. `.gitleaks.toml` allows only invented values: one `[[allowlists]]` entry is the anchored regex of
  one exact value (`regexTarget = "secret"`), never a `paths` entry. gitleaks 8.30 does not scan a file at all in `dir` mode when any
  allowlist `paths` matches it, even with `condition = "AND"` and a regex, so a path would hide a real secret added to that file later.
  `python scripts/test_gitleaks_config.py` (CI `python` job, Docker required there) keeps the shape and proves both scans.
- No install runs package scripts: `npm ci --ignore-scripts` in every CI job and in `frontend/Dockerfile`, followed in the `frontend` job by
  `npm audit signatures`. The packages of `package-lock.json` with `hasInstallScript` are a reviewed list
  (`frontend/lib/supply-chain/lockfile-install-scripts.test.ts`, run by `npm test`): a Dependabot pull request that adds one fails
  until a person has read the script. Nothing in `package.json` may define an install hook.
- A `${{ ... }}` expression never sits inside a `run:` command (or an `actions/github-script` `script:`), except `matrix.*`: the text is
  pasted into the shell script before the shell runs, so a branch name, a tag or a step output becomes command text. Pass the value
  through `env:` and read the variable (`env: BASE_REF: ${{ github.base_ref }}`, then `"origin/$BASE_REF"`).
  `python scripts/test_workflow_expressions.py` (CI `python` job) fails on any other expression inside a command.
- The CI `scan` job fails the build on a HIGH or CRITICAL finding that has a fix: `npm audit --omit=dev --audit-level=high` for the
  frontend and a Trivy filesystem scan (`pom.xml`, `package-lock.json`, Dockerfile misconfigurations). Cure a finding by upgrading;
  a version override in `backend/pom.xml` carries a comment naming the advisory and is removed when Spring Boot manages a fixed
  version. Only a finding without a fix and not reachable goes into `.trivyignore`, with the reason and a review date.
- A step that does not run git uses `persist-credentials: false` on `actions/checkout` when the job holds a write permission.
- `release.yml` publishes images with `packages: write` on a `v*` tag. It is three jobs that `python scripts/test_release_workflow.py`
  (CI `python` job) pins. `scan` comes first and is read-only (exactly `contents: read` and `actions: read`, no registry login, no push,
  no `if:` or `continue-on-error`): it proves the tagged commit is an ancestor of `origin/master` (the checkout before it has
  `fetch-depth: 0`) and that `ci.yml` has a successful push run on `master` for that commit (`gh api` on the runs of the workflow,
  `head_sha`, `event=push`, `branch=master`, `status=success`; a count of 0 or one that is not a number fails the step), both before
  the build; then builds the image for `linux/amd64` into an archive (`push: false`) and scans it with Trivy, failing on a HIGH or CRITICAL finding
  with a fix. `images` has `needs: scan`, so nothing is pushed until the scan passed: the scan is a job of its own because a scan
  inside the push job would run after the approval and could leave a half-published release (an image and `latest` with no
  GitHub release, under a tag ruleset that forbids re-pointing the tag). There is no frontend image (`docs/INSTALL.md`), so the matrix is the backend only. `images` has the same matrix as `scan` and
  builds the same context, arguments and cache, and it keeps in this order: `environment: release` (the approval, effective once the
  repository settings give it reviewers, asked only after a clean scan); the master ancestry check again; cosign installed before the
  push (a failed install must not leave an unsigned image); the push with `provenance: mode=max` and an SBOM generator image pinned by
  digest; `cosign sign --yes` of the pushed digest (never a tag) and `cosign verify` against the identity of `release.yml` on a `v*` tag.
  `release` has `needs: images`. `id-token: write` (the keyless signature) is granted to the `images` job only, never to the workflow as
  a whole. The scanned amd64 image and the pushed image are two builds of the same pinned inputs, so the scan does not cover the
  exact pushed digest. The reviewers, the tag ruleset and the master ruleset are repository settings: they are an owner checklist in
  `docs/DEVELOPMENT.md`, "Release", not code (an edited `release.yml` on a commit can drop the checks above, so they mean something
  only while master is protected).

## 10. Sessions, the second step and secrets at rest

- **One funnel starts a session.** Password login and GitHub login both end in `AuthService.completeFirstFactor(User, FirstFactor)`, the
  gate that decides between a session and a second-step challenge. A session begins only through
  `AuthService.issueSession(User, SessionProof)`. ArchUnit enforces the funnel in main code: `RefreshTokenService.open` and
  `TokenService.mint` are callable only from `AuthService`, and `AuthService.issueSession` only from `AuthService`, `MfaService` and
  `PasswordChangeService`. A new caller extends that list in the same commit, which is the point. Test code is not covered and starts
  sessions through the `AuthTestSupport` helpers (`verifiedSession`, `verifiedRefreshToken`, `unverifiedSession`,
  `verifiedSessionStartedAt`); the helpers never swap the `Clock` bean (a stub bean splits the cached Spring context). The backend
  accepts no access token without a live session of its own subject, so `bearerFor` and its siblings (`bearerIssuedAt`,
  `bearerForSessionStartedAt`) open a real session; `bearerWithoutSession` exists only to prove such a token is refused, and
  `freshCodeOf` / `freshCodeForBearer` give the administrator's own code where a step-up asks for one.
- **The session carries its proof.** `refresh_tokens.mfa_verified_at` (a second factor was verified) and `authenticated_at` (when the
  person signed in with a first factor) are copied unchanged by rotation, never refreshed. `RecentAuthentication` reads
  `authenticated_at` from the session row (by session id AND subject) before any change of two-step verification, the password or a
  privileged role; the `auth_time` claim of the access token is informational and nothing trusts it. A session without `mfa_verified_at`
  cannot rotate once its account requires two-step verification (ADMIN, or AUTHOR with an active enrollment).
- **The life of a session depends on the role.** A reader's refresh token lives `app.security.refresh-token-ttl`, sliding. An ADMIN or
  AUTHOR session ends after `PRIVILEGED_SESSION_IDLE_TTL` without use and `PRIVILEGED_SESSION_ABSOLUTE_TTL` after `authenticated_at`
  (`RefreshTokenService.expiryOf`); every token response carries `refreshExpiresIn` and the frontend sets the refresh cookie's `Max-Age`
  from it. A change that must not push the end back (a password change, an enrollment) issues the caller a session with the SAME proof.
- **Rotation and revocation take the same lock.** `RefreshTokenService.rotate` locks the account row before it reads the token, and every
  bulk revocation updates that row first (`bumpTokensValidAfter`); a new bulk revocation must do the same. The reuse of a retired
  refresh token ends that one session (`revokeAllLiveForSession`), a change of who may hold the account ends all of them.
- **A role change that grants or removes privilege is a step-up.** `RoleChangeStepUp` (to or from ADMIN, a reader becoming an AUTHOR): a
  recent sign-in first, then the acting administrator's own code through `MfaService.requireActorCode`, inside the transaction that holds
  the roster lock and lists `MfaRejection` in `noRollbackFor`. A promotion to ADMIN deletes the enrollment of the promoted account.
- **Secrets at rest.** A TOTP secret is encrypted only through `MfaSecretCipher` (AES-256-GCM, `MFA_ENCRYPTION_KEY`, the account id and the
  purpose are authenticated data). Recovery codes, challenges and refresh tokens are stored as SHA-256 hashes only.
- **Never in a log, an exception message, a response (except the one call that shows it once) or test output:** the TOTP code, the secret
  in any form, a recovery code, the challenge, the enrollment code or token, the `otpauth://` link, the encryption key. Log lines carry
  the `userId` and a stable vocabulary (`docs/SECURITY.md`, "Audit events").
- **One-time state is a conditional statement.** The replay guard, the failure counters, the single use of a recovery code, the attempt
  reservation of a challenge and the swap of a secret are `UPDATE ... WHERE` statements in `MfaRepository`, `MfaRecoveryCodeRepository`
  and `MfaChallengeRepository`, never "load, set, save". Every second-step check of an account runs the reserve-then-verify sequence
  of `MfaVerifier` in one transaction, taking the locks in the order `users`, `user_mfa`, `mfa_challenge`.
- **New account passwords** go through `PasswordPolicy`, the one policy of setup, `ADMIN_PASSWORD` and the password change.
- The frozen ArchUnit lines of `AdminPasswordFromEnvironment` name its constructor signature: when its parameters change, the stored
  line changes with them (it is the same debt, not a new violation).

### Frontend side (`frontend/`)

- **The browser never holds a token or a challenge in script reach.** A sign-in that needs a second step (`202`) is kept in the httpOnly
  `mfa_challenge` cookie (`lib/auth-cookies.ts`: Lax, five minutes, `Path=/admin/login`, so it travels with no other request); the body
  of the route only names the step. Clearing the session does not clear it (a stale tab must not end a sign-in in progress); logging out
  does. Tokens go into the session cookies and never into a body. The session cookies are `__Host-` prefixed in production and
  plain elsewhere: read, set and clear them only through `accessCookieName()`, `refreshCookieName()`, `setSessionCookies` and
  `clearSessionCookies` of `lib/auth-cookies.ts`, never with a literal name (a literal is right in the tests and wrong in production).
- **Route handlers of the second step and of the Security page are JSON `fetch` calls** (`proxy.ts` answers 403 to a plain form post) and
  go through one frame each: `lib/mfa-sign-in-route.ts` (`/admin/login/mfa/submit`, `/admin/login/enroll/*`) and
  `lib/admin-security-bff.ts` (`/admin/security/*`). Same origin and JSON first, then a per-IP bucket of its own (`mfa`: 10 per 10
  minutes, a success clears it; `security`: 20 per 10 minutes), a 4 KB body cap, the fields of the call whitelisted, and only
  translated sentences out (the backend's English text and codes are never echoed). A new path of the second step is added to
  `SIGN_IN_STEP_PATHS` in `proxy.ts` in the same commit (nothing else under `/admin` is reachable without a session).
- **A 401 is read before it is taken for an expired session.** `MFA_CODE_INVALID`, `INVALID_CREDENTIALS` and `REAUTHENTICATION_REQUIRED`
  mean "the proof is not enough", not "the session is gone": `adminFetch` (`lib/admin-api.ts`) keeps them as `ApiError`s, and the Security
  routes answer `reauthenticate: true` and leave the cookies alone, so that the page offers "sign in again" instead of signing out.
- **An id is a UUID before it is a path segment.** Every id the admin client (`lib/admin-api.ts`) puts into a backend path goes through
  `segment()`: anything that is not a UUID (`lib/uuid.ts`, the one definition) is a `400 VALIDATION_ERROR` thrown before any request.
  `encodeURIComponent` alone is not enough, because it leaves `.` and `..` alone and `fetch` collapses dot segments, so an id of `..`
  would send the caller's own token to a parent endpoint. A new admin helper that builds a path from a value uses `segment()`; a new
  check of the same kind uses `isUuid`, not another regular expression.
- **What the browser stores about a person is bound to the account and cleared on sign-out.** The editor's drafts are keyed by the user id
  (`lib/draft-storage.ts`; the shell binds the account in the token's `sub` through `DraftOwner`, and nothing writes for an account that is
  not bound). A new `localStorage` or `sessionStorage` key that holds anything about a person is added to `clearClientSessionData`
  (`lib/client-session-data.ts`, called by the public sign-out, the admin Sign out and Sign out everywhere) and to the table in
  `docs/SECURITY.md`, "In the browser"; a key that is only a device preference (the theme) is not. Do not call `clearLocalDrafts` alone from
  a new sign-out path.
- **A route handler of the admin shell asks the backend.** The role claim of the cookie is unsigned in `proxy.ts`, the layout and
  `adminRole()`; it only chooses a screen. A handler under `app/admin/(shell)` must call the backend with the caller's token (the admin
  client, `downloadRoute`, the Security frame) or confirm the role with `verifiedAdminRole()` when it serves something generated in the
  frontend (the authoring prompt). `routes-ask-the-backend.test.ts` fails for a new handler that does neither.
- **A notice never repeats text from the URL.** An action that redirects to say what it did (`removePost` goes to `/admin?deleted=1`) sets a flag,
  and the page shows a fixed, translated sentence only for that exact value; a title, a count or any other text in a query string would let
  a link write into a signed-in person's page (`app/admin/(shell)/page.test.tsx` holds it).
- **Shown once, then dropped.** The setup key and the recovery codes live only in component state (`components/admin/security`): never in
  storage, the URL or a log; the key leaves the DOM when the codes appear, and leaving the codes needs the "stored" box.
- **E2E** signs in as the administrator through `e2e/support/admin-session.ts` (the global setup signs in once through the real form; a
  code works once per period, so the suite never signs in per page). A spec that ends the administrator's sessions (a sign-out, a password
  change) uses a session of its own or calls `restoreAdminSession()`; a spec that changes someone's two-step verification does it for a
  reader promoted for the length of the spec, never for the shared administrator. `frontend/e2e/.auth/` holds throw-away credentials of
  the stack: git and the Docker context ignore it (`frontend/test/e2e-auth-ignore.test.ts`).

## 11. Deployment and operations (compose, images, proxy, release tooling)

Each rule has a guard that fails when it is broken; the table of commands is in `AGENTS.md`.

- **Containers** (`docker-compose.yml`, the `x-hardened` block). Every service has `no-new-privileges`, `cap_drop: ALL`, a read-only root file
  system (what is written is a tmpfs or a named volume) and a `pids_limit`; postgres adds back only the five capabilities its entrypoint
  needs. Postgres is on the internal `db` network, which only the backend joins, so the frontend cannot reach the database. In the
  images the application tree is `root:root` and the runtime user can write only `.next/cache` (frontend) and `/data` (backend); the
  runtime images carry no package manager. `scripts/test_container_hardening.py` checks the compose file and the Dockerfiles and, with
  `CONTAINER_STACK_DOCKER=1` (CI job `images`), builds and starts the stack and inspects the real containers. A new service, mount
  or feature that writes needs a volume or a tmpfs, not an exemption.
- **The frontend's caches.** Rendered pages (ISR) and the data cache are kept in memory by `frontend/cache-handler.mjs` (the built-in
  cache with its disk writes off; the tree under `.next/server` is read-only); the only content of the `.next/cache` tmpfs is the
  optimized images, and `images.maximumDiskCacheSize` (64 MB) stays under that tmpfs (96 MB), which is memory charged to the container
  limit. Never `experimental.isrFlushToDisk: false` (it turns the image cache off too). The stack test requests a post and an image and
  fails on a logged failed cache write; a restart of the frontend empties every cache, and the docs say so. The one thing a restart does
  not empty is the build: the image build has no backend, so a page that revalidates was prerendered from the neutral default content, and
  Next 16.4 serves that copy once after a start. The build stage of `frontend/Dockerfile` therefore runs
  `scripts/clear-prerendered-pages.mjs` over `.next/standalone/.next` after `next build` (the one rule, also used by
  `lib/runtime-cache.ts`); `scripts/test_container_hardening.py` checks the step statically, and with `CONTAINER_STACK_DOCKER=1` that the
  image holds no such page and that the first request after a restart is rendered (`x-nextjs-cache` is neither `HIT` nor `STALE`).
- **Database roles** (`deploy/postgres-init`). The backend connects as a runtime role (rows only), Flyway as an owner role, the
  superuser is for administration. A migration must run as a role that is not a superuser (`DatabaseRoleIT` migrates with the real
  migrations as the owner) and a table it creates needs no `GRANT`: the default privileges of the owner give the runtime role its rights.
  Code must not need DDL, `TRUNCATE` or a superuser feature at run time. An install from before the roles keeps its single role (the
  compose file falls back to `DB_USERNAME`), and moving it is an opt-in documented in `docs/UPGRADING.md`. With the owner role named,
  the postgres entrypoint (`deploy/postgres-preflight.sh`) requires the owner and administration credentials and refuses a name or a password shared by two roles, before initdb. The compose file never nests a required variable (`${X:?}`) inside the default or alternative of another one: Compose before v2.40 evaluates those eagerly and refuses an install that never set the outer variable, which stops every `docker compose` command (`scripts/test_container_hardening.py` checks the shape and renders the file with an older Compose v2).
- **Links between the parts.** One reader of `API_BASE_URL`, `apiBaseUrl()` (`lib/api-base-url.ts`, the rule is in
  `scripts/api-base-url-rule.mjs`): a module never reads the variable itself. A production backend refuses a remote database without
  `sslmode=verify-full` and a way to check the certificate (`DatabaseTransportCheck`, a `BeanPostProcessor` of the data source, so it
  fires before the first connection; pgjdbc needs `sslrootcert` or `sslfactory=...DefaultJavaSSLFactory`, it has no JVM trust store
  fallback of its own). The frontend image refuses to start under a `SITE_URL` other than the one it was built for and under an
  `API_BASE_URL` the rule would reject (`scripts/start-check.mjs`); no frontend image is published.
- **Recipes listen on loopback.** A development or E2E recipe in the docs and in `ci.yml` publishes ports with `-p 127.0.0.1:...`, starts
  Next with `-H localhost` (never a literal `-H 127.0.0.1`: the locale middleware then redirects `/` to itself for ever) and the backend
  with `SERVER_ADDRESS=127.0.0.1` (the `dev` profile does it by itself). `python
  scripts/docs-as-tests.py --check-loopback` (run by `scripts/test_docs_as_tests.py`) fails otherwise; a deliberate exception says
  `# loopback-ok: <why>`.
- **The reverse proxy examples** (`deploy/`) log without the query string (nginx `log_format no_query`, Caddy's filtered default log),
  state the nginx TLS floor themselves and keep the security headers to Next. `scripts/test_deploy_examples.py` checks both files, and
  with `DEPLOY_EXAMPLES_DOCKER=1` runs them on a real nginx and Caddy.
- **Secrets in tooling.** A script never puts a secret on a command line (`ps` shows it) or in a file with the permissions of its folder:
  `scripts/init-env.*` writes `.env` private to the owner (`scripts/test_init_env.py`). The content-sync package is signed with a shared
  key that is never inside it and is verified before anything is restored (`scripts/test_content_sync.py`, `selftest.ps1`). The tool never uses `docker cp` (the postgres container is read-only): files travel on stdin and stdout, and it runs as the owner role of a three-role install.
- **Release tooling.** The snapshot allow-list names every area explicitly and the export stops on a tracked path no rule names; the
  public placeholders (owner, holder, release date) are filled at export and the export fails if one survives; a blocked check (exit
  code 2) is a failed release. The disclosure channel is GitHub private vulnerability reporting, enabled by the owner
  (`docs/DEVELOPMENT.md`, "Release"). The seeded administrator's development password is locked at startup, and on a production run
  that lock cannot be switched off or fail quietly (`SetupDevSeedLock`).

## 12. Availability and caching (frontend, the one Next process)

One Node process serves every public page, the admin shell and the route handlers, so what one request can cost, and what Next keeps on
disk, is a security matter (`docs/SECURITY.md`, "What is not protected").

- **No dotfile in `frontend/public/`.** Next serves that folder from the web root and answers a request for a dotfile with a 500 instead
  of a 404. The tracked `public/images` files keep the folder in git for the Dockerfile `COPY`; `test/docker-context.test.ts` fails on any
  file or folder whose name starts with a dot. Never add `robots.txt` or `sitemap.xml` there either: `app/robots.ts` and
  `app/sitemap.ts` generate both, and a static file would shadow the route.
- **What Next could write to disk is bounded and starts empty.** While `cacheHandler` is set in `next.config.ts` (every build but
  `next dev`, which is every deployment of this repository) nothing is written under `.next/server/route-cache`, so the flood of made-up
  slugs (a 404 for `/posts/<slug>` is a 250 KB page and anyone can ask for one) is bounded by the in-memory LRU of Next
  (`cacheMaxMemorySize`, 50 MB by default), not by `ROUTE_CACHE_MAX_MB`. That variable and the prune it drives have no effect while
  `frontend/cache-handler.mjs` is configured; they stay as the bound for a build without the handler. `instrumentation.ts` still calls
  `startRuntimeCacheGuard` (`lib/runtime-cache.ts`) when the production server starts: it removes `route-cache`, the cached backend
  answers (`.next/cache/fetch-cache`) and the prerendered pages that revalidate (`scripts/clear-prerendered-pages.mjs`, read from
  `prerender-manifest.json`), because the record of which tags `updateTag` expired lives in memory and files would outlive the process;
  in the image the tree is read-only and that last part is done by the Dockerfile instead (previous bullet). With the handler removed,
  the guard also removes the oldest files of `route-cache` every 30 seconds while it is over `ROUTE_CACHE_MAX_MB`. It logs counts, never
  paths (a path holds a slug). The directory names are those of Next 16.4: after an upgrade of Next, run the measurement in
  `docs/DEVELOPMENT.md`, "Measuring the production page cache".

## Git

Branches: `feat/<topic>`, `fix/<topic>`. Commit messages: imperative English summary, one logical change each. A commit that only
reformats code is added to `.git-blame-ignore-revs`.
