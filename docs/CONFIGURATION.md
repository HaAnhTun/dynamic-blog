# Configuration

Every setting of Blog Engine, where it is read and what it does. For the install steps see [INSTALL.md](INSTALL.md); for the
content settings an owner edits in the browser see [ADMIN-GUIDE.md](ADMIN-GUIDE.md).

## Contents

- [How configuration flows](#how-configuration-flows)
- [Compose and `.env`](#compose-and-env)
- [Backend environment variables](#backend-environment-variables)
- [Backend properties without a variable](#backend-properties-without-a-variable)
- [Frontend build arguments](#frontend-build-arguments)
- [Frontend runtime variables](#frontend-runtime-variables)
- [Split deployment](#split-deployment)
- [Startup checks of a public site](#startup-checks-of-a-public-site)
- [Link the admin account to GitHub](#link-the-admin-account-to-github)
- [GitHub login in production](#github-login-in-production)
- [Newsletter in production](#newsletter-in-production)
- [Search with Meilisearch](#search-with-meilisearch)
- [Upload size limits, by layer](#upload-size-limits-by-layer)
- [Changing `JWT_SECRET`](#changing-jwt_secret)
- [Changing `MFA_ENCRYPTION_KEY`](#changing-mfa_encryption_key)
- [Health check](#health-check)

## How configuration flows

You edit one file, `.env`, next to `docker-compose.yml`. `scripts/init-env.sh` (or `scripts/init-env.ps1` on Windows) writes it
from `.env.example` with random secrets. Compose reads it and does three things with each value:

1. passes it to a container as an environment variable (the backend and the frontend read their own list),
2. passes it to the frontend image build as a build argument (`SITE_URL`, `DEFAULT_LOCALE`, `HSTS_MAX_AGE`),
3. uses it for the compose file itself (published port, image names, memory limit).

Only the variables listed in `docker-compose.yml` reach a container: a variable you add to `.env` that the compose file does not
mention is ignored. `.env` is git-ignored. `init-env.sh` creates it with mode 600 and never puts a secret on a command line (another local user could read it in `ps`); `init-env.ps1` creates it with access for the current user alone on Windows (inheritance switched off) and with `chmod 600` on PowerShell 7 elsewhere. Keep it readable by you only on any system, also when you copy `.env.example` by hand. Never put a secret
in `.env.example`, in the compose file or in a commit.

Values that are baked into the frontend image at build time (`SITE_URL` as `NEXT_PUBLIC_SITE_URL`, `DEFAULT_LOCALE` as
`NEXT_PUBLIC_DEFAULT_LOCALE`, `HSTS_MAX_AGE`) need `docker compose up -d --build` after a change; everything else needs only
`docker compose up -d`, which recreates the containers whose configuration changed.

Per-owner content (site name, profile, about, contact, ...) is not configuration in this sense: it lives in the database and is
edited in the browser ([ADMIN-GUIDE.md](ADMIN-GUIDE.md)). Languages are a deployment setting, see
[CONTENT-AND-I18N.md](CONTENT-AND-I18N.md).

## Compose and `.env`

Compose refuses to start when one of these is missing or empty: `DB_NAME`, `DB_USERNAME`, `DB_PASSWORD`, `JWT_SECRET`,
`MFA_ENCRYPTION_KEY`, `SITE_URL`, `VIEWS_TOKEN`, `CLIENT_IP_TOKEN`. As soon as `DB_OWNER_USERNAME` is set (the three database roles, as
`.env.example` has it), the postgres container refuses to start unless `DB_OWNER_PASSWORD`, `DB_ADMIN_USERNAME` and `DB_ADMIN_PASSWORD`
are given too, and the three role names and the three passwords each differ from each other; it says which variable is wrong in its log
(`docker compose logs postgres`), before it makes a data directory (`deploy/postgres-preflight.sh`; `docker compose config`, `exec`
and `logs` keep working with such a `.env`). That is on purpose: failing at once beats deploying with a development value, or with a
half-filled set of roles that the database could not recover from.

| Variable | Default | Required | Effect |
|---|---|---|---|
| `DB_NAME` | `blog` (in `.env.example`) | yes | Name of the PostgreSQL database that the `postgres` service creates and the backend uses. |
| `DB_USERNAME` | `blog_app` (in `.env.example`) | yes | The **runtime** database role: the backend connects as it. With the three roles it can read and write rows and nothing else. Without `DB_OWNER_USERNAME` and `DB_ADMIN_USERNAME` (an install from before them) it is the one role, a superuser. |
| `DB_OWNER_USERNAME`, `DB_OWNER_PASSWORD` | `blog_owner` (in `.env.example`), none | no | The **owner** role: owns the database and the schema, and Flyway runs the migrations as it (Compose passes them to the backend as `SPRING_FLYWAY_USER` and `SPRING_FLYWAY_PASSWORD`). Not a superuser. Empty means a single-role install: the migrations run as `DB_USERNAME`. Made when the database directory is created ([UPGRADING.md](UPGRADING.md#moving-to-the-three-database-roles) for an existing install). |
| `DB_ADMIN_USERNAME`, `DB_ADMIN_PASSWORD` | `blog_admin` (in `.env.example`), none | no | The **administration** role: the superuser of the postgres container (`POSTGRES_USER`), for backups and repairs. The backend never connects as it. Required while `DB_OWNER_USERNAME` is set (the postgres container refuses to start without them) and different from `DB_USERNAME` and `DB_PASSWORD` and the owner's. Both lines out (a single-role install) means the superuser is `DB_USERNAME` with `DB_PASSWORD`. |
| `DB_PASSWORD` | none | yes | Password of the runtime role. Postgres is not published outside the compose network, but this still protects every post and every password hash. `init-env` writes a random one. The backend does not check its strength (the database is not reachable from outside); use a random value, not a word. |
| `SITE_URL` | `http://localhost:3000` (in `.env.example`) | yes | The public origin, with scheme and no trailing slash. Frontend build argument (`NEXT_PUBLIC_SITE_URL`) and backend variable; details below. |
| `SITE_BIND` | `127.0.0.1` | no | Address on which the host publishes the frontend port. Keep the default when the reverse proxy runs on the same machine. `0.0.0.0` only when the proxy is another machine, and then firewall the port to that machine (see [GitHub login in production](#github-login-in-production), "Next only takes requests through the proxy"). |
| `SITE_PORT` | `3000` | no | Host port of the frontend (container port is always 3000). A port number only: an old value such as `127.0.0.1:3000` makes compose report a port error. |
| `BACKEND_IMAGE` | `blog-engine-backend:local` | no | Image name for the backend. The default is a local-only name: the service has a `build:` section, so `docker compose up -d --build` builds from this checkout and tags the result with it, and `docker compose pull` finds nothing. To run the published image set the namespace that publishes the release (`ghcr.io/<account>/blog-engine-backend`) and pin a version tag or a digest (`@sha256:...`), never a moving tag ([INSTALL.md](INSTALL.md), "Prebuilt backend image or build from source"). |
| `FRONTEND_IMAGE` | `blog-engine-frontend:local` | no | Name of the frontend image that `docker compose up -d --build` builds. There is no published frontend image: `SITE_URL`, `DEFAULT_LOCALE` and `HSTS_MAX_AGE` are compiled in when it is built (see [INSTALL.md](INSTALL.md)). |
| `ALLOW_SITE_URL_MISMATCH` | empty | no | The frontend refuses to start when the `SITE_URL` of `.env` is not the address its image was built for (a changed `SITE_URL` without `docker compose up -d --build`). `true` starts it anyway and logs the same text as a warning. |
| `BACKEND_MEM_LIMIT` | `768m` | no | Memory limit of the backend container, in Docker syntax (`768m`, `1g`). The Java heap is 70 percent of it (`-XX:MaxRAMPercentage=70` in `backend/Dockerfile`): `768m` gives about 538 MiB, `1g` about 718 MiB (measured with this image). Uploaded images are decoded inside this heap, so a lower limit makes large uploads more likely to run out of memory. Without a limit the JVM would take 70 percent of the whole machine and could crowd out Postgres. The backend also runs with `-XX:+ExitOnOutOfMemoryError`, so an out-of-memory process exits and the restart policy replaces it. |
| `FRONTEND_MEM_LIMIT` | `384m` | no | Memory limit of the frontend (Next) container, in Docker syntax (`384m`, `1g`). Raise it only if `docker stats` shows the container near its limit. |
| `HSTS_MAX_AGE` | `86400` | no | See [Frontend build arguments](#frontend-build-arguments). |
| `HSTS_INCLUDE_SUBDOMAINS` | `false` | no | See [Frontend build arguments](#frontend-build-arguments). |
| `DEFAULT_LOCALE` | `en` | no | See [Frontend build arguments](#frontend-build-arguments) and [Backend environment variables](#backend-environment-variables). |
| `TRUSTED_PROXY_HOPS` | `1` | no | See [Frontend runtime variables](#frontend-runtime-variables). |

Fixed in `docker-compose.yml` (not variables): memory limits of `postgres` 384m, `frontend` 384m and `meilisearch` 512m, sized
together with the backend for a 2 GB VPS; log rotation of 3 files of 10 MB per container (`json-file` driver); Postgres image
`postgres:18`; Meilisearch image `getmeili/meilisearch:v1.54.3`, published only on `127.0.0.1:7700` and only with the `search`
profile; `SPRINGDOC_ENABLED=false`; the backend's `SETUP_DATA_DIR=/data` on the named volume `backend_data`. Postgres data is the named
volume `postgres_data` mounted at `/var/lib/postgresql` (not `.../data`: the Postgres 18 image requires the parent).

### `scripts/init-env.sh` and `scripts/init-env.ps1`

Both write `.env` from `.env.example`, replace `DB_PASSWORD`, `JWT_SECRET`, `MFA_ENCRYPTION_KEY`, `VIEWS_TOKEN`, `CLIENT_IP_TOKEN`,
`NEWSLETTER_SECRET` and `MEILI_MASTER_KEY` with random values, set three values from their inputs, and print what they did without printing a secret.
They never overwrite an existing `.env` (they exit with status 1 and a message). `ADMIN_PASSWORD`, `SETUP_TOKEN`,
`ADMIN_GITHUB_ID`, `MFA_ENROLLMENT_TOKEN`, `MFA_RESET_EMAIL` and `MFA_RESET_TOKEN` stay empty: a fresh install is claimed in the
browser ([FIRST-RUN.md](FIRST-RUN.md)).

| Input (shell script) | PowerShell parameter | Default | Effect |
|---|---|---|---|
| `SITE_URL` | `-SiteUrl` | `http://localhost:3000` | Must start with `http://` or `https://`; a trailing `/` is removed. Becomes `SITE_URL` in `.env`. |
| `SITE_PORT` | `-SitePort` | `3000` | Digits only. Becomes `SITE_PORT`. |
| `DEFAULT_LOCALE` | `-DefaultLocale` | `en` | `en` or `vi`. Becomes `DEFAULT_LOCALE`. |

The PowerShell script also falls back to the environment variables `SITE_URL`, `SITE_PORT` and `DEFAULT_LOCALE` when a parameter
is not given.

## Backend environment variables

Read through `backend/src/main/resources/application.yml`. "Default" is the default of the backend itself; where compose differs
it is stated. Compose sets `DB_HOST=postgres`, `DB_PORT=5432` and `SETUP_DATA_DIR=/data` itself.

### Database and server

| Variable | Default | Required | Effect |
|---|---|---|---|
| `DB_HOST` | `localhost` | no | PostgreSQL host. Compose sets `postgres`. |
| `DB_PORT` | `5432` | no | PostgreSQL port. |
| `DB_NAME` | `blog` | no | Database name. |
| `DB_SSLMODE` | `prefer` | no | The `sslmode` of the JDBC URL. `verify-full` encrypts the link and proves the server is the one in `DB_HOST`: use it for a database on another machine ([Split deployment](#split-deployment)). `prefer` (the pgjdbc default) falls back to plain text and checks nothing. `verify-full` also needs a way to check the certificate: see `DB_JDBC_PARAMS`. |
| `DB_JDBC_PARAMS` | empty | no | More JDBC URL parameters, starting with `&`. With `DB_SSLMODE=verify-full` one of: `&sslfactory=org.postgresql.ssl.DefaultJavaSSLFactory` when the server certificate is signed by a CA the JVM trusts (Neon, for example), or `&sslrootcert=/certs/ca.pem` for any other CA (Amazon RDS, a private one), a file the user the backend runs as can read. pgjdbc has no other fallback: `verify-full` alone fails with "Could not open SSL root certificate file". Do not repeat `sslmode` here: the last value wins, and the startup check reads it the same way. |
| `DB_ALLOW_INSECURE_TRANSPORT` | `false` | no | `true` accepts a remote database over a link that is not verified (`sslmode` below `verify-full`), on a private network you control, with one warning. See the startup checks below. |
| `DB_USERNAME` | `blog` | no | Database user. |
| `DB_PASSWORD` | `blog` | no | Database password. The default is for a development machine only; compose requires your own. Needs PostgreSQL 18 with the `unaccent` extension available (the `postgres:18` image has it). On a managed database the user must be allowed to run `CREATE EXTENSION unaccent`, otherwise Flyway stops at migration V23 and the backend does not start. |
| `SERVER_PORT` | `8080` | no | HTTP port of the backend. Compose does not publish it and its healthcheck assumes 8080. |
| `SPRINGDOC_ENABLED` | `false` (`true` under `mvn spring-boot:run`, which uses the `dev` profile) | no | Swagger UI (`/swagger-ui.html`) and `/v3/api-docs`. They describe the whole API, admin part included, and are readable without a sign-in, so they are off by default; compose sets `false` explicitly. When off, both paths answer 404. |

### Site, secrets and the admin account

| Variable | Default | Required | Effect |
|---|---|---|---|
| `SITE_URL` | empty | yes on a public site | The public origin (the frontend's). The backend builds the GitHub callback from it (`<SITE_URL>/api/auth/github/callback`) and uses it to decide whether it is "production": a host that is not `localhost`, `127.0.0.0/8` or `::1` is production even when `APP_ALLOW_DEV_DEFAULTS=true` (see [Startup checks](#startup-checks-of-a-public-site)). It is also the root of every link in newsletter mail and the host of the `internal` source group of view statistics. Compose requires it. **Set it on every public deployment, also outside compose (Koyeb, Render, a bare `java -jar`).** |
| `APP_ALLOW_DEV_DEFAULTS` | `false` | no | The explicit opt-in to development defaults, for a throw-away E2E or CI stack only. The backend is fail-closed: it behaves as production unless this is `true` or the Spring profile `dev` is active (`mvn spring-boot:run` does that). Opted in, it accepts the development admin password and an empty `VIEWS_TOKEN` or `CLIENT_IP_TOKEN`, and `JWT_SECRET` may be the development value (it still must be set). Ignored when `SITE_URL` or `GITHUB_REDIRECT_URI` is a public address. Never set it on a stack other people can reach. |
| `JWT_SECRET` | none | yes | HS256 key for the access tokens, at least 32 bytes and at least 8 different bytes (a shorter key, or one made of a few repeated characters, stops the start; the message shows the length or the count, never the value). In production a value that is long enough but guessable also stops the start: made only of placeholder words (`changeme`, `secret`, `password` ...), one short pattern repeated, fewer than 6 different characters, or mostly a run like `abcdefghij`; every value of `openssl rand -base64 48` or `openssl rand -hex 32` passes. The signing key of the GitHub sign-in cookie is derived from it, so changing it breaks sign-ins in progress. A missing secret stops the start; so does the development value that lives in the repository, unless the run opted in (`dev` profile or `APP_ALLOW_DEV_DEFAULTS=true`). Generate one with `openssl rand -base64 48`. See [Changing `JWT_SECRET`](#changing-jwt_secret). |
| `MFA_ENCRYPTION_KEY` | none | yes | The key that encrypts the two-step verification (TOTP) secrets in the database with AES-256-GCM: **exactly 32 random bytes as base64**, generated with `openssl rand -base64 32`. Required in every mode, so a missing, non-base64 or wrong-sized key stops the start (the message shows the decoded length, never the value); in production so does the development key committed to this repository (in any spelling that decodes to the same bytes), and so does a value equal to `JWT_SECRET` (as text or as the same bytes). It is a key of its own on purpose: rotating `JWT_SECRET` after a leak must not lock anybody out, and a leaked `JWT_SECRET` must not decrypt the seeds. **A database backup does not contain it: keep a copy outside the server** ([Backup and restore](BACKUP-AND-RESTORE.md#take-a-backup)). Changing it voids every enrollment: see [Changing `MFA_ENCRYPTION_KEY`](#changing-mfa_encryption_key). `init-env` writes a random one; for an existing `.env` see [Upgrading](UPGRADING.md#release-with-two-step-verification). |
| `MFA_ENROLLMENT_TOKEN` | empty | no | Optional. The operator's proof of server access that an administrator without two-step verification enters once at the forced enrollment (after an upgrade, or after an operator reset), at least 24 characters (shorter stops the start). Empty means the backend writes a random code to `<SETUP_DATA_DIR>/mfa-enrollment-code` and logs the path, never the code (`docker compose exec backend cat /data/mfa-enrollment-code`). Not needed right after the first-run claim (the enrollment window is open for an hour) or on an opted-in development run. Remove it after the enrollment. |
| `MFA_RESET_EMAIL`, `MFA_RESET_TOKEN` | empty | no | Optional and one-off: resets the two-step verification of the account with that email at startup (lost phone and lost recovery codes), **once per distinct token** (at least 24 characters; shorter stops the start; setting only one of the two does nothing and logs a warning). It deletes the enrollment and the recovery codes and ends the account's sessions. Remove both afterwards. See [Two-step verification and recovery](SECURITY.md#when-the-phone-or-the-codes-are-lost). |
| `PRIVILEGED_SESSION_IDLE_TTL`, `PRIVILEGED_SESSION_ABSOLUTE_TTL` | `7d`, `30d` | no | How long a session of an **ADMIN or AUTHOR** account lives (readers are not affected: their refresh token lives 30 days from each use, `app.security.refresh-token-ttl`). A session ends after `PRIVILEGED_SESSION_IDLE_TTL` without use (every refresh, about once per 15 minutes of use, renews it) and, however active it was, `PRIVILEGED_SESSION_ABSOLUTE_TTL` after the person signed in; the shorter limit wins. The person then signs in again, with a new second-step code if the account has one. A password change or an authenticator change gives the caller a new session that keeps the end of the old one. Values are Spring durations (`7d`, `36h`, `PT12H`); zero or negative stops the start, an empty value means the default. A change applies to the sessions opened afterwards, and the absolute limit also to an open session at its next refresh. See [Authentication and sessions](SECURITY.md#authentication-and-sessions). |
| `ADMIN_EMAIL` | `admin@blog.local` | no | The admin account's sign-in email. A different value renames the seeded admin account at startup (same id, so its posts and links stay), provided no account already has that email; `admin@blog.local` then no longer signs in, and every session the account had (refresh tokens and access tokens) ends. The first-run `/setup` also writes the email you type there. |
| `ADMIN_PASSWORD` | empty | no | Optional. When set, hashed with Argon2id and written to the `ADMIN_EMAIL` account at startup (the plaintext is never stored or logged), and the first-run `/setup` is closed because the instance counts as claimed. It must meet the [password policy](SECURITY.md#password-policy) (at least 12 characters, not a common password, and so on) when its value changes, or the start is refused; an unchanged value that the policy now rejects only logs one warning. Applying a new value ends every session of that account (refresh tokens and access tokens) and clears its second-step counters. A restart with the same value changes nothing. **While it is set, the password cannot be changed in `/admin/security`** (409): the variable would undo the change at the next start. Leave it empty for a fresh install and use `/setup`. |
| `ADMIN_GITHUB_ID` | empty | no | Numeric GitHub id of the owner's account, linked to the admin account at startup so that GitHub sign-in yields ADMIN; the first link ends the sessions the admin account had, a restart that finds it in place signs nobody out. Also closes `/setup`. A value that is not a positive integer stops the start. See [Link the admin account to GitHub](#link-the-admin-account-to-github). |
| `SETUP_TOKEN` | empty | no | The first-run setup code, at least 24 characters (shorter stops the start). Empty means the backend generates a random code and writes it to `<SETUP_DATA_DIR>/setup-code`; the log prints the path, never the code. Ignored once setup is complete. Leave it empty unless you need a known code. |
| `SETUP_DATA_DIR` | `./data` (compose: `/data`) | no | Directory of the generated setup code file. Keep it private: the backend trusts a code file it finds there. The file is deleted when setup completes. |
| `SETUP_LOCK_DEV_SEED` | `true` | no | On a fresh, unclaimed database, replaces the seeded development password so that no default credential works until `/setup` is done. Existing deployments are never touched. On a production run (no `dev` profile or `APP_ALLOW_DEV_DEFAULTS=true`, or a public `SITE_URL`) `false` is ignored and the lock always runs, and a database error while it runs stops the start instead of being logged. |
| `VIEWS_TOKEN` | empty | yes | A secret shared with the frontend for `POST /api/v1/posts/{slug}/views`, an endpoint that writes without a sign-in: a request without the matching `X-View-Token` header gets 403. Empty stops the start in production, because anyone who can reach the backend could add views; so does a value shorter than 16 characters or a guessable one (same rules as `JWT_SECRET`); only an opted-in dev run (`dev` profile or `APP_ALLOW_DEV_DEFAULTS=true`) accepts those. It does not protect the newsletter POSTs, which have their own per-address limits. Outside compose set the same value on both backend and frontend: if they differ every view silently becomes a 403. `openssl rand -hex 32`. |
| `CLIENT_IP_TOKEN` | empty | yes | A secret shared with the frontend that lets the backend believe the reader address Next forwards. Next sends the address it derived in `X-Client-Ip` and this secret in `X-Client-Ip-Token` on the calls that have a per-address limit in the backend (contact form, newsletter subscribe, confirm and unsubscribe, admin sign-in, session refresh, first-run setup, search). The backend believes the address only when the secret matches (constant-time compare); otherwise it ignores both headers and counts the socket address, so someone who reaches the backend directly cannot choose their own key. Empty stops the start in production, because the backend would count the Next server as one caller for every reader; so does a value shorter than 16 characters or a guessable one (same rules as `JWT_SECRET`); only an opted-in dev run accepts those. Outside compose set the same value on both backend and frontend: if they differ, every reader counts as one caller and the per-address limits trip for everybody. It is not an access token: it opens no endpoint. `openssl rand -hex 32`. See [Rate limits](#rate-limits). |
| `DEFAULT_LOCALE` | `vi` (compose: `en`) | no | `en` or `vi`; empty means `vi`; upper case is lower-cased; anything else stops the start before any migration. The language of posts created without one, and, **on the first start after migration V34 only**, the language every existing post and newsletter subscriber is labelled with (the migration cannot be repeated): set it to the language your existing posts are written in and leave it alone afterwards. The same value is the frontend build argument below. A fresh `docker compose` install gets `en` from the compose file and `init-env`. |
| `ANALYTICS_TIME_ZONE` | `Asia/Ho_Chi_Minh` | no | IANA time zone that decides the day boundary of the view statistics, on write and on read. A wrong id stops the start. Changing it later does not move days already recorded. Set your own zone on a fresh install. |

### GitHub login for readers

Off unless both id and secret are set; the site still runs without it. See [GitHub login in production](#github-login-in-production).

| Variable | Default | Required | Effect |
|---|---|---|---|
| `GITHUB_CLIENT_ID` | empty | no | Client id of the GitHub OAuth App. |
| `GITHUB_CLIENT_SECRET` | empty | no | Client secret. Lives only in `.env`. If exactly one of the two is set the backend logs a WARN and login stays off. |
| `GITHUB_REDIRECT_URI` | empty | no | Absolute callback sent to GitHub. Empty is correct: it is built from `SITE_URL`. If set it must equal the OAuth App's "Authorization callback URL" character for character, be the path `/api/auth/github/callback` without query or fragment, and be https (or http on localhost, 127.0.0.1, `::1`). With an id and secret but neither this nor `SITE_URL`, the backend refuses to start. |

### Images

| Variable | Default | Required | Effect |
|---|---|---|---|
| `MEDIA_MAX_TOTAL_SIZE` | `1GB` | no | Quota for the total size of stored images (covers, gallery photos, body images), in Spring's size syntax (`400MB`, `1GB`). Images live in PostgreSQL, so this is the share of the database given to images. Beyond it an upload returns 422 `MEDIA_QUOTA_EXCEEDED`; replacing a cover counts only the increase. Set it lower on a small managed database (about 400MB on a 0.5 GB plan). The admin shows usage through `GET /api/v1/admin/media/usage`. |

### Author limits

An AUTHOR is the least trusted writer, and everything it creates lands in the one shared database and is read whole by public pages.
These limits apply to an AUTHOR only; an ADMIN is exempt from every one of them. They are checked by the backend
(`AuthorQuotaProperties`, `app.author-quota.*`), count rows in the database where they can (so a restart forgets nothing), and
answer with a code and a sentence that says which limit it was. A value below 1 stops the start.

| Variable | Default | Required | Effect |
|---|---|---|---|
| `AUTHOR_MAX_TAGS_PER_POST` | `10` | no | Tags on one post. More is 400 `VALIDATION_ERROR` on create, and on save when the save adds a tag (a post that already has more can still be saved while it adds none). The preview of the post import says the same as a problem of the file (`tags`), so an author is told before the apply. (Any request is also cut at 100 tags, for everyone.) |
| `AUTHOR_MAX_POSTS_PER_DAY` | `30` | no | Posts an author created in the last 24 hours, drafts, translation drafts and imported posts included, deleted or not. More is 429 `AUTHOR_QUOTA_EXCEEDED`. A Markdown or ZIP import counts each post it creates, so an import of more than this many posts is refused as a whole. |
| `AUTHOR_MAX_BODY_IMAGES_PER_POST` | `30` | no | Images in the body of one post. More is 422 `AUTHOR_QUOTA_EXCEEDED`. |
| `AUTHOR_MAX_TAGS` | `1000` | no | Tags in the whole catalog. Once the site has this many, an author cannot create another (422 `AUTHOR_QUOTA_EXCEEDED`); an administrator can. The public lists read every tag, so the catalog is kept small. |
| `AUTHOR_MAX_CATEGORIES` | `100` | no | The same for categories. |
| `AUTHOR_MEDIA_MAX_SIZE` | `100MB` | no | Stored image bytes (covers and body images) of one author, in Spring's size syntax. Over it is 422 `MEDIA_QUOTA_EXCEEDED`. Replacing an author's own cover counts only the increase. The images of a post the author deleted still count (the post is only hidden, and the author can no longer delete its images); an administrator frees the space by deleting the post for good. |
| `AUTHOR_MAX_SLUG_HISTORY` | `5` | no | Old addresses (slugs) that the post of an author keeps working after renames; the oldest are dropped, so renaming again and again cannot reserve addresses for good. An administrator's own posts keep all of theirs. |
| `AUTHOR_MEDIA_SHARE_PERCENT` | `50` | no | The share (1 to 100) of `MEDIA_MAX_TOTAL_SIZE` that all authors together may use, so authors can never fill the room the administrator needs for the gallery and the About photo. An administrator's images are not counted in it and are not refused by it. |

The limits per time window (writes, creating tags and categories, uploads) are `app.rate-limit.post-write`, `taxonomy-create` and
`media-upload` in [Rate limits](#rate-limits). Besides these numbers, an image an author uploads waits for the one image-processing
slot behind a gate that lets at most one author image wait at a time, so an administrator's upload never queues behind a crowd of
author images, and a slug that is taken is numbered at most 50 times before a random suffix is used.

### Newsletter

Default `log`: subscriptions are accepted and the worker runs, but no mail leaves the machine (one INFO line per mail with its
kind and id). Full procedure and startup conditions: [Newsletter in production](#newsletter-in-production).

| Variable | Default | Required | Effect |
|---|---|---|---|
| `NEWSLETTER_TRANSPORT` | `log` | no | `log` or `smtp`. |
| `NEWSLETTER_FROM` | empty | with `smtp` | Sender: one address, `Name <address>` allowed, on a domain verified at the provider (SPF, DKIM). |
| `NEWSLETTER_SECRET` | empty | with `smtp` | HMAC key of the unsubscribe links and of the suppression hashes, at least 32 bytes with `smtp`, and not guessable (the same rules as `JWT_SECRET`). Empty with `log` uses a development key from the repository (and a WARN on a public site). Set it once before the first subscriber and never change it. `init-env` writes one. |
| `SMTP_HOST` | empty | with `smtp` | The provider's SMTP server. |
| `SMTP_PORT` | `587` | no | SMTP port. |
| `SMTP_USERNAME` | empty | no | SMTP user. |
| `SMTP_PASSWORD` | empty | no | SMTP password. Lives only in `.env`. |
| `SMTP_STARTTLS` | `true` | no | `true` enables and requires STARTTLS. `false` is **refused** for any host that is not a loopback address (the SMTP password and every mail would cross the network in clear text); it exists for a mail catcher on the same machine. Connect, read and write each time out after 10 seconds. |
| `SMTP_PROTOCOL` | `smtp` | no | `smtp` (STARTTLS, port 587) or `smtps` (implicit TLS, set `SMTP_PORT=465`; STARTTLS is not used). Any other value stops the start. Both check that the server certificate matches `SMTP_HOST`. |

### Contact form

The public contact form (`POST /api/v1/contact/messages`) stores every message in the database first, and the admin reads them at
`/admin/contact`. A mail copy is optional.

| Variable | Default | Required | Effect |
|---|---|---|---|
| `CONTACT_RECIPIENT` | empty | no | Property `app.contact.recipient`. One address that gets a plain-text mail for each message, with the visitor's address as `Reply-To`. Empty means store only. A value that is not one valid address stops the start (the message names the variable, not the value). |
| `CONTACT_RETENTION_DAYS` | `365` | no | Property `app.contact.retention.days`. How long a message is kept, counted from the day it arrived. A nightly job deletes the messages older than this, read or not. `0` turns the job off and keeps every message until an administrator deletes it. Below 0 stops the start. |
| `CONTACT_RETENTION_CRON` | `0 43 3 * * *` | no | Property `app.contact.retention.cron`: when the job runs (Spring cron, in the JVM's time zone, UTC in the images). `-` turns the job off. |

- The mail goes through the newsletter transport, so it follows `NEWSLETTER_TRANSPORT`: with `log` nothing leaves the machine (one
  INFO line with the mail kind and the message id); with `smtp` it is sent with the `NEWSLETTER_FROM` sender and `SMTP_*` settings,
  and the startup checks of [Newsletter in production](#newsletter-in-production) apply.
- **A message is not kept for ever.** It holds a visitor's name, email address and free text, so the nightly job deletes it after
  `CONTACT_RETENTION_DAYS` days (365 by default); the log line has only the number of rows. Keep it longer, or for ever with `0`, if
  the inbox is your only record. To erase one person's messages sooner, delete them in `/admin/contact`.
- **The message is stored first and is never lost.** If the mail fails, the backend logs a WARN with the message id and a safe failure
  code (never the address or the text), and the visitor still gets the same `202`.
- **Rate limits** (all give 429 `RATE_LIMITED`): at most 5 messages per client address in any hour (`app.rate-limit.contact-client.per-hour`;
  rotating the email address does not help), at most 60 for the whole site in any hour (`app.rate-limit.contact-global.per-hour`, so many
  addresses together cannot flood the inbox or the recipient's mail), and at most 5 per email address (compared in lower case) in any hour,
  counted from the stored rows, so that one survives a restart and holds with several backends and is a fixed rule, not a property.
  The first two are in memory ([Rate limits](#rate-limits)). The client address is the one Next forwards with `CLIENT_IP_TOKEN`, else the
  socket address.
- Name and subject have control characters removed (a mail header cannot be injected); the message keeps its line breaks.

### Search

PostgreSQL full-text search is the default and needs nothing. Meilisearch is optional. See [Search with Meilisearch](#search-with-meilisearch).

| Variable | Default | Required | Effect |
|---|---|---|---|
| `SEARCH_ENGINE` | `postgres` | no | `postgres` or `meilisearch`: the engine that answers `GET /api/v1/search`. When Meilisearch fails the PostgreSQL result is returned with `degraded: true`. |
| `MEILI_URL` | empty | no | Meilisearch address (`http://meilisearch:7700` with the compose `search` profile). Setting it turns indexing on, even while the engine is still `postgres`. |
| `MEILI_MASTER_KEY` | empty | when Meilisearch is used | Read only by the backend and the `meilisearch` service, never by the frontend. At least 32 characters and not the placeholder of `.env.example` on a public site, or the backend refuses to start. `init-env` writes a random one. |
| `MEILI_INDEX_NAME` | `content_v1` | no | The serving index; it must start with `content_` (the backend's search key only sees `content_*`). |

## Backend properties without a variable

These have defaults in `application.yml` or in the code, and no variable in `.env` or in `docker-compose.yml`. They are tuning
knobs, normally left alone. Set one with a command-line argument (`java -jar app.jar --app.media.max-pixels=20000000`, the form the
project's E2E procedure uses) or any other external-configuration mechanism of Spring Boot. Compose passes only the variables
listed in its file, so to change one in a compose deployment add it to the backend's `environment:` in a
`docker-compose.override.yml` using Spring Boot's environment-variable naming rule; that route is not exercised by the project's tests.

| Property | Default | Effect |
|---|---|---|
| `app.i18n.locales` | `vi,en` | Enabled content languages. Each entry is 2 to 8 lower-case letters, listed once, none empty; anything else stops the start before any migration (the default locale is written into the V34 migration as SQL text, so its shape is checked first). The database pins the same set with CHECK constraints, so enabling another needs a migration ([CONTENT-AND-I18N.md](CONTENT-AND-I18N.md)). |
| `app.security.access-token-ttl` | `15m` | Life of an access token. |
| `app.security.refresh-token-ttl` | `30d` | Life of a reader's refresh token (renewed on every use). The sessions of ADMIN and AUTHOR accounts have their own limits: `PRIVILEGED_SESSION_IDLE_TTL` and `PRIVILEGED_SESSION_ABSOLUTE_TTL` above. |
| `app.mfa.issuer` | `Blog` | The name an authenticator app shows next to the account (at most 60 characters). |
| `app.mfa.challenge-ttl` | `5m` | Life of the challenge between the password (or GitHub) step and the code step; at most `15m`. |
| `app.mfa.reauth-window` | `10m` | How recently a person must have signed in to change two-step verification or the password; at most `60m`. |
| `app.media.max-upload-size` | `10MB` | Largest uploaded file, checked in code (413 `MEDIA_TOO_LARGE`). |
| `app.media.max-stored-size` | `4MB` | Ceiling per image after re-encoding; equals the CHECK of the media table. |
| `app.media.max-pixels` | `50000000` | Largest width times height, read from the header before decoding. |
| `app.media.max-edge` | `2400` | Longest side of a stored image, in pixels. |
| `app.media.jpeg-quality` | `0.92` | JPEG quality of re-encoded images. The stored file is the master that the frontend re-encodes once more to AVIF or WebP, so it stays high. |
| `app.media.processing-permits` | `1` | Images processed at the same time. One large image can need up to about a hundred MB of heap. |
| `app.media.processing-wait` | `20s` | How long an upload waits for a permit before 503 `MEDIA_BUSY`. |
| `app.newsletter.worker-enabled`, `app.newsletter.worker-delay` | `true`, `30s` | The mail worker and its pause between passes. |
| `app.search.worker-enabled`, `app.search.worker-delay` | `true`, `10s` | The worker that syncs the search index from the outbox. |
| `app.search.reconcile-cron` | `0 23 * * * *` | Reconciliation of the index with PostgreSQL (Spring cron, six fields); `-` turns it off. |
| `app.search.meili.connect-timeout`, `search-timeout`, `admin-timeout` | `500ms`, `800ms`, `10s` | Timeouts of the Meilisearch client. |
| `spring.servlet.multipart.max-file-size`, `max-request-size` | `10MB`, `11MB` | Servlet upload limits (second line of defence). |
| `server.tomcat.max-swallow-size` | `32MB` | Lets Tomcat discard the rest of an oversized upload so the client gets a JSON 413. |
| `server.tomcat.max-http-form-post-size` | `64KB` | Largest form-encoded POST body Tomcat reads (its default is 2MB), and the most it accepts of the text parts of a multipart request (everything but uploaded files; the `manifest` of the post import, under 10 KiB for 20 files, is one). No endpoint takes a form body. |
| `spring.mvc.formcontent.filter.enabled` | `false` | Spring Boot's filter that reads the body of a PUT, PATCH or DELETE sent as a form. Off: nothing takes one, and it would read what an anonymous caller sends. Leave it off. |
| `app.request-limit.public-body` | `64KB` | Largest JSON body of every `/api/**` path except `/api/v1/admin/**`, refused with 413 before it is read. 1KB to 8MB. |
| `app.request-limit.admin-body` | `6MB` | Largest JSON body under `/api/v1/admin/**` (a post is at most about 3 MB once escaped). 1KB to 8MB. |
| `spring.jackson.factory.constraints.read.max-string-length`, `max-document-length` | `1000000`, `8388608` | Longest JSON string (characters) and document the JSON reader accepts. Keep the document value at or above `app.request-limit.admin-body`. |
| `spring.task.scheduling.pool.size` | `2` | Threads for scheduled work (the newsletter and search workers). |

### Rate limits

Defaults live in `RateLimitProperties`, not in `application.yml`. They are counted in the memory of one backend process, so a
restart forgets them and two backend instances would each keep their own (run one). Over a limit the answer is 429
`RATE_LIMITED` without `Retry-After`. A value below 1 stops the start.

"Client address" below is the address Next forwards (see `CLIENT_IP_TOKEN`), else the socket address of the caller; an IPv6 address
counts as its whole `/64`. The properties named `*-client` are checked before the shared (`*-global`, or whole-process) count next to
them, so a caller over its own limit does not use up a turn of the shared one.

| Property | Default | What it limits |
|---|---|---|
| `app.rate-limit.comment.per-minute`, `.per-hour` | 5, 30 | New comments and replies, per user. |
| `app.rate-limit.comment-edit.per-ten-minutes` | 20 | Edits and deletes of your own comments, per user. |
| `app.rate-limit.like.per-minute` | 30 | Likes and unlikes of posts and comments, per user. |
| `app.rate-limit.bookmark.per-minute` | 30 | Saving and unsaving posts, per user. |
| `app.rate-limit.author-application.per-hour` | 5 | Author applications, per user. |
| `app.rate-limit.role-change.per-ten-minutes` | 20 | Role changes and approvals, per admin. |
| `app.rate-limit.newsletter-signup.per-hour` | 3 | Signups for the same email address. Over the limit nothing is queued and the answer is still 202. |
| `app.rate-limit.newsletter-signup-client.per-hour` | 5 | Signups from one client address, whatever the email address. Over the limit nothing is queued and the answer is still 202. |
| `app.rate-limit.newsletter-signup-global.per-hour` | 120 | Confirmation mails queued for the whole site, counted last so only signups that would really queue a mail use it. Over the limit nothing is queued and the answer is still 202. |
| `app.rate-limit.newsletter-token.per-hour` | 20 | Confirmations and unsubscribes for the same subscriber address. |
| `app.rate-limit.newsletter-token-client.per-hour` | 40 | Confirmations and unsubscribes together from one client address, counted before the token is looked at. |
| `app.rate-limit.newsletter-confirm-global.per-hour` | 300 | Confirmations (not unsubscribes) for the whole site, counted before the token is looked at. Unsubscribes have no whole-site ceiling on purpose: stray tokens must never leave real unsubscribes with a 429. |
| `app.rate-limit.contact-client.per-hour` | 5 | Contact messages from one client address, whatever the email address. |
| `app.rate-limit.contact-global.per-hour` | 60 | Contact messages for the whole site. |
| `app.rate-limit.login-client.per-ten-minutes` | 20 | Admin password sign-in attempts from one client address, every attempt counted (wrong or right), before the password is checked. Twice the frontend's own limit (10, which a success clears). |
| `app.rate-limit.mfa-client.per-ten-minutes` | 20 | The second step of a sign-in (verifying a code, beginning and confirming an enrollment) from one client address, every attempt counted (wrong or right). Twice the frontend's own limit (10, which a success clears). The guarantee against guessing a code is the per-account counter, not this one. |
| `app.rate-limit.refresh-client.per-ten-minutes` | 60 | Session refreshes from one client address. A signed-in reader refreshes once per 15 minutes. |
| `app.rate-limit.search.per-minute` | 1200 | `GET /api/v1/search`, whole process. |
| `app.rate-limit.search-client.per-minute` | 120 | Searches from one client address, checked before the whole-process count above. The same number as the frontend's per-IP limit. |
| `app.rate-limit.search-reindex.per-ten-minutes` | 3 | Index rebuilds per admin, dry runs included. |
| `app.rate-limit.setup.per-minute` | 120 | **Wrong** first-run setup codes for the whole process, counted after the comparison. A right code is never counted, so this cannot keep the owner from claiming; beyond it a wrong code is answered 429 instead of 403. (Before this release it was 10 and counted every attempt before the code was looked at.) |
| `app.rate-limit.setup-client.per-minute` | 5 | First-run setup attempts from one client address, every attempt counted, checked first. |
| `app.rate-limit.site-content-write.per-ten-minutes` | 60 | Site content saves, restores, imports and the sample content load, per admin. |
| `app.rate-limit.post-import-write.per-ten-minutes` | 60 | Post import previews, applies and undos together, per person (admin or author). Counted apart from the site content writes and the article previews. |
| `app.rate-limit.article-preview.per-ten-minutes` | 300 | Article previews of the post import page (one call per importable file of a preview, one per article it opens), per person (admin or author). Counted apart from the previews, applies and undos, so checking many files never uses them up. |
| `app.rate-limit.mfa-step-up.per-ten-minutes` | 10 | Changes of two-step verification (enroll, replace, regenerate, turn off) and the administrator's reset of an author, per user. |
| `app.rate-limit.password-change.per-ten-minutes` | 5 | Password changes, every attempt counted, per user. |
| `app.rate-limit.post-write.per-ten-minutes` | 60 | Creating a post and saving one, together, per AUTHOR. An administrator is not counted. |
| `app.rate-limit.taxonomy-create.per-hour` | 10 | Creating a tag or a category, together, per AUTHOR (the editor creates them in place). An administrator is not counted. |
| `app.rate-limit.media-upload.per-ten-minutes` | 30 | Uploading a cover or a body image, per AUTHOR, counted before the image is decoded. An administrator is not counted. The images of an import are not counted here (the import has its own limit). |
| `app.rate-limit.login.concurrent`, `.max-wait` | 2, `5s` | Not a count per person: how many password checks (Argon2id, 19 MiB each) run at once for the whole server, and how long another login waits before 429. |

There is no lockout of the password step: failed logins are not counted per email, so knowing the owner's address does not let
anyone lock the owner out. The second step of an account has its own brake (delays after the fifth wrong code, frozen after 100;
[Security](SECURITY.md#two-step-verification-and-recovery)), which is not a property. The frontend has per-IP limits of its own
(admin password sign-in 10 per 10 minutes, the second step 10 per 10 minutes, GitHub sign-in 20 per 10 minutes, views 30 per minute,
the contact form 5 per hour, newsletter routes 5 signups, 20 confirmations and 20 unsubscribes per hour, search 120 per minute) that
read the address with `TRUSTED_PROXY_HOPS`. The `*-client` limits above are the backend's second line: they hold when the backend is
reached without Next, when Next's in-memory counter is out of reach (a restart, several instances) and they bound what one address
can take from a shared count. A backend with a public URL of its own counts the socket address of its direct callers, so contact,
newsletter, sign-in, the second step of a sign-in, refresh, setup and search are limited there too; only the two GitHub OAuth paths
stay without a per-IP limit.

The maps behind the `*-client` limits and the per-email signup limit hold at most 20,000 keys each. Expired keys are swept first.
When every key is still inside its window the contact, newsletter and search maps refuse a new key while the keys already counted keep
their exact quota (a flood of invented addresses can neither grow memory without bound nor push a running counter out), but the
`login-client`, `mfa-client`, `refresh-client` and `setup-client` maps never refuse: they drop the stalest keys instead, so a crowd cannot
deny the owner's sign-in, second step or session refresh. The `*-global` counts are shared on purpose: a crowd of addresses can use one
up and deny the feature to everybody for as long as it keeps trying (the alternative is an unbounded flood of mail or searches).

The automated tests and the E2E stack ([DEVELOPMENT.md](DEVELOPMENT.md)) lift some of the `*-client` limits because all their requests
come from one machine; do not copy that to a real site.

## Frontend build arguments

These are compiled into the bundle by `next build`. They are Docker build arguments of `frontend/Dockerfile`; compose fills them
from `.env`. Changing one needs `docker compose up -d --build`.

| Build argument | `.env` name | Dockerfile default | Compose default | Effect |
|---|---|---|---|---|
| `NEXT_PUBLIC_SITE_URL` | `SITE_URL` | `http://localhost:3000` | none (required) | The public origin, used for canonical URLs, Open Graph tags, the sitemap and feeds. Setting it as a runtime variable fails nothing and produces URLs that all say localhost, which is why it is a build argument. When it is https, every response carries `Strict-Transport-Security`. A trailing slash is removed. |
| `NEXT_PUBLIC_DEFAULT_LOCALE` | `DEFAULT_LOCALE` | `vi` | `en` | `vi` or `en`: the locale whose URLs have no `/<locale>` prefix. Any other value fails the build. Building the image by hand without compose gives `vi`; pass `--build-arg NEXT_PUBLIC_DEFAULT_LOCALE=en` for English. Keep it equal to the backend's `DEFAULT_LOCALE`. |
| `HSTS_MAX_AGE` | `HSTS_MAX_AGE` | `86400` | `86400` | `max-age` of `Strict-Transport-Security`, sent only when the site URL is https, without `preload`, and without `includeSubDomains` unless `HSTS_INCLUDE_SUBDOMAINS=true`. A value that is not a number of seconds means 86400. `0` sends `max-age=0`, which turns HSTS off (the browser forgets the policy at its next visit over https). Keep one day until HTTPS has proven stable (certificate renews, every page opens over https), then raise it to `31536000` (about two weeks after the first public start, [INSTALL.md](INSTALL.md#raise-hsts-after-https-is-proven); the build prints an `[hsts]` reminder while it is under a year): a wrong HSTS locks readers out of the site until it expires. |
| `HSTS_INCLUDE_SUBDOMAINS` | `HSTS_INCLUDE_SUBDOMAINS` | `false` | `false` | `true` appends `; includeSubDomains` to `Strict-Transport-Security`. Set it only when you own every subdomain of the host and all of them are served over https: a subdomain without working HTTPS goes dark for the whole `max-age`. Only the exact word `true` (any case) turns it on, and `max-age=0` never carries it. There is no `preload` switch on purpose. Ignored when the site URL is not https. |

## Frontend runtime variables

Read by the Next server when it runs. Compose sets the ones shown.

| Variable | Default | Required | Effect |
|---|---|---|---|
| `API_BASE_URL` | `http://localhost:8080` in code; compose sets `http://backend:8080` | no | Where the Next server finds the backend. Server side only, never prefixed `NEXT_PUBLIC_`. Inside a container `localhost` is the container itself, hence the service name. In production it must be `https`, or `http` to the machine itself or to a single-label service name; anything else stops the start ([Split deployment](#split-deployment)). |
| `API_ALLOW_PLAINTEXT` | empty | no | `true` accepts a plain `http` `API_BASE_URL` to a host that is not the machine itself or a service name, for a private network you trust (a VPN or VPC). Bearer tokens, `VIEWS_TOKEN` and `CLIENT_IP_TOKEN` travel over that link. |
| `VIEWS_TOKEN` | empty; compose requires it | yes in compose | The same value as the backend's. The `/api/views` route sends it in the `X-View-Token` header. If the two sides differ, views silently stop counting while the pages keep working. |
| `CLIENT_IP_TOKEN` | empty; compose requires it | yes in compose | The same value as the backend's. The routes that call a backend endpoint with a per-address limit (contact, newsletter, admin sign-in, session refresh, first-run setup, search) send the address they derived (see `TRUSTED_PROXY_HOPS`) in `X-Client-Ip` and this value in `X-Client-Ip-Token`. Never sent when empty. If the two sides differ, the backend counts the Next server as one caller for every reader and its per-address limits trip for everybody. |
| `TRUSTED_PROXY_HOPS` | `1` | no | Number of your own proxies in front of Next, 1 to 5 (anything else becomes 1): `1` for one reverse proxy as in `deploy/`; behind Cloudflare keep `1` and restore the visitor address in nginx, or use `2` only if the origin accepts connections from Cloudflare alone ([INSTALL.md](INSTALL.md#behind-cloudflare)). Every per-IP limit in Next (GitHub sign-in, admin password sign-in, views, contact, newsletter, search), and the address forwarded to the backend with `CLIENT_IP_TOKEN`, is the one at position N counting from the right of `X-Forwarded-For`, because the first entry is whatever the client sends. Too low and readers behind one proxy share one limit; too high and the key is something the client chooses. If that entry is not an IP address the request is treated as unknown and shares one key per limit: the allowance of one address for the sign-in limits, a wider one for the rest. In production Next logs a `[client-ip]` line once when a header is shorter than this number or missing. |
| `ROUTE_CACHE_MAX_MB` | `256` (compose passes it) | no | **No effect while `frontend/cache-handler.mjs` is configured, which is every build but `next dev`, the image included.** The handler keeps the pages Next renders on demand and the data cache in Next's in-memory LRU (`cacheMaxMemorySize`, 50 MB by default), which is what bounds a flood of made-up post addresses (a 404 is a page of about 250 KB), and writes nothing to `.next/server/route-cache`. Only for a build without the handler: the most megabytes that folder may take on disk, the oldest files removed every 30 seconds when it is over; `0` means no limit; anything that is not a whole number of megabytes means 256. Read when the server starts, which also removes the page entries and cached backend answers that an earlier process left on disk ([SECURITY.md](SECURITY.md#caching-and-a-cdn-in-front)). |
| `NODE_ENV` | `production` in the image | no | When `production`, session cookies and the sign-in flow cookie carry the `secure` flag, so over plain HTTP the browser drops them and login silently does nothing. |
| `PORT`, `HOSTNAME` | `3000`, `0.0.0.0` in the image | no | Set by `frontend/Dockerfile`. Do not change `HOSTNAME`: a server bound to loopback inside a container is unreachable from outside. |
| `PSEUDO_LOCALE` | unset | no | `1` renders every message accented and about 30 percent longer, to check layouts (build and start with it). Never in production. See [DEVELOPMENT.md](DEVELOPMENT.md). |

The E2E suite reads further variables (`E2E_BASE_URL`, `E2E_LOCALE`, `E2E_API_URL`, `E2E_ADMIN_EMAIL`, `E2E_ADMIN_PASSWORD`,
`E2E_SEARCH_ENGINE`, `E2E_PSEUDO`, `E2E_PHONE_PHOTO`, `MOCK_GITHUB_*`); they belong to testing, not to a deployment, and are
described in [DEVELOPMENT.md](DEVELOPMENT.md).

## Split deployment

Compose keeps everything on one machine, and its two internal links (the Next server to the backend, the backend to PostgreSQL) stay on
a private Docker network. When a part runs elsewhere (a frontend on a platform such as Vercel, a backend on Koyeb or Render, a managed
database such as Neon or RDS), those links cross a network that is not yours, and both carry secrets: the first bearer tokens,
`VIEWS_TOKEN` and `CLIENT_IP_TOKEN`, the second every password hash, session and post. Both must be TLS, and both are checked:

- **Next to the backend:** `API_BASE_URL=https://api.example.com`. In production the frontend image refuses to start with a plain `http`
  URL to a host that is neither the machine itself nor a single-label service name (`http://backend:8080`): the container exits with a
  message that names the host (`scripts/start-check.mjs`). Where Next is started some other way (a platform such as Vercel, a bare
  `next start`) nothing checks at start: every page and route that talks to the API fails with a 500 and the log says why. A private
  network you trust (a VPN, a VPC) can be accepted on purpose with `API_ALLOW_PLAINTEXT=true`.
- **The backend to PostgreSQL:** `DB_SSLMODE=verify-full`, which encrypts the link and proves the server is the one named in `DB_HOST`.
  pgjdbc then needs the certificate authority to check the server certificate against, and it does **not** fall back to the JVM's
  trust store by itself, so name one of two things in `DB_JDBC_PARAMS`:
  - a certificate signed by a public CA (Neon, for example): `DB_JDBC_PARAMS=&sslfactory=org.postgresql.ssl.DefaultJavaSSLFactory`,
    which checks the chain against the JVM's trust store (the host name is still compared, because the mode is `verify-full`);
  - any other CA (Amazon RDS, your own): `DB_JDBC_PARAMS=&sslrootcert=/certs/ca.pem`, a CA certificate file the user the backend runs
    as can read (mount it into the container, or put it next to the jar).

  Without either, `verify-full` fails with "Could not open SSL root certificate file", and the default `prefer` falls back to plain
  text and checks nothing. A production backend refuses to start, before it opens the first connection, when it reaches such a host with
  `prefer`, `allow` or `disable`, or with `NonValidatingFactory`; `DB_ALLOW_INSECURE_TRANSPORT=true` accepts that on a network you
  control, with a warning. **Upgrading** a backend that already uses a remote database needs this set before the new version starts
  ([Upgrading](UPGRADING.md#settings-that-need-care)).
- The backend's own public URL (Koyeb, Render) and the `TRUSTED_PROXY_HOPS` of the frontend are described under
  [GitHub login in production](#github-login-in-production) and in [SECURITY.md](SECURITY.md#reverse-proxy-and-the-client-address).

## Startup checks of a public site

The backend is fail-closed: it behaves as production unless the operator opts in to development defaults. The opt-in is the Spring
profile `dev` (what `mvn spring-boot:run` enables and the tests use) or `APP_ALLOW_DEV_DEFAULTS=true` for a throw-away E2E or CI
stack. Nothing else opts in: not an empty or `localhost` `SITE_URL`, not the jar, not the Docker image. A `SITE_URL` (or
`GITHUB_REDIRECT_URI`) whose host is not `localhost`, `127.0.0.0/8` or `::1` is production even with the opt-in; a host that cannot
be read counts as public, and so does a LAN address used to try the site from a phone (`http://192.168.1.10:3000`): give that run
its own secrets. Messages name the variable, never the value. In production:

- a missing `JWT_SECRET`, or the development one, refuses the start (anyone who read the source could sign an ADMIN token);
- an admin account that still accepts the development password `admin12345` refuses the start, and password sign-in always
  rejects that password. A fresh install is safe: the seeded password is locked until `/setup` is done;
- an empty `VIEWS_TOKEN` or `CLIENT_IP_TOKEN` refuses the start, and so does one shorter than 16 characters;
- a `JWT_SECRET`, `VIEWS_TOKEN` or `CLIENT_IP_TOKEN` (and, with `smtp`, a `NEWSLETTER_SECRET`) that is guessable refuses the start: made
  only of placeholder words, one short pattern repeated, fewer than 6 different characters, or mostly a run of characters in sequence.
  The message names the variable and the reason, never the value; every value of the commands in this guide passes;
- `MFA_ENCRYPTION_KEY` that is missing, not base64 or not 32 bytes refuses the start in **every** mode; in production the development
  key of the repository and a value equal to `JWT_SECRET` refuse it too;
- `MFA_ENROLLMENT_TOKEN` or `MFA_RESET_TOKEN` shorter than 24 characters refuses the start;
- an `app.oauth.github.provider.*` address (the override used only by tests and the E2E stack) that is not `https` on `github.com` or
  `api.github.com` refuses the start when GitHub sign-in is on and `SITE_URL` (or `GITHUB_REDIRECT_URI`) is public; on a loopback
  site it is still allowed, with a warning;
- `NEWSLETTER_TRANSPORT=log` logs a WARN (mail is accepted but not sent, and the admin newsletter page counts every mail as
  sent); with an empty `NEWSLETTER_SECRET` a second WARN says the development key is in use;
- with Meilisearch in use (`SEARCH_ENGINE=meilisearch` or `MEILI_URL` set), a missing `MEILI_MASTER_KEY`, one shorter than 32
  characters, or the `.env.example` placeholder refuses the start;
- a PostgreSQL that is not on the machine itself or a single-label service name (`postgres`), reached with `sslmode` `prefer`, `allow`
  or `disable` (the last value of a repeated parameter counts) or through the factory that accepts any certificate, refuses the start,
  before the first connection is opened; `require` and `verify-ca` start with a warning; `verify-full` is accepted
  ([Split deployment](#split-deployment)). The Compose install talks to `postgres` on a private network and is not affected.

`NEWSLETTER_TRANSPORT=smtp` has a stricter check of its own (see [Newsletter in production](#newsletter-in-production)).

An existing installation upgraded from before these checks, still on the development defaults, will not start until `JWT_SECRET`,
`VIEWS_TOKEN`, `CLIENT_IP_TOKEN` and `ADMIN_PASSWORD` are set (and every install now also needs `MFA_ENCRYPTION_KEY`) (a bare `java -jar`, Koyeb or Render install that relied on the defaults included); setting `ADMIN_PASSWORD` to a new value revokes the admin's sessions. See [UPGRADING.md](UPGRADING.md).

## Link the admin account to GitHub

Until linked, the first GitHub sign-in always creates a separate reader (`USER`) account, even with the site owner's own GitHub:
accounts are never joined by email. Promoting that reader to ADMIN in `/admin/users` only adds one more admin; posts,
notifications and the "Site owner" badge still belong to the original admin account. To make a GitHub sign-in land on that admin
account itself, set `ADMIN_GITHUB_ID` to the **numeric id** of the GitHub account, the `"id"` field of
`https://api.github.com/users/<login>` (a login can change, the id cannot). At startup the backend attaches the id to the admin
account (`ADMIN_EMAIL`); password sign-in keeps working.

- **Already signed in with GitHub as a reader earlier?** That reader account is merged into the admin: comments, likes on posts
  and comments, saved posts and notifications move to the admin, then the reader account is deleted. Notifications that would
  make the admin notify themselves are dropped. The log gets one WARN line `merged GitHub reader account into admin ...`.
- **Notifications about a post (likes, comments) go to the post author's account**, the admin for the owner's posts. Only a
  session of that very account sees them: a password sign-in, or a GitHub sign-in linked through `ADMIN_GITHUB_ID`. An unlinked
  GitHub account is a separate reader that does not see them; linking fixes it thanks to the merge above.
- **The first link signs the admin out once.** Linking or merging changes who can reach the admin account, so every session it had
  (refresh tokens and access tokens issued so far) ends and you sign in again, with the password or with GitHub. A startup that finds
  the link in place changes nothing.
- **It never blocks startup**, unless the value is not a positive integer. If the id already belongs to another ADMIN or AUTHOR,
  the admin already has a different id, or the database fails during the attach, there is one WARN line and nothing changes.
- **`ADMIN_GITHUB_ID` also closes `/setup`.** Without GitHub login configured, set `ADMIN_PASSWORD` instead.
- **Removing the variable does not unlink.** To unlink, remove `ADMIN_GITHUB_ID` first (while it stays set, the next startup attaches it
  again), then run the SQL below from the directory of the running compose. The admin account keeps its email and password.

  ```bash
  docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" "$POSTGRES_DB"'
  ```

  ```sql
  UPDATE users SET github_id = NULL WHERE email = 'admin@blog.local';  -- use the ADMIN_EMAIL value
  ```

  Unlinking does not sign anyone out: an ADMIN session already opened through GitHub stays alive, because the refresh token is
  renewed (30 days) on every use. If you unlink because you lost control of the GitHub account, also revoke every session of the
  admin (an access token bound to a revoked session is refused at once; also set `users.tokens_valid_after = now()` to end tokens issued without one), then sign in again with the password:

  ```sql
  UPDATE refresh_tokens SET revoked_at = now()
  WHERE revoked_at IS NULL AND user_id = (SELECT id FROM users WHERE email = 'admin@blog.local');
  ```

## GitHub login in production

**Do not open the site to readers before there is an OAuth App.** The frontend does not know that GitHub sign-in is off: the
"Sign in" button, the invitation to comment and the like button still show, and clicking them leads to `/login` with the sentence
"Signing in with GitHub is not enabled on this server". Reading posts, comments and like counts still works; only writing does not.

Create a **separate OAuth App** for production at GitHub, Settings, Developer settings, OAuth Apps (not a GitHub App; each app has
one callback, so a local app keeps its own):

- Homepage URL: your `SITE_URL`, for example `https://example.com`;
- Authorization callback URL: `<SITE_URL>/api/auth/github/callback`, character for character. That is a Next route, not a
  backend one: GitHub sends the browser back to the site, then Next calls the backend from the server.

There is no field for scopes: the backend asks for `read:user` itself (the public profile: id, login, name, avatar). The email is
neither requested nor stored. Generate a client secret and copy it at once: GitHub shows it once. Put `GITHUB_CLIENT_ID` and
`GITHUB_CLIENT_SECRET` into `.env`, optionally `ADMIN_GITHUB_ID`, then run `docker compose up -d`. Compose already passes
`SITE_URL` to the backend.

- **HTTPS is required.** The backend refuses to start with an http callback (except on loopback). The session cookie and the
  sign-in flow cookie (`__Host-oauth_flow`) carry the `secure` flag, so over plain HTTP sign-in silently has no effect.
- **A single host.** Readers must be on exactly the host of `SITE_URL`. If a sign-in starts at `www.example.com` and the callback
  returns to `example.com`, the attempt's cookie sits on the other host and every attempt ends in "The sign-in session expired or
  is not valid". Make the proxy redirect the secondary host to the main host outright (both files in `deploy/` do).
- **Next only takes requests through the proxy.** The frontend rate-limits GitHub sign-in per IP (20 starts or finishes in 10
  minutes), reading the address at entry `TRUSTED_PROXY_HOPS` from the right of `X-Forwarded-For`. Whoever can call Next's port
  directly can choose that key, and also skips the proxy's body-size limits. That is why compose publishes the frontend only on
  `127.0.0.1` (`SITE_BIND`); do not change it to `0.0.0.0` when the proxy is on the same machine: Docker opens published ports with
  its own iptables rules, which `ufw` does not block.
- **The OAuth code stays out of the access log.** It is in the callback's query string. `deploy/Caddyfile.example` and
  `deploy/nginx.conf.example` both switch logging off for `/api/auth/github/callback`. Next's OAuth responses carry
  `Referrer-Policy: no-referrer`, and neither the backend nor Next logs the code, state or token.
- **There is no CORS to configure.** The browser never calls the API. The readers' write routes and the admin password form reject a
  request whose `Origin` differs from the host in the `Host` header, so the proxy must pass `Host` unchanged.
- **The backend must reach `github.com` and `api.github.com`** to exchange the code and read the profile (connect at most 5
  seconds, wait at most 10). If it cannot, readers see "Could not reach GitHub right now".
- **One backend, one Next.** Rate limits, the set of already used OAuth `state` values and Next's session-refresh memory (one
  minute) live in process memory: a restart forgets them and two instances each keep their own.
- **A backend with a public URL (Koyeb, Render)** has its two OAuth paths (`/api/v1/auth/oauth2/...`) directly callable, bypassing
  Next's per-IP limits and the backend's own per-address ones. A sign-in still needs the signed blob and GitHub's one-time code, so
  this is a loosening, not a hole. There, set `SITE_URL`, `CLIENT_IP_TOKEN` and the other secrets for the backend in the platform's
  configuration: it does not read compose.

Running GitHub login on a development machine is described in [DEVELOPMENT.md](DEVELOPMENT.md).

## Newsletter in production

**Sending real mail has not been verified by the project's checks.** Every check used the `log` transport or an in-process fake
transport. The default is `NEWSLETTER_TRANSPORT=log`: the site accepts subscriptions and the worker runs, but each mail is one INFO
line (kind and id) and nothing leaves the machine. The variables are in the table [above](#newsletter).

With `smtp` the backend **refuses to start**, before opening the port, with a message that names the variable but not its value,
when:

- `SITE_URL` is empty, unreadable, not https, or its host is loopback, `localhost`, `*.localhost`, `0.0.0.0` or `::` (every link in a
  mail is built from it, and a development machine must never send mail);
- `NEWSLETTER_FROM` is not exactly one valid address (a display name is allowed);
- `SMTP_HOST` is empty;
- `SMTP_STARTTLS=false` with a host that is not a loopback address (unless `SMTP_PROTOCOL=smtps`), or `SMTP_PROTOCOL` is neither `smtp` nor `smtps`;
- `NEWSLETTER_SECRET` is shorter than 32 bytes.

**Turning on real sending:**

1. Pick an SMTP provider with port 587 and STARTTLS (a transactional mail service, or the SMTP of a mailbox on your own domain).
2. Authenticate the sending domain at the provider: add the DNS records they give you, usually SPF and DKIM and ideally DMARC.
   Without them mail lands in spam or is rejected, and readers never receive the confirmation mail.
3. Fill `.env`: `NEWSLETTER_TRANSPORT=smtp`, `NEWSLETTER_FROM`, `NEWSLETTER_SECRET`, `SMTP_*`; then `docker compose up -d` (only the
   backend is recreated).
4. Check: the backend log no longer has the WARN `NEWSLETTER_TRANSPORT is log`; subscribe with your own mailbox at `/newsletter`; the
   confirmation mail arrives after about 30 seconds (one worker pass); confirm; look at the mail's `List-Unsubscribe` header and
   try unsubscribing; publish a new post and wait for the new-post mail; the error table at `/admin/newsletter` is empty.

**Tokens in the access log.** The confirm and unsubscribe links (`/newsletter/confirm?token=...`, `/newsletter/unsubscribe?token=...`)
and the mailbox's one-click unsubscribe (`POST /api/newsletter/unsubscribe?token=...`) carry the token in the query string. The
Caddy example logs none of those paths; the nginx example logs every request without the query string (`log_format no_query`: `$uri`,
no `Referer`), so search terms (`/search?q=`, `/api/search/suggest?q=`) stay out of the log too. Both examples
treat `/admin/login` the same way, as a second layer: the login form is a `POST` even before its script has loaded, so the password
should never be in a query string, but a page cached by an old browser may still send a `GET`. The nginx file was run on a real nginx
and the Caddy file on a real Caddy (`DEPLOY_EXAMPLES_DOCKER=1 python scripts/test_deploy_examples.py`). nginx's `error.log` can still copy the
whole request line when the upstream fails, and Caddy's error log names the request until the example's global `log` filter cuts the query
(it does), so keep proxy logs short-lived ([SECURITY.md](SECURITY.md#reverse-proxy-and-the-client-address) has the retention advice).

How the newsletter works for readers and the owner, and its data, is in [ADMIN-GUIDE.md](ADMIN-GUIDE.md).

## Search with Meilisearch

PostgreSQL stays the source of truth and the default engine. Meilisearch is a copy used only for searching (partial words, typo
tolerance, excerpts, technical tokens such as `C++` or `json.loads`), switched on with `SEARCH_ENGINE`. Every hit it returns is
re-checked against PostgreSQL in one query before it is returned: content that is no longer public never appears, even when the
index has not caught up. Your content language does not change how this is set up; the PostgreSQL search folds case and
diacritics for both languages (details in [CONTENT-AND-I18N.md](CONTENT-AND-I18N.md)).

The variables are in the [Search table](#search). The compose service exists only with the `search` profile, uses the pinned image
`getmeili/meilisearch:v1.54.3` (never `latest`), has a 512m memory limit, no telemetry, and is published only on
`127.0.0.1:7700`. The backend does not depend on it: it starts even when Meilisearch is down and search is then PostgreSQL.

**Order to switch it on** (manual; nothing automates it for production):

1. Keep `SEARCH_ENGINE=postgres`. `MEILI_MASTER_KEY` is already set by `init-env`; otherwise put a real one in `.env`.
2. `docker compose --profile search up -d --build`.
3. Set `MEILI_URL=http://meilisearch:7700` in `.env` and run `docker compose up -d`: indexing is on, search is still PostgreSQL.
4. Reindex as a dry run, then for real (below), and read the status: `index.byType` equals `database.byType` and `outbox.failed` is 0.
5. Set `SEARCH_ENGINE=meilisearch` and run `docker compose up -d`. Watch `counters.degradedRequests` in the status.

**Rolling back** is `SEARCH_ENGINE=postgres` and a backend restart; nothing else changes. If you keep `MEILI_URL` the index keeps
being updated, so switching back on needs no reindex. **Backups:** none needed for the index; it is rebuilt from PostgreSQL, which
is also what you do after losing the `meili_data` volume.

**Reindex and status** are admin API calls, `POST /api/v1/admin/search/reindex` (`dryRun=true` by default: counts only, writes
nothing) and `GET /api/v1/admin/search/status`. There is no screen for them in the admin. They need an ADMIN access token, and the
backend port is not published. One way, not yet run against a live stack, is to execute the calls inside the backend container:
sign in as an administrator in two steps (`POST /api/v1/auth/login` answers 202 with a `challenge`, and `POST /api/v1/auth/mfa/verify`
with that challenge and a current code answers with `accessToken`; [the backend README](../backend/README.md#two-step-sign-in-by-hand)), then send that token as
`Authorization: Bearer <token>` with `wget` from `docker compose exec backend`. Reindex is limited to 3 per 10 minutes per admin.
A real run builds `<index>_build`, writes in batches of 200, checks the count, swaps it in, deletes the old index and reconciles
right away; if it fails before the swap, the half-built index is deleted and the serving one is untouched. Errors: 409
`SEARCH_NOT_CONFIGURED` (no `MEILI_URL` or `MEILI_MASTER_KEY`), 409 `SEARCH_REINDEX_RUNNING`, 502 `SEARCH_REINDEX_FAILED` (names the
step), 429 `RATE_LIMITED`. The status shows the engine, whether Meilisearch is reachable and its version, document counts by type
in the index and in PostgreSQL, the outbox (`pending`, `failed`, `oldestPendingAgeSeconds`), the last reconciliation and the
counters since startup; never a key, a URL or a query.

**Delivery guarantee:** at least once and eventually consistent; reads fail closed at once. Every change to public content writes
a `search_outbox` row in the same transaction; a worker (every 10 seconds) re-reads the database, writes or deletes the document
and removes the row after the task finishes; retries start at 30 seconds and double up to 30 minutes, and a row is FAILED on the
10th attempt. A reconciliation (minute 23 of every hour) compares a content hash per document and repairs missing, stale and extra
documents. One backend instance only.

| Situation | Look at | Do |
|---|---|---|
| Stale results | `outbox.pending`, `oldestPendingAgeSeconds`, `lastReconciliation` | Wait for the worker (seconds) or the reconciliation (hours); to fix it now, reindex. PostgreSQL meanwhile blocks content that is no longer public. |
| Missing documents | `index.byType` against `database.byType` | The reconciliation repairs it; to fix it now, reindex. |
| Index task failed | `outbox.failed`, the log, `lastReconciliation.failed` | `INDEX_NOT_FOUND`: no reindex has ever run, run one. `TASK_FAILED`: the log has the id of the rejected document; fix that content. A complete reconciliation resolves old FAILED rows. |
| Meilisearch is down | `meilisearch.reachable`, `counters.degradedRequests` | Search has already fallen back to PostgreSQL (`degraded`). `docker compose --profile search up -d meilisearch`; the outbox catches up by itself. |
| Changing the key | `meilisearch.error` | Change `MEILI_MASTER_KEY` in `.env`, restart `meilisearch`, then the backend. The child keys derive from the master key and are recreated; if `INVALID_API_KEY` remains, reindex. |
| Upgrading Meilisearch | its release notes | Change the image tag in `docker-compose.yml`, delete the `meili_data` volume, `up -d`, reindex. Search is PostgreSQL meanwhile. |

## Upload size limits, by layer

Each layer blocks as early as it can, and each later layer is slightly wider than the one before, so the error shows up at the layer
that can explain it best.

| Layer | Limit | When exceeded |
|---|---|---|
| Browser (admin) | A file over 4 MB or a side over 2400 px is shrunk to a JPEG with a side of at most 2400 px before sending. Smaller files are sent as they are, so the server can still read the shooting date from EXIF. | n/a |
| Reverse proxy | `deploy/` examples: 1 MB for everything, 6 MB for `/admin/`. | 413 from the proxy |
| Next, Server Action | `serverActions.bodySizeLimit: '5mb'`, multipart overhead included. The upload action rechecks that the file is at most 4 MB before sending it to the backend. | Next rejects the action; for a file over 4 MB the action returns an error shown in place. |
| Next, `proxy.ts` | `proxyClientMaxBodySize: '10mb'`, always larger than the limit above (a test pins the relation). | The body is cut off **silently**, which is why it must be wider. |
| Spring | Multipart `max-file-size` 10MB, `max-request-size` 11MB; `app.media.max-upload-size` 10MB rechecked in code. | 413 `MEDIA_TOO_LARGE` |
| Backend, JSON body | `RequestSizeLimitFilter`: 64 KiB for every `/api/**` path except `/api/v1/admin/**`, 6 MiB under it (`app.request-limit.*` above), counted before anything reads the body, also for a chunked one. The JSON reader then refuses a string over 1,000,000 characters or a document over 8 MiB, and `@Size` on the anonymous request records gives a 400 for a field that is too long. This is the only bound of a backend with a public URL of its own. | 413 or 400 `VALIDATION_ERROR` |
| Image pipeline | At most 50 million pixels, read from the header before decoding. A stored image has its long side at most 2400 px and at most 4 MiB. Only JPEG, PNG and WebP, by magic bytes. | 422 `MEDIA_DIMENSIONS_TOO_LARGE`; 413 `MEDIA_TOO_LARGE` when even shrunk to 800 px it is over 4 MiB; 415 `MEDIA_UNSUPPORTED_TYPE` |
| Quota | Total of all images at most `MEDIA_MAX_TOTAL_SIZE`. | 422 `MEDIA_QUOTA_EXCEEDED` |

Public pages send nothing over 16 KB (a view beacon is at most 512 bytes, a comment at most 16 KB). The 1 MB proxy limit has real
work to do: Next reads every multipart POST to every page up to 5 MiB before it knows whether it is a valid action, so the proxy is
the place that stops junk POSTs before they take up Next's memory.

## Changing `JWT_SECRET`

Change it when the secret may have leaked: whoever has it can sign an access token with the ADMIN role themselves.

```bash
# .env: JWT_SECRET=<new value>, for example from `openssl rand -base64 48`
docker compose up -d    # only the backend is recreated: only it reads this variable
```

- **Every existing access token is invalid at once** (they live at most 15 minutes): the backend answers 401.
- **Refresh tokens are not.** A refresh token is a random string stored as SHA-256 in the `refresh_tokens` table, not signed with the
  secret, so changing `JWT_SECRET` does **not** sign anyone out. Readers have nothing to do: the session route and the write
  routes refresh the session once on a 401 and carry on. An admin who still holds an old access token is sent to `/admin/login`:
  sign in again, or wait up to 15 minutes.
- **GitHub sign-ins in progress break:** that attempt's cookie is signed with a key derived from `JWT_SECRET`.

Signing out every session for real means revoking every refresh token:

```bash
docker compose exec postgres sh -c \
  'psql -U "$POSTGRES_USER" "$POSTGRES_DB" -c "UPDATE refresh_tokens SET revoked_at = now(), expires_at = LEAST(expires_at, now()) WHERE revoked_at IS NULL;"'
```

`expires_at` is ended at the same time, like every bulk revocation of the backend: a revoked token that is still valid by expiry
would be treated as an old token being reused (reuse detection) each time an old device sends it, and each time that signs the user
out once more. If the secret leaked, changing it blocks forged tokens; revoke refresh tokens too when the sessions themselves may
have been taken.

## Changing `MFA_ENCRYPTION_KEY`

There is nothing to do for a normal operation: the key is read at start and never leaves the backend. Change it only when it may have
leaked, and know the cost first. **This release has no key rotation:** a new key cannot read what the old one wrote.

- **Every enrolled account loses its enrollment.** The ciphertexts in `user_mfa` cannot be decrypted, so each enrolled account
  answers `MFA_CODE_INVALID` to every code (the backend log has `mfa secret undecryptable userId=...`, one line per attempt, never the
  value), recovery codes still work for a sign-in, and each person then replaces the authenticator.
- **The way back is the operator reset**, once per enrolled account: `MFA_RESET_EMAIL` and a new `MFA_RESET_TOKEN` per account, one
  restart each, or the SQL in [Security](SECURITY.md#when-the-phone-or-the-codes-are-lost). Start with the administrators.
- **Do it in this order:** save the new key in your password manager, put it in `.env`, run the reset for each administrator (the
  reset can run in the same restart as the key change for one account), `docker compose up -d`, then follow the enrollment page. An
  administrator who enrols again needs the enrollment code ([`MFA_ENROLLMENT_TOKEN`](#site-secrets-and-the-admin-account) or the
  generated file).
- **Losing the key is the same as changing it.** A restored database dump has no key: put the saved key in `.env` before you start the
  backend ([Backup and restore](BACKUP-AND-RESTORE.md)).

## Health check

`GET /api/v1/health` returns `{"data":{"status":"UP","database":"UP"}}`, and 503 when it cannot read the database. Compose uses it
for `depends_on: service_healthy`. The backend port is not published, so from the host use
`docker compose exec backend wget -q -O - http://localhost:8080/api/v1/health`. The endpoint is listed explicitly in the security
configuration, because the filter chain's fallback is deny: a health check that always answers 403 is something a reverse proxy
believes, and it pulls the whole site out of rotation.
