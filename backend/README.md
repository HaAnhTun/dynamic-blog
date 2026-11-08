# Blog Backend

Spring Boot 4.1.0 (Java 25) REST API of Blog Engine, a bilingual (English and Vietnamese), self-hostable blog engine. It owns
the content model (posts, categories, tags, series, a photo gallery, images stored in PostgreSQL), the publish workflow, search
([Search](#search), optionally Meilisearch), authentication and roles, GitHub sign-in for readers, comments, likes, saved posts and
notifications, per-day view analytics ([Analytics](#analytics)), an opt-in newsletter ([Newsletter](#newsletter)), the
site content that describes the owner ([Setup, site content, import and sample content](#setup-site-content-import-and-sample-content)),
and the first-run setup that claims a fresh install. The [endpoint table](#endpoints) below lists every route and who may call it.
The whole stack, its design and its operation are in [the root README](../README.md) and [docs/](../docs/).

## Run locally

[docs/DEVELOPMENT.md](../docs/DEVELOPMENT.md) is the guide: requirements, the three-terminal setup, the Windows port notes, signing
in on a fresh database and GitHub sign-in on your machine. In short, from this directory:

1. Start PostgreSQL: `docker compose up -d` (`DB_PORT=55432 docker compose up -d` if port 5432 is taken; export the same variable
   before step 2, because Spring Boot does not read `.env` files).
2. Run the app: `mvn spring-boot:run`. It runs with the Spring profile `dev`, which `pom.xml` sets for the Maven plugin only.
3. A new database has no usable credential: claim it at `/setup` of the frontend with the code in `./data/setup-code`
   ([Development credentials](#development-credentials)).
4. API docs: http://localhost:8080/swagger-ui.html (the raw document is at `/v3/api-docs`).
   Both describe the whole API, admin included, and need no token, so they are **off by
   default** and the `dev` profile (`application-dev.yml`) turns them back on. Anything that
   starts the jar without that profile, `java -jar`, the Docker image, the E2E stack, Koyeb or
   Render, has them off, and both paths answer 404 `ENDPOINT_NOT_FOUND`.
   `SPRINGDOC_ENABLED=true` or `false` overrides either default.
   Operations that need a token carry a lock (paste an access token into "Authorize"), every
   failure is documented with the shared `ErrorResponse` schema, and the comment, like,
   moderation and user schemas say which fields can be `null`. `OpenApiConfigIT` checks all of
   it against real responses. The two GitHub sign-in paths are Spring Security filters, not
   controllers, so they are not in the document; [GitHub sign-in](#github-sign-in-readers)
   describes them.

### Development credentials

A new database is **unclaimed**: migrations V2 and V8 still seed an `ADMIN` called `admin@blog.local` with a development password
that is public in this repository, but while first-run setup is pending the backend disables that password at startup
(`SetupDevSeedLock`, `SETUP_LOCK_DEV_SEED=true` by default). Nothing signs in until the owner completes `/setup`
([First-run setup](#setup-site-content-import-and-sample-content)), or the operator sets `ADMIN_PASSWORD` or `ADMIN_GITHUB_ID`, which claims the instance
through the environment.

For a database you can throw away, `SETUP_LOCK_DEV_SEED=false` keeps the seeded `admin@blog.local` with the development password
and leaves `/setup` open (the E2E stack does this). The application then logs a warning at every startup while the password is
unchanged. On a production run (no opt-in to development defaults, or a public `SITE_URL`) the switch is ignored: the lock always runs,
and a database error while it runs stops the start (the runner is idempotent, so a restart tries again). This is a development credential in a public repository, and so is the development `JWT_SECRET` of the `dev` profile: never use
either on a reachable machine. Outside `mvn spring-boot:run` the stack must opt in with `APP_ALLOW_DEV_DEFAULTS=true` and its own `JWT_SECRET`. An existing deployment is migrated as already set up and never touched by the lock.

Admins need a second step even here. On a `dev` run (or `APP_ALLOW_DEV_DEFAULTS=true` with a loopback `SITE_URL`) the enrollment window
is always open, so the first sign-in as the development admin answers a 202 challenge with purpose `ENROLL` and no enrollment code is
asked; follow [Two-step sign-in by hand](#two-step-sign-in-by-hand). The `dev` profile also supplies a throw-away
`MFA_ENCRYPTION_KEY` (`application-dev.yml`); anywhere else the variable is required.

A real deployment sets `JWT_SECRET`, claims the instance through `/setup` (or sets `ADMIN_PASSWORD`), and usually leaves
`ADMIN_EMAIL` alone. Unless the run opted in to development defaults, the backend refuses to start without a real `JWT_SECRET`, `VIEWS_TOKEN` and `CLIENT_IP_TOKEN`, and while the admin still accepts the
development password; see [Production checks](#production-checks).

### Production checks

The backend is **fail-closed**: it treats itself as a public deployment ("production") unless the
operator opts in to development defaults. The opt-in is the Spring profile `dev` (what
`mvn spring-boot:run` enables, `application-dev.yml`; the tests opt in through their configuration) or
`APP_ALLOW_DEV_DEFAULTS=true` for a throw-away E2E or CI stack. Nothing else: an empty or
`localhost` `SITE_URL` does not. A `SITE_URL` (or `GITHUB_REDIRECT_URI`) whose host is not a loopback
address (`localhost`, `127.0.0.0/8`, `::1`) is production even with the opt-in; so is a value whose host
cannot be read, and a LAN address used to try the site from a phone (`http://192.168.1.10:3000`): give
that run its own `JWT_SECRET`, `VIEWS_TOKEN`, `CLIENT_IP_TOKEN` and `ADMIN_PASSWORD`. The root `docker-compose.yml` requires
them; anywhere else (Koyeb, Render, a bare `java -jar`) set them too. In production:

- **A missing `JWT_SECRET`, or the committed development one, refuses startup.** `JWT_SECRET` has no
  default in `application.yml`. Anyone who reads the repository could sign an `ADMIN` token with the
  development value. The check runs while the beans are created, so the port never opens. The message
  names `JWT_SECRET` and the opt-in, never a value.
- **An admin account that still accepts `admin12345` refuses startup**, after `ADMIN_EMAIL` and
  `ADMIN_PASSWORD` have been applied. Both the `ADMIN_EMAIL` row and any row still called
  `admin@blog.local` are checked. The message asks for `ADMIN_PASSWORD` (at least 12 characters)
  and `ADMIN_EMAIL`, and quotes neither.
- **Password login always refuses `admin12345`**, for every account, with the usual 401
  `INVALID_CREDENTIALS` after the usual password check, so the answer is no faster and no
  different. This also covers the seconds between the port opening and the startup checks.
- **A missing or malformed `MFA_ENCRYPTION_KEY` refuses startup, in every mode**, because it encrypts
  the two-step verification secrets and has no default in code: it must be base64 of exactly 32 bytes
  (`openssl rand -base64 32`). In production the development key committed to this repository, and a
  value equal to `JWT_SECRET`, refuse it too (an opted-in run only logs a WARN for the development
  key). `MFA_ENROLLMENT_TOKEN` and `MFA_RESET_TOKEN` must be empty or at least 24 characters. The
  messages name the variable (and, for a wrong size, the decoded length), never a value
  (`MfaProperties`, `MfaSecretCipher.refuseUnsafeKey`).
- **A new `ADMIN_PASSWORD` must meet the password policy** (`PasswordPolicy`: 12 to 128 characters, not
  common, not a run, not containing the email's local part); an unchanged value that fails it only
  logs a WARN, so an upgrade never refuses to start over it.
- **An empty `VIEWS_TOKEN` refuses startup**: anyone who can reach the backend directly could add views,
  and views decide the "popular" order.
- **An empty `CLIENT_IP_TOKEN` refuses startup** (`ClientIpTokenCheck`): without it the backend cannot believe the
  reader address that Next forwards, so every per-address limit would count the Next server as one caller
  ([Rate limits](#rate-limits)).
- **`NEWSLETTER_TRANSPORT=log` logs a WARN** (V7c): signups are accepted but no mail is sent, and the
  admin newsletter page counts every mail as sent. With `NEWSLETTER_SECRET` also empty, a second WARN:
  unsubscribe links and suppression hashes use the development key committed to this repository.
  Startup goes on (`NewsletterWarnings`).
- **A weak `MEILI_MASTER_KEY` refuses startup** (V8b) once Meilisearch is used, that is
  `SEARCH_ENGINE=meilisearch` or `MEILI_URL` set: missing, shorter than 32 characters, or the placeholder
  of `.env.example`. The message names the variable, never the value (`SearchConfig.refuseUnsafeMeilisearch`).

**`NEWSLETTER_TRANSPORT=smtp` has its own, stricter check** (V7c), whatever the production test above
says: a `SITE_URL` that is empty or unreadable counts as unsafe here, not as production. The backend
refuses to start, while the beans are created and before the port opens, unless `SITE_URL` is `https`
with a host that is not loopback, `localhost`, `*.localhost` or an any-address (`0.0.0.0`, `::`),
`NEWSLETTER_FROM` is one valid sender address (a display name is allowed), `SMTP_HOST` is set and
`NEWSLETTER_SECRET` has at least 32 bytes. The message names the variable, never a value
(`NewsletterConfig.refuseUnsafeSmtp`).

Upgrading a public deployment that still runs on the development defaults: it will not start
until `JWT_SECRET`, `VIEWS_TOKEN`, `CLIENT_IP_TOKEN` and `ADMIN_PASSWORD` are set. Access tokens signed with the old secret stop
working at once (401); refresh tokens are database rows, not signed with it, so a client that
refreshes gets a new pair. The admin's own sessions are the exception: setting `ADMIN_PASSWORD`
to a new value revokes them, so the admin signs in again with it. Readers' sessions survive the
upgrade (see [Sessions and refresh tokens](#sessions-and-refresh-tokens)).

### The admin account (`ADMIN_EMAIL`, `ADMIN_PASSWORD`)

The seed migration creates one `ADMIN`, id `00000000-0000-0000-0000-000000000001`, email
`admin@blog.local`. At startup, in this order:

0. **While setup is pending, the development password is disabled** (`SetupDevSeedLock`, see
   [Development credentials](#development-credentials)); `ADMIN_PASSWORD` in the next steps then replaces that marker.
1. **`ADMIN_EMAIL` renames it** (`AdminSeedEmail`) when the value differs from
   `admin@blog.local`, the row is still `ADMIN` with that email, and no account has the new
   address yet. The id stays, so its posts, comments, likes, notifications and GitHub link stay
   with it. Its live refresh tokens are revoked (and their expiry ended, see
   [reuse detection](#sessions-and-refresh-tokens)), so a session opened with the public credential
   does not outlive it. `admin@blog.local` then no longer signs in. If another account already has
   the address, the seeded row keeps `admin@blog.local` and a WARN says so (in production the check
   above then refuses to start while that row still accepts `admin12345`). A database error is a
   WARN and startup goes on.
2. **`ADMIN_PASSWORD` is hashed and written** (`AdminPasswordFromEnvironment`) to the row with
   `ADMIN_EMAIL`, when set. It must have at least 12 characters, or startup is refused. Only a
   real change writes: when the stored hash already verifies the value, nothing is written and
   nothing is logged, so restarting with the same password changes nothing. A real change also
   revokes every live refresh token of that account, in the same transaction, and logs
   `Applied ADMIN_PASSWORD to userId=<id>; <n> refresh token(s) revoked.` (the account id, never the address) A session opened with the
   old password, someone else's included, ends at its next refresh; the access token it holds
   lasts at most 15 more minutes.
3. `ADMIN_GITHUB_ID` links that row to GitHub ([details](#link-the-admin-account-to-github-admin_github_id)).
4. The development-password check above: a WARN on a development machine, a refused startup in
   production.

The rename happens once. Every later start finds the row already renamed and does nothing. To
change the address again, change the row first:
`UPDATE users SET email = '<new address>' WHERE id = '00000000-0000-0000-0000-000000000001';`
then set `ADMIN_EMAIL` to the same value.

None of the three ever writes a role. `ADMIN_EMAIL` and `ADMIN_GITHUB_ID` act only on a row that is
still `ADMIN`, and `ADMIN_PASSWORD` sets the password whatever the row's role, so an account demoted
with a [role change](#roles) stays demoted across restarts.

## Authentication

Log in:

```bash
curl -s -X POST http://localhost:8080/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@blog.local","password":"admin12345"}'
```

An account that needs a second step (every `ADMIN`, and an `AUTHOR` who turned two-step
verification on) gets **202 with a challenge and no token**; finish the sign-in as described in
[Two-step sign-in by hand](#two-step-sign-in-by-hand). Any other account gets a 200 whose response
carries an **access token, valid 15 minutes**, and a **refresh token** (valid
30 days from each use for a reader; for an ADMIN or AUTHOR 7 days without use and 30 days after the sign-in in all,
`PRIVILEGED_SESSION_IDLE_TTL` and `PRIVILEGED_SESSION_ABSOLUTE_TTL`). `refreshExpiresIn` says how many seconds the refresh token lives. Send the access token as `Authorization: Bearer <token>` on every protected
request. When it expires, `POST /api/v1/auth/refresh` exchanges the refresh token for a
new pair and **rotates the refresh token**: the one you sent is revoked, so each refresh
token is good for exactly one use and a replayed one is rejected; replayed after a two-minute
grace window, it also revokes every session of the account
([Sessions and refresh tokens](#sessions-and-refresh-tokens)). `POST /api/v1/auth/logout`
revokes it early. Password login is for the admin and authors; readers sign in with
[GitHub](#github-sign-in-readers) and receive the same token pair.

`/api/v1/admin/**` requires a valid bearer token of role `ADMIN`; a reader's
(`USER`) token is 403 everywhere under it, and so is an `AUTHOR`'s except in five trees listed by name:
`/api/v1/admin/posts/**`, `post-import/**`, `tags/**`, `categories/**` and `analytics/**` (the default is closed: a
controller added under `/api/v1/admin` that nobody decided about is ADMIN only, and
`AdminRouteAuthorizationCoverageIT` fails for a handler in those five trees that has no reviewed decision). For an
`ADMIN` or `AUTHOR` token that role is the
account's current one, read from the database on every request ([Roles](#roles)). Routes on a
single post — reading, editing, deleting, publishing and its cover image — are owner-or-admin
(`hasRole('ADMIN') or @postAccess.isOwner(#id)`): an `ADMIN` manages every post and an
`AUTHOR` only its own, deleting included. A post that does not exist is 403 for an `AUTHOR`
and 404 for an `ADMIN`, so an author cannot probe for post ids. `GET /api/v1/admin/analytics` (V7c) is
in the `ADMIN`-or-`AUTHOR` list; its scope, the whole site or the author's own posts, is decided
in the query. `ADMIN`-only: everything else under `/api/v1/admin`, in particular
`/api/v1/admin/series/**`, `/api/v1/admin/gallery/**` and `/api/v1/admin/media/**`,
`POST /api/v1/admin/posts/{id}/feature` and `/unfeature` (since V7a: homepage prominence is the
site's call, not an author's), `PUT
/api/v1/admin/posts/featured-order` (it orders every author's posts), `PUT` and `DELETE` on
`/api/v1/admin/categories/{id}` and `/api/v1/admin/tags/{id}` (a category or tag spans every
author's posts; listing and creating them stay open to an `AUTHOR`, whose editor creates them
inline), and comment moderation, user management, author applications and the newsletter's counts,
`/api/v1/admin/comments/**`, `/api/v1/admin/users/**`, `/api/v1/admin/author-applications/**` and
`/api/v1/admin/newsletter/**` (V7c; comments and subscribers belong to readers, so there is no "my comments"
for an author to manage). Any valid token, whatever its
role: `GET /api/v1/auth/me` and the reader writes,
`POST /api/v1/posts/{slug}/comments`, `POST /api/v1/comments/{id}/replies`, `PUT` and `DELETE
/api/v1/comments/{id}`, `PUT` and `DELETE /api/v1/posts/{slug}/like`, `PUT` and `DELETE
/api/v1/comments/{id}/like`, and the caller's own notifications: `GET /api/v1/notifications` and
`/api/v1/notifications/unread-count`, `POST /api/v1/notifications/{id}/read` and
`/api/v1/notifications/read-all`, `DELETE /api/v1/notifications/{id}`, the caller's own
author application, `GET` and `POST /api/v1/me/author-application`, and the caller's own bookmarks
(V7b), `GET /api/v1/me/bookmarks` and `GET`, `PUT` and `DELETE /api/v1/me/bookmarks/{slug}`. Each
of these rules names one method and one path shape, so another method on the same path is denied. The
`/auth/me` rule names no method: any method with a valid token passes it, and every method but
`GET` is then a 405. Whose comment a caller may change, and whether the account is suspended,
is decided in the services, because a URL rule cannot read the database. Public: `GET` on posts
(their comments and like counts included), categories, tags, series, the gallery, media and
stats, plus `POST /api/v1/posts/{slug}/views` and, since V7c, `POST /api/v1/newsletter/subscriptions`,
`/api/v1/newsletter/confirm` and `/api/v1/newsletter/unsubscribe` (for the last two the token is the
permission). A post is attributed to whichever user's token
created it, not to a hardcoded actor, and a comment or a like to the token's user: no endpoint
takes a user id from the body or the query. Anything with no matching rule is denied outright,
so a new endpoint is unreachable until a rule is written for it. `SecurityMatrixIT` sends a
real request, without a token and with a real token of each role, to one or two representative
endpoints of each kind of rule above. It does not call every endpoint: the post routes beyond
reading and featuring, and the category and tag renames and deletes, are covered
by their own integration tests, as is the `ADMIN` success on the featured order (the matrix
sends that one a request it must refuse with 400, so it never changes the shared order).

**A 401 and a 403 arrive as `{"error":{"code":...,"message":...,"traceId":...}}`, exactly
like every other failure in this API** — there is one error shape to parse, not three. No
`WWW-Authenticate` header is sent, so a browser will not pop a credential dialog at a JSON
endpoint, and both answers are logged at `WARN` with the same `traceId` they returned.

Neither the response body nor this API's own log line quotes the token or the JWT decoder's
message — the handlers log the exception's class name and nothing else from it. That is a
guarantee about the lines this project writes, not about the log file as a whole: raise
Spring Security's own level (`logging.level.org.springframework.security=DEBUG`) and the
framework prints the decoder's text verbatim, expiry instant included. Keep that off outside
local debugging.

**A token that is sent must be valid, even on a public read.** The bearer filter checks any
`Authorization` header before the URL rules are consulted, so an expired token on `GET
/api/v1/posts/{slug}/comments` is a 401, not an anonymous read. The frontend retries such a
read once without the token.

### Two-step sign-in by hand

A script that signs in as an administrator follows the same handshake as the frontend. The development
admin below has no authenticator yet, so its first sign-in is an enrollment.

```bash
# 1. Password. 202, no token: {"data":{"challenge":"...","purpose":"ENROLL"|"VERIFY","methods":[...],
#    "expiresIn":300,"enrollmentCodeRequired":false}}
curl -s -X POST http://localhost:8080/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@blog.local","password":"admin12345"}'

# 2a. purpose VERIFY: the 6-digit code of the authenticator (or a recovery code). 200 with the token pair.
curl -s -X POST http://localhost:8080/api/v1/auth/mfa/verify -H 'Content-Type: application/json' \
  -d '{"challenge":"<challenge>","code":"123456"}'

# 2b. purpose ENROLL: begin (add "enrollmentCode" when enrollmentCodeRequired is true), then confirm with the
#     first code of the new app. begin answers secretBase32 and otpauthUri once; confirm answers the token
#     pair and ten recovery codes, once.
curl -s -X POST http://localhost:8080/api/v1/auth/mfa/enroll/begin -H 'Content-Type: application/json' \
  -d '{"challenge":"<challenge>"}'
curl -s -X POST http://localhost:8080/api/v1/auth/mfa/enroll/confirm -H 'Content-Type: application/json' \
  -d '{"challenge":"<challenge>","code":"123456"}'
```

- The **challenge** is single use, lives `app.mfa.challenge-ttl` (5 minutes), allows 5 evaluated codes and
  is bound to the account that passed the first factor. It also answers a GitHub callback that needs a
  second step (202 instead of 200, same body). A wrong, expired, used or unknown challenge is one 401
  `MFA_CHALLENGE_INVALID`.
- **Wrong code**: 401 `MFA_CODE_INVALID`, the same for a wrong code, a replayed one (each 30-second step is
  accepted once) and a secret that cannot be decrypted. **429 `MFA_RATE_LIMITED`** with
  `error.details.retryAfterSeconds` while the account's delay runs (nothing is evaluated, a correct code
  included); **403 `MFA_FROZEN`** after 100 failures in a row. 403 `ENROLLMENT_CODE_INVALID` for a wrong
  or missing enrollment code.
- The rules (why the window is open or closed, the delays, recovery codes, the secret at rest) are in
  [Security](../docs/SECURITY.md#two-step-verification-and-recovery). A client that does not know the
  handshake finds no `accessToken` in the 202 and fails closed.
- `POST /api/v1/auth/refresh` refuses (401 `MFA_REQUIRED`, and ends the session) a session that never
  verified a second factor when its account now needs one.

### Sessions and refresh tokens

An access token is a signed JWT that is not stored anywhere; it cannot be revoked and lasts its
15 minutes. A refresh token is an opaque random string; the `refresh_tokens` table keeps only its
SHA-256, with its expiry and, once revoked, the time of revocation. A session therefore ends at
its next refresh after its refresh token is revoked. These revoke refresh tokens:

| Event | Revokes |
|---|---|
| `POST /api/v1/auth/refresh` | the token it was given (rotation) |
| `POST /api/v1/auth/logout` | the token it was given |
| Suspending a reader | every live token of that reader |
| A role change, by hand or by approving an author application ([Roles](#roles)) | every live token of that account |
| Enrolling, replacing or turning off an authenticator, and a password change | every live token of that account; the caller is answered with a new session that keeps its original `authenticated_at` |
| `POST /api/v1/auth/sessions/revoke-all` ("sign out everywhere") | every live token of the caller, the calling session included |
| The operator's reset (`MFA_RESET_EMAIL` and `MFA_RESET_TOKEN`) | every live token of that account |
| An administrator's reset of an author (`POST /api/v1/admin/users/{id}/mfa/reset`) | every live token of that author |
| A refresh whose session never verified a second factor, for an account that needs one | that session |
| `ADMIN_PASSWORD` set to a new value | every live token of the admin ([details](#the-admin-account-admin_email-admin_password)) |
| `ADMIN_EMAIL` renaming the seeded admin | every live token of that row |
| A replayed refresh token (below) | every live token of that session (its successors included), not the account's other sessions |

Linking a reader to the admin with `ADMIN_GITHUB_ID` deletes the reader's tokens instead.

**Reuse detection.** A refresh token that was revoked on its own (by a rotation or a logout) and
is presented again more than `app.security.refresh-token-reuse-grace` (default 2 minutes) after
its revocation, while it has not expired, was most likely copied: either someone else holds it,
or a client lost the answer of a rotation, and the two cannot be told apart. Every live refresh
token of that session (the chain of rotations of that one sign-in) is revoked, including the one
the rotation handed to whoever holds the copy; the account's other sessions stay, and so does its
`tokens_valid_after`. One WARN line is logged after the commit: `refresh token reuse detected
userId=… revokedSecondsAgo=… tokensRevoked=…`, with no token, hash or issue time. The answer does not
change: 401 `REFRESH_TOKEN_REVOKED`, the same code and message as for a token revoked on its own,
which the frontend treats as a lost race and keeps its cookies for.
- **Inside the grace window it is a lost race**, not reuse: the frontend's `/admin` proxy and its
  `/api/session` route can present the same cookie seconds apart, and the loser gets
  `REFRESH_TOKEN_REVOKED` while the winner's new session stays alive.
- **Once per token.** Detection ends the presented token's expiry, and every bulk revocation in
  the table above ends the expiry of the tokens it revokes. Since V7a the expiry is checked before
  the revocation, so replaying an old token again, or an old device coming back after a password
  change, a role change or a detection, gets `REFRESH_TOKEN_EXPIRED`: the frontend clears its
  cookies, the user signs in again, and nobody is logged out a second time. A refresh for a
  suspended account gets `USER_SUSPENDED` before any of these checks.
- **Logout is not checked.** `POST /api/v1/auth/logout` with a revoked token is a plain 401:
  `REFRESH_TOKEN_REVOKED`, or `REFRESH_TOKEN_EXPIRED` once its expiry was ended.
- **The commit survives the 401.** `rotate()` commits when it throws the reuse error
  (`noRollbackFor` on that one exception type, not on every `ApiException`); without that, the
  revocation was rolled back together with the error it caused. `RefreshTokenServiceIT` and
  `AuthRefreshIT` fail without it.

**Cleanup.** A job deletes expired tokens and tokens revoked more than
`app.security.refresh-token-revoked-retention` ago (default 7 days), once a day at 03:17 UTC
(10:17 in Vietnam; the JVM runs in UTC under the Dockerfile, `mvn spring-boot:run` and the
tests alike), in one `DELETE` statement. Running it with nothing to delete, or on two instances
at once, is harmless. It logs one INFO line with the number of rows only: `refresh token cleanup:
<n> expired or long-revoked row(s) deleted`. Before V6 nothing deleted these rows (about 2,350
of them after four days on a development machine). A deleted token is simply unknown (401
`REFRESH_TOKEN_INVALID`, which makes the frontend clear its cookies), so reuse detection covers a
revoked token for the retention period only. Bulk-revoked tokens already have their expiry
ended, so they go at the next run.

| Key (environment variable) | Default | Meaning |
|---|---|---|
| `app.security.refresh-token-cleanup-cron` (`APP_SECURITY_REFRESH_TOKEN_CLEANUP_CRON`) | `0 17 3 * * *` | When the cleanup runs (Spring cron: second minute hour day month weekday). `-` turns it off. |
| `app.security.refresh-token-revoked-retention` (`APP_SECURITY_REFRESH_TOKEN_REVOKED_RETENTION`) | `7d` | How long a revoked token is kept, and so can be detected as reused. |
| `app.security.refresh-token-reuse-grace` (`APP_SECURITY_REFRESH_TOKEN_REUSE_GRACE`) | `2m` | How old a revocation must be before presenting the token counts as reuse. `0` makes every lost race log the user out everywhere. |

Like the rate limits, these keys are left out of `application.yml`; their defaults live in
`SecurityProperties` and the cleanup's `@Scheduled`. A negative duration refuses startup.

**Rotating `JWT_SECRET` is not a global logout.** It invalidates every access token at once
(each had at most 15 minutes left) and cancels GitHub sign-ins in flight, but refresh tokens
are not signed with it: every client refreshes and carries on. To end every session of every
account, revoke the refresh tokens:

```sql
UPDATE refresh_tokens SET revoked_at = now(), expires_at = LEAST(expires_at, now())
WHERE revoked_at IS NULL;
```

Add `AND user_id = '<uuid>'` for one account. Ending the expiry as well matters: without it, each
device that comes back after the grace window counts as a reuse and logs that account out again,
new sessions included. Access tokens already issued still last up to 15 minutes; rotate
`JWT_SECRET` at the same time to end those too. There is no endpoint for this ("log out
everywhere" is deferred).

### Roles

| Role | Who | May |
|---|---|---|
| `USER` | Every account a GitHub sign-in creates | Comment, reply, edit and delete its own comments, like posts and comments, read and manage its own notifications, apply to become an author. Nothing under `/api/v1/admin`. |
| `AUTHOR` | A reader an `ADMIN` promoted, by hand or by approving its application (V7a); it signs in with GitHub | Its own posts (with their covers, body images and revisions), and listing and creating categories and tags. Everything a `USER` may except applying. Since V7a the frontend's `/admin` UI is open to it, its own posts only; since V7c the view report of its own posts (`GET /api/v1/admin/analytics`). |
| `ADMIN` | The seeded account (`app.admin.email`), and any account an `ADMIN` promoted | Everything, moderation, suspension, role changes and author applications included. Through the public comment endpoints it edits and deletes only its own comments, like anyone else. |

**Changing a role** (V7a). `PATCH /api/v1/admin/users/{id}/role`, or approving an author
application, goes through `RoleChangeService`, the only code that writes `users.role` (the entity
maps it `updatable = false`, like `posts.featured`). In one transaction it takes a Postgres advisory
lock on the admin roster (`pg_advisory_xact_lock(hashtext('admin-roster'))`), checks that the caller
is still an active `ADMIN` (403 otherwise), then:

- the current role again is a 200 no-op: nothing revoked, nothing logged;
- demoting an `ADMIN` needs another active `ADMIN` (409 `LAST_ADMIN`); the count runs under the
  lock, so two admins demoting each other at once cannot leave none;
- the site owner's role (the seeded account, `00000000-0000-0000-0000-000000000001`) changes only
  at the site owner's own request (409 `SITE_OWNER_PROTECTED`);
- a suspended account can only become `USER` (409 `ROLE_TARGET_SUSPENDED`);
- a demotion to `USER` deletes the account's two-step enrollment and recovery codes (`by=role_change`); a
  demotion to `AUTHOR` keeps them; a promotion to `ADMIN` makes its next sign-in an enrollment;
- a real change revokes every live refresh token of the account and, after the commit, logs
  `role changed actor=<id> target=<id> from=<role> to=<role>`, ids only.

A role changed with SQL skips all of that, revocation and log included.

**Immediate effect.** For an access token whose `role` claim is `ADMIN` or `AUTHOR`,
`CurrentAccessJwtConverter` reads the account's current role and status on every request, and the
database wins over the claim: a demotion applies at the next request, and a suspended or missing
account gets no authority at all (403). A database error there is a 503 `INTERNAL_ERROR` with the
usual error body (`ApiBearerFailureHandler`). A `USER` token, or no token, costs no extra query. The
trade-off: a promotion applies only after the account signs in again. Its `USER` access token keeps
that role until it expires (at most 15 minutes), and its refresh tokens are already revoked, so its
next refresh is a 401 `REFRESH_TOKEN_EXPIRED` and the frontend ends the session. Suspension is
described below.

### GitHub sign-in (readers)

The browser never calls the backend. The frontend's route handlers (`/api/auth/github/start`
and `/api/auth/github/callback`) call two backend paths, server to server. Those paths belong to
their own filter chain (`GithubLoginSecurityConfig`, `@Order(2)`), which runs Spring Security's
`oauth2Login`:

1. `GET /api/v1/auth/oauth2/authorization/github` answers 302 to GitHub's authorize page, with a
   `state`, a PKCE S256 `code_challenge`, scope `read:user` and the site's callback as
   `redirect_uri`. It also sets
   `oauth2_auth_request=<payload>.<HMAC>; Path=/api/v1/auth/oauth2; Max-Age=600; HttpOnly; SameSite=Lax`.
   The frontend keeps that value in a cookie of its own. The backend creates no session and no
   `JSESSIONID`. Any other provider name in that path, such as `/authorization/gitlab`, is 404
   `ENDPOINT_NOT_FOUND`, the same answer as when GitHub sign-in is off.
2. `GET /api/v1/auth/oauth2/callback/github?code=…&state=…`, sent with the same cookie, checks
   the signature, the expiry and the state, exchanges the code with the stored `code_verifier`,
   reads GitHub's `GET /user`, and creates or updates the account. It answers
   `200 {"data": {"accessToken", "refreshToken", "expiresIn", "refreshExpiresIn"}}` with `Cache-Control: no-store`,
   the same body as password login. Every answer to a callback that carries a `state` and a
   `code` or an `error` expires the cookie, failures included. A callback missing those is
   refused by Spring before the cookie is read (401 `OAUTH_STATE_INVALID`, no `Set-Cookie`), so
   the frontend clears its own copy on every callback.

A failure is the usual error envelope:
- 401 `OAUTH_ACCESS_DENIED`: the reader pressed Cancel on GitHub;
- 401 `OAUTH_STATE_INVALID`: a cookie that is missing, tampered with or expired, a wrong state,
  or the same callback twice;
- 502 `OAUTH_PROVIDER_UNAVAILABLE`: GitHub unreachable, too slow (5 s to connect, 10 s to read,
  the body of the answer included), dropping the connection mid-answer, or answering 5xx;
- 403 `USER_SUSPENDED`;
- 401 `OAUTH_LOGIN_FAILED` for the rest, such as a bad or reused code or a malformed profile.

The frontend turns each of these into a message on `/login`.

- **The account is the numeric GitHub id**, not the login, so a renamed GitHub account keeps
  its comments. The first sign-in creates a `USER` with no email and no password. Every sign-in
  refreshes the GitHub login and avatar. It refreshes the display name only for role `USER`: an
  admin's or author's name stays the one set in the CMS.
- **No email.** The scope is `read:user`, and the email GitHub may send is ignored, never stored.
  There is therefore no linking by email: a GitHub account with the admin's address is just
  another reader. A GitHub reader has no password, so `POST /api/v1/auth/login` refuses it like
  an unknown email.
- **Signed with `JWT_SECRET`.** The cookie's key is derived from `JWT_SECRET`, so there is no
  extra secret to manage, and changing `JWT_SECRET` also cancels sign-ins in flight. On a public
  site the committed development value refuses startup ([Production checks](#production-checks)),
  so the cookie key is never one anybody can read in the repository. Each
  `state` is accepted once and remembered in memory for 10 minutes (at most 10 000, per
  instance); after a restart, GitHub's single-use code is the backstop.
- **The callback address is never compared.** The backend can sit on an internal address while
  GitHub is given the site's public one.
- **Logs.** Each success writes one INFO line, `github login ok userId=… created=…`. Each
  failure writes one WARN line, `github login failed error=<code> oauthError=… cause=<class>
  traceId=…`. Neither line contains the code, the state, a token, the client secret, an email
  or a cookie value.
- **Off unless configured.** With `GITHUB_CLIENT_ID` or `GITHUB_CLIENT_SECRET` blank, the site
  runs without GitHub sign-in and both paths answer 404 `ENDPOINT_NOT_FOUND`; setting only one
  of the two logs a WARN. With both set, the backend needs the callback GitHub will redirect to,
  from `GITHUB_REDIRECT_URI` or derived from `SITE_URL` as
  `<SITE_URL>/api/auth/github/callback`. It refuses to start if:
  - neither of the two is set;
  - the callback is not exactly that path, or carries a query or a fragment;
  - the callback is plain http on a host that is not a loopback address (localhost,
    127.0.0.0/8 or ::1, the same definition the [production checks](#production-checks) use).

  There is no localhost default. Register exactly the same callback URL in the GitHub OAuth App.
- **Mock GitHub only.** `app.oauth.github.provider.authorization-uri`, `token-uri` and
  `user-info-uri` point the flow at a mock GitHub for tests and E2E. A host other than GitHub's
  logs a WARN at startup. They are not operator settings.

### Link the admin account to GitHub (`ADMIN_GITHUB_ID`)

Set `ADMIN_GITHUB_ID` to the numeric id of the owner's GitHub account: the `id` field of
`https://api.github.com/users/<login>`. At startup the backend links the admin row
(`app.admin.email`, role `ADMIN`) to it. A GitHub sign-in with that id then gets an `ADMIN`
token, and password login keeps working.

- **A reader with that id is merged into the admin.** This is the usual case: the owner signed
  in with GitHub as a reader before setting the variable. The reader's comments move to the
  admin, and so do its post and comment likes, minus any the admin already gave, and (since V7b)
  its bookmarks, minus posts the admin already saved, each keeping when it was saved. Its
  notifications move to the admin too, those it caused and those it received, except the ones
  that would become the admin notifying itself and like notifications the admin already has. Its
  refresh tokens and the row itself are deleted, and the admin takes its GitHub login and avatar.
  It is logged at WARN as `merged GitHub reader account into admin: githubId=… oldUserId=…
  oldStatus=… comments=… likes=… commentLikes=… bookmarks=… notifications=…` (`notifications`
  counts the rows moved). The reader's leftover access token, valid at most 15 minutes, is then
  refused on every write.
- **Notifications about posts go to the post's author**, which for the owner's posts is the
  admin row. A GitHub session sees them only when it is that row, that is once
  `ADMIN_GITHUB_ID` links it. While the owner reads the blog as an unlinked GitHub reader, a
  separate `USER` row, that reader never sees likes and comments on the owner's posts, and its
  own likes and comments notify the admin row. Linking fixes both.
- **Nothing changes, with a WARN,** if the id belongs to another `ADMIN` or `AUTHOR`, or if the
  admin is already linked to a different id.
- **Startup never fails because of linking.** A database error is a WARN like the cases above.
  Only a value that is not a positive whole number refuses startup.
- **Unsetting the variable does not unlink.** Linking again is a no-op. To unlink, run
  `UPDATE users SET github_id = NULL WHERE id = '00000000-0000-0000-0000-000000000001';` (the
  seeded admin's id, whatever `ADMIN_EMAIL` renamed it to). The admin row keeps its email and
  password, so it stays a valid account.

### Suspension

An `ADMIN` suspends a reader with `PATCH /api/v1/admin/users/{id}/status` and
`{"status": "SUSPENDED"}`. Only role `USER` can be suspended, never the caller's own account:
anything else is 409 `USER_NOT_SUSPENDABLE`. The same transaction revokes all of the reader's
refresh tokens. From then on:
- every write (comment, reply, edit, delete, like) is 403 `USER_SUSPENDED`, even with a
  still-valid access token, because each write reads the account's status first. So is every
  notification and bookmark endpoint (V7b), reads included: an inbox and a reading list are private
  to an active account. Notifications
  are still created for a suspended reader, and appear once the account is reactivated;
- `GET /api/v1/auth/me`, `POST /api/v1/auth/refresh`, password login and GitHub sign-in are 403
  `USER_SUSPENDED` too. Password login says so only after the password matched, so it does not
  reveal which accounts are suspended. A refused GitHub sign-in writes nothing: the display name,
  login and avatar that the reader's still-visible comments show, and the last-login time, stay as
  they were, whatever the reader changed on GitHub meanwhile;
- public reads still work and do not check the account's status, so while the old access token
  lasts, `mine`, `liked` and `likedByMe` still reflect the reader's own comments and likes.

`{"status": "ACTIVE"}` reactivates the account, and the reader then signs in again. Suspension
deletes nothing. To suspend an `AUTHOR` or an `ADMIN`, demote it to `USER` first
([Roles](#roles)); a suspended account must be reactivated before it can become `AUTHOR` or
`ADMIN`.

## Endpoints

Every path is under `/api/v1`. A success is `{"data": ...}` (lists add `"pagination"`), a
failure is `{"error": {"code", "message", "traceId"}}`. A query string Tomcat cannot decode (a
malformed `%` escape such as `%FF`) is 400 `VALIDATION_ERROR` when an endpoint reads its
parameters, logged (at DEBUG) without the raw value; before V7b it was a 500.

A request body is bounded before anything reads it (`RequestSizeLimitFilter`): 64 KiB for every path except `/admin/**`, 6 MiB under it
(`app.request-limit.public-body` and `.admin-body`), also for a chunked body. A larger one is 413 `VALIDATION_ERROR`; a JSON string over
1,000,000 characters or a document over 8 MiB is 400. Multipart uploads keep their own limits. This is the only bound of a backend with
a public URL of its own ([Security](../docs/SECURITY.md#upload-limits-by-layer)). A 404, a malformed request and the other errors that
anonymous traffic can cause without limit are logged at DEBUG with the error code and the trace id, never with the message; a request that
the firewall refuses (a matrix parameter, `TRACE`) is a 400 with the same envelope.

Lists paged by `page` and `size` (`/posts`, `/posts/search`, `/gallery`, and the admin
`/posts`, `/comments`, `/users` and `/author-applications`) clamp `page` to 0–21474836: the offset is `page × size`, JPA
takes it as an `int`, and 21474836 is `2147483647 / 100`, the largest page whose offset still
fits at the largest size. A larger page answers 200 with an empty `data` and
`"pagination": {"page": 21474836, ...}`, as any page past the end does. Before V6 it was a 500
on the public lists. Comments and notifications are paged by cursor, not by offset.

**Languages.** Content has one language per post. The public list endpoints take an optional `lang` (`en` or `vi`): absent means no
language filter, an unknown code is 400 `VALIDATION_ERROR`; the frontend always sends the page locale. A post response carries
`translations`, built from published siblings only. The rules (translation groups, taxonomy names, newsletter text) are in
[docs/CONVENTIONS.md](../docs/CONVENTIONS.md), section 5.

### Public

| Method | Path | Notes |
|---|---|---|
| `GET` | `/posts` | Published posts. `page`, `size`, `category`, `tag`, `featured`, `sort=latest\|popular` (default `latest`). `popular` is most-viewed first and cannot be combined with a filter (400). `featured=true` follows the curated rank, unranked last. A `category` or `tag` slug with no published post is an empty page, exactly like an unknown slug; so is a malformed one (V7b), answered without a query (a NUL in it used to be a 409). Each item is a summary, the post without its `content`. Its `updatedAt` is the post's own (the sitemap's `lastmod`): saving, publishing and unpublishing the post change it; featuring, ranking, series membership, the cover image and deleting a tag do not. Every post and summary, admin responses included, carries `author` (V7a): `displayName`, `githubLogin` and `avatarUrl` (`null` without GitHub), and `siteOwner`, true only for the seeded admin account; never an id, email or role. |
| `GET` | `/posts/search?q=` | Ranked full-text search over published posts, ignoring case and Vietnamese diacritics ([Search](#search)). Optional filters (V7b): `category`, `series` and `tag` (repeatable, at most 5 different), all ANDed; filters without `q` list the matches newest first. Blank `q` with no filter is an empty page, not 400. `q` longer than 200 characters after cleaning, or more than 5 different tags, is 400 `VALIDATION_ERROR`. Same summaries as `/posts`. |
| `GET` | `/posts/{slug}` | One published post. Its comments and likes are not in it: they are read separately, so the cached post never carries anything per reader. |
| `GET` | `/posts/{slug}/redirect` | `{"slug"}`: the current slug of the published post that used to have this slug, for a permanent redirect ([Slug changes](#slug-changes-and-redirects)). One hop, however many times the slug changed, and never the slug asked for. 404 `POST_NOT_FOUND` for anything else: an unknown slug, a post's current slug, or a post that is now a draft, archived or deleted. |
| `GET` | `/posts/{slug}/comments` | A page of comments: top-level ones oldest first, each with its visible replies (oldest first, at most 30). `size` (default 10, clamped to 1–20) and `after`, the previous page's `nextCursor`, which is `null` on the last page. The cursor is a position, not an offset, so a comment added or removed between two pages is neither skipped nor repeated. A hidden or deleted top-level comment that still has visible replies is a placeholder whose `content` and `author` are `null`; other comments that are not visible are left out. A comment's `author` is `displayName`, `githubLogin`, `avatarUrl` and `siteOwner`: no id, email or role. `siteOwner` is true only for the seeded admin account, the site owner (before V7a: any `ADMIN`), for the frontend's "site owner" badge: a reader's display name follows GitHub, so anyone can copy the owner's name, but not this flag. It is false for an `AUTHOR` and for any other `ADMIN`. With a token, `mine` marks the caller's own comments. Every comment also carries `editedAt` (the last edit, `null` unless `edited` is true), `likeCount` and `likedByMe` (false without a token); a placeholder has `null`, 0 and false. Like counts are read in two queries per page, whatever its size. 404 `POST_NOT_FOUND` unless the post is published, 400 for a malformed cursor. |
| `GET` | `/posts/{slug}/like` | `{"liked", "count"}`; `liked` is false without a token. 404 `POST_NOT_FOUND` unless the post is published. |
| `POST` | `/posts/{slug}/views` | One view, 204. 404 `POST_NOT_FOUND` unless the post is published. When `VIEWS_TOKEN` is set, a matching `X-View-Token` header is required (403 otherwise). Adds one to the post's all-time counter (`post_views`) and, since V7c, in the same transaction, to its row for the local day and source group in `post_view_daily` ([Analytics](#analytics)). Optional `X-View-Referrer` (V7c): the referring host, untrusted, used only to pick the source group and never stored. No IP, user agent or per-view row is stored. |
| `GET` | `/categories`, `/categories/{slug}` | Only categories with at least one published post, by name. A category whose posts are all drafts or archived, or that has none, is left out of the list and is 404 `CATEGORY_NOT_FOUND` by slug, the same answer as an unknown slug, so the name of a topic being drafted is never public. It appears with its first published post and leaves with its last. The admin list (`/api/v1/admin/categories`) shows every category. |
| `GET` | `/tags`, `/tags/{slug}` | Only tags on at least one published post, by name; otherwise 404 `TAG_NOT_FOUND` by slug and left out of the list, as for categories. The admin list shows every tag. |
| `GET` | `/series` | Series with at least one published part, the one with the newest published part first, each with its parts in reading order. |
| `GET` | `/series/{slug}` | The published parts in reading order. 404 `SERIES_NOT_FOUND` for an unknown slug or a series with no published part. |
| `GET` | `/gallery` | Published photos in the owner's order. `page` (clamped to 0–21474836, see above), `size` (default 24, clamped to 1–100). |
| `GET` | `/media/{id}.{jpg\|png}` | Image bytes. The extension must match the stored type (404 `MEDIA_NOT_FOUND` otherwise), so each image has exactly one URL. `ETag` is the SHA-256, `If-None-Match` answers 304 without reading the bytes, `Cache-Control: public, max-age=31536000, immutable`. At most 8 images are read from the database at once (each is held whole in the heap, up to 4 MiB): a ninth read waits 2 seconds and then answers 503 `MEDIA_BUSY` (the Next route turns it into a 502 that is never cached); a 304 reads no bytes and is not counted, and the owner's exports (a post package, the site export) read through their own path and are never refused for it. **Unlisted, not private**: anyone with the URL can fetch it, including a draft's cover and a hidden gallery photo. |
| `GET` | `/stats` | `publishedPosts`, `totalViews`, `seriesCount` (series with a published part), `galleryPhotos` (published). |
| `GET` | `/health` | 200, or 503 when the database cannot be read. |
| `POST` | `/newsletter/subscriptions` | `{"email"}`, 202 `{"status": "PENDING_CONFIRMATION"}` for every well-formed address: new, pending, confirmed, unsubscribed, or over the per-address, per-client-address or whole-site limit alike (V7c, [Newsletter](#newsletter), [Rate limits](#rate-limits)). Only an address that cannot be used is 400 `VALIDATION_ERROR`. Sends nothing and creates no token: the worker mails the confirmation. |
| `POST` | `/newsletter/confirm` | `{"token"}`, 200 `{"status": "CONFIRMED"}`. 400 `NEWSLETTER_TOKEN_INVALID`, one message for a malformed, unknown, expired (48 hours) or used token; 429 `RATE_LIMITED` (`newsletter-token-client` and `newsletter-confirm-global`, counted before the token is looked at; `newsletter-token`, counted once the token is found). |
| `POST` | `/newsletter/unsubscribe` | `{"token"}`, 200 `{"status": "UNSUBSCRIBED"}`, also when already unsubscribed. No login: the token is the permission. 400 `NEWSLETTER_TOKEN_INVALID` for a malformed token or a wrong MAC; 429 `RATE_LIMITED` (`newsletter-token-client`, counted before the token is looked at; `newsletter-token`, counted once the subscription is found). There is no whole-site limit on unsubscribing, so stray tokens cannot leave real unsubscribes without budget. |
| `POST` | `/auth/login`, `/auth/refresh`, `/auth/logout` | See [Authentication](#authentication). Login and refresh are 403 `USER_SUSPENDED` for a suspended account. Login is 429 `RATE_LIMITED` when its client address made too many attempts (`login-client`, counted before the password is checked, wrong or right) or when it waited too long for a password check; refresh is 429 for `refresh-client` ([Rate limits](#rate-limits)), and on a public site always 401 for the development password ([Production checks](#production-checks)). |
| `POST` | `/auth/mfa/verify`, `/auth/mfa/enroll/begin`, `/auth/mfa/enroll/confirm` | The second step of a sign-in and the forced enrollment: [Two-step sign-in by hand](#two-step-sign-in-by-hand). Public, with the challenge as the credential; the login answers 202 with it. 401 `MFA_CHALLENGE_INVALID` / `MFA_CODE_INVALID`, 403 `ENROLLMENT_CODE_INVALID` / `MFA_FROZEN`, 429 `MFA_RATE_LIMITED`, and 429 `RATE_LIMITED` when the client address made too many second-step attempts (`mfa-client`, [Rate limits](#rate-limits)). |
| `GET` | `/auth/me` | Any valid token. `id`, `email` (`null` for a GitHub reader), `displayName`, `role`, `githubLogin` and `avatarUrl` (`null` for an account that never signed in with GitHub), `status`, `createdAt`. No password hash, GitHub id or token. 403 `USER_SUSPENDED` for a suspended account. Only `GET`: other methods are 405. |

### Readers (any valid token)

| Method | Path | Notes |
|---|---|---|
| `POST` | `/posts/{slug}/comments` | `{"content": "..."}`, 201 with the comment. The content is cleaned (CRLF to LF; control, zero-width and bidi characters removed; trimmed; three or more newlines collapsed to two) and must then hold 2–2000 characters, one of them visible (400 `VALIDATION_ERROR`). It is stored and returned as plain text, which the frontend renders as text, never as HTML or Markdown. Posting content you already posted on the same post less than 10 minutes ago, and have not deleted, is 409 `COMMENT_DUPLICATE`. The check is per account: the same text from someone else is accepted. 404 `POST_NOT_FOUND` unless the post is published, also when it is unpublished between the check and the insert: the insert itself only selects a published post. |
| `POST` | `/comments/{id}/replies` | Same body and rules; the duplicate check compares with your own replies to the same comment, so one short "Thanks!" can still answer two different people. One level only: replying to a reply, or to a comment that already has 30 replies, is 422 `COMMENT_NOT_REPLYABLE`. A parent that is missing, not visible, or on a post that is not published is 404 `COMMENT_NOT_FOUND`. |
| `PUT` | `/comments/{id}` | Edit your own comment, with no time limit. Someone else's is 403 `FORBIDDEN`. A hidden or deleted one is 404, for its author too, so nobody can edit around moderation. `edited` turns true when the content changes; the same content again changes nothing. |
| `DELETE` | `/comments/{id}` | Soft delete of your own comment, 204, then 404 on a second try. The content stays for moderation. |
| `PUT`, `DELETE` | `/posts/{slug}/like` | Like and unlike. No body, idempotent; both answer 200 `{"liked", "count"}`. 404 `POST_NOT_FOUND` unless the post is published. |
| `PUT`, `DELETE` | `/comments/{id}/like` | Like and unlike a comment, the same way: no body, idempotent, 200 `{"liked", "count"}`. Only a visible comment on a published post; anything else (hidden, deleted, a placeholder, an unpublished post, an unknown id) is 404 `COMMENT_NOT_FOUND`, and a malformed id 400. Liking your own comment is allowed. There is no `GET`: the count comes with each comment. |
| `GET` | `/me/bookmarks` | Your saved posts that are still published, most recently saved first (V7b, migration V29): the same summaries as `/posts`, with nothing per reader in them. `size` (default 20, clamped to 1–50), `page` (clamped to 0–42949672, for the same reason as above). A saved post that is unpublished leaves the page and the total but keeps its row, so it is back once republished; deleting the post deletes the bookmark. |
| `GET` | `/me/bookmarks/{slug}` | `{"bookmarked"}`. 404 `POST_NOT_FOUND` unless the post is published. |
| `PUT`, `DELETE` | `/me/bookmarks/{slug}` | Save and unsave. No body, idempotent; both answer 200 `{"bookmarked"}`. `PUT` is 404 `POST_NOT_FOUND` unless the post is published; the insert itself only selects a published post, so one unpublished between the check and the insert is not saved, and the answer is read back from the table, so it never reports a bookmark that does not exist. `DELETE` also removes your bookmark of a post unpublished since (otherwise it would come back on republish), and is 404 only when the slug is neither a published post nor one of your bookmarks, so a draft's slug never leaks. |
| `GET` | `/notifications` | Your notifications, newest first: `{"items", "nextCursor", "headCursor"}`. Each item is `id`, `type` (`POST_LIKED`, `POST_COMMENTED` on your post; `COMMENT_REPLIED`, `COMMENT_LIKED` on your comment), `createdAt`, `read`, `actor` (`displayName`, `githubLogin`, `avatarUrl`: no id, email or role), `post` (`slug`, `title`), `commentId` and `excerpt` (at most 120 characters plus `…`; both `null` for `POST_LIKED`). Never your own actions. Only while still current: the post is published, the comment involved is visible, and a like has not been withdrawn (liking again brings the same item back, with its time and read state). `size` (default 20, clamped to 1–50), `after` (the previous page's `nextCursor`), `unread=true` for unread ones only. `headCursor`, the newest item's position, is set on the first page only. 400 for a malformed cursor, `size` or `unread`. |
| `GET` | `/notifications/unread-count` | `{"count"}`, capped at 100. |
| `POST` | `/notifications/{id}/read` | Mark one read; idempotent. 404 `NOTIFICATION_NOT_FOUND` for an unknown id or someone else's, never 403. |
| `POST` | `/notifications/read-all` | Mark all read, up to and including `before` when given (send the list's `headCursor`, so that what arrived after the list was loaded stays unread); without it, all. 400 for a malformed `before`. |
| `DELETE` | `/notifications/{id}` | Delete one for good; 200, not 204. 404 `NOTIFICATION_NOT_FOUND` as above, and on a second delete. |
| `GET` | `/me/author-application` | Your latest author application (V7a): `application` (`id`, `status`, `motivation`, `createdAt`, `decidedAt`; `null` if you never applied, never who decided), `canApply`, and `reapplyAfter` (the end of the 30-day wait after a rejection, else `null`). 403 `USER_SUSPENDED` for a suspended account, like the notifications. |
| `POST` | `/me/author-application` | `{"motivation": "..."}`, optional, cleaned like a comment, at most 500 characters (400 `VALIDATION_ERROR`); 201 with the application. Role `USER` only. 409 `AUTHOR_APPLICATION_NOT_ALLOWED` for an `AUTHOR` or `ADMIN`, `AUTHOR_APPLICATION_PENDING` with one already pending (a partial unique index, V28), `AUTHOR_APPLICATION_COOLDOWN` within 30 days of a rejection. Nothing changes until an `ADMIN` decides, and no notification is sent either way. There is no cancel: `DELETE` is denied. |

The author of a comment or a like is always the token's user; a `userId`, or any field other
than `content`, in the body is ignored. Every one of these writes checks the account's status
first (403 `USER_SUSPENDED`) and is [rate limited](#rate-limits) per user (429 `RATE_LIMITED`).
The notification endpoints check the account's status too, but have no rate limit: they only
read or change the caller's own rows, and every write there is an idempotent conditional
statement. Every write under `/notifications` answers the new `{"count"}`. The bookmark endpoints
check the account's status on reads too, like the notifications; only `PUT` and `DELETE` are rate
limited (bucket `bookmark`).

A notification is created in the same transaction as the like or comment that causes it, only
when a like row was actually inserted (liking again changes nothing), only when the actor is not
the recipient, and only while the post is published; each insert checks the last two itself, so
a post unpublished mid-request gets none. A new comment notifies the post's author; a reply notifies the parent
comment's author, and the post's author too unless that is the replier or the parent's author.
Edits, deletes, unlikes and moderation notify nobody. There is no email, push or websocket: the
frontend polls the unread count.

### The caller's own security (any valid token, `/api/v1/me`)

Every row except `GET /me/mfa` needs a sign-in from the last `app.mfa.reauth-window` (10 minutes) and answers 401
`REAUTHENTICATION_REQUIRED` otherwise, before any code is looked at. A code is a TOTP code or, where noted, a recovery code. They share the
`mfa-step-up` bucket (10 per 10 minutes, per user), and `POST /me/password` the `password-change` one (5 per 10 minutes).
A wrong code counts against the account's second-step brake like at sign-in ([Rate limits](#rate-limits)).

| Method | Path | Notes |
|---|---|---|
| `GET` | `/me/mfa` | `enrolled`, `required`, `recoveryCodesRemaining`, `hasPassword`, `passwordManagedByEnvironment`. Never a secret. |
| `POST` | `/me/mfa/enroll/begin` | An author turns it on: `{"currentPassword"?}` (required when the account has a password). Answers `secretBase32`, `otpauthUri`, `issuer`, `account` once; nothing changes until the first code. 409 `RESOURCE_CONFLICT` when already enrolled; 403 for a role other than `AUTHOR` (an admin enrols at sign-in). |
| `POST` | `/me/mfa/enroll/confirm` | `{"code"}`. Activates it, answers the new session and ten `recoveryCodes` once, and ends the account's other sessions. |
| `POST` | `/me/mfa/recovery-codes/regenerate` | `{"code","currentPassword"?}` (authenticator or recovery code). Replaces all ten; answers them once. |
| `POST` | `/me/mfa/replace/begin` | `{"code","currentPassword"?}` (authenticator or recovery code). Stores a pending secret next to the active one, which keeps working; answers the new secret once. |
| `POST` | `/me/mfa/replace/confirm` | `{"code"}` of the new app. Swaps them, answers a new session and ten new `recoveryCodes`. |
| `DELETE` | `/me/mfa` | `{"code"}`. An author turns it off (answers a new session); an `ADMIN` gets 403 `MFA_REQUIRED`. |
| `POST` | `/me/password` | `{"currentPassword","newPassword","code"?}` (the code is required with two-step verification on). The new password must meet the [policy](../docs/SECURITY.md#password-policy) (400 `VALIDATION_ERROR`, one message for every weak case). Ends every other session and answers the caller's new one. 409 `PASSWORD_MANAGED_BY_ENVIRONMENT` while `ADMIN_PASSWORD` is set; 401 `INVALID_CREDENTIALS` for a wrong current password. |

### GitHub sign-in (the frontend's server only)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/auth/oauth2/authorization/github` | 302 to GitHub, plus the signed `oauth2_auth_request` cookie. |
| `GET` | `/auth/oauth2/callback/github` | 200 with a token pair, **202 with a challenge** for an account that needs a second step, or an `OAUTH_*` or `USER_SUSPENDED` error. |

See [GitHub sign-in](#github-sign-in-readers). Both answer 404 `ENDPOINT_NOT_FOUND` while GitHub
sign-in is off, and neither is in the OpenAPI document.

### Admin (`/api/v1/admin`, bearer token)

| Method | Path | Who | Notes |
|---|---|---|---|
| `GET`, `POST` | `/posts` | `ADMIN`, `AUTHOR` | The list is scoped: an `AUTHOR` sees only its own posts. A new post belongs to the caller. |
| `GET`, `PUT`, `DELETE` | `/posts/{id}` | owner or `ADMIN` | `PUT` replaces the post and never touches its cover, series or curated rank. A blank or absent `slug` keeps the current one (it is never re-derived from the title). A slug that another post has, now or as an old slug, gets a numbered suffix (`-2`, `-3`…) rather than a 409. Changing the slug of a post that was ever published keeps the old one as a redirect ([Slug changes](#slug-changes-and-redirects)). A `PUT` that changes the title, excerpt or content may record the previous text as a [revision](#revisions). The response of `PUT`, publish, unpublish and restore carries exactly the stored `updatedAt`. `DELETE` (204) also deletes the cover image, the body images with their bytes, the revisions and the post's old slugs. |
| `POST` | `/posts/{id}/publish`, `/unpublish` | owner or `ADMIN` | |
| `POST` | `/posts/{id}/feature`, `/unfeature` | `ADMIN` | `ADMIN` only since V7a (before: owner or `ADMIN`). `unfeature` also clears the curated rank. |
| `PUT` | `/posts/featured-order` | `ADMIN` | `{"postIds": [...]}`, at most 50: those posts become featured with rank 1..n. Other featured posts stay featured and lose their rank. Returns every featured post in the new order. |
| `POST` | `/posts/{id}/cover` | owner or `ADMIN` | Multipart `file` and optional `altText` (≤ 300). Uploads and attaches in one call; replacing a cover deletes the old image, and the quota counts only the net growth. Returns the post. |
| `PUT` | `/posts/{id}/cover` | owner or `ADMIN` | `{"altText": "..." \| null}`. 404 `MEDIA_NOT_FOUND` when the post has no cover. |
| `DELETE` | `/posts/{id}` | owner or `ADMIN` | 204. An `ADMIN` deletes for good (everything that hangs on the post goes with it). The owner only hides it (V49): `status` `ARCHIVED`, `deleted_at` and `deleted_by` set, every other row kept, the slug still reserved; the owner no longer reaches it (403) and an `ADMIN` can delete it for good or publish it again. |
| `DELETE` | `/posts/{id}/cover` | owner or `ADMIN` | Detaches and deletes the image. Idempotent; 200 with the post. |
| `POST` | `/posts/{id}/images` | owner or `ADMIN` | A [body image](#body-images): multipart `file` and optional `altText` (≤ 300), processed like a cover. 200 with the image (`id`, `fileName`, `width`, `height`, `altText`, `dominantColor`); link it as `/media/<fileName>`. 404 `POST_NOT_FOUND` before any processing. |
| `GET` | `/posts/{id}/images` | owner or `ADMIN` | The post's body images, newest first. Never its cover or a gallery photo. |
| `DELETE` | `/posts/{id}/images/{mediaId}` | owner or `ADMIN` | Deletes the image and its bytes; 200 with the remaining images. 404 `MEDIA_NOT_FOUND` when `mediaId` is not a body image of this post: a cover, a gallery photo, another post's image or one already deleted. |
| `GET` | `/posts/{id}/revisions` | owner or `ADMIN` | `[{"id", "title", "createdAt"}]`, newest first, at most 20 ([Revisions](#revisions)). |
| `GET` | `/posts/{id}/revisions/{revisionId}` | owner or `ADMIN` | `{"id", "title", "excerpt", "content", "createdAt"}`. 404 `REVISION_NOT_FOUND` for an unknown id or a revision of another post. |
| `POST` | `/posts/{id}/revisions/{revisionId}/restore` | owner or `ADMIN` | Records the current text as a revision, then puts the revision's title, excerpt and content back; slug, status and taxonomy stay. 200 with the post. Errors as for `GET`. |
| `GET`, `POST` | `/categories`, `/tags` | `ADMIN`, `AUTHOR` | `GET` lists every category or tag, including those with no post or only drafts, which the public lists leave out. |
| `PUT`, `DELETE` | `/categories/{id}` | `ADMIN` | `PUT` `{"name", "description"}` renames and replaces the description (blank or absent clears it); the slug never changes. A name equal to another category's ignoring case is 409 `CATEGORY_ALREADY_EXISTS`. `DELETE` (204) only when no post uses the category, drafts included: otherwise 409 `CATEGORY_IN_USE`, whose message gives the count; [merge](#merging-tags-and-categories) it instead. |
| `POST` | `/categories/{id}/merge` | `ADMIN` | `{"targetId"}`: moves every post, any status, to that category, then deletes this one. 200 `{"target": <category>, "moved": <posts moved>}`. |
| `PUT`, `DELETE` | `/tags/{id}` | `ADMIN` | `PUT` `{"name"}` renames; the slug never changes; 409 `TAG_ALREADY_EXISTS` on a clash ignoring case. `DELETE` (204) detaches the tag from every post; the posts stay, `updatedAt` included. |
| `POST` | `/tags/{id}/merge` | `ADMIN` | `{"targetId"}`: every post with this tag gets that tag (once), then this tag is deleted. 200 `{"target": <tag>, "moved": <posts that had this tag>}`. |
| `GET`, `POST` | `/series` | `ADMIN` | `{"title", "slug", "description"}`; a title equal to another one ignoring case is 409 `SERIES_ALREADY_EXISTS`. |
| `GET`, `PUT`, `DELETE` | `/series/{id}` | `ADMIN` | `GET` includes every member post, any status, with its position. `DELETE` (204) detaches the posts first; they stay. |
| `PUT` | `/series/{id}/posts` | `ADMIN` | `{"postIds": [...]}`, at most 100, no duplicates. Positions become 1..n in list order, and a post in another series moves here. A post that stays keeps the part its author declared (`posts.series_part`, V41); a post that leaves, or comes from another series, has none. The other way to write membership is the post import (`SeriesService.placeByPart`, ADMIN files only). Both take the translation-writes lock first. |
| `GET`, `POST` | `/gallery` | `ADMIN` | `GET` returns every photo, unpaged, with admin-only fields. `POST` (201) is multipart: `file`, `caption` (≤ 1000), `altText` (≤ 300), `takenOn` (`yyyy-MM-dd`, defaults to the EXIF date), `published` (default true). A new photo goes first. |
| `PUT`, `DELETE` | `/gallery/{id}` | `ADMIN` | `PUT` replaces caption, alt text, date and visibility. `DELETE` (204) deletes the image with it. |
| `PUT` | `/gallery/order` | `ADMIN` | `{"photoIds": [...]}` must be a permutation of every photo (400 otherwise); order becomes 1..n. |
| `GET` | `/media/usage` | `ADMIN` | `{"usedBytes", "maxBytes", "count"}`: the bytes the quota is checked against (covers, gallery photos and body images together), the quota (`MEDIA_MAX_TOTAL_SIZE`) and the number of images. |
| `GET` | `/comments` | `ADMIN` | Every comment on every post, any status, newest first. Each row has its post (id, slug, title, status, never the post's content) and its author (id, display name, GitHub login, avatar, role, status, no email). `status` filters, `postId` keeps one post's comments (in the page and in the totals; an id that is no post gives an empty page, a value that is not a UUID is 400), `q` searches the content, GitHub login and display name ignoring case, `page`, `size` (default 20, clamped to 1–100). Deleted comments keep their content here. |
| `PATCH` | `/comments/{id}/status` | `ADMIN` | `{"status": "HIDDEN"}` hides, `{"status": "VISIBLE"}` restores; asking for the current status again is a no-op 200. Returns the comment as the list shows it. A deleted comment is 409 `RESOURCE_CONFLICT` (deleted is final), `DELETED` in the body is 400 (use `DELETE`), an unknown id 404 `COMMENT_NOT_FOUND`. Moderation also works on comments of unpublished posts. |
| `DELETE` | `/comments/{id}` | `ADMIN` | Soft delete of a visible or hidden comment, 204, and 204 again when it is already deleted; 404 `COMMENT_NOT_FOUND` for an unknown id. |
| `GET` | `/users` | `ADMIN` | Accounts, newest first: id, display name, GitHub login, avatar, role, status, creation and last GitHub sign-in. Never the email, password hash or GitHub id. `q` (GitHub login or display name, never email), `role`, `status`, `page`, `size` (default 20, clamped to 1–100). |
| `PATCH` | `/users/{id}/status` | `ADMIN` | `{"status": "SUSPENDED"}` or `{"status": "ACTIVE"}`, see [Suspension](#suspension). Returns the account. 409 `USER_NOT_SUSPENDABLE` for an `ADMIN`, an `AUTHOR` or yourself, 404 `USER_NOT_FOUND`. Any other field, `role` included, is ignored. |
| `POST` | `/users/{id}/mfa/reset` | `ADMIN` | `{"code"}`: the administrator's own code, and a sign-in from the last 10 minutes. Deletes the enrollment and recovery codes of an `AUTHOR` and ends the author's sessions; 204. 403 `FORBIDDEN` for another `ADMIN` (the server owner's job: [Security](../docs/SECURITY.md#when-the-phone-or-the-codes-are-lost)), 404 `USER_NOT_FOUND` for a reader or an unknown id. |
| `PATCH` | `/users/{id}/role` | `ADMIN` | `{"role": "ADMIN"}`, `"AUTHOR"` or `"USER"`, your own account included; see [Roles](#roles). Returns the account, like `PATCH …/status`; the current role again is a no-op 200. 400 `VALIDATION_ERROR` for a missing or unknown role, 403 when the caller is no longer an active `ADMIN`, 404 `USER_NOT_FOUND`, 409 `LAST_ADMIN`, `SITE_OWNER_PROTECTED` or `ROLE_TARGET_SUSPENDED`, 429 `RATE_LIMITED` (`role-change`). A change to or from `ADMIN`, or one that makes a reader an `AUTHOR`, is a step-up: the body also carries the caller's own `code` (an authenticator code or a recovery code), and the call needs a sign-in from the last 10 minutes: 401 `REAUTHENTICATION_REQUIRED` (first), 401 `MFA_CODE_INVALID` (also when `code` is missing), 429 `MFA_RATE_LIMITED`, 403 `MFA_FROZEN`. A promotion to `ADMIN` deletes the account's two-step enrollment. |
| `GET` | `/author-applications` | `ADMIN` | Applications with their applicant: id, display name, GitHub login, avatar, current role and status; never an email. `status` (default `PENDING`, oldest first; decided ones most recently decided first; an unknown value is 400), `page`, `size` (default 20, clamped to 1–100). |
| `POST` | `/author-applications/{id}/approve` | `ADMIN` | Makes the applicant an `AUTHOR` through the same role change as `PATCH /users/{id}/role`, then marks the application `APPROVED`; an applicant already `AUTHOR` or `ADMIN` keeps that role. Counts against the `role-change` limit. Approving an approved application is a no-op 200. 403 `FORBIDDEN` for your own application, 404 `AUTHOR_APPLICATION_NOT_FOUND`, 409 `AUTHOR_APPLICATION_DECIDED` for a rejected one, 409 `ROLE_TARGET_SUSPENDED` for a suspended applicant. Promoting a reader is a step-up like the role change: the optional body `{"code": …}` carries the caller's own code, with the same 401/403/429 answers; an applicant who already has the role needs none. |
| `POST` | `/author-applications/{id}/reject` | `ADMIN` | Changes no role; the applicant may apply again 30 days after the decision. Rejecting a rejected application is a no-op 200. 404 `AUTHOR_APPLICATION_NOT_FOUND`, 409 `AUTHOR_APPLICATION_DECIDED` for an approved one. Not rate limited. |
| `GET` | `/analytics` | `ADMIN`, `AUTHOR` | View report (V7c, [Analytics](#analytics)). `from`, `to`: `YYYY-MM-DD`, optional; `to` defaults to today and `from` to 30 days ending at `to`, in `ANALYTICS_TIME_ZONE`. 400 `VALIDATION_ERROR` for a malformed date, `from` after `to`, more than 366 days (both ends included) or `to` after today. Scoped in the SQL: an `ADMIN` sees the whole site, an `AUTHOR` only its own posts, any status. |
| `GET` | `/newsletter` | `ADMIN` | Counts only, never an address (V7c): `subscribers` (`pending`, `confirmed`), `suppressed`, the 10 latest `issues` (`postId`, `slug`, `title`, `createdAt`, `status` `PENDING`, `EXPANDED`, `HELD` or `DISCARDED`, and delivery counts `sent`, `retrying`, `dead`, `pending`), `failures` (`reason`, `count`) over retrying and dead deliveries. |
| `GET` | `/newsletter/held` | `ADMIN` | The newsletters waiting for an administrator (V48), oldest first, at most 100: `postId`, `slug`, `title` and `excerpt` as the mail would carry them, `language`, `authorName`, `heldAt`, `published`, `recipients` (confirmed subscribers of the post language), `version` (stands for the text shown; send it back with the release). Never an address. |
| `POST` | `/newsletter/issues/{postId}/release` | `ADMIN` | `{"version"}`: the `version` that the held list returned for the post. 204. `HELD` to `PENDING`, storing the subject, excerpt and language shown now; the worker mails them to the subscribers of that language. 400 `VALIDATION_ERROR` without a version, 404 `NEWSLETTER_ISSUE_NOT_FOUND` when the issue is not held, 409 `NEWSLETTER_ISSUE_CHANGED` when the post changed (address, subject, excerpt or language) after the list was loaded: nothing is released. |
| `POST` | `/newsletter/issues/{postId}/discard` | `ADMIN` | 204. `HELD` to `DISCARDED`: kept as a record, never mailed. Same 404. |
| `POST` | `/search/reindex` | `ADMIN` | Rebuilds the search index; `dryRun` defaults to `true` (counts only). See [Search with Meilisearch](#search-with-meilisearch). |
| `GET` | `/search/status` | `ADMIN` | Search engine, index and sync status; never a key or a URL. Same section. |

Moderation and a reader's own edits never overwrite each other. Every status or content change
is a conditional `UPDATE`, and its row count decides the answer: a comment hidden while its
author was editing it stays hidden, and the edit gets 404.

An image upload (cover, body image or gallery) fails with 400 `VALIDATION_ERROR` (no file,
empty file), 413 `MEDIA_TOO_LARGE`, 415 `MEDIA_UNSUPPORTED_TYPE` (anything but JPEG, PNG or WebP
by magic bytes), 422 `MEDIA_UNREADABLE`, `MEDIA_DIMENSIONS_TOO_LARGE` or `MEDIA_QUOTA_EXCEEDED`,
or 503 `MEDIA_BUSY` (one image is processed at a time; the next waits up to 20 s). A failed upload
stores nothing and leaves an existing cover in place.

## Setup, site content, import and sample content

First-run setup and everything "about one person" are documented in [docs/CONVENTIONS.md](../docs/CONVENTIONS.md), section 6, and
the user view is in [docs/FIRST-RUN.md](../docs/FIRST-RUN.md) and [docs/ADMIN-GUIDE.md](../docs/ADMIN-GUIDE.md). The endpoints:

| Method | Path | Who | Notes |
|---|---|---|---|
| `GET` | `/setup/status` | anyone | `{"setupRequired": true or false}`. |
| `POST` | `/setup` | anyone with the code | Body `{"setupCode", "email", "password", "displayName"}` (email at most 120 characters; password 12 to 128; name at most 60). 201 `{"completed": true}`. 429 `RATE_LIMITED` (5 attempts per minute from one client address, then 10 per minute for the whole process, every attempt counted), 404 `SETUP_CLOSED` (already claimed), 403 `SETUP_CODE_INVALID`, 400 `VALIDATION_ERROR` (checked only after the code is right). Never logs or echoes the code or the password. |
| `GET` | `/site-content?locale=` | anyone | The site content of one language: the row of the locale, else the default locale, else the key is absent. Only payloads, no ids or timestamps. An unknown or disabled locale is 400. |
| `GET` | `/admin/site-content?locale=` | `ADMIN` | Every key of the locale, with its stored version. |
| `GET`, `PUT` | `/admin/site-content/{key}?locale=` | `ADMIN` | One section. Keys: `site`, `profile`, `about` (with an optional Markdown `body` of at most 20,000 characters, rendered on `/about` with the article blocks), `skills`, `now`, `timeline`, `contact`, `blogroll`, `case_studies`. Validated by the typed records in `com.blog.sitecontent.schema`; unknown properties, control characters, over-long text and URLs other than `https://` or `mailto:` are 400. |
| `GET` | `/admin/site-content/{key}/revisions?locale=` | `ADMIN` | The last 10 versions of the key and locale. |
| `POST` | `/admin/site-content/{key}/revisions/{id}/restore?locale=` | `ADMIN` | Restores one version (recorded as a new revision). |
| `GET`, `POST` | `/admin/site-content/export`, `/admin/site-content/import` | `ADMIN` | JSON document of the whole locale, not wrapped in the envelope, so it imports as it is. |
| `POST` | `/admin/site-content/avatar` | `ADMIN` | One image (`file`) through the media pipeline; creates no gallery photo. 201. |
| `GET` | `/admin/site-import/template?locale=`, `/admin/site-import/export?locale=&format=` | `ADMIN` | The Markdown template, and the current content as a Markdown file (`format=md`, the default) or as a ZIP package (`format=zip`: `profile.md` plus every site image the content uses under `assets/`: the About photo, the body images and the timeline logos), both in the format of [docs/site-profile-format.md](../docs/site-profile-format.md); the `# About page` section carries the About body verbatim as Markdown. The ZIP imports back unchanged on the same site and restores the content and the images on a clean one. |
| `POST` | `/admin/site-import/preview` | `ADMIN` | Multipart `file`: a `.md` (at most 256 KiB) or a `.zip` package (the same file plus images under `assets/`, same archive rules as a post package; 4 MiB at most). Parses and validates; writes nothing. Returns the SHA-256 of the file and, for a package, `pack` (its entries and images) and `notes` (images nothing uses). |
| `POST` | `/admin/site-import/apply` | `ADMIN` | Multipart `file` (`.md` or `.zip`), `sha256` (must equal the previewed one), `mode` (`create-only` or `update`), `sections`. The images of a package (the About photo, the About page body images and the timeline logos) are processed first, then stored with the content in one transaction under an advisory lock; previous versions become revisions. A missing or empty value never deletes; list parts replace the whole list. |
| `POST` | `/admin/site-import/undo?importId=` | `ADMIN` | Restores the previous versions of that import unless a section changed since (409). |
| `GET` | `/admin/site-import/status` | `ADMIN` | The last import and whether it can be undone. |
| `POST` | `/admin/sample-content` | `ADMIN` | Loads the packaged sample posts, series, category and tags (`backend/src/main/resources/sample-content/`) in one transaction. Idempotent. Returns `{"posts", "series", "categories", "tags", "skipped"}`: what this call created, and the items that already existed (posts matched by slug, the rest by name ignoring case). Posts are published and belong to the caller. AUTHOR: 403; anonymous: 401. |

Site content, import and sample-content writes are rate limited per admin (60 per 10 minutes for site content). The import log keeps
hashes and counts, never content. A direct API write shows on public pages after the frontend's 300-second revalidation window;
the admin's own server actions clear the `site-content` cache tag at once.

### Post import

Importing posts from Markdown files is for `ADMIN` and `AUTHOR` (`/api/v1/admin/post-import/**` is one of the five trees an author
may enter; a reader account gets 403, an anonymous caller 401). Nothing is written by a preview. The importer never publishes. Every
answer that is an error, every problem message and every log line holds no text from a file (a file is named by its position in the
upload, a key by its name in the format, a place by a line number).
Each apply that writes is logged in `post_import_log` (migration V40): who, when, the number, sizes and SHA-256 hashes of the files and one item per post (action, post id, previous revision, category and tag ids, hash of the written state, whether a link was created, the series the post joined and whether the import created it, and the series, position and part it had before: ids and numbers, no name). Identifiers, hashes and counts only, never text of a file or a post. The residual SQL-error log of the driver or the ORM may still print detail for a constraint violation, as for the editor.

| Method | Path | Who | Notes |
|---|---|---|---|
| `GET` | `/admin/post-import/template?language=` | `ADMIN`, `AUTHOR` | The template for one language (default: the site default) as a Markdown attachment: instructions for an AI assistant, every key annotated, and a neutral example post from the packaged sample posts. Not rate limited. |
| `POST` | `/admin/post-import/preview` | `ADMIN`, `AUTHOR` | Multipart, one `file` part per post file: at most 20 files, 256 KiB each, 4 MiB in total. A file is a `.md` post file or a `.zip` [package](#zip-packages) (an article and its images, at most 4 MiB). Parses and checks every file and answers per file, in upload order: name, size, SHA-256, final slug (and its source when it is not the `slug` key), language, state (`new`, `will_change`, `unchanged`, `error`), changes (title, description, category, tags and, for an administrator's file with series keys, `series` and `seriesPart` as before and after), notes, the categories, tags and series (`newSeries`, ADMIN only) that would be created, problems (position, key, line, no values), ignored keys, for a package its `pkg` facts (`entries`, `assets`, `assetBytes`, `usedAssets`, `unusedAssets`, `unsupportedItems`; the `asset_unused` note names each image the article does not use) and an opaque preview `state` (for an update: the post id, its status and the hash of its stored fields; a published post also gets the note `published_goes_live`; a file with a `translation_of` key gets the note `translation_of_ignored`, because the link is not made yet; a package with a `cover` key counts the cover as a used image and gets `cover_will_be_set` or `cover_will_be_replaced`, and `cover` in a plain `.md` file, a cover that is not in the package or is not a supported image is a problem; the preview state of an update covers the stored cover). A package that cannot be read is an `error` card with its one problem, not a failed request. A file whose final slug is the current slug of a post the caller may manage (an admin: any post; an author: own posts) is `will_change` or `unchanged` (every value it supplies equals the stored one in the normal form of the download); the slug of someone else's post is the same "slug not available" error as an old slug, and a `language` that differs from the post's is an error. Writes nothing. More than 20 files, a missing file part, a wrong name, an empty file, invalid UTF-8 or a control character is 400 `POST_IMPORT_INVALID_FILE` (the message names the file by position); a file or a total over its cap is 413 `VALIDATION_ERROR`; 429 `RATE_LIMITED` over the [limit](#rate-limits). |
| `POST` | `/admin/post-import/apply` | `ADMIN`, `AUTHOR` | Multipart: one `file` part per post file (at most 20, in the order of the preview) and exactly one text part `manifest`, a JSON array with one item per file in upload order: `{"sha256", "selected", "state"}` (the hash and the opaque `state` of the preview, whether the file is ticked). At most 21 parts. Re-reads and re-parses every file and compares the hashes, prepares the images that the selected packages use (decoded, resized and re-encoded by the media pipeline, BEFORE the transaction), then in ONE transaction takes the translation-writes lock, then an import-wide lock, and plans from what it reads under them. Creates the selected new files as **drafts owned by the caller** through the post service and updates the selected files that match a post the caller may manage, with the stored value for every key the file leaves out or supplies equal (the post service update replaces the whole post); the language, status, author, slug, cover and `featured` never change. An ADMIN's file with the `series`, `series_part` and `series_description` keys also creates the series by name (resolved by slug or title, once per name, at most 10 per import) and puts the post at its declared part with `SeriesService.placeByPart`, under the series row lock taken after the import-wide lock and before the post rows. A `series_description` creates the series with it or, through `SeriesService.fillDescriptionIfEmpty` (same row lock, search documents queued), fills the EMPTY description of a series that exists: the first file to give one wins in an import, a description that has text is never overwritten (note `series_description_ignored`; `series_description_will_be_set` when it will be filled), an empty value writes nothing, and a post that keeps its place with a file that only gives the description is a change; an AUTHOR's series keys are ignored with the note `series_ignored_author` and nothing about series is read; a part already held in the same series and language is a problem, and a series-only change writes no revision ([post-file-format.md](../docs/post-file-format.md#series)). When the title, description or content changes, the replaced text is first recorded as a revision that the ten-minute merging cannot swallow (`PostRevisionService.recordCurrent`) and its id is logged (null for a category-only or tags-only change). Categories and tags that do not exist are created once each, in file order. For a package, each image the article uses is stored as an image of the post (`MediaService.persistForPost`, so it counts against the media quota and goes with the post) and the references in the body (Markdown images and links, link definitions, the `src` of a `figure`) become `/media/<id>.<ext>#<width>x<height>`; an image of the post with the same bytes is reused, an unused image is not stored, the block syntax of the body is kept as written. All or nothing, the images included. Answers per file `created` or `updated` (with the post id and slug), `unchanged` (nothing written, no revision, no log row) or `skipped`, the counts, and the `importId` (null when nothing was written). A selected file with a problem is 400 `POST_IMPORT_INVALID` (positions, keys and line numbers only); a hash that is not the previewed one is 409 `POST_IMPORT_HASH_MISMATCH`; a selected file that is not as the preview showed it (a slug taken since, a post edited or published since the preview, or no preview state while it would be written; a file that is now unchanged is not a conflict) is 409 `POST_IMPORT_PREVIEW_OUT_OF_DATE` (a count only); an image that cannot be read is a problem of its file (400 `POST_IMPORT_INVALID`, the entry named by position); the cover image of a package is prepared with the others, then stored through `PostCoverService.replace` (the editor's upload path) as the cover of the new post, or in place of the cover of the existing one, whose old image is deleted; a full media quota is 422 `POST_IMPORT_MEDIA_QUOTA_EXCEEDED` and a busy image pipeline 503 `POST_IMPORT_MEDIA_BUSY` (both name the file and the entry by position); a missing or malformed manifest is 400 `POST_IMPORT_INVALID_FILE`; limits as for the preview; 429 `RATE_LIMITED` over the [limit](#rate-limits). No message of the post, category or tag services and no database detail reaches the caller or a log line. |
| `POST` | `/admin/post-import/article-preview` | `ADMIN`, `AUTHOR` | Multipart, ONE `file` part (a `.md` file or a `.zip` package). The article as its uploader will see it, to render it before an import: `fileName`, the front matter values the header needs (`title`, `excerpt`, `category`, `tags`, `language`, `slug`), the `body` exactly as written (null when the file cannot be read), `bodyLine` (the line of the file where the body starts), `assets` (the images of a package that the body uses, as uploaded: `path`, `contentType`, `base64`, `width`, `height` from the header), the package facts `pkg`, and the `problems` of the file as the preview lists them. Writes and stores nothing. Counts as one use of its own [bucket](#rate-limits) (`article-preview`, 300 per 10 minutes), apart from the preview, apply and undo bucket, because the import page calls it once per importable file. Like a success answer of the preview it may hold text of the file, for the caller only; no log line does. 400 `POST_IMPORT_INVALID_FILE` without a file; limits and 429 as for the preview. |
| `GET` | `/admin/post-import/status` | `ADMIN`, `AUTHOR` | The caller's own latest import (never anybody else's): id, time, number of files, posts created and updated, whether it was undone and whether it can be undone now (always `false` until the undo exists). `lastImport` is null when the caller never imported. |
| `GET` | `/admin/posts/{id}/export` | `ADMIN` (any post), `AUTHOR` (own posts) | The saved post (a draft too) as a [ZIP package](../docs/post-file-format.md#round-trip-with-download-zip) that the post import reads back as the same post: `application/zip`, `Content-Disposition: attachment` named `<slug>.zip` (ASCII), `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`. The same rule as every route that names a post (`@PreAuthorize` with `AdminPostController.CAN_MANAGE`: 403 for another author or a reader, 404 for an `ADMIN` when the post does not exist, 403 for an `AUTHOR`, 401 anonymous). `article.md` (the keys of `PostMarkdownWriter`, plus `series`, `series_part` and `series_description` when the post is in a series at a declared part, and `cover` and `cover_alt` when the post has a cover), the stored cover under `assets/` (`assets/cover-1.png`, the real format extension) and the site images of the body under `assets/` (`PostPackageWriter`, `PostExportService`): the references the import resolves (Markdown images and links, link definitions, the `src` of a `figure`) are rewritten to `assets/<ASCII name>`, a `/media/` path in code is left as written, and an image that is missing, not JPEG/PNG/WebP or over the package limits keeps its original reference. Deterministic bytes. A post whose article is over 256 KiB or whose package would be over 4 MiB is 413 `POST_EXPORT_TOO_LARGE` with one fixed sentence. No title, slug or image name is logged. |

#### ZIP packages

A package is one `.zip` with exactly one Markdown article (`.md`, at the top level or in the one top-level folder, in the post file format) and its images under `assets/` (JPEG, PNG or WebP by their magic bytes: SVG and any other format are a problem that names the supported ones). A file is a package when its name ends in `.zip`, or when it is not named `.md` and starts with the ZIP magic bytes. The article refers to an image by its path relative to the article, in a Markdown image or link, a link definition, the `src` of a `figure` or the images of a `gallery`; fenced and inline code are skipped, and raw HTML `<img>` does not count, so an image used only there is unused. When the name of the package stands in for a missing `slug`, `a.zip` counts as `a.md`.

The reader (`PostPackageReader`) uses `java.util.zip` only and trusts nothing the archive declares: it reads the central directory by hand and streams the entries, with bounded reads. Limits (`PostFileLimits`): 4 MiB per package, 40 entries, 256 KiB for the article, 4 MiB per image, 16 MiB unpacked in all packages of one request, a compression ratio of at most 100. Refused: absolute paths, `..` and `.` segments, backslashes, drive letters, control characters and NUL, names that are not UTF-8, duplicate names (also after NFC and case folding), symbolic links and special files, encrypted entries, ZIP64 and multi-part archives, archives inside a package, an entry that does not match the central directory, a truncated archive. Folders and the noise of file managers (`__MACOSX`, `.DS_Store`) are skipped; any other file outside `assets/` is a problem. Every message names an entry by its position and never holds a name or text of the archive.

Problems of a package (a preview card, an article preview, a refused apply): an image the article names that is not in the package (the line, and for the uploader's preview the path as written, cut to 200 characters; the refusal of an apply names the line only, because the error handler logs it), unsafe content outside code (`<script`, `<style`, `<iframe`, `<object`, `<embed`, `javascript:` URLs, inline event handlers) and the unusable entries above. The unsafe-content check is a best-effort lint over lines, not a security boundary: it does not parse Markdown or HTML, a determined author can write around it, and a plain `.md` file is not checked at all. What keeps a post safe is the sanitizing schema of the renderer (`rehype-sanitize`), which cleans every post when it is rendered, whatever its source. Unused images are notes. The decoding of the images happens at the apply, so a damaged image is a problem of the apply, not of the preview.

## Editorial tools

Added in V6 (migrations V25 and V26). All of them sit behind the rules of the table above: body
images and revisions follow the post (owner or `ADMIN`), merging and storage usage are
`ADMIN`-only.

### Body images

`POST /api/v1/admin/posts/{id}/images` uploads an image for the post's body. It goes through the
cover pipeline (JPEG, PNG or WebP in; re-encoded JPEG or PNG out, longest edge 2400 px, EXIF and
GPS gone) and is served like any image, at `/api/v1/media/<id>.<jpg|png>`, unlisted rather than
private. The backend inserts nothing into the post: the editor writes
`![alt text](/media/<fileName>)` into the Markdown.

- **Ownership.** The image belongs to the post it was uploaded to (`media.post_id`, V25; covers and
  gallery photos keep `post_id` empty). It is listed with the post and can be deleted only through
  it, so the delete endpoint can never reach a cover or a gallery photo.
- **Quota.** One quota for every image: a body image counts against `MEDIA_MAX_TOTAL_SIZE` exactly
  like a cover or a gallery photo, and `GET /api/v1/admin/media/usage` shows the total.
- **Cleanup.** Deleting the post deletes its body images and their bytes in the same statement
  (`ON DELETE CASCADE` from `posts` to `media`, then to `media_content`). Nothing else removes
  them: an image taken out of the text stays, and keeps counting against the quota, until it is
  deleted through the post. The backend does not parse Markdown, so it cannot tell which images
  the text still uses; deleting one the text links to breaks that image in the post, and a
  revision or a copy of the post that links to an image of another post loses it when that post
  is deleted.

### Revisions

A minimal history of a post's text, to undo a bad edit, not version control: no diffs, no
branches, and only the title, excerpt and content (`post_revisions`, V26).

- **When.** A `PUT /api/v1/admin/posts/{id}` that changes the title, excerpt or content records
  the text as it was *before* that save. Saves that change only the slug, category or tags, and
  publish, unpublish, feature, series membership and covers, record nothing. A save that fails
  (unknown category or tag) records nothing either.
- **Coalescing.** When the post already has a revision from the last 10 minutes, a save records
  nothing: a writing session that saves ten times leaves one revision, not ten near-copies. At
  most those 10 minutes of work have no revision of their own; the editor's local autosave covers
  them.
- **Limit.** The newest 20 revisions of each post are kept; older ones are deleted in the same
  transaction. Deleting the post deletes its revisions.
- **Restore.** `POST …/revisions/{revisionId}/restore` first records the current text as a
  revision, whatever the 10-minute rule says, so restoring that new revision undoes the restore;
  then it puts the old title, excerpt and content back and answers the post. Slug, status,
  publication date, category, tags, series and cover stay. When the post already has exactly that
  text, nothing changes. `createdAt` of a revision is when that text was replaced; `created_by`
  (not exposed) is who saved or restored.

### Merging tags and categories

`POST /api/v1/admin/tags/{id}/merge` and `POST /api/v1/admin/categories/{id}/merge`, with
`{"targetId": "<uuid>"}`, `ADMIN` only.

- **Tags.** Every post carrying the tag in the path, in any status, gets the target tag (a post
  that already had both keeps one), then the source tag is deleted. `moved` counts the posts that
  carried the source tag.
- **Categories.** Every post of the source category, drafts included, moves to the target; the
  source, now empty, is deleted. This is the way out for a category that `DELETE` refuses with 409
  `CATEGORY_IN_USE`. `moved` counts the posts moved.
- **Untouched.** No post's `updatedAt`, status or publication date changes: like deleting a tag,
  this is curation, not an edit, and the statements bypass the post entity.
- **Errors.** The same id as source and target is 400 `VALIDATION_ERROR`; an unknown target 400
  `TAG_NOT_FOUND` or `CATEGORY_NOT_FOUND` (it comes from the body); an unknown source 404 with the
  same code. The source's public URL (`/tags/{slug}`, `/categories/{slug}`) becomes a 404 like any
  deleted one; no redirect to the target is recorded.
- **Concurrency.** Both rows are locked `FOR UPDATE`, in id order: two opposite merges cannot
  deadlock, and a post saved with the source at that moment either commits first and is moved, or
  waits and then fails on the foreign key because the source is gone.

### Storage usage and the moderation filter

`GET /api/v1/admin/media/usage` (`ADMIN`) answers `usedBytes`, `maxBytes` and `count`: the sum the
quota is checked against when an image is stored, the configured quota, and the number of images,
so the admin can see the ceiling coming. `GET /api/v1/admin/comments?postId=<uuid>` limits the
moderation list, and its totals, to one post's comments; it combines with `status` and `q`.

`PostStatus.ARCHIVED` stays in the enum but is reserved: nothing in the application assigns it,
and the admin UI no longer offers it. A row that carries it (written with SQL) is never shown on a
public page, which every public query filters on `PUBLISHED`.

## Search

`GET /api/v1/posts/search` is PostgreSQL full-text search over the title, excerpt and body of
published posts; there is no search service. Since V6 (migration V23) it ignores case and
Vietnamese diacritics on both sides: `hoc` finds h&#x1ECD;c, `duong` finds &#x110;&#x1B0;&#x1EDD;ng, and H&#x1ECC;C, h&#x1ECD;c
and `hoc` are the same query. Decomposed Unicode (NFD: a letter followed by separate combining
marks, as macOS and text copied from some PDFs produce) matches too, in the query and in a post.

- **How.** V23 creates the `unaccent` extension and a text search configuration, `vi_unaccent`:
  PostgreSQL's `simple` configuration (lowercase, no stemming, no stop words) with the `unaccent`
  dictionary in front of it for every kind of word that can hold a non-ASCII letter. The generated
  `search_vector` column and every query use it. The query goes through `plainto_tsquery`: the
  words are ANDed, punctuation is ignored, and nothing a reader types is a syntax error. Ranking
  is unchanged: `ts_rank` without per-field weights, then newest first, then (since V7b) the id, so
  pages never repeat or skip a post when rank and date tie.
- **Filters (V7b).** `category` and `series` take one slug each; `tag` is repeatable (Spring also
  splits `a,b`), blanks and duplicates dropped, at most 5 different (400 beyond). Different kinds are
  ANDed, and so are several tags: a post must carry all of them. A post has one category and at most
  one series, so a repeated `category` or `series` matches nothing. An unknown slug is an empty page;
  a malformed one (not lowercase letters and digits in hyphen-separated runs, or over 255
  characters) is an empty page answered without a query. Filters without `q` list the matches newest
  first. The SQL is assembled from fixed fragments for the conditions present, every value bound, and
  the page and count queries share one `WHERE`.
- **Input (V7b).** `q` is cleaned like a comment (NUL, other control, zero-width and bidi characters
  removed; trimmed); longer than 200 characters after that is 400 `VALIDATION_ERROR`. Before V7b a
  NUL reached PostgreSQL and answered 409.
- **Code in posts.** The body's Markdown, fenced code included, is in the vector, within what the
  tokenizer does, pinned by `PostSearchAndFeaturedIT`: a dotted identifier is one token
  (`json.loads` finds it, `loads` does not), `snake_case` splits at `_`, `C++` and `C#` both become
  `c`, `maxReceiveCount` is one lowercase token, and there is no substring match.
- **Blocks in posts (known limit).** The Meilisearch document text (`MarkdownText`) and the reading time (`PostMapper`) leave out the
  marker lines of article blocks (`:::callout{...}`, `:::`) and the source of a `diagram` block, and keep the text of the blocks
  (`BlockMarkers`). The default PostgreSQL search does not: its generated `search_vector` (V23, never edited) is built from the raw
  title, excerpt and body, so the syntax of blocks (a block name such as `callout` or `mermaid`, an attribute value, a diagram source,
  the `/media/<id>.<ext>#<width>x<height>` URL of an image) is indexed and ranked like the other raw Markdown of a post (link
  addresses, fence languages, HTML). A word that only appears in block syntax can therefore find a post on the default engine. Making
  the vector ignore it would need a new migration that rewrites the table and its index, and a second copy of the `BlockMarkers`
  rules in SQL; that is not done, and a separate change would have to decide it.
- **Trade-off.** Vietnamese words that differ only by their marks become one word: `ban` finds
  b&aacute;n, b&agrave;n and b&#x1EA1;n. A query typed with diacritics is folded the same way, so it cannot narrow
  that down; ranking still puts the posts with the most matches first. That is the price of finding
  h&#x1ECD;c from `hoc`, the way most readers type.
- **The `unaccent` extension is required.** It ships with PostgreSQL (contrib) and has been
  "trusted" since PostgreSQL 13, so the owner of the database can create it without a superuser;
  V23 runs `CREATE EXTENSION IF NOT EXISTS unaccent`. The `postgres:18` image of the compose files
  and of the tests has it. A managed provider must allow it; the common ones (Neon, Supabase,
  Amazon RDS, Cloud SQL) list it. Where it is not allowed, V23 fails on its first statement,
  changes nothing, and the backend does not start.
- **Index.** The GIN index `idx_posts_search_vector` is rebuilt on the new column. With a few
  dozen posts the planner rightly leaves it alone (a sequential scan, or the `(status,
  published_at)` index plus a filter, is cheaper); `PostSearchAndFeaturedIT` checks with `EXPLAIN`
  that it still serves a `@@` match with the new configuration, for when the table grows. No other
  search index ([Indexes](#indexes) lists the two taxonomy ones). V7b's filters added none either: on
  2,000 synthetic posts in a rolled-back transaction, `EXPLAIN ANALYZE` showed category + `q` on
  `idx_posts_category_id`, two tags on `idx_post_tags_tag_id` and `posts_pkey`, a series alone on
  `uq_posts_series_position`, and no sequential scan of `posts` for the page or the count query.
  `PostSearchAndFeaturedIT` re-runs those shapes on synthetic data and fails on a sequential scan of
  `posts`.
- **After a major PostgreSQL upgrade with `pg_upgrade`**, recompute the stored vectors, which were
  computed with the old version's `unaccent.rules`: `UPDATE posts SET title = title;`. A dump and
  restore needs nothing: generated columns are recomputed on load.

## Search with Meilisearch

V8b. PostgreSQL stays the source of truth and the default engine ([Search](#search)). Meilisearch is a
copy used only for searching (partial words, typo tolerance, excerpts, technical tokens), switched on with
`SEARCH_ENGINE`. Every result it returns is re-checked against PostgreSQL in one query before it is
returned: content that is no longer public never appears, even when the index has not caught up yet.

| Variable | Default | Meaning |
|---|---|---|
| `SEARCH_ENGINE` | `postgres` | `postgres` or `meilisearch`: the engine that answers `GET /api/v1/search`. When Meilisearch fails, the PostgreSQL result is returned with `degraded: true`. |
| `MEILI_URL` | empty | Compose: `http://meilisearch:7700`; dev: `http://127.0.0.1:7700`. Setting it turns indexing on (outbox, worker, reconciliation), even when the engine is `postgres`. |
| `MEILI_MASTER_KEY` | empty | Only in the backend and the `meilisearch` service, never in the frontend. The backend derives two child keys (search, indexing) from it and does not use it for queries. |
| `MEILI_INDEX_NAME` | `content_v1` | The serving index; it must start with `content_`. A reindex builds `<name>_build` and then swaps it in. |
| `app.search.worker-delay` | `10s` | Pause between two runs of the outbox worker. |
| `app.search.reconcile-cron` | `0 23 * * * *` | Reconciliation schedule (minute 23 of every hour); `-` turns it off. |

Startup check: on a public site ([Production checks](#production-checks)) that uses Meilisearch
(`SEARCH_ENGINE=meilisearch` or `MEILI_URL` set), `MEILI_MASTER_KEY` must be present, at least 32 characters
and different from the placeholder in `.env.example`; otherwise the backend does not start.
Compose does not enforce it with `:?` on the `meilisearch` service: compose interpolates the whole file before
filtering profiles, so `:?` would force every `docker compose up`, even one that does not use search, to have a
key. Meilisearch with `MEILI_ENV=production` rejects an empty key or one shorter than 16 bytes by itself. The
backend does not `depends_on` Meilisearch: it starts even when Meilisearch is down, and search is then PostgreSQL.

**Running on a dev machine (optional).** Without `SEARCH_ENGINE`, search is PostgreSQL.

1. Pick a master key (`openssl rand -base64 48`) and start a Meilisearch container bound to loopback, with the settings of
   `docker-compose.yml`:

   ```bash
   docker run -d --name blog-meilisearch-dev -p 127.0.0.1:7700:7700 --memory 512m      -e MEILI_ENV=production -e MEILI_MASTER_KEY=<key> -e MEILI_NO_ANALYTICS=true      -e MEILI_MAX_INDEXING_MEMORY=268435456 -e MEILI_MAX_INDEXING_THREADS=1      -v blog-meilisearch-dev-data:/meili_data getmeili/meilisearch:v1.54.3
   ```

2. Start the backend with `MEILI_MASTER_KEY=<key>` and `MEILI_URL=http://127.0.0.1:7700` in its environment, then, as an ADMIN:
   `POST /api/v1/admin/search/reindex?dryRun=false`.
3. Add `SEARCH_ENGINE=meilisearch` and restart the backend.

Stop it with `docker rm -f blog-meilisearch-dev`; the volume keeps the index, which a reindex rebuilds anyway.

**Delivery guarantee: at least once, eventually consistent, reads fail closed immediately.**

| Part | How |
|---|---|
| Write | Every change to public content writes `search_outbox` (V33) in the same transaction; repeated changes are merged per document. |
| Sync | The worker re-reads the DB, writes or deletes the document, and deletes the row only after the task finishes; retries start at 30 seconds and double, capped at 30 minutes, FAILED on the 10th attempt. A rejected batch is resent document by document. |
| Read | Re-checked against PostgreSQL: unpublishing a post or suspending an author takes effect immediately; stale hits are dropped and counted (`staleHitsDropped`). |
| Reconcile | Compares each document's `contentHash` with PostgreSQL in batches; writes what is missing or different, deletes what is extra; a source that changed while being written is handed back to the outbox; a complete run resolves old FAILED rows. Does nothing when search is not configured or the index does not exist yet. |
| Limit | One backend instance (the maintenance lock and the counters live in memory). There is no "exactly once". |

**Reindex** (`POST /api/v1/admin/search/reindex`, ADMIN only, 3 per 10 minutes per admin, dry runs included). The default is
`dryRun=true`: it only counts and writes nothing (not even a Meilisearch key). `dryRun=false`: records T0; deletes an old
`<index>_build`; creates it with the settings; writes in batches of 200, waiting for each task; compares the document count with
the number written; swaps it with the serving index (a rename when there is none yet), waiting for the task with the indexing
key; deletes the old index; reconciles right away to pick up changes since T0 (the worker had written them to the old index).
When it fails before the swap, the half-built index is deleted and the serving index is untouched. Running it again produces the
same index. The request waits until it is done.

| Field | Meaning |
|---|---|
| `scanned` | Documents read from PostgreSQL and the static content (dry run: counted). |
| `indexed` | Documents written to the new index, plus documents the reconciliation run that follows wrote again. |
| `skipped` | Documents read but not written: all of them in a dry run, 0 in a real run. |
| `deleted` | Documents the reconciliation run after the swap deleted (hidden or removed while the index was being built). |
| `failed` | Documents Meilisearch rejected (ids are in the log). If any, there is no swap. |
| `documentsByType`, `indexDocuments` | Per type; the document count of the serving index (before, for a dry run; after, for a real run). |
| `outboxPending`, `outboxFailed`, `engineError` | The outbox at the time of the answer; dry run: why the index could not be read (`NOT_CONFIGURED`, `INDEX_NOT_FOUND`...). |
| `swapped`, `startedAt`, `finishedAt`, `catchUp` | The new index is serving; T0; end time; the report of the reconciliation run right after. |

Errors: 409 `SEARCH_NOT_CONFIGURED` (a real run without `MEILI_URL` or `MEILI_MASTER_KEY`: a configuration problem, not a
temporary one, so not a 503), 409 `SEARCH_REINDEX_RUNNING` (a reindex or reconciliation is running), 502 `SEARCH_REINDEX_FAILED`
(the message names the step, `PREPARE`, `BUILD`, `COUNT_CHECK` or `SWAP`, and the code), 429 `RATE_LIMITED`.

**Status** (`GET /api/v1/admin/search/status`, ADMIN only; no keys, no URLs, no queries):

| Field | Meaning |
|---|---|
| `engine`, `indexing`, `maintenanceRunning` | The engine that is answering; `MEILI_URL` is set; a reindex or reconciliation is running. |
| `meilisearch` | `configured`, `reachable` (`/health`), `version` (`/version`), `error` (the code of the first failed read). |
| `index` | `name`, `exists`, `documents`, `byType` (the `facetDistribution` of `type`). |
| `database.byType` | PostgreSQL documents under the same visibility rules, to compare with `index.byType`. |
| `outbox` | `pending`, `processing`, `failed`, `oldestPendingAgeSeconds`. |
| `lastReconciliation` | `startedAt`, `finishedAt`, `outcome` (`COMPLETED`, `SKIPPED`, `ABORTED`), `failureCode`, `scanned`, `upserted`, `deleted`, `failed`, `requeued`, `resolvedFailedRows`. |
| `counters` | `degradedRequests`, `lastDegradedAt`, `lastDegradedCode`, `staleHitsDropped`, `deepPageFallbacks`, `outboxSynced`, `outboxFailed`, since startup. |

**Order to switch it on (manual, not automated for production):**

1. Keep `SEARCH_ENGINE=postgres`.
2. Set a real `MEILI_MASTER_KEY` in `.env`, then `docker compose --profile search up -d`.
3. Set `MEILI_URL=http://meilisearch:7700` and restart the backend: indexing is on, search is still PostgreSQL.
4. Reindex as a dry run, then for real; `GET /status`: `index.byType` matches `database.byType` and `outbox.failed` is 0.
5. `SEARCH_ENGINE=meilisearch` in a non-production environment first; check by hand and with the opt-in E2E.
6. Switch it on in production through the deploy procedure; watch `counters.degradedRequests`.

**Rolling back:** `SEARCH_ENGINE=postgres` and restart the backend, nothing else changes (`SearchReindexIT` checks this). If you
keep `MEILI_URL`, the index keeps being updated and switching back on needs no reindex.

**Backups:** not needed. The index is a copy that can be rebuilt from PostgreSQL: restoring means a reindex, and so does losing the `meili_data` volume.

**Runbook**

| Situation | Look at | Do |
|---|---|---|
| Stale results | `outbox.pending`, `oldestPendingAgeSeconds`, `lastReconciliation` | Wait for the worker (seconds) or the reconciliation (hours); if you need it now: reindex. Meanwhile PostgreSQL still blocks content that is no longer public. |
| Missing documents | `index.byType` compared with `database.byType` | The reconciliation repairs it by itself; if you need it now: reindex. Static content changes only on deploy: a reconciliation or reindex picks it up. |
| Index task failed | `outbox.failed`, the `search outbox` log (code), `lastReconciliation.failed` | `INDEX_NOT_FOUND`: no reindex has ever run, run one. `TASK_FAILED`: the log has the id of the rejected document, fix that content. A complete reconciliation run resolves old FAILED rows. |
| Meilisearch is not running | `meilisearch.reachable`, `counters.degradedRequests`, the log (at most one line per minute) | Search has already fallen back to PostgreSQL (`degraded`). `docker compose --profile search up -d meilisearch`; the outbox catches up by itself and the reconciliation resolves FAILED rows. |
| Changing the key | `meilisearch.error` | Change `MEILI_MASTER_KEY` in `.env`, restart `meilisearch`, then the backend. The child keys are an HMAC of the master key, so they change with it; the backend recreates a missing key. If `INVALID_API_KEY` remains: run a reindex (it recreates the key). |
| Upgrading the version | Meilisearch release notes | Change the image tag in `docker-compose.yml` and `MeiliTestContainer`; run the Meilisearch ITs; delete the `meili_data` volume, `up -d`, reindex. Meanwhile search is PostgreSQL. |
| Adding a content type | | Mapper (`SearchDocuments`, `DocType`); settings (`MeiliSettings`, reindex after changing them); outbox hook in every transaction that changes it (`SearchOutbox`, `doc_type` CHECK through a new migration); visibility rule (`SearchDocumentSource`, `SearchVisibility`, PostgreSQL provider); tests (`SearchOutboxIT`, `MeiliSearchIT`, parity); then reindex. |

## Slug changes and redirects

A post's slug changes only when its slug field is edited: correcting the title never moves a
published post. When the slug of a post that was ever published changes (it has a
`publishedAt`, also while unpublished), the old slug is kept in `post_slug_history` (migration
V24), and `GET /api/v1/posts/{old}/redirect` answers `{"data": {"slug": "<current>"}}`. The
frontend asks it when `GET /api/v1/posts/{slug}` is a 404 and redirects permanently, so shared
links and search results survive the change.

- **One hop, no loops.** Each old slug points at the post, not at the next slug: after
  `a → b → c`, both `a` and `b` answer `c`. A post that takes one of its old slugs back makes it
  live again: its row is deleted, and the other old slugs answer it. The endpoint never answers the
  slug it was asked about.
- **Old slugs stay taken.** No other post gets an old slug, on create or on edit: it gets a
  numbered suffix, exactly like a slug in use. Deleting a post deletes its old slugs, which are then
  free again.
- **Only while published.** The endpoint answers only while the post is published. Unpublished or
  archived, every old slug is a 404 like an unknown one, so a draft's current slug never leaks;
  publish it again and the redirects are back.
- **Drafts leave nothing.** Renaming a post that was never published records nothing and reserves
  nothing.
- **Not retroactive.** Slug changes made before V24 were not recorded; those old links stay 404.
- **RSS.** The feed's `<guid>` is the post's URL (`isPermaLink="true"`), so after a slug change a
  feed reader shows the post as a new item, once. That is unchanged on purpose: moving every item to
  another kind of GUID would make every post look new once, and slug changes are rare.

## Analytics

Since V7c (migration V30), every counted view also lands in
`post_view_daily (post_id, day, source, views)`: one row per post, local day and source group, primary key
`(post_id, day, source)`, deleted with the post. `post_views` keeps the all-time total exactly as before, so the "popular" sort and `/stats` do not
change. This revises V16's documented "no per-view data" decision while staying aggregate: no row per view,
no IP, user agent, session or visitor id, referrer URL or host.

- **Write.** `PostViewService.record` increments `post_views`, then, in the same transaction and only when
  that matched a published post, upserts the day row. Locks are taken total first, day second.
- **Day.** `ANALYTICS_TIME_ZONE` (default `Asia/Ho_Chi_Minh`, checked with `ZoneId.of` at startup) applied to
  the application's `Clock` bean, on write and on read; never SQL's `current_date`, since the database
  session runs in UTC. Changing the zone later does not move days already stored.
- **Source.** `X-View-Referrer` (optional, at most 253 characters, set by the Next route from the beacon,
  untrusted) is checked again: ASCII letters, digits, dots and hyphens, labels of 1–63 characters that
  neither start nor end with a hyphen, compared ignoring case. `ViewSourceClassifier` then maps it to
  `internal` (the `SITE_URL` host, with or without `www.`), `search`, `social` or `github` from fixed
  lists in the code, `other` (any other host, or a malformed one), or `direct` (absent or blank). A list
  entry matches itself and its subdomains, by dot, never by substring (`notgoogle.com` is `other`). Only
  the group is stored.
- **Metric.** "Accepted views": what passes the Next route's bot filter, its 30-per-minute limit per IP and
  its 30-minute dedupe, once per tab session. No unique visitors or sessions are computed.
- **Retention.** Indefinite, at most 6 rows per post per day; there is no cleanup job.
- **Report.** `GET /api/v1/admin/analytics` reads in one read-only `REPEATABLE READ` transaction, so all the
  numbers of an answer agree:
  `{from, to, timeZone, since, totals: {views, allTimeViews}, daily: [{day, views}], topPosts: [{id, slug, title, status, views}], sources: [{source, views}]}`.
  `daily` has every day of the range, 0 for a day without views; `topPosts` at most 10, ties by title then id; `sources` all six
  groups in a fixed order. `since` is the first day with daily data in the caller's scope, whatever the
  range (`null` before any), and `allTimeViews` comes from `post_views`, so it includes views before
  `since`. Daily series start on the day V30 is deployed; nothing is backfilled.

## Newsletter

Since V7c (migration V31): double opt-in, and one plain-text mail per post on its first publish. **Real
delivery is NOT VERIFIED**: no SMTP provider was configured and no real message was sent. The tests use an
in-process capturing transport, and `MailTransportTest` builds `SmtpMailTransport`'s full MIME message,
unsubscribe headers included, in memory without opening a connection.

| Table | Holds | Kept until |
|---|---|---|
| `newsletter_subscribers` | the normalized address (unique, lowercase by `CHECK`), `PENDING` or `CONFIRMED`, timestamps, the SHA-256 of the pending confirmation token and its expiry | `PENDING`: deleted by the worker 7 days after the latest request. `CONFIRMED`: until unsubscribed, which deletes the row |
| `newsletter_suppressions` | `HMAC-SHA256(NEWSLETTER_SECRET, address)` in hex, and when | indefinitely; removed when the address confirms again |
| `newsletter_issues` | the outbox: one row per post first published, `PENDING`, `EXPANDED`, `HELD` (an author's post, waiting for an administrator) or `DISCARDED`; who decided and when; the approved subject, excerpt and language after a release | until the post is deleted |
| `newsletter_deliveries` | one row per (post, subscriber), unique: `PENDING`, `RETRYING`, `SENT` or `DEAD`, attempts, next attempt, a safe error code, sent time | deleted with its subscriber or its post; no cleanup |

`CHECK` constraints keep raw tokens (hash columns must be 64 lowercase hex characters) and provider messages
(`last_error` must match `^[A-Z_]{1,32}$`) out of the tables. Writes that could collide go through
`ON CONFLICT`, because a unique violation would copy the address into the log. Log lines carry ids and
codes only, never an address, token or exception message.

- **Addresses.** Trimmed, NFC, lowercased; ASCII only, at most 254 characters (64 before the `@`), a domain
  with at least one dot; a `+tag` is kept, so `a+x@…` and `a@…` are two subscribers. No DNS lookup.
- **Signup.** One upsert for every state: unknown (unsubscribed included) → a new `PENDING`, which has to
  confirm; pending → a new confirmation mail is queued, its token replacing the old one; confirmed →
  nothing. The request never sends mail or creates a token, so its timing says nothing about the address.
  Over the `newsletter-signup` limit it does nothing and still answers 202.
- **Tokens.** Confirmation: 32 random bytes, base64url, made by the worker when the mail goes out; only the
  SHA-256 is stored; valid 48 hours, single use. Unsubscribe: base64url(16-byte subscriber id ‖ first 16
  bytes of `HMAC-SHA256(NEWSLETTER_SECRET, "unsubscribe:" + id)`), never stored, valid until the secret
  changes, compared in constant time. Both match `^[A-Za-z0-9_-]{20,200}$`, which the frontend checks before
  calling. Confirming removes the address's suppression row; unsubscribing writes it and deletes the
  subscriber, whose deliveries go with it. **Never change `NEWSLETTER_SECRET`** once a mail is out: every
  unsubscribe link already sent, and every suppression row, stops matching.
- **Trigger.** `PostService.publish`, in the branch where `publishedAt` is first set, inserts
  `newsletter_issues(post_id)` with `ON CONFLICT DO NOTHING` in the same transaction (`NewsletterOutbox`,
  `Propagation.MANDATORY`). `publish` now locks the post row, so two concurrent first publishes make one
  issue. Unpublish, republish, edits and drafts send nothing. A post unpublished before its mails went out
  keeps them waiting until it is published again; deleting the post deletes them. The issue of a post that an
  `AUTHOR` publishes is `HELD` (V48): `pendingIssues` selects `PENDING` only, so the worker never splits it,
  until an `ADMIN` releases it (`HELD` to `PENDING`, with the approved subject, excerpt and language stored in
  `approved_title`, `approved_excerpt` and `approved_language` (V51), which the delivery query and the expansion prefer to the post's own
  values; the release carries the `version` of the text the administrator read and is refused with 409 `NEWSLETTER_ISSUE_CHANGED`
  when the post is not that text any more, checked under the lock of the issue) or
  discards it (`DISCARDED`, kept, never sent). A post an `ADMIN` publishes is `PENDING` at once.
  `PostService.publish(id, byAdmin)` takes the publisher's role from the token; there is no overload that guesses.
- **Worker.** `NewsletterSchedule` runs `NewsletterWorker.runOnce()` `app.newsletter.worker-delay` after the
  previous run ends, never inside a request. Four steps, at most 50 rows each, rows locked with
  `FOR UPDATE SKIP LOCKED`: purge stale pending signups; send confirmations (a failure rolls the new hash
  back and the row stays due); expand each issue of a published post into one delivery per confirmed
  subscriber; send due deliveries. A failed delivery is retried after 1 minute, 5 minutes, 30 minutes,
  2 hours and 12 hours, then becomes `DEAD` (at most six sends). `CONNECTION_FAILED`, `TIMEOUT` and
  `AUTH_FAILED` are provider-wide: the step stops until the next run, so one outage does not use up every
  delivery's attempts. A delivery to a suppressed address becomes `DEAD` with `SUPPRESSED`. A failing row
  rolls back alone. **At least once:** a crash after the provider accepted a mail and before the commit
  sends that mail once more.
- **Mail.** `MailTransport`: `LoggingMailTransport` by default (one INFO line with the kind and an id: no
  address, subject, link or token), `SmtpMailTransport` only with `NEWSLETTER_TRANSPORT=smtp`. Boot's
  `MailSenderAutoConfiguration` is excluded in `application.yml`: it builds a sender as soon as
  `spring.mail.host` exists, even empty. Plain text, UTF-8, from `NEWSLETTER_FROM`, with
  `List-Unsubscribe: <SITE_URL/api/newsletter/unsubscribe?token=…>` (the frontend route, RFC 8058) and
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. The body links to `SITE_URL/newsletter/confirm?token=…`
  or `SITE_URL/posts/<slug>`, and always to `SITE_URL/newsletter/unsubscribe?token=…`. SMTP connect, read and
  write time out after 10 seconds.

| Key (environment variable) | Default | Meaning |
|---|---|---|
| `app.newsletter.worker-enabled` (`APP_NEWSLETTER_WORKER_ENABLED`) | `true` | `false` removes the schedule; the integration tests set it, and `NewsletterIT` calls the worker directly. |
| `app.newsletter.worker-delay` (`APP_NEWSLETTER_WORKER_DELAY`) | `30s` | Pause between the end of one run and the start of the next, and before the first. |

## Rate limits

Readers' writes, and an admin's role changes, are limited per user id, in this process's memory; the two
newsletter buckets (V7c) per normalized address instead, hashed into the key so that the memory never holds
the address. The anonymous endpoints are also limited per **client address** and, for the ones that can flood
mail or the search engine, for the whole site (the `*-client` and `*-global` rows; see below the table for how the
address is decided):

| Bucket | Default | Counts | Keys |
|---|---|---|---|
| comment | 5 per minute **and** 30 per hour | new comments and replies | `app.rate-limit.comment.per-minute`, `app.rate-limit.comment.per-hour` |
| comment edit | 20 per 10 minutes | edits and deletes of your own comments | `app.rate-limit.comment-edit.per-ten-minutes` |
| like | 30 per minute | likes and unlikes, of posts and comments together | `app.rate-limit.like.per-minute` |
| author application | 5 per hour | author applications submitted (V7a) | `app.rate-limit.author-application.per-hour` |
| bookmark | 30 per minute | saves and unsaves of posts together, `PUT` and `DELETE /api/v1/me/bookmarks/{slug}` (V7b) | `app.rate-limit.bookmark.per-minute` |
| mfa step-up | 10 per 10 minutes, per user | the changes of [the caller's own security](#the-callers-own-security-any-valid-token-apiv1me) and an administrator's reset of an author, attempts included | `app.rate-limit.mfa-step-up.per-ten-minutes` |
| password change | 5 per 10 minutes, per user | `POST /api/v1/me/password`, every attempt | `app.rate-limit.password-change.per-ten-minutes` |
| role change | 20 per 10 minutes, per admin | `PATCH /api/v1/admin/users/{id}/role` and approvals of author applications, no-ops included (V7a) | `app.rate-limit.role-change.per-ten-minutes` |
| newsletter signup | 3 per hour, per address | `POST /api/v1/newsletter/subscriptions`. Over the limit nothing is queued and the answer is still 202, so the limit itself reveals nothing (V7c) | `app.rate-limit.newsletter-signup.per-hour` |
| newsletter signup, client | 5 per hour, per client address | the same endpoint, whatever email address is submitted; checked first, same quiet answer | `app.rate-limit.newsletter-signup-client.per-hour` |
| newsletter signup, whole site | 120 per hour | confirmation mails queued for the whole site; counted last so only signups that would really queue a mail use it; same quiet answer | `app.rate-limit.newsletter-signup-global.per-hour` |
| newsletter token | 20 per hour, per address | confirmations and unsubscribes, counted once the token's address is known, so an unknown token blocks nobody; 429 (V7c) | `app.rate-limit.newsletter-token.per-hour` |
| newsletter token, client | 40 per hour, per client address | confirmations and unsubscribes together, counted before the token is looked at; 429 | `app.rate-limit.newsletter-token-client.per-hour` |
| newsletter confirm, whole site | 300 per hour | confirmations only, counted before the token is looked at; unsubscribes have no whole-site limit on purpose; 429 | `app.rate-limit.newsletter-confirm-global.per-hour` |
| contact, client | 5 per hour, per client address | `POST /api/v1/contact/messages`, whatever email address is submitted; a request refused by validation (400) is not counted; 429 | `app.rate-limit.contact-client.per-hour` |
| contact, whole site | 60 per hour | the same endpoint, counted after the client address and before the per-email SQL count (5 per hour per email address, from the stored rows); 429 | `app.rate-limit.contact-global.per-hour` |
| login, client | 20 per 10 minutes, per client address | `POST /api/v1/auth/login`, every attempt (wrong or right) counted before the password is checked; 429 | `app.rate-limit.login-client.per-ten-minutes` |
| second step of a sign-in, client | 20 per 10 minutes, per client address | `POST /api/v1/auth/mfa/verify`, `/auth/mfa/enroll/begin` and `/auth/mfa/enroll/confirm` together, every attempt counted before the challenge is looked at; 429 `RATE_LIMITED`. The guarantee against guessing a code is the per-account brake (`MFA_RATE_LIMITED`, `MFA_FROZEN`), not this count | `app.rate-limit.mfa-client.per-ten-minutes` |
| refresh, client | 60 per 10 minutes, per client address | `POST /api/v1/auth/refresh`; 429 | `app.rate-limit.refresh-client.per-ten-minutes` |
| setup, client | 5 per minute, per client address | `POST /api/v1/setup`, checked before the whole-process count below, every attempt counted; 429 | `app.rate-limit.setup-client.per-minute` |
| setup | 10 per minute, whole server | `POST /api/v1/setup`, every attempt counted (a correct code included) | `app.rate-limit.setup.per-minute` |
| search, client | 120 per minute, per client address | `GET /api/v1/search` with a query or a filter, checked before the whole-server cap below, so a few callers cannot spend the cap alone | `app.rate-limit.search-client.per-minute` |
| search | 1200 per minute, whole server | `GET /api/v1/search` with a query or a filter. Next also limits per IP (120 per minute): the palette's suggest and popular routes and the server-rendered `/search` page share one bucket (V8b) | `app.rate-limit.search.per-minute` |
| search reindex | 3 per 10 minutes, per admin | `POST /api/v1/admin/search/reindex`, dry runs included (V8b) | `app.rate-limit.search-reindex.per-ten-minutes` |
| post import | 60 per 10 minutes, per person (admin or author) | previews, applies and undos of the [post import](#post-import) together; a count of its own, apart from the site content writes and the article previews | `app.rate-limit.post-import-write.per-ten-minutes` |
| article preview | 300 per 10 minutes, per person (admin or author) | `POST /api/v1/admin/post-import/article-preview`. The import page calls it once per importable file of a preview and once per article it opens, so it has a count of its own: checking 20 files never uses up the previews and applies | `app.rate-limit.article-preview.per-ten-minutes` |

**The client address.** Behind Next the backend sees only the Next server's address, so Next sends the address it derived from
`X-Forwarded-For` (`TRUSTED_PROXY_HOPS`) in `X-Client-Ip` together with the shared secret `CLIENT_IP_TOKEN` in `X-Client-Ip-Token`
(`ClientAddressResolver`). The backend believes the address **only when the token matches** (a constant-time compare); with no token
configured, no token sent or a wrong one, both headers are ignored and the socket address counts, so a caller who reaches the
backend directly cannot choose its key by writing a header. A request that carries the token but no usable address counts as one
shared "unknown" caller, kept apart from direct callers. `X-Forwarded-For` is never read. An IPv6 address counts as its whole `/64`
and an IPv4-mapped IPv6 address as that IPv4 address (`ClientAddress`), the same rule as the frontend's `lib/rate-limit.ts`. The
address is never logged or returned.

**Bounded memory.** The buckets keyed by a value the caller chooses (a client address, a submitted newsletter email address) hold at
most 20,000 keys each. Keys whose window has passed are swept first (at most once a second at the ceiling); when every key is still
inside its window a NEW key is refused (429, or the quiet "nothing queued" for a signup) while the keys already counted keep their
exact quota, so a flood of invented addresses can neither grow memory without bound nor push a running counter out of the map.
The buckets keyed by user id have no such ceiling: their keys are accounts.

Over a limit is 429 `RATE_LIMITED`, without a `Retry-After` header. The windows slide: the last
minute and the last hour, not calendar minutes. A request refused by validation (400) is not
counted; one refused after the check (404, 409, 422) is. Reads and moderation are not limited.
The keys are deliberately left out of `application.yml`, and their defaults live in
`RateLimitProperties`: set one only to tune it. A value below 1 refuses startup.

**Password login** is limited differently: by how many password checks run at once, for the
whole server, not per user. Each check is Argon2id with 16 MiB of memory, and an unknown email
pays the same cost, so unbounded parallel attempts could exhaust the heap. At most
`app.rate-limit.login.concurrent` checks (default 2) run together; another login waits for its
turn, first come first served, up to `app.rate-limit.login.max-wait` (default `5s`), and is then
refused with 429 `RATE_LIMITED` before its password is checked. A waiting login holds a thread but
not the 16 MiB. A normal login only waits for the checks queued ahead of it: `AuthControllerIT`
sends six correct logins at once and none is refused. `concurrent` below 1 or a `max-wait` that is
not positive refuses startup.

**No per-account lockout.** Failed logins are not counted per email, and no account is ever
locked: anyone who knows the owner's address could otherwise lock the owner out at will. Guessing
is slowed by the per-IP limit on the frontend's login route, the backend's own per-client-address limit (`login-client`) and the
concurrency limit above. The second step of a sign-in is limited the same way (`mfa-client`), and the account's own brake holds whatever the address.

**One instance.** These counters live in memory, like the set of used OAuth states: a restart
forgets them, and two backend instances each keep their own, so the effective limit doubles.
Run one backend instance, or accept looser limits. Next has per-IP limits of its own, on password
login, on starting and finishing a GitHub sign-in, on the contact form and (V7c) on the three
newsletter routes (`TRUSTED_PROXY_HOPS`); the per-client-address rows above are the backend's second
line, for a backend reached without Next and for what Next's in-memory counters cannot hold (a restart,
several instances). A backend with a public URL of its own (Koyeb, Render) counts the socket address of
its direct callers (the platform's load balancer address, shared by all of them), so login, refresh,
setup, the contact form, the newsletter POSTs and search are limited there as well; only the two GitHub
OAuth paths stay without a per-IP limit, and a GitHub sign-in still needs the signed cookie and GitHub's
single-use code. `VIEWS_TOKEN` does not guard the newsletter POSTs, and `CLIENT_IP_TOKEN` opens nothing.

## Indexes

Migration V27 adds two indexes on the foreign-key side of the two taxonomy relations, and no
others:

- `idx_post_tags_tag_id` on `post_tags (tag_id, post_id)`. The primary key `(post_id, tag_id)`
  serves lookups by post only. Lookups by tag: the posts of a tag (`/posts?tag=`), the public tag
  list's `EXISTS`, the count and copy of a tag merge, and the `ON DELETE CASCADE` that PostgreSQL
  runs when a tag is deleted or merged. PostgreSQL 18 can answer `tag_id = ?` from the primary key
  with a skip scan, but `post_id` has as many values as there are posts, so that reads the whole
  key. With `post_id` second, "which posts carry this tag" reads the index only.
- `idx_posts_category_id` on `posts (category_id)`. Nothing indexed it, so counting a category's
  posts before a delete, PostgreSQL's foreign-key check when a category is deleted or merged
  (`SELECT 1 FROM posts WHERE category_id = $1 FOR KEY SHARE`), and the move of a category merge
  all scanned the whole table.

At the current size (12 posts, 42 tag links) the benefit is structural, not measurable: each of
those statements reads a page or two, and the planner rightly prefers a sequential scan. On 2,000
synthetic posts with 6,000 tag links, finding a tag's posts read 3 index pages instead of 43 pages
of the primary key, and the posts of a tag 498 buffers instead of 1,732. The public lists' `EXISTS`
gained nothing measurable, since a semi-join stops at the first match. `posts.author_id` stays
unindexed: one admin and a few authors, so a filter on it selects most of the table. The nightly
refresh-token cleanup scans its small table once a night, cheaper than an index updated on every
sign-in and refresh. `TaxonomyIndexSchemaIT` checks both definitions and that, with sequential
scans off, the foreign-key statements above use them.

Migration V29 (V7b) creates `post_bookmarks` with the primary key `(user_id, post_id)`, which serves
every read by reader, and `idx_post_bookmarks_post_id` for the `ON DELETE CASCADE` when a post is
deleted.

Migration V30 (V7c) adds `idx_post_view_daily_day` on `post_view_daily (day)`: the site-wide report filters
by a date range, while the primary key starts with `post_id`. Measured with `EXPLAIN` on 1.1 million
aggregate rows (the figures are in the migration's comment): a 30-day series went from 7,166 to 168
buffers, and the first day with data (`since`) from 41 ms, a whole-table scan, to 0.03 ms. An author's
report goes through the primary key, post by post. Migration V31 adds a partial index on
`newsletter_deliveries (next_attempt_at)` for `PENDING` and `RETRYING` rows, the worker's due list, and
one on `subscriber_id` for the cascade when someone unsubscribes.

## Configuration

Environment variables, read through `application.yml`:

| Variable | Default | Meaning |
|---|---|---|
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USERNAME`, `DB_PASSWORD` | `localhost`, `5432`, `blog`, `blog`, `blog` | PostgreSQL (compose and the tests use 18), with the `unaccent` extension available ([Search](#search)). |
| `SERVER_PORT` | `8080` | |
| `APP_ALLOW_DEV_DEFAULTS` | `false` | The explicit opt-in to development defaults (the development admin password, an empty `VIEWS_TOKEN` or `CLIENT_IP_TOKEN`, the development `JWT_SECRET`) for a throw-away E2E or CI stack. The `dev` profile of `mvn spring-boot:run` opts in too. Ignored for a public `SITE_URL`. [Production checks](#production-checks). |
| `JWT_SECRET` | none (required; the `dev` profile supplies a development value) | HS256 key, at least 32 bytes (a missing or shorter one refuses startup). It also keys the GitHub sign-in cookie. The development value logs a WARN on an opted-in run and refuses startup otherwise ([Production checks](#production-checks)). Generate one with `openssl rand -base64 48`. Changing it invalidates every access token (15 minutes at most) but no refresh token, so it is **not** a global logout; [Sessions and refresh tokens](#sessions-and-refresh-tokens) gives the SQL that is. |
| `MFA_ENCRYPTION_KEY` | none (required in every mode; the `dev` profile and the tests supply a development key) | Base64 of exactly 32 bytes: the AES-256-GCM key of the stored authenticator secrets. Not derived from `JWT_SECRET`, not in the database. See [Production checks](#production-checks) and [Changing `MFA_ENCRYPTION_KEY`](../docs/CONFIGURATION.md#changing-mfa_encryption_key). |
| `MFA_ENROLLMENT_TOKEN` | empty | The operator's proof for the forced enrollment, at least 24 characters. Empty means a generated file `<SETUP_DATA_DIR>/mfa-enrollment-code`. `app.mfa.enrollment-token`. |
| `MFA_RESET_EMAIL`, `MFA_RESET_TOKEN` | empty | One-off operator reset of one account's second step at startup, once per distinct token (at least 24 characters). `app.mfa.reset-email`, `app.mfa.reset-token`. |
| `ADMIN_EMAIL` | `admin@blog.local` | The admin account's email (`app.admin.email`). Another value renames the seeded admin at startup, same id, unless an account already has it ([details](#the-admin-account-admin_email-admin_password)). |
| `ADMIN_PASSWORD` | empty | When set, hashed and written to the admin account at startup; it must meet the password policy when its value changes (12 to 128 characters and more); it also closes first-run `/setup`, and the password cannot be changed through `/api/v1/me/password` while it is set. Leave it empty on a fresh install and claim the instance through `/setup`. On a public site the backend refuses to start while the admin still accepts the development password. |
| `SETUP_TOKEN` | empty | The first-run setup code itself, at least 24 characters (shorter refuses startup). Empty: the backend generates one into `SETUP_DATA_DIR`. Ignored once setup is completed. |
| `SETUP_DATA_DIR` | `./data` | Where the generated `setup-code` file is written; deleted when setup completes. `/data` in Docker (a named volume). Keep it private. |
| `SETUP_LOCK_DEV_SEED` | `true` | While setup is pending, disable the seeded development password. `false` only on a throw-away database, and ignored on a production run. |
| `DEFAULT_LOCALE` | `vi` (Compose passes `en`) | `en` or `vi`: the language of posts created without one and, on the first start of a database that predates languages (V34), of every existing post and subscriber. Also `app.i18n.default-locale`. Set it once. Anything else refuses startup. |
| `ADMIN_GITHUB_ID` | empty | Numeric GitHub id the admin account is linked to at startup ([details](#link-the-admin-account-to-github-admin_github_id)). Empty: no linking. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | empty | The GitHub OAuth App. Either one empty: GitHub sign-in is off and the site still runs. Never commit the secret. |
| `GITHUB_REDIRECT_URI` | empty | The callback GitHub redirects to, `<site>/api/auth/github/callback` exactly. Empty: derived from `SITE_URL`. |
| `SITE_URL` | empty | The site's public origin, the frontend's. Required for GitHub sign-in when `GITHUB_REDIRECT_URI` is empty. Also decides whether the [production checks](#production-checks) run: set, with a host other than localhost, `127.0.0.0/8` or `::1`. Set it on every public deployment, not only under compose. Since V7c also the base of every newsletter link (`NEWSLETTER_TRANSPORT=smtp` requires public `https`) and the host of the `internal` view source. |
| `VIEWS_TOKEN` | empty | Shared token for `POST /posts/{slug}/views`; required in production (empty refuses startup unless the run opted in to development defaults). It does not guard the newsletter POSTs. |
| `CLIENT_IP_TOKEN` | empty | Shared secret (`app.client-ip.token`) that lets the backend believe the reader address Next forwards in `X-Client-Ip`; the same value on the frontend. Required in production (empty refuses startup unless the run opted in to development defaults). Never printed. [Rate limits](#rate-limits). |
| `ANALYTICS_TIME_ZONE` | `Asia/Ho_Chi_Minh` | The IANA zone that decides a view's day, on write and on read ([Analytics](#analytics)). An id Java does not know refuses startup; empty means the default. Changing it later does not move days already stored. |
| `NEWSLETTER_TRANSPORT` | `log` | `log`: no mail leaves the process, one INFO line per mail (kind and id only). `smtp`: real sending, behind the startup check in [Production checks](#production-checks). |
| `NEWSLETTER_FROM` | empty | The sender, an address or `Name <address>`, on a domain your SMTP provider has verified (SPF, DKIM). Required with `smtp`. |
| `NEWSLETTER_SECRET` | empty | HMAC key of unsubscribe tokens and suppression hashes; at least 32 bytes with `smtp` (`openssl rand -base64 48`). Empty with `log`: a development key from this repository, and a WARN on a public site. Set it once, before the first subscriber, and never change it ([Newsletter](#newsletter)). |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_STARTTLS` | empty, `587`, empty, empty, `true` | The provider's SMTP server (`spring.mail.*`), used only with `smtp`; `SMTP_HOST` is required then. `SMTP_STARTTLS=true` enables and requires STARTTLS. Never commit the password. |
| `SPRINGDOC_ENABLED` | `false`; `true` under `mvn spring-boot:run` (profile `dev`) | `true` turns on Swagger UI and `/v3/api-docs`, `false` turns them off, whatever the profile. Off, both answer 404. |
| `MEDIA_MAX_TOTAL_SIZE` | `1GB` | Total image quota: covers, gallery photos and body images together. `GET /api/v1/admin/media/usage` shows how much is used. |
| `SEARCH_ENGINE`, `MEILI_URL`, `MEILI_MASTER_KEY`, `MEILI_INDEX_NAME` | `postgres`, empty, empty, `content_v1` | Meilisearch search (V8b): [Search with Meilisearch](#search-with-meilisearch). |

To try GitHub sign-in locally, create an OAuth App at https://github.com/settings/developers
with homepage `http://localhost:3000` and callback `http://localhost:3000/api/auth/github/callback`.
Start the backend with `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and
`SITE_URL=http://localhost:3000`; [Run locally](#run-locally) shows the syntax for each shell.
Browse on `localhost`, not `127.0.0.1`, because cookies are per host. [docs/CONFIGURATION.md](../docs/CONFIGURATION.md) covers
every variable of the whole stack.

## Run tests

`mvn clean test` — unit tests run without Docker; repository/controller tests use
Testcontainers and require Docker to be running. `clean` matters: a run without it has read
stale `target/classes` and reported green for code that no longer compiled.

The integration tests run with GitHub sign-in turned on, against a GitHub stand-in inside the
test JVM (`GithubStub`), so they need no network access and no GitHub credentials. They run with
the refresh-token cleanup schedule off (`app.security.refresh-token-cleanup-cron=-`), so a run
at 03:17 cannot delete a token a test has just created; `RefreshTokenCleanupIT` calls the job
directly, and `RefreshTokenCleanupConfigTest` checks the schedule without a database. They also
run with `SITE_URL` empty (a development machine, so the development secret and password work) and
with Swagger on; `SpringDocDisabledIT` and `AdminSeedEmailIT` start their own contexts for Swagger
off and for a renamed admin, and `AdminSeedEmailIT` puts the seeded admin back afterwards because
every test class shares one database. The production refusals are tested as rules without a
database (`DevJwtSecretFailClosedTest`, `DevCredentialWarningTest`, `ProductionModeTest`).
`SecurityMatrixIT` sends a real request, without a token and with a real token of each role, to
one or two representative endpoints of each kind of authorization rule;
[Authentication](#authentication) lists what it leaves to other tests. `OpenApiConfigIT`
compares the OpenAPI document with real responses, field by field: each call must first return
the status it is meant to exercise, then its body must match the schema documented for that
status.

No test can send a real mail (V7c). The integration tests run with the newsletter worker's schedule off
(`app.newsletter.worker-enabled=false`) and the default `log` transport; `NewsletterIT` runs on its own
database, calls `NewsletterWorker.runOnce()` directly with an in-process capturing transport and a clock
it moves by hand (token expiry, pending retention, retry backoff). `NewsletterConfigTest` checks the
`smtp` startup rules, the schedule wiring and the WARNs without a database.

Search (V8b) runs with the outbox worker and the reconciliation schedule off in every context
(`app.search.worker-enabled=false`, `app.search.reconcile-cron=-`). The shared context has no `MEILI_URL`, so indexing is
off there. The Meilisearch ITs (`MeiliIntegrationTest` and its subclasses) share one context on their own database and a
real `getmeili/meilisearch:v1.54.3` Testcontainer (random port, 512 MiB, never the machine's 7700), and call the worker,
the reconciler and the reindex service directly. `SearchConfigTest` checks the master-key startup rule without a context.
