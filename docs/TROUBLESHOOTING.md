# Troubleshooting

Find the symptom, read the cause, apply the fix. Start with the logs: they name the variable or the step, and never print a
secret.

```bash
docker compose ps                          # state and health of every service
docker compose logs --tail=100 backend     # startup refusals and Flyway messages
docker compose logs --tail=100 frontend
docker compose exec backend wget -qO- http://localhost:8080/api/v1/health
```

## Contents

- [Compose will not start](#compose-will-not-start)
- [The backend stops at startup](#the-backend-stops-at-startup)
- [Database](#database)
- [First run and setup](#first-run-and-setup)
- [Signing in](#signing-in)
- [Two-step codes are rejected](#two-step-codes-are-rejected)
- [The admin area](#the-admin-area)
- [Pages and content](#pages-and-content)
- [Images and uploads](#images-and-uploads)
- [Newsletter](#newsletter)
- [Search](#search)
- [Building and running from source](#building-and-running-from-source)

## Compose will not start

| Symptom | Cause and fix |
|---|---|
| `set DB_PASSWORD in .env` (or `JWT_SECRET`, `MFA_ENCRYPTION_KEY`, `SITE_URL`, `VIEWS_TOKEN`, `CLIENT_IP_TOKEN`) | A required variable is empty or missing. `docker-compose.yml` refuses to start rather than deploy with a development value. Run `./scripts/init-env.sh` (or `init-env.ps1`) for a new `.env`, or fill the variable by hand. For an existing `.env` after an upgrade, append `MFA_ENCRYPTION_KEY` and `CLIENT_IP_TOKEN` ([Upgrading](UPGRADING.md#release-with-two-step-verification)). |
| The `postgres` container restarts in a loop and `docker compose logs postgres` says `postgres-preflight: set DB_OWNER_PASSWORD in .env (DB_OWNER_USERNAME is set)`, or `DB_ADMIN_USERNAME`, or `DB_ADMIN_PASSWORD`, or that two roles must differ | The three database roles are half filled: with `DB_OWNER_USERNAME` set, the owner password and the administration pair are required, and the three names and the three passwords (`DB_PASSWORD`, the owner and the administration one) must differ. Nothing was initialised yet, so after you fill them (change `.env`, then `docker compose up -d`) the database starts normally. Fill them (`./scripts/init-env.sh` on a new `.env` writes all three), or delete the OWNER and ADMIN lines for a single-role install ([Configuration](CONFIGURATION.md#compose-and-env)). |
| The `postgres` log ends with `roles.psql: set APP_DB_USER, ...`, or the backend says `password authentication failed for user "blog_app"` after a first start | The database container was started with a bad set of roles (an older compose file, or a hand-made environment) and stopped halfway through its first-run script. PostgreSQL does not run that script again on a data directory that already exists. On a **brand-new install with nothing in it**: `docker compose down -v` (this deletes the volumes), correct `.env`, `docker compose up -d --build`. On an install with data **do not delete the volume**: correct `.env`, then run the roles script by hand ([Upgrading](UPGRADING.md#moving-to-the-three-database-roles), step 4). |
| `.env` already exists, the init script exits with an error | The script never overwrites an existing `.env`. Edit the file, or move it away first. |
| `dependency failed to start: container ... is unhealthy` | Look at the log of the service that is unhealthy (`docker compose logs postgres`, then `backend`). The backend reports healthy only after Flyway finishes, which can take a minute on first start. |
| `invalid IP address` for the frontend port | `SITE_PORT` must be a port number only (`3000`). The address is `SITE_BIND`. |
| The `postgres` container restarts in a loop | An old data volume mounted at `/var/lib/postgresql/data`. PostgreSQL 18's image wants the volume at `/var/lib/postgresql`, as `docker-compose.yml` has it. Keep that mount. |
| Compose says a service is `Exited (137)` | Out of memory: the container hit its `mem_limit`. For the backend raise `BACKEND_MEM_LIMIT` (the VPS needs at least 2 GB of RAM in total). A backend that ran out of Java heap (not of container memory) also exits by design (`-XX:+ExitOnOutOfMemoryError`) and is restarted; the log shows `java.lang.OutOfMemoryError` before the restart. |

## The backend stops at startup

The log has one line naming the variable. The cause is on purpose: the backend refuses to run in an unsafe state. The full list is
in [SECURITY.md](SECURITY.md#startup-refusals). The common ones:

| Message names | Fix |
|---|---|
| `JWT_SECRET` | Required, at least 32 bytes, not the development value and not guessable (placeholder words, a repeated pattern, fewer than 6 different characters, a run like `abcdefghij`): `openssl rand -base64 48`. The backend has no default and is production unless the `dev` profile or `APP_ALLOW_DEV_DEFAULTS=true` opts in. |
| `MFA_ENCRYPTION_KEY` | Required in every mode, base64 of exactly 32 bytes: `openssl rand -base64 32`. The message says which part is wrong (missing, not base64, or the decoded length). In production it must not be the development key of the repository or equal to `JWT_SECRET`. Keep a copy outside the server. |
| `MFA_ENROLLMENT_TOKEN` or `MFA_RESET_TOKEN` | At least 24 characters, or leave it empty. |
| `ADMIN_PASSWORD` | At least 12 characters, and a value that changes must meet the [password policy](SECURITY.md#password-policy) (not a common password, not made of a few repeated characters). On a public site the development password `admin12345` is refused too. |
| `SETUP_TOKEN` | At least 24 characters, or leave it empty. |
| `ADMIN_GITHUB_ID` | The **numeric** id (the `id` field of `https://api.github.com/users/<login>`), not the login. |
| `GITHUB_REDIRECT_URI` or `SITE_URL` | GitHub sign-in is configured (id and secret set) but no callback can be built. Set `SITE_URL`. The callback must be `<SITE_URL>/api/auth/github/callback`, and `https` unless the host is loopback. |
| `SMTP_HOST`, `NEWSLETTER_FROM`, `NEWSLETTER_SECRET` | `NEWSLETTER_TRANSPORT=smtp` needs a public `https` `SITE_URL`, one valid sender, a host, and a 32-byte secret. Use `log` to send nothing. |
| `MEILI_MASTER_KEY` | Meilisearch is in use: the key must be at least 32 characters and not the sample. `scripts/init-env.*` writes a good one. |
| `ANALYTICS_TIME_ZONE` or `DEFAULT_LOCALE` | Use an IANA time zone id, and `en` or `vi`. |

"Public `SITE_URL`" means a host that is not `localhost`, `127.0.0.0/8` or `::1`. A LAN address such as `http://192.168.1.10:3000`
counts as public.

## Database

| Symptom | Cause and fix |
|---|---|
| The backend answers "permission denied for table ..." after a restore | The restore gave the tables to the administration role. On an install with the three database roles run `docker compose exec -T postgres sh /docker-entrypoint-initdb.d/10-roles.sh` and restart the backend ([BACKUP-AND-RESTORE.md](BACKUP-AND-RESTORE.md#restore-from-a-backup)). With the three roles the same command also sets the role passwords to the ones in `.env` after you change them. |
| `Migration checksum mismatch` or `Validate failed` from Flyway | An applied migration file was changed (even a comment). Flyway refuses to start so that schemas do not drift. Restore the original file from the release you run (`git checkout <tag> -- backend/src/main/resources/db/migration`). Never edit an applied migration; add a new one. |
| `Detected applied migration not resolved locally` | The database was migrated by a newer version than the image you run. Run the newer image, or restore a dump taken by your version ([Upgrading](UPGRADING.md#rolling-back)). |
| Flyway stops at `V23`, `permission denied to create extension "unaccent"` | The database user may not create extensions. `unaccent` is trusted since PostgreSQL 13, so granting `CREATE` on the database is enough. The Compose `postgres` service needs nothing. |
| `password authentication failed for user` right after you changed `DB_PASSWORD` | PostgreSQL stores the password when it first creates the data volume; changing `.env` later does not change it. Either set the old value back, or change it inside the database (`ALTER USER ... PASSWORD ...`), or, **only on a database you can lose**, `docker compose down -v` to start from an empty volume. |
| After a restore the site looks empty | A failed `pg_restore` left an empty database and the backend then created a new schema. Restore again ([Backup and restore](BACKUP-AND-RESTORE.md#restore-from-a-backup)). |
| Port 5432 is blocked on Windows (`bind: An attempt was made to access a socket in a way forbidden by its access permissions`) | Hyper-V reserves port ranges that often cover 5432. Run Postgres on another port (`DB_PORT=55432`) and give the backend the same `DB_PORT`. See [DEVELOPMENT.md](DEVELOPMENT.md#run-locally). |
| A timezone error on connect from a hand-started jar | PostgreSQL 18 rejects the old time zone aliases the JVM may send. Start the JVM with `-Duser.timezone=UTC`, as the Docker image and Maven do. |

## First run and setup

| Symptom | Cause and fix |
|---|---|
| `/setup` is 404 | Setup is already completed, or the instance was claimed through `ADMIN_PASSWORD` or `ADMIN_GITHUB_ID`. It cannot be reopened ([Upgrading](UPGRADING.md#an-existing-deployment-is-never-re-claimable)). Sign in at `/admin/login`. |
| Where is the setup code? | `docker compose exec backend sh -c 'cat /data/setup-code'`. With `SETUP_TOKEN` set, the code is that value and there is no file. The backend log prints the path, never the code. |
| `/setup` opens but there is no code file | The backend could not write it: look for `First-run setup code could not be written` in the backend log. Make `SETUP_DATA_DIR` writable, or set `SETUP_TOKEN`, then restart the backend. |
| "The setup code is not valid" | Copy the whole content of the file. The code is long; do not retype it. Check that you read the file of **this** backend (a second Compose project has its own volume). |
| Setup answers 429 | Too many attempts from your address (10 per 10 minutes in Next, 5 per minute in the backend), or the whole backend has seen more than 120 wrong codes in a minute. The right code is never refused for the second reason. Wait a minute, or claim the instance through `ADMIN_PASSWORD` and a restart. If every address is refused at once, see "Per-IP limits seem to apply to everybody at once" below. |
| Nobody can sign in on a fresh install | By design: the seeded development password is disabled until `/setup` completes. `admin12345` does not work. |
| Setup page says the email belongs to another account | Choose another email. |
| The password is rejected | At least 12 and at most 128 characters, not a common password (also not one with digits or symbols around it), not a run of the same or consecutive characters, and not containing the first part of your email ([Password policy](SECURITY.md#password-policy)). The message is the same for all weak cases on purpose. |

## Signing in

| Symptom | Cause and fix |
|---|---|
| Sign-in "does nothing": you return to the login page, no error | The session cookies are `Secure` in production, so over plain HTTP a browser may drop them. Serve the site over HTTPS (a reverse proxy, [deploy/](../deploy)). For a trial on one machine use `http://localhost:3000`, which Chrome (the browser of the E2E suite) accepts; do not rely on that for other browsers or other host names. |
| "Signing in with GitHub is not enabled on this server" | `GITHUB_CLIENT_ID` or `GITHUB_CLIENT_SECRET` is empty. The site works without them; readers just cannot sign in. Create an OAuth App and fill both ([CONFIGURATION.md](CONFIGURATION.md)). |
| GitHub says the `redirect_uri` is not associated with the application | The callback of the OAuth App must be `<SITE_URL>/api/auth/github/callback`, character for character. |
| "The sign-in session expired or is not valid" | The attempt's cookie is on another host: you started on `www.` and came back to the bare domain, or on `127.0.0.1` and came back to `localhost`. Use exactly the host of `SITE_URL`, and redirect the other host in the proxy. Also: only one sign-in at a time per browser; a second tab breaks the first. |
| "Could not reach GitHub right now" | The backend cannot reach `github.com` and `api.github.com` (5 s to connect, 10 s to answer). Check outbound access of the backend container. |
| A sign-in, contact or newsletter form answers a raw `{"error":{"code":"UNSUPPORTED_MEDIA_TYPE",...}}` page | The form was submitted before the page had finished loading, or with JavaScript blocked. The server refuses a plain form post on purpose (it takes JSON from the page's own script only, so nothing typed ends up in the address bar). Go back, reload the page and send it again. |
| Admin sign-in answers "You tried to sign in too many times" | 10 attempts per 10 minutes per IP. Wait, sign in from another network, or `docker compose restart frontend`. |
| "The server is busy with other sign-ins" | Two password checks run at once at most; a third waits 5 seconds. Try again. |
| Signed in with GitHub as the owner but not an admin | An unlinked GitHub account is a separate reader. Set `ADMIN_GITHUB_ID` to your numeric GitHub id and restart ([CONFIGURATION.md](CONFIGURATION.md)). |
| After sign-in with the password you land on an enrollment or code page | Two-step verification is mandatory for admins. Enrol an authenticator app on the enrollment page; an existing site asks once for the enrollment code ([Upgrading](UPGRADING.md#release-with-two-step-verification)). |
| The enrollment page asks for an enrollment code and you do not have one | Read it on the server: `docker compose exec backend cat /data/mfa-enrollment-code` (or the value of `MFA_ENROLLMENT_TOKEN`). A wrong value counts against the five attempts of the sign-in; the code is not shown in the log. |
| The code page says to wait, or the second step is "frozen" | Five wrong codes in a row start a delay (30 seconds, doubling up to 15 minutes); 100 in a row freeze the second step until the operator resets it ([Security](SECURITY.md#two-step-verification-and-recovery)). Change `ADMIN_PASSWORD` or use `MFA_RESET_EMAIL` and `MFA_RESET_TOKEN`. |
| `/admin/security` says "sign in again to continue" | Changing two-step verification or the password needs a sign-in from the last 10 minutes. Sign in again and retry. |
| Changing the password answers "managed by the environment" | `ADMIN_PASSWORD` is set in `.env`: it would undo the change at the next start. Change the value there and restart, or remove it. |
| Everyone is signed out after a change | You changed `JWT_SECRET`: access tokens died, and refresh tokens renew them on the next page load. Admins sign in again ([SECURITY.md](SECURITY.md#rotating-jwt_secret-and-ending-sessions)). |

## Two-step codes are rejected

| Symptom | Cause and fix |
|---|---|
| Every code is rejected, including the first one of a new app | A wrong **clock**. Codes depend on time, in steps of 30 seconds. Check the phone (automatic time on) **and the server** (`timedatectl`, NTP). The backend log then has `mfa code matched outside window ... offsetSteps=<n>`: a code of an earlier or later step was right, which tells that the clocks differ by about `n` x 30 seconds. The code is still refused. |
| The code is right but refused, and it worked a moment ago | Each code works **once** (replay protection). Wait for the next code (up to 30 seconds) and type that one. |
| "Too many attempts, try again in N seconds" | The brake of the account (see above). Wait for the time shown; a correct code is refused while it runs. |
| Codes stopped working for everyone after a restart or a restore | `MFA_ENCRYPTION_KEY` changed or is missing the right value: the log has `mfa secret undecryptable`. Put the saved key back. If it is lost, use a recovery code and replace the authenticator, or the operator reset ([Configuration](CONFIGURATION.md#changing-mfa_encryption_key)). |
| The phone is lost | Sign in with a recovery code, then "Replace authenticator" in `/admin/security`. Without recovery codes: an administrator resets an author in `/admin/users`; for an administrator, `MFA_RESET_EMAIL` and `MFA_RESET_TOKEN` ([Security](SECURITY.md#when-the-phone-or-the-codes-are-lost)). |
| A recovery code is rejected | Case, spaces and dashes do not matter; `I` and `L` are read as `1` and `O` as `0`. It has 24 characters (six groups of four). Each works once. |

## The admin area

| Symptom | Cause and fix |
|---|---|
| Every save, upload and reorder fails with "Could not reach the server" or is silently rejected | The reverse proxy does not send `Host: $host`. Next compares the `Origin` with the request host and cancels a mismatch. Use the proxy example in [deploy/](../deploy). |
| A reader sees `/admin/login?reason=forbidden` | Readers (`USER`) have no admin access. Promote them in `/admin/users`. A promotion takes effect when they sign in again. |
| An author sees "This page is for admins only" | By design: users, comments, series, gallery, newsletter, settings and search belong to ADMIN. |
| A change written by a script shows late | Public pages are cached up to five minutes. See [Pages and content](#pages-and-content). |
| Sample content: nothing happens, 403 | Only an ADMIN can load it. A second click creates nothing (it is idempotent) and reports the items as skipped. |

## Pages and content

| Symptom | Cause and fix |
|---|---|
| A new post is not on the site yet, but it is in the feed | Public pages read through a cache of up to five minutes, while `/sitemap.xml` and the feeds read live. `docker compose restart frontend` shows it at once (the cache is in the memory of the process; [Architecture](ARCHITECTURE.md#caching-and-why-there-is-one-backend-and-one-next)). |
| Canonical URLs, Open Graph tags and the sitemap point at `localhost` | `SITE_URL` is baked in at build time. Set it in `.env` and run `docker compose up -d --build`. Setting it only as a runtime variable changes nothing. |
| No `Strict-Transport-Security` header | The image was built with a `SITE_URL` that is not `https`. Fix `SITE_URL`, rebuild. |
| Two `Strict-Transport-Security` lines | The reverse proxy adds the header too. Remove it from the proxy; Next sends it. |
| The site is in the wrong language, or `/en` is the unprefixed one | `DEFAULT_LOCALE` decides which language has no prefix. It is set at build time for the frontend, so changing it needs a rebuild, and it moves URLs. Choose it before you publish. |
| The English (or Vietnamese) list is empty | Every public list shows posts of that language only. Write the post in that language or add a translation. The page shows a "no posts in this language yet" note and a link. |
| View counts do not move | Either `VIEWS_TOKEN` differs between the backend and the frontend (every view becomes a silent 403: the pages work, the counter stands still), or the visitor is a bot, or the 30-per-minute IP limit was reached. Compare the two values in `.env`, which Compose passes to both. |
| Per-IP limits seem to apply to everybody at once, sign-in answers 429 after a few attempts from different places, or the frontend log has a `[client-ip]` line | Read that line first (`docker compose logs frontend \| grep "\[client-ip\]"`; it is written once per process): it says that a request did not come through the proxies `TRUSTED_PROXY_HOPS` describes, and that such requests share one "unknown" address. For sign-in, the second step, the Security page, GitHub sign-in and setup that shared address has the allowance of **one** person (10 sign-in attempts per 10 minutes), so anyone can use it up and keep the owner out until the window ends: fix the cause before anything else. `TRUSTED_PROXY_HOPS` is wrong, or the proxy does not append to `X-Forwarded-For`. Behind Cloudflare with nginx, `/etc/nginx/cloudflare-realip.conf` may miss a range, so every request from that range counts as one visitor ([INSTALL.md](INSTALL.md#behind-cloudflare)). See [SECURITY.md](SECURITY.md#reverse-proxy-and-the-client-address). |
| The contact form, newsletter, sign-in, refresh, setup or search answer 429 for everybody after a few requests, while Next's own limits are not reached | The backend counts the Next server as one caller: `CLIENT_IP_TOKEN` differs between the backend and the frontend, or the frontend has none. Compare the two values in `.env`, which Compose passes to both, and recreate both services. |
| The backend refuses to start with `VIEWS_TOKEN` or `CLIENT_IP_TOKEN` `is shorter than 16 characters` or `... which is too weak for a production run` | Replace it with a random value, the same on backend and frontend: `openssl rand -hex 32`. |
| The backend refuses to start with `CLIENT_IP_TOKEN is empty in a production run` | Set it: `echo "CLIENT_IP_TOKEN=$(openssl rand -hex 32)" >> .env`, the same value for backend and frontend. See [UPGRADING.md](UPGRADING.md#settings-that-need-care). |
| A deleted image can still be opened by its optimized URL | It is in Next's image cache. `docker compose restart frontend` empties it ([Backup and restore](BACKUP-AND-RESTORE.md#clearing-the-optimized-image-cache)). |
| `/feed.xml` returns 503, `/sitemap.xml` returns 200 without posts | The backend is down or unreachable. Fix the backend; the feeds do not serve stale data. |

## Images and uploads

| Symptom | Cause and fix |
|---|---|
| 413 from the proxy on upload | The proxy limit is 1 MB outside `/admin/` and 6 MB inside it. Upload from `/admin`, and check that your proxy uses the per-path limits of [deploy/](../deploy). |
| 413 `MEDIA_TOO_LARGE` or 422 `MEDIA_DIMENSIONS_TOO_LARGE` | A file over 10 MB, over 50 million pixels, or one that is over 4 MiB even at 800 px. Resize it first. |
| 422 `MEDIA_QUOTA_EXCEEDED` | The total of stored images reached `MEDIA_MAX_TOTAL_SIZE` (default 1GB). Delete images or raise the value ([limits by layer](SECURITY.md#upload-limits-by-layer)). |
| 503 `MEDIA_BUSY` | Another large image is being processed; retry. Only one is decoded at a time. |
| The backend is killed during an upload | The image is decoded inside the JVM heap, which is 70 percent of `BACKEND_MEM_LIMIT`. Raise the limit if the machine allows it (default `768m`; `1g` gives a 718 MiB heap). |

## Newsletter

| Symptom | Cause and fix |
|---|---|
| Subscribers get nothing | The default `NEWSLETTER_TRANSPORT=log` accepts subscriptions and sends no mail; each mail is one log line with a kind and an id. Real sending needs `smtp` and the checklist in [CONFIGURATION.md](CONFIGURATION.md). The admin counts `log` mail as sent. |
| `smtp` and the backend will not start | See [the table above](#the-backend-stops-at-startup): public `https` `SITE_URL`, valid sender, host, 32-byte secret. |
| Confirmation mail goes to spam | Authenticate the sending domain at the provider (SPF, DKIM, ideally DMARC). |
| Unsubscribe links stopped working | `NEWSLETTER_SECRET` changed. It must never change after the first subscriber. |
| Confirm link answers with a generic sentence | The token is wrong, expired (48 hours) or used. Subscribe again. |

## Search

| Symptom | Cause and fix |
|---|---|
| "Using basic search" | `SEARCH_ENGINE=meilisearch` is set but Meilisearch is down, slow or has no index yet; the backend serves PostgreSQL results. Start the `search` profile and reindex, or set `SEARCH_ENGINE=postgres`. |
| Meilisearch container is unhealthy or exits | It needs a master key of at least 16 bytes in production mode (the backend wants 32 characters). Check `MEILI_MASTER_KEY`. Memory is limited to 512m. |
| Reindex answers 429 | Three per 10 minutes per admin. Wait, or restart the backend (the counter is in memory). |
| A search for a symbol such as `C++` finds the wrong thing | PostgreSQL search matches whole words and turns `C++` into `c`. Meilisearch keeps these as tokens. |

## Building and running from source

| Symptom | Cause and fix |
|---|---|
| `npm run build` or the frontend image build fails fetching fonts | `next/font/google` downloads the Inter font files during `next build` (the built site then serves them itself, so readers' browsers never contact Google). The build machine needs internet access to `fonts.googleapis.com` and `fonts.gstatic.com`. See [ASSETS.md](ASSETS.md). |
| The frontend build cannot reach the API | The build does not need a running backend: `generateStaticParams` and the sitemap tolerate an unreachable API. If it fails, read the first error: it is usually a type or lint problem, not the network. |
| Two `vitest` runs at once give failures that look flaky | They fight over `node_modules/.vite`. Run one at a time in a directory. |
| `mvn test` is green but the code does not compile | A stale `target/classes`. Always `mvn clean test`. |
| Backend tests cannot start | Testcontainers needs Docker running. |
| Playwright cannot find a browser | The suite uses the Google Chrome installed on the machine (`channel: 'chrome'`) and downloads none. Install Chrome. |
| E2E admin sign-in fails on a fresh database | A fresh database disables the development password until `/setup`. Start the throw-away E2E backend with `SETUP_LOCK_DEV_SEED=false` ([DEVELOPMENT.md](DEVELOPMENT.md#e2e-playwright)). |
