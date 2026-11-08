# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Two-step verification (TOTP) for admins, optional for authors.** After the password (or GitHub), an admin enters a 6-digit code from an
  authenticator app; the very first sign-in after an upgrade enrols the app and shows ten single-use recovery codes. Codes are RFC 6238
  (HMAC-SHA1, 30 seconds, each step accepted once); the secret is encrypted at rest with AES-256-GCM under the new required
  `MFA_ENCRYPTION_KEY`; wrong codes are slowed down per account (delays from the fifth, frozen after 100 in a row); the enrollment of an
  existing site asks for an operator-only enrollment code. The sign-in has two pages after the password (`/admin/login/mfa` for a code or
  a recovery code, `/admin/login/enroll` for the first setup: the key as text with a copy button and an `otpauth://` link, no QR image,
  the recovery codes shown once behind a checkbox). `/admin/security` (in the sidebar for admins and authors) turns it on or off for an
  author, replaces the authenticator, makes new recovery codes, changes the password (new password policy: 12 to 128 characters, not
  common, not a run, no email local part), signing other devices out, and has **Sign out everywhere**; changes need a sign-in from the
  last 10 minutes, and the page offers "sign in again". A lost phone and lost codes are recovered by the operator (`MFA_RESET_EMAIL` and
  `MFA_RESET_TOKEN`, once per token, or SQL) and an administrator can reset an author from the Users page. The E2E suite signs in
  through both steps (`frontend/scripts/e2e-bootstrap.mjs`, `frontend/e2e/.auth/`; [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)),
  and `seed/push.py` takes the code with `--totp` or `BLOG_TOTP`. The sign-in log gained audit lines without personal
  data. See [docs/SECURITY.md](docs/SECURITY.md#two-step-verification-and-recovery) and
  [docs/UPGRADING.md](docs/UPGRADING.md#release-with-two-step-verification).

- **Full journey on the home and About pages, a Timeline form and one ZIP both ways.** A timeline entry gets optional details: a link
  (`https://`), a logo (a stored `/media/<id>` image), a location, a department, bullet highlights (up to 12) and technology pills (up to
  30); older entries stay valid. The About page shows each entry as a card (the company or school as the heading, linked, with the logo
  at the top right, then the role, period and location, department, blurb, highlights and pills); the home "Journey" shows the same
  details in a compact layout. The home page has no skills section any more (the skills are the tabs on the About page) and gets a
  **Series** block right after the best posts (the newest published series of the language, hidden when there is none). Admin, Settings has
  a real Timeline form (add, remove, move, every field, lists as lines; a logo can be removed but only a ZIP import sets one) instead of the
  JSON box. The site profile file writes the details (see [site-profile-format.md](docs/site-profile-format.md)) and **Export ZIP with
  images** (`GET /api/v1/admin/site-import/export?locale=<l>&format=zip`) downloads the profile file plus the About photo, the body images
  and the timeline logos, which the import reads back.
- **About page photo and ZIP import.** The About content gets an optional `photo` (a stored `/media/<id>.<ext>` image, JPEG, PNG or WebP).
  The profile import in Settings accepts a ZIP package (4 MiB at most) next to a Markdown file: the `.md` file plus the photo and the body
  images under `assets/`. The preview lists the photo and image changes, unused images and problems without file contents. The About hero shows
  `about.photo`, else the profile avatar. The About editor keeps the photo when saving and can remove it; it cannot upload one.
- **Cover image in ZIP packages.** A package carries the cover of a post both ways. The front matter keys `cover` (the path of a JPEG,
  PNG or WebP image inside the package) and `cover_alt` set the cover of a new post, and replace the cover of an existing post (the
  package wins, as an upload in the editor does); the import preview says which happens (`cover_will_be_set`, `cover_will_be_replaced`)
  and shows a file whose only change is the cover as will change. A `cover` in a plain Markdown file, a path that is not in the package
  and a file that is not a supported image are problems of the file. Download ZIP puts the cover of a post under `assets/` and writes
  the two lines, so a package round-trips with its cover: the same pixels and bytes on a clean site, and no change when it is imported
  back onto the same post. The authoring prompt describes both keys.

- **Dynamic About page.** The About content gets an optional `body`: Markdown with the same article blocks as a post (callout, metrics,
  timeline, tabs, steps, comparison, diagram and the rest), up to 20000 characters. The About page shows it after the introduction in
  the article prose styling, adds its `##` and `###` headings to "On this page" and keeps exactly one `h1` (a `#` in the body is shown
  as a level 2); the sections, the photos band and "Read next" stay. The About editor in Admin, Settings has a Markdown field with a
  character counter, and the site profile file has a `# About page` section that is imported verbatim as the body.

- **Post import.** Admins and authors can import posts from Markdown files at `/admin/posts/import`: download a template per language
  (the keys, instructions for an AI assistant and a neutral example), upload up to 20 files (256 KiB each, 4 MiB in all), review a
  preview that writes nothing, and confirm. New posts are drafts owned by the importer; an import never publishes, unpublishes or
  features a post. Each apply is
  logged by ids, hashes and counts only (`post_import_log`, migration V40) and has its own rate limit
  (`app.rate-limit.post-import-write.per-ten-minutes`, default 60). Format reference: [docs/post-file-format.md](docs/post-file-format.md).
  A file whose slug is the current slug of a post the caller may manage (an admin: any post; an author: own posts) updates that post:
  missing or empty keys keep the stored values, a `tags` line replaces the tags, the language never changes (a different one is an
  error), an unedited or downloaded file is reported as unchanged and writes nothing, and a changed title, description or content keeps
  the replaced text as a revision. A published post is warned about and not ticked; a draft published or a post edited between preview and
  confirm makes the confirm refuse and ask for a new preview. Not available yet: linking a post with `translation_of` (the key is read
  and ignored, and the preview shows a note), and undo.

- **Article blocks.** Posts can use sixteen native blocks written as `:::name{attributes}` ... `:::` in Markdown: callout, figure, gallery,
  compare (with panes), comparison table, Mermaid diagram, steps, code tabs, details (several with the same `group` open one at a time),
  key takeaways, checklist, pull quote, file tree, timeline, metrics and tabs, plus titled code panels (`title="file.py"` on a fence),
  highlighted lines (`highlight="2,5-7"`) and twenty highlighted fence languages, `diff` among them. One registry (`frontend/lib/blocks/registry.ts`) defines them, one pipeline renders them for
  the public page, the previews and the feeds, and a block with a mistake renders as plain content and is listed with its line number
  (import page, editor preview, "Check before publishing"). New dependencies: `remark-directive` and `mermaid` (lazy, browser only,
  strict security level), with their reasons in [docs/CONVENTIONS.md](docs/CONVENTIONS.md). Reference:
  [docs/content-blocks.md](docs/content-blocks.md).
- **ZIP packages for the post import.** A `.zip` with one article and its images (JPEG, PNG, WebP; at most 4 MiB, 40 entries) can be
  previewed and imported like a Markdown file. The backend reads the archive defensively, reports missing or unsupported images and unsafe
  content with line numbers, and on apply stores the images with the post and rewrites the references in one transaction. A new endpoint,
  `POST /api/v1/admin/post-import/article-preview`, returns the article and its images so that the import page can draw it in the real
  article template; it has its own rate limit (`app.rate-limit.article-preview.per-ten-minutes`, default 300). New error codes
  `POST_IMPORT_MEDIA_QUOTA_EXCEEDED` and `POST_IMPORT_MEDIA_BUSY`. Format: [docs/post-file-format.md](docs/post-file-format.md#zip-packages).
- **AI authoring prompt.** The import page downloads a prompt generated from the block registry for an AI assistant to write a package
  ([docs/ai-article-authoring.md](docs/ai-article-authoring.md)). Seven example article packages are in `fixtures/article-packages/`.
- **Series from an import.** An administrator's import can create a series by name (found by its slug, its title or a translated title) and
  put a post at the part it declares. The new front matter keys are `series`, `series_part` (1 to 1000) and `series_description` (sets
  the description of a new series and fills an empty one of a series that exists, never one that has text). The parts may arrive in any order, in one file or many; the series is put in order by the declared
  numbers, and the "Part n of m" a reader sees stays the position among the published parts. Migration V41 adds `posts.series_part`, with
  a unique index per series and language. For an author the keys are read and checked but not applied. The import preview shows the series
  and the part as a change and adds series notes, and a successful import clears the series cache. Format:
  [docs/post-file-format.md](docs/post-file-format.md#series).

### Security

- **HSTS can include subdomains, and the build reminds you to raise it.** New build option `HSTS_INCLUDE_SUBDOMAINS` (default `false`; only `true` opts in; never with `max-age=0`; there is still no `preload`), passed through `.env`, compose and the Dockerfile like `HSTS_MAX_AGE`. The frontend build prints one `[hsts]` line while the max-age is under a year, and the install guide has a dated step to raise it about two weeks after the first public start. The one-day default does not change, so a broken HTTPS setup cannot lock readers out for a year. No action is needed on upgrade (audit 032).
- **A name typed by an author cannot forge a log line.** Error messages that repeat what a caller typed are written to the log through
  `UserText.forLog` (control characters, line and paragraph separators and text-direction characters become U+FFFD, 300 characters at
  most), and a tag or category name, with its translated names, is refused with `400 VALIDATION_ERROR` when it holds a control
  character.
- **Titles, names and file names lose text-direction and invisible characters.** A post title and excerpt, a tag or category name with
  its translations, a category description and the original file name of an upload are cleaned when they are saved, so a right-to-left
  override cannot make a label read as another one; a title or name with nothing visible left is refused with `400`. Restoring an old
  revision cleans it the same way.

- **The admin API is ADMIN only by default.** `/api/v1/admin/**` used to admit an AUTHOR unless a prefix was on a hand-kept ADMIN-only
  list; now the five trees an author uses (posts, post import, tags, categories, analytics) are listed and everything else, including
  a controller nobody has decided about yet, is ADMIN only. `AdminRouteAuthorizationCoverageIT` walks the handler mapping and fails
  for a route in an author tree that has no reviewed decision. No author feature changes.

- **An embedded colour profile is checked before the native colour engine sees it.** The header of a PNG profile (signature, device
  class, RGB colour space, declared size, tag count and tag ranges) is validated first; a profile that fails is ignored and the image
  is read as sRGB. Mutated and forged profiles are covered by tests. The residual risk of the native image decoders is written down
  in `docs/SECURITY.md`.
- **Documented: views can be inflated from many addresses.** "Most read" follows the view count, which is best effort against bots and
  against one person with many addresses; the security notes say so.
- **Documented: categories and tags are a shared pool.** An author sees every category and tag in the admin, drafts-only topics
  included; the security notes say not to create a secret topic name before its post is public.
- **A public post no longer reveals how many parts of its series are unpublished.** `series.position` is now the number among the
  published parts. The cover art of a series post is chosen from it, so a series with gaps may show different art than before.
- **The ZIP export of a post no longer names entries after other people's images.** For an author, the package holds only the cover and
  the body images of that post; any other `/media/<id>` in the text stays as written. An administrator's export is unchanged.
- **Renaming a post again and again cannot reserve addresses for good.** The post of an author keeps only its newest five old
  addresses (`AUTHOR_MAX_SLUG_HISTORY`); an administrator can release an old address with `DELETE /api/v1/admin/slug-history/{slug}`.
  That an author can see whether a slug is taken is documented as accepted.
- **The database refuses rows that break rules the application kept.** Migration V50 adds checks for the status and publish date of a
  post, the shape of a slug, the size of a stored image, an old slug that is also another post's current slug (both directions, by
  trigger) and a reply to a reply; `recordOldSlug` no longer moves a history row to another post, it fails the edit instead, and
  `merge-content.sql` names a slug clash before it writes anything.
- **An author's delete only hides the post.** Deleting a post used to destroy, with one `DELETE`, the readers' comments and their
  likes, post likes, saved posts, the newsletter record and the images that other posts may link to. Now an AUTHOR's delete of their own
  post hides it (migration V49: status `ARCHIVED`, `deleted_at`, `deleted_by`) and keeps every other row; it leaves the site, the
  search and the author's list, and its address stays reserved. An administrator still deletes for good, sees a hidden post as
  "Archived" and can publish it again. Each deletion is logged with ids and the comment count, never text. The confirmation an author
  sees (in the editor, in the post list and for several posts) says so: the post leaves the site and their list and an administrator
  keeps it, with no "permanently"; an administrator's confirmation still says the delete is for good.
- **Contact messages are deleted after a year.** A nightly job deletes the messages older than `CONTACT_RETENTION_DAYS` days (365 by
  default, `0` keeps them until an administrator deletes them), read or not; the data table in `docs/SECURITY.md` lists them, and the
  admin guide says how to erase one person's data.
- **An author cannot flood the site with posts, tags or images.** Tags per post (10; a post that already has more can still be saved while the save adds none), posts created per day (30, imports and translation drafts included),
  images per post (30), the number of tags and categories an author can add to the catalog (1,000 and 100), a hundred megabytes of
  images per author and half of the image quota for all authors together, plus rate limits on saving posts, creating tags and
  categories and uploading images (`post-write`, `taxonomy-create`, `media-upload`). An administrator is exempt from all of it. One
  author image at a time waits for the image-processing slot, and a taken slug is numbered at most 50 times before a random suffix.
  Eight `AUTHOR_*` variables set the numbers ([docs/CONFIGURATION.md](docs/CONFIGURATION.md#author-limits)); new error code
  `AUTHOR_QUOTA_EXCEEDED`. A Markdown or ZIP import that one of these limits stops answers with that limit (`429` or `422`), not with
  "the data changed, preview again".
- **The newsletter of an author's post waits for an administrator.** A post that an AUTHOR publishes for the first time used to queue
  a mail to every confirmed subscriber with the title and excerpt the author wrote. The issue is now `HELD` (migration V48) and the worker
  ignores it until an ADMIN releases it on `/admin/newsletter`, or discards it for good; the subject, excerpt and language shown at the
  release are the ones mailed (migration V51 stores the language), so a later edit of the post changes nothing. The release carries a
  `version` of the text the administrator read and is refused with `NEWSLETTER_ISSUE_CHANGED` (409) if the author changed the post after the
  page loaded. A post an ADMIN publishes is queued as before. A subject is one line and an
  excerpt is cut at 300 characters, also for older posts. New endpoints `GET /api/v1/admin/newsletter/held` and
  `POST /api/v1/admin/newsletter/issues/{postId}/release|discard` (ADMIN only), error codes `NEWSLETTER_ISSUE_NOT_FOUND` and `NEWSLETTER_ISSUE_CHANGED`.
- **No frontend image is published any more, and the frontend refuses a `SITE_URL` it was not built for.** The frontend image carries its
  site address, language and HSTS in the bundle, so the one the release workflow pushed could only say `http://localhost:3000`: wrong
  canonical URLs, Open Graph tags and sitemap and no `Strict-Transport-Security` on a public site, with nothing failing. The release
  publishes the backend image only; `docker compose up -d --build` builds the frontend from your checkout, as the docs always said. The
  image now records the address it was built for (`BAKED_SITE_URL`), compose gives the container the `SITE_URL` of `.env`, and
  `scripts/start-check.mjs` stops the container with a message when the two differ (a changed `SITE_URL` without `--build`);
  `ALLOW_SITE_URL_MISMATCH=true` starts it anyway with a warning. A bare `docker run` without `SITE_URL` starts as before. See
  [docs/INSTALL.md](docs/INSTALL.md#prebuilt-backend-image-or-build-from-source).
- **The development and E2E recipes listen on loopback only.** The E2E recipe published PostgreSQL (user `blog`/`blog`) and ran the
  backend with development defaults and Next on every interface, and Docker opens a published port with firewall rules that `ufw`
  does not block. The docs now publish the database on `127.0.0.1`, start the backend with `SERVER_ADDRESS=127.0.0.1` and Next with
  `-H localhost` (a literal `-H 127.0.0.1` makes Next's locale redirect loop); `mvn spring-boot:run` (the `dev` profile) binds to `127.0.0.1` by default (`SERVER_ADDRESS=0.0.0.0` opens it on
  purpose); the CI E2E stack does the same. `python scripts/docs-as-tests.py --check-loopback` fails on a recipe that forgets it.
- **A new Compose install gives the backend a database role that can only read and write rows.** The stock install used one PostgreSQL
  role that was also the superuser of the container, so a bug that reached SQL in the backend could read files and run programs on the
  database host. `deploy/postgres-init` now makes an owner role (owns the schema, runs the Flyway migrations, not a superuser) and a
  runtime role (`DB_USERNAME`: `SELECT`, `INSERT`, `UPDATE`, `DELETE` and sequences, no DDL) the first time the data directory is
  made; the superuser (`DB_ADMIN_USERNAME`) is for administration. `init-env` writes the two new passwords and `.env.example` has the
  new variables (`DB_OWNER_*`, `DB_ADMIN_*`). **An existing install is not touched by the upgrade** and keeps working with its one
  role; the backend logs one warning per start on a public site while it connects as a superuser, and
  [docs/UPGRADING.md](docs/UPGRADING.md#moving-to-the-three-database-roles) has the opt-in steps (and the rollback, which is a change
  of `.env`). After a restore on an install with the three roles run `10-roles.sh` before the backend starts
  ([docs/BACKUP-AND-RESTORE.md](docs/BACKUP-AND-RESTORE.md#restore-from-a-backup)). Outside Compose, `SPRING_FLYWAY_USER` and
  `SPRING_FLYWAY_PASSWORD` name the owner role. A `.env` that names the owner role must be complete: the postgres container refuses to start without
  `DB_OWNER_PASSWORD`, `DB_ADMIN_USERNAME` and `DB_ADMIN_PASSWORD` (an empty administration pair used to fall back to the runtime role,
  and an empty owner password made the first-run script fail halfway, which left a data directory that is not initialised again), and
  it refuses one name or one password shared by two of the three roles. The check is `deploy/postgres-preflight.sh`, the entrypoint
  of the postgres service, and it runs before the data directory is made; it is not a `${VAR:?}` in the compose file, because Docker
  Compose before v2.40 evaluates a required variable nested inside the default of another one eagerly and refused every single-role
  `.env` (and with it `docker compose exec`, `logs` and the backup cron). `docker compose config` and every other command now work with
  any Compose v2 and any `.env` the earlier versions accepted; `docker compose logs postgres` names the missing variable.
- **The content-sync tool works against the hardened database container.** `export-content.ps1` and `import-content.ps1` used `docker cp`,
  which fails on the read-only postgres container of the compose file (and could not see a file written to its tmpfs). They now stream
  the SQL, the dump and the backup on the standard input and output of `docker exec -i` (`scripts/content-sync/docker-stream.ps1`),
  and the container stages nothing. On an install with the three database roles run them with `-User` set to the owner role
  (`DB_OWNER_USERNAME`); the runtime role cannot create the staging schema. A single-role install keeps `-User` as `DB_USERNAME`.
  Packages are unchanged. `selftest.ps1` now starts a read-only, three-role throw-away container and runs as the owner role, so both
  failures are caught.
- **The containers are hardened, and the database is out of the frontend's reach.** Every service of `docker-compose.yml` runs with
  `no-new-privileges`, all capabilities dropped (postgres keeps the five its entrypoint needs), a read-only root file system with tmpfs
  or volumes for what is written, and a process limit. PostgreSQL sits on a new internal network (`db`) that only the backend joins, so
  the frontend can no longer open a connection to it. The frontend gets a healthcheck (`node`, `/robots.txt`). In the images, the
  frontend application tree is root-owned (it was owned by the user that runs it) and only `.next/cache` is writable; npm, npx,
  corepack, yarn, the Alpine package manager, `nc` and `wget` are gone from the frontend image, and the package manager and `nc` from
  the backend image. The rendered pages and the data cache of Next are now kept in memory (`frontend/cache-handler.mjs`) instead of
  being written under the read-only `.next/server`, and the optimized images are the only content of `.next/cache`, a 96 MB tmpfs
  capped at 64 MB (`images.maximumDiskCacheSize`, it was 500 MB on disk). A tmpfs and the process memory are empty after every start,
  so **`docker compose restart frontend` now clears the page, data and image caches** (it used to clear nothing), and an image is
  encoded again the first time it is asked for after a restart. **Upgrade note:** run `docker compose up -d --build` (the
  containers are recreated; the volumes are kept). A local `docker-compose.override.yml` that mounts or writes somewhere new needs a
  volume or a tmpfs, and a service of yours on the old default network (a proxy, a backup sidecar) can no longer reach the frontend or
  the backend: give it `networks: [app]`
  ([docs/SECURITY.md](docs/SECURITY.md#containers-and-networks), [docs/UPGRADING.md](docs/UPGRADING.md#settings-that-need-care)). `python scripts/test_container_hardening.py` checks the compose file
  and, with `CONTAINER_STACK_DOCKER=1`, builds and starts the stack and inspects the real containers (CI job `images`).
- **The first-run lock of the seeded admin password fails closed on a production run.** `SETUP_LOCK_DEV_SEED=false` is ignored there
  (the lock always runs), and a database error while it runs stops the start instead of being logged as a warning and leaving the
  development password in place. An opted-in development run (the `dev` profile, or `APP_ALLOW_DEV_DEFAULTS=true` with a loopback
  `SITE_URL`, as in the E2E stack) is unchanged.
- **Corrections to the security documentation.** `docs/SECURITY.md` no longer says that every startup refusal comes before the port
  opens (the checks that are startup runners, among them the development admin password, run right after it, and password sign-in
  already rejects that password in the meantime), and no longer says Compose publishes only the frontend (the optional Meilisearch
  profile is also on `127.0.0.1:7700`).
- **The links between the parts of a split deployment must be TLS.** In production the frontend image refuses to start (the container
  exits, `scripts/start-check.mjs`) when `API_BASE_URL` is plain `http` to a host that is neither the machine itself nor a
  single-label service name (`http://backend:8080`); a frontend started another way answers 500 from every page that reads the API.
  One helper, `apiBaseUrl()`, replaces the twenty copies of the default that read the variable. The backend gets `DB_SSLMODE` (the
  JDBC URL now says `sslmode=prefer` explicitly, as pgjdbc always did) and `DB_JDBC_PARAMS`, and a production backend refuses to start,
  before its first connection, when it reaches a remote PostgreSQL with `prefer`, `allow` or `disable` (the last value of a repeated
  parameter counts) or through the factory that accepts any certificate; `verify-full` is accepted and `require` or `verify-ca` warn.
  `verify-full` needs a certificate authority, and pgjdbc does not use the JVM trust store by itself: add
  `DB_JDBC_PARAMS=&sslfactory=org.postgresql.ssl.DefaultJavaSSLFactory` for a certificate from a public CA, or
  `&sslrootcert=<file>` for any other. Compose installs (`postgres` on a private network) and development machines are not affected;
  `API_ALLOW_PLAINTEXT=true` and `DB_ALLOW_INSECURE_TRANSPORT=true` accept a private network on purpose. **Manual step for a backend
  with a remote database, or a frontend with a plain `http` `API_BASE_URL` to a non-local host:** set these before you upgrade
  ([docs/UPGRADING.md](docs/UPGRADING.md#settings-that-need-care), [docs/CONFIGURATION.md](docs/CONFIGURATION.md#split-deployment)).
- **A content package is authenticated before it is restored.** `scripts/content-sync/export-content.ps1` signs the package with
  HMAC-SHA256 under a shared key (`-KeyFile` or `CONTENT_SYNC_KEY`, never inside the package) and `import-content.ps1` refuses one it cannot
  verify unless `-AllowUnsigned` is given: the checksum in the manifest only detected damage, and `pg_restore` runs the SQL of the dump on
  the live database. The import also accepts only the three files in the ZIP and only the schema `export_content` and its content tables
  in `pg_restore -l`, all before anything is restored (also with `-DryRun`). **Manual step for existing users of the tool:** create a key
  once (`openssl rand -hex 32 > content-sync.key`) and pass `-KeyFile` to both scripts
  ([scripts/content-sync/README.md](scripts/content-sync/README.md)).
- **Vulnerabilities are reported through GitHub's private vulnerability reporting.** `SECURITY.md` no longer asks reporters to write to
  an address that had to be filled in before publishing: the channel is the "Report a vulnerability" button of the Security tab (the
  owner checklist in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#release) says to enable it before the announcement), with a public
  issue without details as the fallback when the button is missing.
- **`init-env` keeps the generated secrets off command lines and private to you.** `scripts/init-env.sh` used to expand each secret into
  the arguments of `sed`, readable by every local user in `/proc/<pid>/cmdline` while it ran; the values now reach `sed` through a mode 600
  script file written by a shell builtin. `scripts/init-env.ps1` creates `.env` with access for the current user only (Windows:
  inheritance off; PowerShell 7 elsewhere: `chmod 600`) before it writes a secret. `python scripts/test_init_env.py` checks both.
- **The nginx example states its TLS floor.** Both port-443 blocks set `ssl_protocols TLSv1.2 TLSv1.3`, `ssl_session_tickets off`,
  `ssl_prefer_server_ciphers off` and `server_tokens off` instead of relying on the distribution's defaults (`certbot certonly` never adds
  certbot's own options file). `nginx -t` and the TLS 1.1 refusal are checked on a real nginx by `scripts/test_deploy_examples.py`.
- **The reverse proxy examples keep search terms out of the access log.** `deploy/nginx.conf.example` logs every request with
  `log_format no_query` (`$uri`, no `Referer`) in all three server blocks, not only for the newsletter and login paths, and
  `deploy/Caddyfile.example` filters the query and the `Referer` out of Caddy's error log, which names the request when the upstream
  fails. `python scripts/test_deploy_examples.py` checks both files (with `DEPLOY_EXAMPLES_DOCKER=1` also on a real nginx and Caddy
  in Docker). Operators who copied the old nginx file should copy the new one ([docs/INSTALL.md](docs/INSTALL.md#tls-with-nginx-and-certbot)).

### Changed

- **Role changes want a second proof.** A role change to or from ADMIN, and a change that makes a reader an author (in `/admin/users`
  or by approving an application), needs a sign-in from the last 10 minutes and the acting administrator's own code
  (`code` in the body of `PATCH /api/v1/admin/users/{id}/role` and of `POST /api/v1/admin/author-applications/{id}/approve`), checked
  before anything is written: 401 `REAUTHENTICATION_REQUIRED`, 401 `MFA_CODE_INVALID`, then the usual brakes of the second step. A
  promotion to ADMIN also deletes the account's two-step enrollment, so the promoted account enrols again with the operator's
  enrollment code. The panels of the Users and Author applications pages ask for the code; an API client that changes roles must send
  it ([docs/SECURITY.md](docs/SECURITY.md#authentication-and-sessions)).
- **Access tokens are validated harder.** The decoder accepts only HS256, requires `exp` and `iat`, and requires the issuer
  `blog-backend` and the audience `blog-api` that the backend now puts in every token; a hand-made token with `alg` `none`, HS512,
  no `exp`, or another issuer or audience is refused (the regression tests build each). `JWT_SECRET` must have at least 8 different
  bytes. Tokens issued before the upgrade are refused once, within 15 minutes
  ([UPGRADING.md](docs/UPGRADING.md#release-with-session-and-cookie-changes)).
- **Reusing an old refresh token ends that session, not every session of the person.** A refresh token presented again after its
  grace period used to revoke every refresh token of the account, so a rotation whose response was lost on the way signed out a
  second device as collateral. It now revokes the session the token belongs to (the chain of rotations of that sign-in, successor
  included) and leaves the person's other sessions and `tokens_valid_after` alone. A suspension, a password or role change and "sign
  out everywhere" still end every session. The log line says `tokensRevoked` instead of `sessionsRevoked`.
- **Sessions of admins and authors end.** A session of an ADMIN or AUTHOR account now ends after 7 days without use and, however active
  it was, 30 days after the person signed in (`PRIVILEGED_SESSION_IDLE_TTL` and `PRIVILEGED_SESSION_ABSOLUTE_TTL`, both optional);
  readers keep today's sliding 30 days. Each new session means a new second-step code for an account that has one. The start of a
  session is `refresh_tokens.authenticated_at`; migration V45 gives the sessions that were open before the two-step release a real
  start in place of the `epoch` marker. Every token response carries `refreshExpiresIn` (seconds) and the frontend sets the cookie's
  `Max-Age` from it ([UPGRADING.md](docs/UPGRADING.md#release-with-session-and-cookie-changes)).
- **An access token must name a live session of its own account.** The backend used to accept a token with no `sid` claim, and to check
  only that a session with that id was live, not that it belonged to the subject; the recent-sign-in time was read from the token. Now a
  token without a session is refused (401), the session must be the subject's own, and the start of the session comes from its row. A
  holder of `JWT_SECRET` alone can no longer forge a working admin token. The `TokenService.mint` overloads that made a token without a
  session are gone.
- **The session cookies are `__Host-` prefixed in production.** `access_token` and `refresh_token` become `__Host-access_token` and
  `__Host-refresh_token` (Secure, `Path=/`, no `Domain`), so a sibling subdomain or a network attacker cannot plant a session cookie
  that is read before the real one. Development on plain HTTP keeps the plain names. The old names are never read and are deleted by the
  next response that sets or clears the session, so everybody signs in once after the upgrade
  ([UPGRADING.md](docs/UPGRADING.md#release-with-session-and-cookie-changes)).
- **The Content Security Policy is enforced, and violations are reported.** The full policy that every page sent as
  `Content-Security-Policy-Report-Only` is now the `Content-Security-Policy` header (default, script, frame, object, base and form
  origins; no nonce, so `'unsafe-inline'` stays for scripts), and the policy names a new route, `/api/csp-report`, that logs one line per
  violation (directive and blocked origin only, 100 per 10 minutes per client address, 8 KiB at most). Images from any `https` host
  stay allowed. See [docs/SECURITY.md](docs/SECURITY.md#content-security-policy).
- **Upgrading needs a step: `MFA_ENCRYPTION_KEY` is required** (the backend refuses to start without it, in every mode), every admin
  session ends at the upgrade, and the next admin sign-in enrols an authenticator. Deploy the frontend before the backend. An API client
  that signs in as an admin now follows a two-step handshake: `POST /api/v1/auth/login` answers `202` with a challenge and no token, and
  `POST /api/v1/auth/mfa/verify` answers with the tokens. Details and the other lockouts to avoid:
  [docs/UPGRADING.md](docs/UPGRADING.md#release-with-two-step-verification).
- **The image names in `docker-compose.yml` default to local-only names.** `BACKEND_IMAGE` and `FRONTEND_IMAGE` used to default to a
  placeholder account on `ghcr.io`, so `docker compose pull` could fetch images from an account that is not this project's. They are
  now `blog-engine-backend:local` and `blog-engine-frontend:local`: `docker compose up -d --build` is unchanged, and to run the
  published backend image you set `BACKEND_IMAGE` to the publishing namespace and pin a version tag or a digest
  ([INSTALL.md](docs/INSTALL.md#prebuilt-backend-image-or-build-from-source)). The release scan refuses the placeholder namespace.
- **The release workflow checks the tag before it publishes.** The images are pushed only for a tagged commit that is on `master`,
  after the approval of the new `release` environment (it approves nothing until reviewers are set in the repository settings,
  see [DEVELOPMENT.md](docs/DEVELOPMENT.md#release)), and they carry build provenance and an SBOM.
- **A release needs a green CI run for the tagged commit.** The first job of `release.yml` asks GitHub for the runs of `ci.yml` and
  stops the release, before anything is built or approved, unless there is a successful push run on `master` for exactly the tagged
  commit. A tag on a commit whose CI is red, still running or cancelled publishes nothing; tag again once it is green. The job got
  `actions: read` to list the runs (still read-only). The owner checklist in [DEVELOPMENT.md](docs/DEVELOPMENT.md#release) now also
  asks for a branch ruleset on `master`, because the checks in the workflow are only as strong as who may edit the file there.
- **The published backend image is scanned before they are published, and signed.** The backend image is built once for `linux/amd64` into an
  archive and scanned with the pinned Trivy in a read-only job of its own, and the job that pushes needs it, so a HIGH or CRITICAL
  finding with a fix stops the release before anything is public; after the
  push, the digest is signed with cosign, keyless, and the signature is verified in the same job. Check it with cosign 3 or newer and the command in
  [INSTALL.md](docs/INSTALL.md#prebuilt-backend-image-or-build-from-source) (`cosign verify ... --certificate-identity-regexp ...`). The
  SBOM scanner, QEMU and BuildKit images of the workflow are pinned by digest. `id-token: write` is granted to the `images` job only.
  The owner checklist in [DEVELOPMENT.md](docs/DEVELOPMENT.md#release) lists the repository settings that give the signature its
  meaning (reviewers of the `release` environment, a tag ruleset, a master ruleset) and what to do after the first release.
- **Every container image the repository builds from or runs is pinned by digest.** The `FROM` lines of both Dockerfiles, the
  PostgreSQL and Meilisearch images of the compose files, the QEMU, BuildKit and SBOM scanner images of the release workflow, and the
  images of the release export script now carry `name:tag@sha256:...`; the scanner containers of CI mount the checkout read-only; a
  `${{ }}` expression no longer sits inside a CI command (the pull request base branch goes through `env:`). Two new checks
  (`scripts/test_image_pinning.py`, `scripts/test_workflow_expressions.py`) run in the CI `python` job. Existing installs are not
  affected: a build just starts from the same bytes every time. See [docs/CONVENTIONS.md](docs/CONVENTIONS.md#9-ci-supply-chain-pins-and-scans).
- **Dependabot also watches the compose files, waits a week, and keeps the risky packages apart.** New `docker-compose` entries cover
  PostgreSQL and Meilisearch, every entry has a 7-day `cooldown`, and the Markdown and diagram pipeline, the image parsers, BouncyCastle
  and the Boot parent get their own pull requests instead of sitting in the weekly catch-all group. `scripts/test_dependabot_coverage.py`
  fails when a manifest folder has no entry and when the Meilisearch version of a script, test or doc differs from the compose pin.
  The compose entries skip the major versions of PostgreSQL (a new major needs a data migration), and the CI end-to-end job runs on
  the same PostgreSQL digest as the compose files.
- **Installs run no package scripts.** CI and the frontend image use `npm ci --ignore-scripts`, so a dependency that gains an install
  script cannot run code while the image is built; the frontend CI job also runs `npm audit signatures`. A test
  (`frontend/lib/supply-chain/lockfile-install-scripts.test.ts`) lists the four lock entries that have an install script and fails
  when a new one appears. The build, the lint, the type check and the tests were run without the scripts and pass.
- **CI scans the secret history, and the gitleaks allowlist names values, not files.** The `guards` job runs `gitleaks git` next to
  `gitleaks dir` (a pull request from its merge base, a push over every commit), so a secret that was added and removed again is
  found. The allowlist used to exempt four whole test files; it is now a list of the exact invented values (the RFC 6238 test secret,
  the fixture tokens and keys of the second-step and newsletter tests, the development key of the second step), and the scan of the files
  reports again when a real secret is added to those files. This also clears the findings that the fixtures of the two-step
  verification work had added. `scripts/test_gitleaks_config.py` checks the shape and, with Docker, both scans.
- **The Maven build accepts Maven Central only, and a checksum mismatch fails it.** `maven-enforcer-plugin` (a build plugin, not a
  dependency of the jar) runs first in every build and refuses an older Maven or Java and any repository or plugin repository other than
  Maven Central; `backend/.mvn/maven.config` turns checksum warnings into failures, also in the Docker image build. If your
  `settings.xml` has a mirror, the build now stops with the name of the repository (add the mirror to the allowed lists in your own
  checkout, see [docs/SECURITY.md](docs/SECURITY.md#supply-chain-what-the-build-trusts)). A "Supply chain" section in SECURITY.md lists what the
  build trusts; signature checks of artifacts are not used, with the reason.
- **Dependency updates: DOMPurify 3.4.17, TwelveMonkeys 3.15.3, springdoc 3.1.1.** DOMPurify (used inside Mermaid) moves within the range
  Mermaid declares, which clears the critical and high advisories that failed the CI dependency scan. TwelveMonkeys (image parser) and
  springdoc get their latest patch release. One low advisory stays open: KaTeX inside Mermaid 12.1.0, fixed only by Mermaid 12.2.0, which
  needs the census of diagram types in the authoring prompt to be run again (`MERMAID_VERIFIED_VERSION`). ESLint stays on 9.39 (the last 9.x release, marked
  deprecated): the React, import and a11y plugins of `eslint-config-next` do not accept ESLint 10 yet. A new test
  (`frontend/lib/supply-chain/deprecated-dependencies.test.ts`) fails on a deprecated direct dependency unless it is listed with its
  reason, and notices when the blocker is gone. The libraries that Boot does not manage are named in a comment of `pom.xml`.
- **"Download .md" is now "Download ZIP".** The post editor button and the link in the post list download the saved post as a ZIP
  package in the format the post import reads (`article.md` plus the images under `assets/`), so a post and a package convert both
  ways. The route `/admin/posts/<id>/export` returns the ZIP; the single Markdown file stays available as `?format=md`. A post whose
  package would be too large is refused with a message.
- **Saving a series order** in the admin keeps the parts that authors declared for the posts that stay in the series.
  `SeriesService.setPosts` and deleting a series now take the translation-writes lock first, so they cannot deadlock with an import.
- **Search text and reading time** leave out the block marker lines and diagram sources (the default PostgreSQL search still indexes them).
- **The Markdown download** (now `?format=md`) now also writes the post's `slug`, its `language` and, when there is one, the `translation_of` link, so the
  file can be read by the post import. Older readers of the file, such as `seed/push.py`, keep working.
- **Limits by client address in the backend; `CLIENT_IP_TOKEN` is new and required.** Next forwards the reader address it derives to the
  backend in `X-Client-Ip`, proved by the shared secret `CLIENT_IP_TOKEN` in `X-Client-Ip-Token` (constant-time compare; without the
  secret both headers are ignored and the socket address counts). The backend then limits the contact form (5 per hour per address, 60
  per hour for the whole site, besides the 5 per hour per email address), newsletter signups (5 per hour per address, 120 queued
  confirmations per hour for the whole site, besides 3 per hour per email address; still answered 202), confirmations and unsubscribes
  (40 per hour per address, together; 300 per hour for the whole site for confirmations only, because a whole-site ceiling on
  unsubscribing would let stray tokens block real unsubscribes), admin sign-in (20 per 10 minutes), the second step of a sign-in (20 per 10 minutes, the three `/auth/mfa/*` calls together), session refresh (60 per 10 minutes),
  first-run setup (5 per minute, before the existing 10 per minute for the whole process) and search (120 per minute, before the existing
  1200 per minute), so a backend reached without Next is no longer unlimited. The maps are bounded: a flood of invented addresses cannot grow
  memory or push a counted address out. **Manual step:** set `CLIENT_IP_TOKEN` (`openssl rand -hex 32`, the same value for the backend and
  the frontend) before you upgrade; compose and the production backend refuse to start without it, and `scripts/init-env` writes one
  ([UPGRADING.md](docs/UPGRADING.md#settings-that-need-care)). New properties: `app.rate-limit.{contact,newsletter-signup}-{client,global}`, `newsletter-token-client`,
  `newsletter-confirm-global`, `login-client`, `mfa-client`, `refresh-client`, `setup-client`, `search-client` ([CONFIGURATION.md](docs/CONFIGURATION.md#rate-limits)). The `/search`
  page no longer exempts an unknown address from the per-IP allowance: it counts in the shared "unknown" bucket like every other limiter.
- **The admin client refuses an identifier that is not a UUID.** Every id that `lib/admin-api.ts` puts into a backend path (posts, media,
  revisions, series, gallery photos, categories, tags, comments, users, applications, contact messages) is checked first; `..`, `.`, a
  value with a slash or anything else that is not a UUID is a 400 before any request, so it cannot redirect the caller's own token to
  another endpoint. The UUID pattern now lives in one module, `lib/uuid.ts`.
- **The admin dashboard no longer shows text taken from its URL.** After deleting a post the redirect carries `?deleted=1` and the
  dashboard shows a fixed sentence ("The post was deleted.") only for that exact value; it used to print the title found in `?deleted=`,
  which let a crafted link put its own sentence in a green banner on a signed-in person's page.
- **The authoring prompt download confirms the role with the backend.** `/admin/posts/import/authoring-prompt` served a file generated in the
  frontend on the strength of the unsigned role claim of the cookie, so a hand-made token plus any refresh cookie could download it
  (it holds nothing but the public block rules). It now asks `GET /auth/me` first; a refused token goes to the sign-in, a reader or a
  suspended account gets 403, and a backend that cannot be reached gets a 502. The shell itself still renders from the claim, and
  [docs/SECURITY.md](docs/SECURITY.md#what-is-not-protected) now says so; a test requires every route handler of the shell to ask the backend.
- **Browser storage is bound to the account and cleared on sign-out.** The editor's unsaved copy of a post is keyed by the user id and the
  record names its owner, so the next account on the same browser is never offered it (the admin deletes other accounts' copies, expired
  ones and old-format ones when it opens). Every sign-out (the account menu and profile page on the site, the admin Sign out button, Sign
  out everywhere) now deletes the drafts, the recent searches and the comment drafts, and stops the editor from writing again: the admin
  button stops the writes before it sends the request, and a `BroadcastChannel` stops editor tabs that are still open. A session that
  only expires keeps the copy, so signing in again restores it. See [docs/SECURITY.md](docs/SECURITY.md#in-the-browser). **Manual step:**
  none; copies written by the earlier version are dropped once ([docs/UPGRADING.md](docs/UPGRADING.md#settings-that-need-care)).

- **Passwords are hashed at the OWASP minimum and strengthened on sign-in.** Argon2id uses 19 MiB of memory, 2 iterations and 1 lane (it
  was Spring's 16 MiB). A hash made with weaker parameters is replaced right after its owner signs in with the correct password (a wrong
  password, a suspended account and a password changed in the meantime never rewrite it). The account that is still waiting for the
  first-run setup now takes the same Argon2 run and gives the same 401 as an unknown email, instead of answering faster and writing a
  warning per attempt.
- **Guessable secrets are refused in production.** `JWT_SECRET`, `VIEWS_TOKEN`, `CLIENT_IP_TOKEN` and (with `smtp`) `NEWSLETTER_SECRET`
  made only of placeholder words, one repeated pattern, fewer than 6 different characters, or mostly a run like `abcdefghij` stop the
  start, and the two tokens need 16 characters; every value of the documented commands passes. The message names the variable and the
  reason, never the value ([docs/SECURITY.md](docs/SECURITY.md#startup-refusals)).
- **Logs name the account that acted or was refused, never an address.** A refusal (`Access denied`, any `ApiException`) carries
  `actor=<id|anonymous>`; every write under `/api/v1/admin/**` leaves an `admin request` line with the actor, method, path, handler and
  status; the administrator's reset of an author's two-step verification, a suspension or reactivation, a role change and a site content
  save or restore name the administrator; a correct step-up code is recorded with its purpose. The administrator's address is no longer
  written at startup. Records and properties that hold a secret (`LoginRequest`, `RefreshRequest`, `TokenResponse`, the second-step
  answers, `SecurityProperties`, `AdminAccountProperties`) print none in `toString`, and ArchUnit keeps it so
  ([docs/SECURITY.md](docs/SECURITY.md#audit-events)).
- **Outgoing mail is stricter.** `SMTP_STARTTLS=false` is refused for a host that is not on this machine; `SMTP_PROTOCOL=smtps` (port 465)
  is new for providers with implicit TLS, and the server certificate is checked against `SMTP_HOST` on both. A subject is one line (a
  post title cannot add a header), and a recipient or Reply-To with an RFC 2047 encoded word is refused.
- **The GitHub address override is refused on a public site, and `app.i18n.locales` is checked for its shape.** See
  [docs/UPGRADING.md](docs/UPGRADING.md#settings-that-need-care).

### Fixed

- **Sign out ends the session even with a token that was already rotated, and the admin button no longer claims a sign-out that did not happen.** Logout with a rotated refresh token (a rotation answer that never arrived) answered 401 and left the live successor valid; it now revokes the whole session of that token and no other. The admin Sign out button treated any HTTP answer as a sign-out: a proxy error, a refused origin or a limiter cleared the editor drafts and sent the person to the login page while the session lived; it now keeps everything, shows a notice and lets the person try again.
- **An article made of thousands of links, emphasis spans or footnote references is shown as plain text before it costs seconds.** The
  Markdown size estimate priced a run of markers by the square of its length per paragraph, which does not see markup spread over many short
  paragraphs: 62,400 links, 25 to a paragraph, took 4 s through the page pipeline (5.6 s in the review) at an estimate of 1,500, 62,000
  emphasis spans 2.7 s, 14,400 references to one footnote 2.1 s. Every marker character (`*`, `_`, `~`, `[`, `]`, the backtick) now costs
  0.04 ms and every `[^` 0.16 ms more, so the biggest article of each shape the estimate admits holds about 14,000 links or emphasis
  spans (5,700 footnote references) and is read in under a second; a real article has a few hundred. The `too-heavy` message names the
  markers. The repository documents stay inside (the 146 KB `backend/README.md` at 56 percent of the budget). **Manual step:** none; an
  article that is now over the budget is shown as plain text in the editor preview, which says why
  ([docs/SECURITY.md](docs/SECURITY.md#authentication-and-sessions), "Markdown in posts").
- **The syntax highlighting of an article is bounded.** A code fence with a language went to Shiki without any limit: ten lines of 5,000
  characters took 12 s on the one Node process, a review run of a 500 KB fence 118 s, on every render of the page and of the preview. A
  line of 300 characters or more is now drawn without colour, the fences of one article are highlighted up to 120,000 characters and
  2,000 lines, and all the highlighting of one article may take 1.5 s, shared out as the time limit of each line; a block past a limit is
  still a code block with the text intact, only without colour. Nothing to configure
  ([docs/SECURITY.md](docs/SECURITY.md#authentication-and-sessions), "Markdown in posts").
- **A long site name or post title no longer breaks the phone layout.** Below 768px the header keeps its first row for the site name and the
  four controls: the name takes whatever room the controls leave, also where they are wider (from 640px: sign-in text, language chevron,
  bell, account name), and a name longer than that (the packaged default is longer than it on a 320px or 360px phone) is cut with an
  ellipsis instead of pushing the controls to a row of their own, which made the header three rows. The link rows of "What to read next"
  and of the `/writing` band wrap a long title with no space (80 characters, a URL-like title) instead of making the whole post page
  scroll sideways on a phone. Nothing changes from 768px and 640px up.
- **Expected client errors no longer fill the log.** An unknown slug (404), a malformed request, a conflict and a request that the
  firewall refuses are logged at DEBUG with the error code and the trace id, not at WARN with the slug the visitor asked for; a refused
  token (401) or a 403 stays at WARN without the message, and a 5xx keeps its message. A request with no credential at all (every anonymous 401) is DEBUG too;
  a line that stays at WARN quotes at most 120 characters of the path and no query; and a 429, a token that was sent and refused
  (`Authorization: Bearer <junk>`) and an upload over the multipart limit are WARN once a minute per reason with a count of the similar
  answers left out, so a crowd that is past a ceiling, or a caller who sends junk tokens, no longer writes a line per request. Anonymous requests
  without a credential, for unknown paths or malformed, and a crowd past a ceiling can no longer rotate the security lines out of the
  3 x 10 MB log window. Volume through the audit lines themselves (refused tokens, 403s of a signed-in account, wrong passwords from many
  addresses) still can: ship the logs off the machine or raise the rotation ([docs/SECURITY.md](docs/SECURITY.md#audit-events)).
- **A post URL no post can have is a 404, not a 500.** `/posts/<slug>` answers 404 at once, without asking the backend, for a slug with
  a slash, a control character (NUL included) or more than 255 characters, and a backend 400 for a slug it refuses is a 404 too (it was
  rethrown as a 500 with a stack trace in the log). A 5xx from the backend still passes through.
- **The backend bounds the size of what it reads.** A JSON body over 64 KiB (6 MiB under `/api/v1/admin/`) is refused with 413 before
  anything reads it, a chunked body is counted as it streams, a string over 1,000,000 characters or a document over 8 MiB is refused by
  the JSON reader (the Jackson 3 defaults were 100 million characters and no limit), and the anonymous requests (sign-in, refresh,
  contact, newsletter, setup) carry `@Size` bounds for a clean 400. Before, a backend with its own public URL could be taken down by a
  few large anonymous bodies. A chunked body that a filter reads (Spring Boot's form filter for PUT, PATCH and DELETE) is answered with the
  same 413 instead of a 500 and a stack trace, and that filter is off because nothing takes a form body. New properties
  `app.request-limit.public-body` and `.admin-body` ([CONFIGURATION.md](docs/CONFIGURATION.md#backend-properties-without-a-variable)).
- **A crowd can no longer keep the owner from signing in.** The backend counters of the password step, the second step, session
  refresh and the first-run setup used to refuse every new address once 20,000 addresses were counted, so a flood from that many
  invented addresses (one IPv6 prefix holds tens of thousands of `/64`) answered 429 to the owner's sign-in, code and refresh for as
  long as it lasted. Those four maps now drop their stalest addresses to make room and always serve a new one; the contact,
  newsletter and search maps keep refusing a new key at the ceiling ([docs/SECURITY.md](docs/SECURITY.md#rate-limits)).
- **A crowd can no longer keep the owner from claiming a fresh instance.** The first-run setup count for the whole backend (10 per
  minute) was charged to every attempt before the code was looked at, so two addresses sending five wrong codes a minute each kept the
  right code answering 429. It now counts only wrong codes, after the comparison, and defaults to 120 per minute
  (`app.rate-limit.setup.per-minute`); the right code is never refused for it. Guesses stay bounded per client address (5 per minute),
  which is safe for the generated 256-bit code; set `SETUP_TOKEN` long and random if you choose your own. A finished instance
  answers `/setup` with 404 from a plain read of the flag, without a transaction or the setup lock
  ([docs/SECURITY.md](docs/SECURITY.md#first-run-setup-code)).
- **The Next rate limiter keeps one table per kind of limit.** The sign-in, second-step, Security page, GitHub sign-in, setup, view
  beacon, search, contact and newsletter counters shared a single 10,000-entry map, so about 10,000 anonymous keys (a view beacon or a
  search suggestion from as many addresses) pushed a running sign-in counter out and gave the address a fresh allowance. Each kind now
  has its own table, an expired entry is swept wherever it sits, and a full table drops the entry that ends first and always serves the
  new key ([docs/SECURITY.md](docs/SECURITY.md#rate-limits)).
- **An unreadable client address no longer buys a wider sign-in allowance.** A request whose `X-Forwarded-For` entry was missing or not
  an IP address counted in a shared "unknown" key of 100 attempts per 10 minutes, ten times the allowance of one address, for the admin
  sign-in, the second step, the Security page, GitHub sign-in and the first-run setup. That key now has the allowance of one address for
  those limits (the views, search, contact and newsletter limits keep 100). Next also logs one `[client-ip]` line per process in
  production when a header is shorter than `TRUSTED_PROXY_HOPS` or missing, which points at a proxy that is not in the way or at too
  many hops ([docs/SECURITY.md](docs/SECURITY.md#reverse-proxy-and-the-client-address)).
- **The Cloudflare guidance no longer lets a caller who reaches the origin choose its rate-limit key.** The documents said to set
  `TRUSTED_PROXY_HOPS=2` behind Cloudflare, which is right only if the origin accepts Cloudflare alone: nginx appends to the
  `X-Forwarded-For` a direct caller sent, so for that caller the second entry from the right is its own invention and every
  per-address limit, in Next and in the backend, could be rotated. The guidance (INSTALL, SECURITY, CONFIGURATION, `.env.example`,
  compose, the nginx and Caddy examples) now keeps `TRUSTED_PROXY_HOPS=1` and has nginx restore the visitor address with
  `set_real_ip_from` for Cloudflare's ranges and `real_ip_header CF-Connecting-IP` (`deploy/nginx.conf.example`, the include is
  commented out), which holds even when the origin is reachable, and says how to let the origin accept Cloudflare alone before
  using `2`. `python scripts/test_proxy_guidance.py` (CI) fails when a place recommends `2` without that restriction
  ([docs/INSTALL.md](docs/INSTALL.md#behind-cloudflare)).
- **A malformed request is answered with the API's envelope and its own status, not with a 401.** A matrix parameter
  (`/api/v1/admin/users;x=1`) or an unknown method was refused by the Spring Security firewall, `TRACE` by Tomcat before Spring saw
  it; both were dispatched again to `/error` without the caller's token and answered 401 "Authentication required", even to a
  signed-in author. `ApiRequestRejectedHandler` now writes the 400 `VALIDATION_ERROR` envelope for a firewall refusal, and
  `ApiErrorDispatchFilter` answers the container's error dispatch with the envelope and the status the container chose (405 for
  `TRACE`), ahead of the security chain and without ever reaching the dispatcher servlet, whose default for `TRACE` would echo the request
  headers. Nothing reached a handler before either; only the status and the body change
  ([docs/SECURITY.md](docs/SECURITY.md#audit-events)).
- **The size limits of a post's text are also in the database.** Migration `V46` adds CHECK constraints on `posts` for the body (500,000
  characters) and the excerpt (1,000), `NOT VALID` first so that a site with an older, longer post still starts, and validated at once
  when there is none ([docs/UPGRADING.md](docs/UPGRADING.md#settings-that-need-care)). Restoring a revision longer than a post may
  be answers 400 instead of a conflict, and an excerpt over 1,000 characters in an imported file is a problem of that file instead of
  a failed write ([post-file-format.md](docs/post-file-format.md)).
- **No list of posts reads the body of a post, with one exception.** The public lists, the popular and featured lists, the
  PostgreSQL search, the series pages, the bookmarks and the admin list loaded the whole text of every post they showed and computed the
  reading time from it, so their cost grew with the size of the posts (up to 500,000 characters each). They now read `PostCard`, the row
  of `posts` without its body, and the reading time is stored with the post (migration `V47`, filled at the first start; a post that is
  over the limits of `V46` keeps 0 until it is shortened). The page of one post still reads its body. **The exception is the search
  through Meilisearch:** it re-validates the posts of one result page on PostgreSQL (`SearchVisibility`) and compares the snippet of the
  index with the current text of each, so it loads those posts whole. That is at most 50 posts per request, behind the search limits
  (120 per minute per address, 1200 for the process), and it is the only list that does ([docs/CONVENTIONS.md](docs/CONVENTIONS.md#3-architecture-archunit-comblogarchitecturearchitecturetest)).

- **RSS and Atom feeds say how long a cache may keep them.** A feed is sent with `Cache-Control: public, max-age=0, must-revalidate`, a
  feed that cannot be built (503) with `no-store` and `Retry-After`, and a 404 feed with the revalidate rule, so a CDN or caching proxy in
  front of the site no longer applies a default lifetime of its own (CloudFront keeps an answer 24 hours by default) and keeps a withdrawn
  post or a 503 after the backend recovered. See [docs/SECURITY.md](docs/SECURITY.md#caching-and-a-cdn-in-front).
- **`GET /.gitkeep` is a 404 again.** The placeholder file `frontend/public/.gitkeep` is gone: Next served the dotfile from the web root and
  answered a request for it with a 500, which error alerting counts.

- **The admin sign-in route reads at most 16 KB.** `/admin/login/submit` buffered the whole body of an anonymous request (a 30 MB body was
  accepted); it now reads it with the limit every other public route uses and answers 413, and it refuses an address over 254 characters
  or a password over 256 with 400 before the backend hashes anything.

- **A bulk unpublish or delete clears the public cache even for posts that were already gone.** The posts found already unpublished or
  deleted (changed by a script, an API call or SQL, which clear nothing) used to leave the public pages untouched; the admin's own click
  now heals the cache. `docs/SECURITY.md` no longer says that a page stays stale for five minutes at most: a page nobody opened serves one
  stale copy however old it is.

- **An article that costs the Markdown parser too much work is shown as plain text.** The parser is slower than linear for ordinary shapes
  (24 KB of `*]` took 25 s, 100 KB of quotes 42 s, 500,000 characters of inline code 16 s) and runs on the one Node process that serves
  the site, on every render of the page, the preview and the feeds, so the size limit of a post did not bound the cost. Every parser of an
  article now asks first (`lib/blocks/reading.ts`): one pass over the lines prices the shapes that blow up (`lib/blocks/parse-budget.ts`),
  and an article over the budget is read as plain text, with one `too-heavy` problem in the editor preview and on the import page. The
  prices cover what the stages after the parser do with a node as well as the parser: link literals (`www.a.co`, e-mail addresses; 450 KB of
  `www.a.co ` took 24 s through the page), table cells (a table of 5 rows and 20,000 columns took 11 s), colons (`remark-directive` reads a
  text directive at every one) and unclosed `<!--`, `<?` and `<![CDATA[` (each is tried against the rest of its paragraph: 1,600 of them in
  225 KB took 10 s). At the budget 58 shapes were read in under 2 s through the whole page pipeline (54 in under a second); the longest
  document of the repository costs two fifths of it. A parse that overflows the call stack (thousands of open tags) is shown as plain text
  too, instead of a 500. `PARSE_PROBE=1` repeats the measurement ([docs/SECURITY.md](docs/SECURITY.md),
  [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#testing)).

- **The page cache is bounded, and a restart no longer brings back a withdrawn post.** Next wrote every page it rendered on demand
  (about 250 KB each, a 404 for a made-up post address included) to disk and never removed it, so a script asking for random addresses could
  fill the disk. Pages rendered on demand and the data cache are now kept in Next's in-memory LRU (`frontend/cache-handler.mjs`,
  `cacheMaxMemorySize`, 50 MB by default), which bounds that flood and writes nothing to disk. `ROUTE_CACHE_MAX_MB` (new, default 256,
  `0` for no limit) bounds `.next/server/route-cache` only for a build without the handler and **has no effect while the handler is
  configured**, as it is in the image. And because the record of which tags the admin had expired lives only in memory, a restart
  served an unpublished post again from the files on disk; entries in memory die with the process, and the image build now removes the
  pages `next build` prerendered that revalidate (they were rendered without a backend, so they held the neutral default content and were
  served once after every restart), so the first visit to each is rendered against the backend. Outside the image the server removes the
  same files at every start. The optimized images stay. See [docs/SECURITY.md](docs/SECURITY.md#caching-and-a-cdn-in-front) and
  [docs/CONFIGURATION.md](docs/CONFIGURATION.md#frontend-runtime-variables).

- **A page can be served stale for an hour at most, and the docs say what a CDN in front must do.** Pages carried
  `stale-while-revalidate=31535700` (a year): Next itself served an entry of any age once before it rendered again, and a shared cache was
  told it could do the same. `expireTime: 3600` in `next.config.ts` makes it `s-maxage=300, stale-while-revalidate=3300` and renders an
  entry older than an hour before answering, a 404 page included. [INSTALL.md](docs/INSTALL.md#a-cdn-in-front) (and its Vietnamese copy)
  now tells what to purge after an unpublish, a delete or an image deletion: `updateTag` never reaches a CDN, and `/media/*` is cached
  for a year.

- **The proxy examples stop TRACE and rate limit the expensive paths.** `deploy/nginx.conf.example` and `deploy/Caddyfile.example` answer
  405 to `TRACE`, `TRACK` and `CONNECT`, which made Next throw a 500 and log a stack trace for every request. The nginx example also
  limits the request rate per address (pages 20 a second with a burst of 100; pictures, share cards, feeds and the sitemap 5 a second),
  answers 429, and keeps pictures in a one-hour cache (keyed by the path alone, so a random query string cannot miss it) and share cards
  in a five-minute one, so a flood of requests for one picture is one request to Next.
  Checked against nginx 1.27 and Caddy 2 with a stub upstream; `python scripts/test_proxy_availability.py` keeps the rules. Copy the new
  blocks into your own configuration and create `/var/cache/nginx/blog` ([docs/INSTALL.md](docs/INSTALL.md#limit-the-rate-of-requests)).

- **The expensive anonymous reads are limited per address, and the share card is drawn once for every address that is not a post.**
  Pictures (`/media/*`, 1,200 a minute), the image optimizer (`/_next/image`, 1,200 a minute, counted in `proxy.ts` on the reader's own
  request: the request it makes to `/media` for itself carries the address of the reverse proxy and is not counted, or one source
  would use up the allowance of every reader), share cards (`/api/og/posts/*`, 60 a minute), the RSS feeds (120 a minute) and the sitemap
  (60 a minute, in `proxy.ts`) answer 429 with `Retry-After` past their allowance, before they read the database or draw anything; a
  caller whose address cannot be read is not limited. The share card of an address that is not a post is one picture drawn once and kept (it may be cached for five minutes),
  and an address that cannot be a post never reaches the backend. See [docs/SECURITY.md](docs/SECURITY.md#rate-limits).

- **The backend reads at most 8 images from the database at once.** Each served image is read whole into the heap (up to 4 MiB), so a
  crowd asking for large pictures could use all of the container's memory and end the process. A ninth read waits 2 seconds
  and then gets 503 `MEDIA_BUSY` (Next shows a 502 that is never cached); a `304` reads no bytes and is not counted. The owner's own
  exports (a post package, the site export) read their images through a path without that bound, so a flood of anonymous reads never
  makes a package leave its cover or pictures out.

## [1.0.0-rc.1] - 2026-11-08

First release candidate of Blog Engine, a bilingual (English and Vietnamese), self-hostable blog engine. **This is a release
candidate and has not been published as a final release.** Expect to find rough edges, and read
[the limits](docs/SECURITY.md#what-is-not-protected) before you expose a site. The list below describes what the code does today.

### Added

- **Stack and installation.** Spring Boot 4 (Java 25) backend, Next.js 16 (React 19) frontend, PostgreSQL 18 with Flyway migrations,
  deployed with one Docker Compose file (`postgres`, `backend`, `frontend`, and an optional `meilisearch` service behind the
  `search` profile). `scripts/init-env.sh` and `scripts/init-env.ps1` write a `.env` with random secrets. Memory limits sized for a
  2 GB VPS, rotating container logs, and Caddy and nginx example configurations in `deploy/`. Images are published to `ghcr.io`
  by the release workflow.
- **First-run setup.** A fresh install has no usable credential. The owner claims it at `/setup` with a one-time setup code read
  from the server, and `/setup` closes for good. Existing databases are never claimable.
- **Two languages.** The public site and the admin in English and Vietnamese; one language per post with linked translations
  (`hreflang`, sitemap alternates, a language switcher that links only to real translations); translated category, tag and series
  names; per-language site content and newsletter text. The default language has no URL prefix.
- **Site content in the database.** Site name, tagline, profile, about, skills, now, timeline, contact, blogroll and case studies are
  edited in **Admin > Settings** per language, with the last ten versions of each section, JSON export and import, and a Markdown
  profile import with preview and undo ([docs/site-profile-format.md](docs/site-profile-format.md)). Defaults are neutral.
- **Sample content.** An admin action loads two English and Vietnamese post pairs, a series, a category and tags, once.
- **Publishing.** Markdown posts with server-side syntax highlighting, table of contents, cover images, body images, series, a curated
  "Best posts" order, categories and tags, drafts with preview, revision history, duplicate, bulk actions,
  slug history with 308 redirects, related posts, RSS feeds (all posts, categories, series, tags) with full content, sitemap, Open
  Graph share cards, JSON-LD, print styles.
- **Search.** Accent-insensitive PostgreSQL full-text search with filters, a quick-search panel (`/` or Ctrl/Cmd+K), and optional
  Meilisearch with typo tolerance and a safe fallback to PostgreSQL.
- **Readers.** Sign in with GitHub to comment (one reply level), like posts and comments, save posts, and receive notifications;
  author applications; moderation, suspension and role management for admins. Email address and password are never asked from
  readers.
- **Authors and roles.** `USER`, `AUTHOR` and `ADMIN`, enforced in the backend; an author manages their own posts and sees statistics
  of their own posts.
- **Newsletter.** Two-step subscription, plain-text mail for each first publication per language, one-click unsubscribe, a retrying
  worker, and an admin overview without addresses. The default `log` transport sends nothing.
- **Statistics.** First-party view counts per day and source group, with no IP, user agent or visitor identifier stored.
- **Images.** Uploads re-encoded and size-limited, stored in PostgreSQL with a quota, a photo gallery with EXIF dates, and
  optimization through Next's image pipeline.
- **Security.** Argon2id passwords, short-lived JWT access tokens and rotating refresh tokens in `httpOnly` cookies, authorization
  decided by the backend with a deny-all fallback, per-IP and per-user rate limits, security headers, startup refusals for unsafe
  public configurations, and a reverse-proxy setup with per-path body limits. See [docs/SECURITY.md](docs/SECURITY.md).
- **Quality gates.** Backend unit and integration tests with Testcontainers, Spotless, Checkstyle and ArchUnit; frontend lint,
  type check, Vitest and a production build; a Playwright end-to-end suite with a fake GitHub; an English-only guard, a personal-data
  guard, a license check and secret scanning in CI; CodeQL.
- **Documentation.** Installation, first run, configuration, content and languages, admin guide, upgrading, backup and restore,
  architecture, security notes, troubleshooting, assets and development guides in `docs/`, with Vietnamese quick-start and admin
  guides in `docs/vi/`.

### Known limitations

- Real email delivery through SMTP has **not** been verified against a real provider. The documented steps are derived from the
  code and tested with an in-process fake transport.
- One backend instance and one Next instance only: rate limits, caches and some state live in process memory
  ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#caching-and-why-there-is-one-backend-and-one-next)).
- Two content languages (`vi` and `en`). Adding a language needs a migration and a frontend change.
- The frontend build downloads the Inter font files from Google Fonts at build time, so a build needs internet access
  ([docs/ASSETS.md](docs/ASSETS.md)).
- Content written outside the admin appears on public pages within about five minutes.
- The published frontend image is built for `http://localhost:3000`; a public site builds its own with `docker compose up -d --build`.

[Unreleased]: https://github.com/HaAnhTun/blog-engine/compare/v1.0.0-rc.1...HEAD
[1.0.0-rc.1]: https://github.com/HaAnhTun/blog-engine/releases/tag/v1.0.0-rc.1
