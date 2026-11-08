# Upgrading

How to move a running Blog Engine to a newer version, and how to go back if it goes wrong. The short version: back up first,
build the new version, let the backend migrate the database, run the checks.

## Contents

- [The rules](#the-rules)
- [Release with two-step verification](#release-with-two-step-verification)
- [Release with session and cookie changes](#release-with-session-and-cookie-changes)
- [Before you upgrade](#before-you-upgrade)
- [Upgrade](#upgrade)
- [Checks after every upgrade](#checks-after-every-upgrade)
- [Rolling back](#rolling-back)
- [Moving to the three database roles](#moving-to-the-three-database-roles)
- [Settings that need care](#settings-that-need-care)
- [An existing deployment is never re-claimable](#an-existing-deployment-is-never-re-claimable)

## The rules

- **Flyway only goes forward.** The backend applies every migration it has that the database does not, in order, when it starts.
  There are no reverse migrations, and an older backend image is not promised to work on a newer schema.
- **Nothing in a migration is edited after release.** Flyway stores a checksum of every applied migration and the backend refuses
  to start if a file changed, even by a comment. If you see a checksum error, you or your tooling modified a migration:
  see [Troubleshooting](TROUBLESHOOTING.md).
- **The database holds everything**: posts, comments, site content, subscribers and uploaded images. A backup of the database is a
  backup of the whole site ([Backup and restore](BACKUP-AND-RESTORE.md)).
- **Rolling back means the pre-upgrade dump plus the old image**, in that order. Everything written after the upgrade is lost.

## Release with two-step verification

**Read this before you upgrade a site that already has an administrator.** This release makes two-step verification (an authenticator
app) mandatory for every ADMIN account, and the backend needs a new required secret. Three things can lock you out if you skip them.

**What the administrator sees.** Every administrator session is ended by the upgrade (the migration revokes them). The next sign-in
with the password does not open the admin area: it leads to an enrollment page that shows a key and a link for an authenticator app,
asks for the first code, and then shows ten recovery codes **once**. Save them. After that, every sign-in is password, then code.
Readers are not affected. An author is asked for a code only after enabling it in `/admin/security`.

**Where the enrollment code is.** An existing site does not let a password alone start the enrollment (a stranger who guessed it could
enrol a phone of their own). The page asks once for the **enrollment code**, a proof that you can read the server:

```bash
docker compose logs backend | grep "enrollment code"        # prints the path, never the code
docker compose exec backend cat /data/mfa-enrollment-code
```

If you prefer a value of your own, put `MFA_ENROLLMENT_TOKEN=<24 or more random characters>` in `.env` before the upgrade, and remove
it after you enrolled. A site claimed through `/setup` after this release needs no code for the first hour.

### Three lockouts to avoid

1. **`MFA_ENCRYPTION_KEY` is required, and the backend refuses to start without it.** `scripts/init-env.sh` and `init-env.ps1` refuse to
   touch an existing `.env`, so append the key yourself, once, from the directory that contains `.env`:

   ```bash
   printf '\nMFA_ENCRYPTION_KEY=%s\n' "$(openssl rand -base64 32)" >> .env
   ```

   ```powershell
   $bytes = New-Object 'byte[]' 32
   $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($bytes); $rng.Dispose()
   Add-Content -Path .env -Value ("`nMFA_ENCRYPTION_KEY=" + [Convert]::ToBase64String($bytes))
   ```

   Then **copy the key outside the server** (a password manager). A database backup does not contain it, and without it every
   enrollment is lost ([Configuration](CONFIGURATION.md#changing-mfa_encryption_key)). Outside Compose (Koyeb, Render, a bare
   `java -jar`) set `MFA_ENCRYPTION_KEY` in the platform's configuration.
2. **Deploy the frontend before the backend.** The old admin login route answers a backend `202` (a sign-in that needs a code) with an
   error, so the new backend with the old frontend locks the admin area out until the frontend is upgraded; the new frontend against
   the old backend still works. A single `docker compose up -d --build` is fine (the gap is seconds). With a staged deploy (images from
   a registry, two platforms) start the frontend first.
3. **A server clock that is off by more than 30 seconds rejects every code.** The backend log then has
   `mfa code matched outside window ... offsetSteps=<n>`. Check the clock of the server (NTP) **and** of the phone
   ([Troubleshooting](TROUBLESHOOTING.md#two-step-codes-are-rejected)).

Also:

- **`CLIENT_IP_TOKEN` is required in the same release** (the backend limits sign-in, including the second step, per client address;
  [Settings that need care](#settings-that-need-care)). Append it to the same `.env` when you append `MFA_ENCRYPTION_KEY`, or the
  backend and `docker compose` refuse to start.
- **`ADMIN_PASSWORD`.** While it is set, the password cannot be changed in `/admin/security` (the variable would undo the change at the
  next start). It is also checked against the [password policy](SECURITY.md#password-policy) when its value changes. An unchanged
  value that the policy now rejects keeps working and logs one warning.
- **A lost phone and lost recovery codes** are recovered by the person who controls the server, with `MFA_RESET_EMAIL` and
  `MFA_RESET_TOKEN` ([Security](SECURITY.md#when-the-phone-or-the-codes-are-lost)). Know this before you need it.
- **Rolling back is a security regression.** A backend from before this release does not know the second step: on a database that kept
  the new tables it signs administrators in with the password alone. Restoring the pre-upgrade dump (the procedure
  [below](#rolling-back)) removes the enrollments with it. Upgrade again as soon as you can.
- **API clients.** `POST /api/v1/auth/login` answers `202` without a token for an account that needs a second step, and the token
  comes from `POST /api/v1/auth/mfa/verify`. A script that signs in as an administrator must follow that handshake
  ([backend README](../backend/README.md#two-step-sign-in-by-hand)).

## Release with session and cookie changes

**Everybody signs in once after this upgrade, and nothing else is required.** The session cookies are renamed in production to
`__Host-access_token` and `__Host-refresh_token` (the `__Host-` prefix stops a sibling subdomain from planting a session cookie, see
[SECURITY.md](SECURITY.md#authentication-and-sessions)). The frontend never reads the old `access_token` and `refresh_token` cookies of
a production browser, because a cookie of that name can be planted; it deletes them on its next response that sets or clears the
session. A reader sees the signed-out page, an administrator is sent to `/admin/login`, and the sessions that were open stay valid in the
database until they expire or you sign out everywhere. Nothing needs to be configured. Development on plain HTTP keeps the plain
names. Deploy the frontend and the backend of this release together.

**Access tokens in flight are refused once.** Access tokens now carry an issuer and an audience, and the backend refuses a token
without them. The tokens issued before the upgrade (at most 15 minutes old) therefore answer 401: a reader's page refreshes by
itself, and an administrator in the middle of a page may be sent to sign in again. Nothing else changes for the people who sign in
afterwards. `JWT_SECRET` must have at least 8 different bytes now; a secret from `openssl rand` always does.

**Role changes ask for your own code.** A role change to or from ADMIN, and a change that makes a reader an author (in `/admin/users`
or by approving an application), now needs a sign-in from the last 10 minutes and the acting administrator's own code, and a promotion
to ADMIN removes the promoted account's authenticator (it enrols again with the enrollment code at its next sign-in). The admin pages
ask for the code; a script that calls `PATCH /api/v1/admin/users/{id}/role` or `POST /api/v1/admin/author-applications/{id}/approve`
must send `code` in the body ([SECURITY.md](SECURITY.md#authentication-and-sessions)).

**Sessions of admins and authors now end.** Until now a session of any role slid for as long as it was used and lived 30 days after
its last use. From this release a session of an **ADMIN or AUTHOR** ends after 7 days without use and, however active it was, 30 days
after the person signed in (`PRIVILEGED_SESSION_IDLE_TTL` and `PRIVILEGED_SESSION_ABSOLUTE_TTL`, both optional,
[CONFIGURATION.md](CONFIGURATION.md)); readers are not affected. Each new session means a new second-step code for an account that has
one, so expect to enter a code about once a month, and again after a week away. A session opened since the two-step release already
has its real start; one that was open before it carries the `epoch` marker, and migration V45 replaces that with the oldest row of the
session that still exists (never less than a day ago; a session in daily use is at most about a week older than that row says), so
such a session is cut once 30 days have passed from that start, not all at once at the upgrade. The backend now also answers `refreshExpiresIn` (seconds) next to `expiresIn` in every token response, and
the frontend sets the cookie's lifetime from it: **deploy the backend first or together with the frontend**; a frontend that finds no
`refreshExpiresIn` falls back to 30 days.

## Before you upgrade

1. Read the section of [CHANGELOG.md](../CHANGELOG.md) for every version between yours and the new one. Anything that needs a
   manual step is listed there.
2. Take a backup and note its file name ([Backup and restore](BACKUP-AND-RESTORE.md)). Copy it off the server if you can.
3. Note what is running, so you can return to it:

   ```bash
   git rev-parse HEAD        # the checkout you run (source installs)
   docker compose images     # the exact image names and tags
   ```

4. Keep the old images. Tag them so that a later `docker compose up -d --build` does not replace them (use the names that
   `docker compose images` printed):

   ```bash
   docker tag <backend image>:<tag> <backend image>:rollback
   docker tag <frontend image>:<tag> <frontend image>:rollback
   ```

5. If you use managed PostgreSQL, check that the backend's database user may create extensions: migration `V23` runs
   `CREATE EXTENSION IF NOT EXISTS unaccent`. `unaccent` is a trusted extension since PostgreSQL 13, so the `CREATE` privilege on
   the database is enough. Without it Flyway stops at `V23` and the backend does not start. The Compose `postgres` service needs
   nothing.

## Upgrade

From the directory that contains `docker-compose.yml` and `.env`:

```bash
git pull
docker compose up -d --build
```

Compose rebuilds both images from your checkout and recreates the containers whose image or configuration changed. On start the
backend runs the new migrations. Each one runs once; the first start of a big upgrade can take a little longer than usual, and
the backend container reports `healthy` only after Flyway has finished (the healthcheck has a 60 second start period).

Things to know:

- **Always build the frontend yourself.** `NEXT_PUBLIC_SITE_URL` and `NEXT_PUBLIC_DEFAULT_LOCALE` are written into the frontend at
  build time, so there is no published frontend image any more (it could only carry `http://localhost:3000`).
  `docker compose up -d --build` builds with the values of your `.env`, and the frontend container now refuses to start when the
  `SITE_URL` of `.env` is not the address its image was built for, so a forgotten `--build` after a change of `SITE_URL` stops the
  deploy instead of serving a site that names the wrong address ([INSTALL.md](INSTALL.md)).
- **`docker compose pull` can fetch the backend image only.** No frontend image is published (see the first item), so there is
  nothing to pull for it and `FRONTEND_IMAGE` stays at its local name. The image names default to local-only names, so a pull does
  nothing until you set `BACKEND_IMAGE` in `.env` to the publishing namespace, pinned to a version tag or a digest
  ([INSTALL.md](INSTALL.md)). If you want the published backend image, set `BACKEND_IMAGE`, pull only that service and build the
  frontend:

  ```bash
  docker compose pull backend
  docker compose build frontend
  docker compose up -d
  ```

  To move to a newer release change the pinned tag or digest in `.env`, then pull again. A pre-release such as `1.0.0-rc.1` gets
  no `latest` tag ([INSTALL.md](INSTALL.md)). Each published image is scanned before its tags move and its digest is signed: run the
  `cosign verify` command of [INSTALL.md](INSTALL.md#prebuilt-backend-image-or-build-from-source) on the new digest before you put it in `.env`.
- **The PostgreSQL and Meilisearch images of the compose file are pinned by digest** (`tag@sha256:...`), so a pull fetches the bytes
  that were tested. A release that moves a pin says so in the changelog. Do not replace the digest by a bare tag; a new PostgreSQL
  major version needs a data migration, not just a new tag.

- **New settings.** A new version can add variables to `.env.example`. Compare it with your `.env`
  (`diff .env.example .env` shows both the new variables and your real values: read it on a private terminal). A required
  variable that is missing makes Compose refuse to start; an optional one keeps its documented default.
- **Meilisearch.** If you run the optional search engine and the release changes the pinned `getmeili/meilisearch` tag, rebuild
  the index after the upgrade (`POST /api/v1/admin/search/reindex?dryRun=false` as an ADMIN; without `dryRun=false` it only
  counts; the runbook is in [the backend README](../backend/README.md#search-with-meilisearch)).
  Postgres is always the source of truth, so setting `SEARCH_ENGINE=postgres` is a safe fallback in the meantime.

## Checks after every upgrade

After `docker compose up -d --build`, and after the first install, from the directory that contains `docker-compose.yml`:

```bash
docker compose ps                 # postgres and backend "healthy", frontend "Up"
docker compose exec backend wget -qO- http://localhost:8080/api/v1/health
# {"data":{"status":"UP","database":"UP"}}
for path in / /sitemap.xml /feed.xml /robots.txt; do
  curl -s -o /dev/null -w "%{http_code} $path\n" "https://<domain>$path"
done                              # four lines of 200
curl -s "https://<domain>/feed.xml" | grep -oE '<item>|<content:encoded>' | sort | uniq -c
# two equal numbers, at most 20 (each item carries the whole post)
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' "http://www.<domain>/"
# 301 https://<domain>/
curl -s -o /dev/null -D - "https://<domain>/" \
  | grep -iE '^(strict-transport-security|x-content-type-options|referrer-policy|x-frame-options):'
```

Replace `<domain>` with the host of `SITE_URL`. Without a `www` redirect, skip that line. A site without published posts has an
empty feed, so the `<item>` count is zero.

What to look for:

- **The headers**: each of `strict-transport-security: max-age=86400` (or your `HSTS_MAX_AGE`), `x-content-type-options: nosniff`,
  `referrer-policy: strict-origin-when-cross-origin` and `x-frame-options: DENY` exactly once. Two lines mean the reverse proxy
  adds the header too: remove it there. A missing HSTS header means the frontend image was built with a `SITE_URL` that is not
  `https`.
- **Health is the backend test.** `/sitemap.xml` still returns 200 when the backend is down, only without the post URLs, while
  `/feed.xml` and the category, series and tag feeds return 503.
- **A feed item without `content:encoded`** is a post whose detail the frontend could not read at that moment. The frontend log has
  a line starting `[feed] Could not read the content of post`, and the next poll retries.
- Open the home page in both languages, sign in to `/admin`, and open a post.

If a check fails, look at `docker compose logs backend frontend` and at [Troubleshooting](TROUBLESHOOTING.md) before you roll back.

## Rolling back

Rolling back replaces the whole database with the dump taken before the upgrade. Everything written since (posts, comments,
subscriptions, uploads, sessions) is lost. From the directory that contains `docker-compose.yml`:

```bash
docker compose stop backend frontend
docker compose exec postgres sh -c \
  'dropdb -U "$POSTGRES_USER" "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
docker compose exec -T postgres sh -c \
  'pg_restore --no-owner --single-transaction -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < "/var/backups/blog/blog-<date>.dump"          # the dump right before the upgrade
git checkout <noted commit or tag>
docker tag <backend image>:rollback <backend image>:<tag>
docker tag <frontend image>:rollback <frontend image>:<tag>
docker compose up -d --force-recreate backend frontend
```

Without the `rollback` tags, drop the two `docker tag` lines and replace the last line with `docker compose up -d --build`: that
rebuilds the old version from the checked-out source. Do not pass `--build` if you tagged images and want to keep them, because
a build replaces the tag.

If `pg_restore` reports an error, **do not start the backend**: `--single-transaction` left the database empty, and Flyway would
build a brand-new schema on it, that is an empty site. Fix the restore first ([Backup and restore](BACKUP-AND-RESTORE.md)).
With the [three database roles](#moving-to-the-three-database-roles), run `docker compose exec -T postgres sh
/docker-entrypoint-initdb.d/10-roles.sh` after the restore and before you start the backend.
After a rollback also run `docker compose up -d --force-recreate frontend` once more if the site still shows content from
before the restore: Next keeps a data cache in the container.

## Content sync after the container hardening

`scripts/content-sync` (export and import of posts between two installs) no longer uses `docker cp`, which cannot write into the
read-only postgres container of the hardened compose file: it streams through `docker exec -i`. Nothing changes in a package. Give
`-User` the owner role on an install with the three database roles (`DB_OWNER_USERNAME`, see below) and `DB_USERNAME` on a single-role
install; see the [README of the tool](../scripts/content-sync/README.md).

## Moving to the three database roles

Compose installs made before this change connect to PostgreSQL with one role that is also the superuser of the container. A bug that
reaches SQL in the backend could then read files and run programs on the database host (`COPY ... PROGRAM`). New installs get three
roles instead ([SECURITY.md](SECURITY.md#containers-and-networks)): a runtime role that can only read and write rows (the backend
connects as it), an owner role that owns the schema and runs the Flyway migrations, and the superuser for administration. **An
existing install is not changed by an upgrade.** It keeps working as it is, with a warning in the backend log at every start on a
public site. Moving it is optional and takes a few minutes of downtime; do it when you have a recent backup:

1. **Back up** ([BACKUP-AND-RESTORE.md](BACKUP-AND-RESTORE.md)) and note the current `DB_USERNAME` and `DB_PASSWORD` of `.env`.
2. **Edit `.env`.** The current pair becomes the administration pair, and the runtime and owner roles are new (pick any names; the
   passwords of the two new roles are random and different from each other and from the old one, for example `openssl rand -hex 24`;
   the postgres container refuses to start when the owner or administration values are missing or when two roles share a name or a password, and says which variable in `docker compose logs postgres`):

   ```bash
   DB_ADMIN_USERNAME=<the DB_USERNAME you have now>
   DB_ADMIN_PASSWORD=<the DB_PASSWORD you have now>
   DB_USERNAME=blog_app
   DB_PASSWORD=<new>
   DB_OWNER_USERNAME=blog_owner
   DB_OWNER_PASSWORD=<new>
   ```

3. **Recreate the database container** so that it sees the new variables and the `deploy/postgres-init` folder (the data volume is
   kept): `docker compose up -d --no-deps postgres`.
4. **Create the roles and move the ownership**, once, as the administration role:

   ```bash
   docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -q -v ON_ERROR_STOP=1 \
     -f /docker-entrypoint-initdb.d/roles.psql'
   ```

   It makes the two roles, hands everything the old role created to the owner role, and gives the runtime role the right to read and
   write rows. It can be run again (it only sets the passwords to the ones in `.env`). It never deletes anything.
5. **Start the rest:** `docker compose up -d`. The backend now connects as the runtime role and Flyway runs as the owner role. Check
   that `docker compose logs backend` has no line "connects to PostgreSQL as a superuser" and that `/admin` works.

**Rolling back** the move is a change of `.env` only: put the old `DB_USERNAME` and `DB_PASSWORD` back and delete the four new
variables, then `docker compose up -d`. The old role is still a superuser and can use everything; the ownership that moved does not
get in its way.

After any restore of a dump on an install that has the three roles, run `docker compose exec -T postgres sh
/docker-entrypoint-initdb.d/10-roles.sh` before starting the backend: `pg_restore --no-owner` gives the restored objects to the role
that restores, and the script gives them back to the owner role and grants the runtime role again. On a single-role install the same
command prints that there is nothing to do.

Outside Compose, give the backend `SPRING_FLYWAY_USER` and `SPRING_FLYWAY_PASSWORD` (the owner role) next to `DB_USERNAME` and
`DB_PASSWORD` (the runtime role); without them Flyway uses the runtime role, which cannot create tables.

## Settings that need care

- **Unsaved editor copies are dropped once.** The browser's copy of a post being written is now bound to the account that typed it
  (`bai-viet:nhap:<userId>:<postId>`). Copies written by an earlier version have no owner, are never offered, and are deleted the first time
  the admin opens after the upgrade, so text that was only in such a copy is lost: save open posts before you upgrade.
- **`DEFAULT_LOCALE`.** On the first start of a database that predates content languages (migration `V34`), every existing post and
  newsletter subscriber is labelled with the value of `DEFAULT_LOCALE`. The migration cannot be repeated, so set it to the
  language your existing posts are written in **before** that start, and leave it alone afterwards. The frontend takes the same
  value as a build argument, so changing it later means rebuilding the frontend image, and it moves which language has no URL
  prefix. Databases created by this version or later are not affected.
- **Database constraints on posts (migration V50).** The database now refuses a post whose status is not `DRAFT`, `PUBLISHED` or
  `ARCHIVED`, a `PUBLISHED` post without `published_at` (the migration first gives such a post the date it last changed), a slug that is
  not lower case words joined by single hyphens, an old slug that is also the current slug of another post, an image of more than
  4 MiB, and a reply to a reply. The migration checks the existing rows and stops with the name of the constraint when one is wrong;
  look for the rows first with
  `SELECT id, slug FROM posts WHERE slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR status NOT IN ('DRAFT','PUBLISHED','ARCHIVED')` and
  `SELECT h.old_slug FROM post_slug_history h JOIN posts p ON p.slug = h.old_slug AND p.id <> h.post_id`, fix them, and start again.
  Posts written by the application always pass.
- **An author's delete hides the post (migration V49).** Posts that authors delete from now on stay in the database as `ARCHIVED`
  with `deleted_at` set, and take no space from the public site. If you want one gone for good, delete it as an administrator from the
  post list, where it shows as "Archived". Nothing to configure.
- **Contact messages are deleted after a year (new setting).** A nightly job now deletes the messages in `/admin/contact` that are older
  than `CONTACT_RETENTION_DAYS` days (365 by default), read or not. If the inbox is your only record of the messages (no
  `CONTACT_RECIPIENT`), copy what you need first, or set `CONTACT_RETENTION_DAYS=0` to keep every message until you delete it.
- **Authors are limited (new settings, all optional).** An AUTHOR is now held to ten tags per post, thirty posts created in 24 hours
  (an import counts each post), thirty images in a post body, a hundred megabytes of images of their own and half of the image quota for
  all authors together, a catalog of at most 1,000 tags and 100 categories for creation by authors, and sixty saves in ten minutes, ten tag or
  category creations an hour and thirty uploads in ten minutes. An administrator is exempt from all of it. Nothing to configure; the
  eight `AUTHOR_*` variables in [CONFIGURATION.md](CONFIGURATION.md#author-limits) change the numbers. Existing content is never
  removed: an author who is already over a number simply cannot add more.
- **The newsletter of an author's post is held (migrations V48 and V51).** Since this release a post that an AUTHOR publishes for the first time
  does not mail the subscribers until an administrator releases it at `/admin/newsletter`; a post you publish yourself is queued as
  before. An issue that was already mailed stays as it is; one that is still queued (not yet split into mails) for a post an author
  wrote is held by the migration too, and listed at `/admin/newsletter` for you to release or discard. Nothing to configure. If your authors expect their posts to
  reach subscribers at once, tell them that an administrator now decides.
- **`NEWSLETTER_SECRET`.** Set it once, before the first subscriber, and never change it: a new key makes every unsubscribe link
  already sent and every suppression row useless.
- **`SITE_URL`.** It is baked into the frontend image. After changing it, run `docker compose up -d --build`, and change the
  callback of the GitHub OAuth App to match.
- **`CLIENT_IP_TOKEN` is new and required.** The backend now limits the contact form, newsletter, admin sign-in (and its second step), session refresh,
  first-run setup and search per client address as well as per email address and for the whole site. It learns the reader's address
  from Next, which sends it together with this shared secret. Without a value the backend refuses to start in production, and
  `docker-compose.yml` refuses to start at all. Add it before you upgrade:

  ```bash
  echo "CLIENT_IP_TOKEN=$(openssl rand -hex 32)" >> .env    # the same line works in a new .env from scripts/init-env
  docker compose up -d --build                              # both services read it: recreate backend and frontend
  ```

  Outside Compose (Koyeb, Render, a bare `java -jar`) set the same value on the backend and the frontend. If the two differ, or the
  frontend has none, nothing breaks at once but every reader counts as one caller to the backend, so its per-address limits trip
  for everybody. New optional properties tune the numbers (`app.rate-limit.*-client`, `*-global`;
  [CONFIGURATION.md](CONFIGURATION.md#rate-limits)); the defaults need no change.
- **Fail-closed startup.** The backend now behaves as production unless the Spring profile `dev` or
  `APP_ALLOW_DEV_DEFAULTS=true` opts in to development defaults. An install that relied on those defaults (a bare `java -jar`,
  Koyeb or Render, a `.env` copied with an empty `SITE_URL`) refuses to start until `JWT_SECRET`, `VIEWS_TOKEN`, `CLIENT_IP_TOKEN` and, if the admin
  still has the development password, `ADMIN_PASSWORD` are set. Compose installs already set them. Never set
  `APP_ALLOW_DEV_DEFAULTS` on a real site. See [Startup checks of a public site](CONFIGURATION.md#startup-checks-of-a-public-site).
- **`MFA_ENCRYPTION_KEY`.** Set it once and keep a copy outside the server. Changing or losing it voids every enrollment
  ([Configuration](CONFIGURATION.md#changing-mfa_encryption_key)).
- **`HSTS_MAX_AGE`.** The default is one day, on purpose, for the first days of HTTPS. About two weeks after the first public start, raise it to
  `31536000` and rebuild the frontend (`docker compose up -d --build`); the frontend build prints an `[hsts]` line until you do
  ([Raise HSTS](INSTALL.md#raise-hsts-after-https-is-proven)). `HSTS_INCLUDE_SUBDOMAINS=true` is a separate, optional switch for an
  operator who owns every subdomain of the host.
- **`JWT_SECRET`.** Changing it invalidates access tokens (15 minutes at most) but not refresh tokens. See
  [Security](SECURITY.md#rotating-jwt_secret-and-ending-sessions).
- **Languages.** The set of enabled content languages is pinned by database constraints. Adding a language needs a migration and a
  frontend change, so it comes with a release, not with a setting ([Content and i18n](CONTENT-AND-I18N.md)).
- **A split deployment must use TLS on its internal links, and the new version refuses to start without it.** This does not touch a
  Compose install (the database and the backend sit on private networks), but it does touch a backend that reaches a database on
  another machine (Neon, RDS, a backend on Koyeb or Render): until now the link used the implicit `sslmode=prefer`, which the new
  backend refuses in production. **Before you upgrade**, set `DB_SSLMODE=verify-full` and one way to check the certificate in
  `DB_JDBC_PARAMS`: `&sslfactory=org.postgresql.ssl.DefaultJavaSSLFactory` for a certificate from a public CA, or
  `&sslrootcert=/path/ca.pem` (a CA certificate file the backend's user can read) for any other, or, on a network you fully control
  (a VPN, a VPC), `DB_ALLOW_INSECURE_TRANSPORT=true`. `verify-full` alone does not work: pgjdbc then looks for `~/.postgresql/root.crt`
  and does not use the JVM's trust store. A frontend that reaches the backend over plain `http` to a host that is not the machine
  itself or a service name needs an `https` `API_BASE_URL` or `API_ALLOW_PLAINTEXT=true`: the frontend image exits at start with a
  message that names the host, and a frontend started another way returns 500 from every page that reads the API
  ([Configuration](CONFIGURATION.md#split-deployment)).
- **The containers are hardened; a local `docker-compose.override.yml` may need a change.** Every service now has a read-only root file
  system (what is written is a tmpfs or a volume), no capabilities and a process limit, and the stack has two networks, `db`
  (internal: postgres and the backend) and `app` (frontend, backend, Meilisearch), instead of the single default one. An override that
  mounts or writes somewhere new needs a volume or a tmpfs, and a service of yours that sat on the default network (a proxy, a backup
  sidecar) can no longer reach the frontend or the backend: attach it with `networks: [app]`. A reverse proxy on the host is not
  affected (it uses the published `127.0.0.1` port). The frontend keeps rendered pages and its data cache in memory and the optimized
  images in a 96 MB tmpfs, so `docker compose restart frontend` now empties both ([Security](SECURITY.md#containers-and-networks)).
- **`BACKEND_IMAGE` and `FRONTEND_IMAGE` default to local-only names.** They used to default to a placeholder registry account. An
  install that built from source (`docker compose up -d --build`) notices nothing. One that ran `docker compose pull` now has to set
  `BACKEND_IMAGE` in `.env` to the publishing namespace and pin a version tag or a digest ([INSTALL.md](INSTALL.md)); until then the
  pull finds nothing and fails. Only the backend image is published; the frontend is always built locally.
- **The backup script is private by default.** If you copied the cron script of
  [Backup and restore](BACKUP-AND-RESTORE.md#back-up-every-day) before this change, copy the new one: the old one created the folder
  as 0755 and the dumps as 0644. Close what exists now: `chmod 700 /var/backups/blog && chmod 600 /var/backups/blog/blog-*.dump`,
  and the same on the other machine.
- **The Content Security Policy is enforced.** Every page now carries a `Content-Security-Policy` that was a `Report-Only` header
  before: scripts, frames, plugins and form posts to other origins are blocked, and violations are reported to `/api/csp-report` and
  logged as `[csp] violation <directive> blocked=<origin>` by the frontend. Images from any `https` host still load. Nothing needs
  to be configured. After the upgrade, watch `docker compose logs frontend | grep "\[csp\]"` for a day: a line means a page or a
  browser extension is blocked ([Security](SECURITY.md#content-security-policy) says how to read it and how to take the policy back
  to Report-Only). A reverse proxy must not add its own `Content-Security-Policy`: the browser would apply both.
- **Posts have size limits at the API and in the database.** A body is at most 500,000 characters and an excerpt at most 1,000
  ([Security](SECURITY.md#upload-limits-by-layer)). A post saved before that, and longer, still loads; saving it again fails with
  400 until it is shortened. Migration `V46` adds the same limits as CHECK constraints on `posts`. It does not scan the table, so a
  site that has such a post still starts: the constraints stay `NOT VALID` (the log has a `V46` warning), they refuse every new
  oversized write, and **any statement that rewrites the row of the long post fails as a whole** until it is shortened (PostgreSQL
  checks a `NOT VALID` constraint on every UPDATE of the row, not only when the text changes): a series order, a cover, a featured
  rank, a translation link, and the merge of a category or a tag that the post uses, which stops with an error at that one post.
  Find them before you upgrade:

  ```sql
  SELECT id, slug, char_length(content) AS content_chars, char_length(excerpt) AS excerpt_chars
  FROM posts WHERE char_length(content) > 500000 OR char_length(excerpt) > 1000;
  ```

  After shortening them, `ALTER TABLE posts VALIDATE CONSTRAINT chk_posts_content_size;` and the same for `chk_posts_excerpt_size`
  finish the job. An older revision that is longer than a post may be can no longer be restored (400).
- **Migration `V47` stores the reading time of a post.** The new column is filled for the posts that exist by the backend when it starts,
  before it serves a request (a log line says how many; a site with thousands of long posts takes a few seconds). Nothing to set. Lists
  no longer read the body of a post, so a first start after the upgrade is the only one that reads them all. A post that is over the
  limits above is skipped (writing its row would fail, see the previous item): the backend starts, logs one `WARN` with the number
  of such posts (no slug, no text), and the post keeps 0, which a card shows as 1 minute, until its text is shortened and saved.
- **The backend reads at most 64 KiB of JSON from the public API and 6 MiB under `/api/v1/admin/`.** A larger request body is
  refused with 413 before it is read, and a JSON string over 1,000,000 characters is refused by the reader. The Compose proxy
  already stops anything over 1 MB (6 MB under `/admin/`), so a site behind it notices nothing; a client of the API that posted a
  bigger body (a script importing very long posts, say) now gets 413. The ceilings are `app.request-limit.public-body` and
  `.admin-body` ([Configuration](CONFIGURATION.md#backend-properties-without-a-variable)).
- **The first-run setup count changed.** `app.rate-limit.setup.per-minute` now counts only *wrong* setup codes for the whole backend and
  defaults to 120 (it counted every attempt and defaulted to 10), so a crowd can no longer keep the owner from claiming a fresh
  instance; the right code is never refused for it. An override of the old number in your own configuration can be removed.

- **Secrets are checked for guessable values in production.** `JWT_SECRET`, `VIEWS_TOKEN`, `CLIENT_IP_TOKEN` and, with `smtp`,
  `NEWSLETTER_SECRET` are refused when they are made only of placeholder words (`changeme`, `secret` ...), one repeated pattern, fewer
  than 6 different characters, or mostly a run like `abcdefghij`; `VIEWS_TOKEN` and `CLIENT_IP_TOKEN` also when shorter than 16
  characters. Every value of `openssl rand -base64 48` and `openssl rand -hex 32` passes. If the backend stops with
  `... which is too weak for a production run`, replace that one value (the same on backend and frontend for the two tokens) and start
  again; for `JWT_SECRET` that ends the access tokens in use, see [Security](SECURITY.md#rotating-jwt_secret-and-ending-sessions).
  The database password and `MEILI_MASTER_KEY` keep their own rules.
- **`SMTP_STARTTLS=false` is refused** for a host that is not on this machine. Keep it `true` (port 587), or set `SMTP_PROTOCOL=smtps`
  and `SMTP_PORT=465` for implicit TLS. Only `NEWSLETTER_TRANSPORT=smtp` is affected.
- **The GitHub address override is refused on a public site.** `app.oauth.github.provider.*` (used only by tests and the E2E stack) must
  stay unset, or point at `github.com` or `api.github.com`, when `SITE_URL` or `GITHUB_REDIRECT_URI` is public. Nothing in this repository
  sets it for a real site.
- **`app.i18n.locales` is checked for its shape** (2 to 8 lower-case letters per entry, none empty, none twice). The default `vi,en` is unchanged.
- **Password hashes are strengthened by themselves.** New hashes use Argon2id with 19 MiB (it was 16 MiB); an existing account's hash is
  replaced the next time its owner signs in with the correct password. Nothing to do, and no one is signed out. A sign-in holds about
  38 MiB of heap while it runs (two at most at the same time).
- **Log lines changed.** The line that confirms `ADMIN_PASSWORD` now names the account by id (`Applied ADMIN_PASSWORD to userId=<id>`), no
  line writes the administrator's address any more, and refusals and administrator acts carry `actor=<id>` (the table of
  [Audit events](SECURITY.md#audit-events)). A log filter on the old text needs the new one.
- **The frontend starts with an empty page cache.** Pages rendered on demand and the data cache are kept in the memory of the Next
  process (`frontend/cache-handler.mjs`), and the image no longer carries the pages `next build` prerendered that revalidate (the build
  has no backend, so they held the neutral default content). Nothing to configure: the first visit to each page after an upgrade or a
  restart is a render against the backend, a little slower than usual, and a post taken down in the admin cannot come back from the
  disk of an earlier process. The optimized images stay. `ROUTE_CACHE_MAX_MB` has no effect while the handler is configured (the
  in-memory LRU, 50 MB by default, bounds a flood of made-up addresses); it is kept only for a build without the handler
  ([CONFIGURATION.md](CONFIGURATION.md#frontend-runtime-variables)). Pages carry `stale-while-revalidate=3300` instead of a year
  (`expireTime: 3600`), which matters only if a CDN is in front.
- **A very link-dense article can now be shown as plain text.** The size estimate that guards the Markdown reader prices every
  emphasis, link, code span and footnote reference one by one, so an article with more than about 14,000 of them (a few hundred is a
  long article) is read as plain text, and the editor preview says so. Nothing to configure; split such an article. The
  syntax highlighting of code fences is bounded too: a line of 300 characters or more, a block of about 375 lines or more and everything
  past 120,000 characters, 2,000 lines or 1.5 s of highlighting in one article is drawn without colour, text intact.
- **Copy the new blocks of the proxy example if you use one.** `deploy/nginx.conf.example` and `deploy/Caddyfile.example` now answer
  405 to `TRACE`, and the nginx example limits the request rate per address and caches pictures for an hour (share cards for five
  minutes) in `/var/cache/nginx/blog` (create the folder first; [INSTALL.md](INSTALL.md#limit-the-rate-of-requests)). If you copied
  the first version of that example, its picture location used one cache key for `/media/`, `/_next/image` and `/api/og/` that included
  the query string, so `/media/<id>.jpg?x=<random>` missed the cache every time: take the three locations of the current file. Your own
  copy keeps working without them.
- **Per-address limits on pictures and the sitemap are in Next now.** `/_next/image` and `/sitemap.xml` are counted per address in
  `proxy.ts` (1,200 and 60 a minute), and the owner's exports (a post package, the site export) read pictures without the backend's
  bound of eight concurrent reads. Nothing to configure; behind Caddy the optimizer is no longer unlimited.

## An existing deployment is never re-claimable

A fresh database starts "unclaimed": there is no usable credential, and the first-run `/setup` page accepts the owner. Migration
`V36` records, in `app_settings.setup_completed`, whether setup is needed. It is `false` (setup required) only on a **provably
fresh** database: one with no content and an untouched seeded admin. A database that already has content or a changed admin
is migrated as **completed**, so:

- upgrading a running site never opens `/setup`: the route answers 404 and the seeded development password is not touched;
- nobody can claim an existing site by finding `/setup`;
- `SETUP_TOKEN`, `SETUP_DATA_DIR` and `SETUP_LOCK_DEV_SEED` have no effect on it.

If you lose every admin credential on a completed site, setup does not come back. Recover through the environment instead: set
`ADMIN_EMAIL` (the email of the owner account) and `ADMIN_PASSWORD` (a password that meets the policy, hashed at startup and applied to the account of `ADMIN_EMAIL`, which also ends that
account's sessions) and restart the backend, or link a GitHub account with `ADMIN_GITHUB_ID`. The next sign-in still asks for the second step; if the phone and the recovery codes are
lost as well, see [Security](SECURITY.md#when-the-phone-or-the-codes-are-lost). See [Configuration](CONFIGURATION.md) and [First run](FIRST-RUN.md).
