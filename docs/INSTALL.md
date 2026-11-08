# Install

Blog Engine runs as three containers (PostgreSQL, the Spring Boot API, the Next.js site) from one `docker-compose.yml`, plus an
optional fourth for search. This page takes you from a clean machine to a running site, then to a public one with TLS.

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Prebuilt backend image or build from source](#prebuilt-backend-image-or-build-from-source)
- [What init-env does](#what-init-env-does)
- [Deploy to a VPS](#deploy-to-a-vps)
- [TLS with Caddy](#tls-with-caddy)
- [TLS with nginx and certbot](#tls-with-nginx-and-certbot)
- [Optional: GitHub login for readers](#optional-github-login-for-readers)
- [Optional: sending newsletter mail](#optional-sending-newsletter-mail)
- [Optional: Meilisearch search](#optional-meilisearch-search)
- [After the install](#after-the-install)

## Requirements

| | |
|---|---|
| Docker | Docker Engine with the Compose plugin (the `docker compose` command, version 2). Docker Desktop on Windows and macOS works. |
| Memory | **At least 2 GB of RAM on the server.** The containers are limited to 384m (PostgreSQL), 768m (backend, `BACKEND_MEM_LIMIT`), 384m (frontend) and 512m (Meilisearch, only if you enable it). Uploaded images are decoded in the backend's heap, so a smaller machine makes large uploads more likely to run out of memory. |
| Disk | Postgres holds posts and images (images count against `MEDIA_MAX_TOTAL_SIZE`, default 1GB), plus the Docker images. |
| Network | For a public site: a domain whose DNS points at the machine, and ports 80 and 443 open. The site itself listens only on `127.0.0.1:3000`. |

You do **not** need a JDK, Node.js or Maven to run the site; the images are built or pulled by Docker. Those are for
[development](DEVELOPMENT.md).

## Quick start

On one machine, to try it at `http://localhost:3000`. From the root of the repository:

<!-- docs-test: run -->
```bash
./scripts/init-env.sh
```

This writes `.env` with random secrets. On Windows PowerShell run `.\scripts\init-env.ps1` instead. Then build and start:

<!-- docs-test: run -->
```bash
docker compose up -d --build
```

The first build downloads base images and compiles both applications; expect several minutes. When it is done, wait for the
site to answer:

<!-- docs-test: run -->
```bash
curl -fsS --retry 40 --retry-delay 5 --retry-connrefused -o /dev/null "http://localhost:${SITE_PORT:-3000}/setup"
```

Open <http://localhost:3000/setup>. A fresh install has no usable password: you claim it with a **setup code** that the backend
writes to a file, as described in [FIRST-RUN.md](FIRST-RUN.md). Read it with:

```bash
docker compose exec backend sh -c 'cat /data/setup-code'
```

(In a script without a terminal add `-T`: `docker compose exec -T backend sh -c 'cat /data/setup-code'`.)

To see what is running, `docker compose ps`; for logs, `docker compose logs -f backend`. To stop, `docker compose down` (the data
stays in the named volumes); `docker compose down -v` deletes the volumes, and with them every post and image.

## Prebuilt backend image or build from source

`docker-compose.yml` names two images, `BACKEND_IMAGE` and `FRONTEND_IMAGE`, and keeps a `build:` section on each service. Their
defaults are local-only names (`blog-engine-backend:local` and `blog-engine-frontend:local`), on purpose: a default that named a
registry account would make `docker compose pull` fetch whatever that account publishes, and the backend container holds your
database password, `JWT_SECRET` and the mail and sign-in secrets. With the defaults a pull finds nothing and fails, which is safe.
Two ways follow from that:

| | Command | Use when |
|---|---|---|
| Build from source | `docker compose up -d --build` | Any real deployment. It builds both images from your checkout with your `.env` and tags them with those names. |
| Prebuilt backend image | set `BACKEND_IMAGE` in `.env` (below), then `docker compose pull backend`, `docker compose build frontend` and `docker compose up -d` | You would rather pull the backend than build it. The frontend is built either way. |

The release workflow publishes the **backend** image to `ghcr.io` for `linux/amd64` and `linux/arm64` when a version tag is pushed,
under the account that owns the repository the release was made in: `ghcr.io/<account>/blog-engine-backend`. To use it, set
`BACKEND_IMAGE` in `.env` to that namespace, **and pin it**: a version
tag (`ghcr.io/<account>/blog-engine-backend:1.2.3`) or, better, a digest (`ghcr.io/<account>/blog-engine-backend@sha256:<digest>`,
printed by `docker buildx imagetools inspect <image>:<tag>`). Do not rely on `latest` or on `1.2`: they move with every release, so
the same `.env` would pull different code next month. Take `<account>` from the repository you trust, not from an example. A
pre-release such as `1.0.0-rc.1` gives only its own tag and **no `latest`**.

**Check the signature before you trust a digest.** Before the release workflow pushes anything, Trivy scans the backend image (no HIGH or
CRITICAL vulnerability with a fix); after the push it signs the digest of the image with
[cosign](https://docs.sigstore.dev/cosign/overview/), keyless: there is no key to steal, the certificate names the workflow run and
the signature is recorded in the public Sigstore log. With cosign 3 or newer (the workflow signs and verifies with cosign 3, which
stores the signature in the newer Sigstore bundle format; an older client may not find it), replace `<account>` and `<repository>` by
the account and the repository you trust:

```bash
cosign verify ghcr.io/<account>/blog-engine-backend@sha256:<digest> \
  --certificate-identity-regexp '^https://github\.com/<account>/<repository>/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

It succeeds only for an image that the `release.yml` workflow of that repository signed on a `v*` tag. Put the digest that passed
in `.env` (`BACKEND_IMAGE=ghcr.io/<account>/blog-engine-backend@sha256:<digest>`), not a tag. The signature says who built the image,
not that its code is free of bugs, and an image you build yourself with `docker compose up -d --build` needs no such check.

**There is no published frontend image: build it yourself.** `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_DEFAULT_LOCALE` and `HSTS_MAX_AGE`
are compiled into the Next bundle when the image is built, so one prebuilt image could only carry `http://localhost:3000`
(default language `en`, HSTS 86400). Canonical URLs, Open Graph tags and the sitemap would then all say `localhost` on a public
site, an https site would send no `Strict-Transport-Security`, and nothing would fail to tell you. So the frontend is always built
from your checkout with the `.env` of the site:

```bash
docker compose build frontend
docker compose up -d
```

The same rule applies whenever you change `SITE_URL`, `DEFAULT_LOCALE` or `HSTS_MAX_AGE`: rebuild the frontend with
`docker compose up -d --build`. The frontend also checks itself: the image records the address it was built for, compose gives the
container the `SITE_URL` of `.env`, and the container **refuses to start** when the two differ (the log says which addresses and what
would be wrong), so a forgotten `--build` stops the deploy instead of serving a site that names the wrong address. If you really want
to run an image under another address, set `ALLOW_SITE_URL_MISMATCH=true` in `.env`: it then starts with the same text as a warning.
A bare `docker run` of the image (no `SITE_URL`) starts as before.

## What init-env does

`scripts/init-env.sh` (Linux, macOS, Git Bash) and `scripts/init-env.ps1` (Windows PowerShell) copy `.env.example` to `.env`
and fill the secrets with random values: `DB_PASSWORD`, `JWT_SECRET`, `MFA_ENCRYPTION_KEY`, `VIEWS_TOKEN`, `CLIENT_IP_TOKEN`,
`NEWSLETTER_SECRET`, `MEILI_MASTER_KEY`, and the passwords of the three database roles (`DB_OWNER_PASSWORD`, `DB_ADMIN_PASSWORD`).
They print what they did and never print a secret, and they create `.env` private to you: mode 600 for the shell script (which also keeps
every secret off the command lines of the programs it starts), owner-only access without inheritance for the PowerShell script on
Windows. They refuse to overwrite an existing `.env` (exit status 1): move it away
first. Three inputs, all optional:

```bash
SITE_URL=https://example.com SITE_PORT=3000 DEFAULT_LOCALE=vi ./scripts/init-env.sh
```

```powershell
.\scripts\init-env.ps1 -SiteUrl https://example.com -SitePort 3000 -DefaultLocale vi
```

`SITE_URL` is the public origin (default `http://localhost:3000`), `SITE_PORT` the host port of the site (default `3000`),
`DEFAULT_LOCALE` the language whose URLs have no prefix, `en` (default) or `vi`. `ADMIN_PASSWORD`, `SETUP_TOKEN`,
`ADMIN_GITHUB_ID`, `MFA_ENROLLMENT_TOKEN`, `MFA_RESET_EMAIL` and `MFA_RESET_TOKEN` stay empty on purpose. You can also copy `.env.example` by hand and fill every secret yourself; compose refuses to
start with `DB_PASSWORD`, `JWT_SECRET`, `MFA_ENCRYPTION_KEY`, `SITE_URL`, `VIEWS_TOKEN` or `CLIENT_IP_TOKEN` missing (`MFA_ENCRYPTION_KEY`:
`openssl rand -base64 32`, and keep a copy outside the server). `.env.example` names the owner and administration database roles, and
then `DB_OWNER_PASSWORD` and `DB_ADMIN_PASSWORD` are required too, each different from `DB_PASSWORD` and from each other (the postgres
container refuses to start otherwise, and says why in `docker compose logs postgres`); delete the OWNER and ADMIN lines for a single-role install. Every variable is explained in
[CONFIGURATION.md](CONFIGURATION.md).

## Deploy to a VPS

The site is built for one small server. The compose file publishes one port for public traffic, the frontend on `127.0.0.1:3000`
(with the optional `search` profile, Meilisearch is also on `127.0.0.1:7700` for checks from the machine itself), so a
reverse proxy on the same machine is the only way in from the internet. PostgreSQL and the backend are not published at all,
because the browser never calls the API directly: the Next server does. Inside Docker, PostgreSQL is on an internal network that only
the backend joins (the frontend cannot open a connection to it), and every container runs without Linux capabilities, with no way to
gain privileges, a read-only root file system and a process limit ([SECURITY.md](SECURITY.md#containers-and-networks)).

This section puts everything on one machine, where the links between the parts stay on a private Docker network. For a frontend,
backend or database on separate machines (a managed database, a platform for the frontend) those links must be TLS: see
[Split deployment](CONFIGURATION.md#split-deployment).

1. **Prepare the machine.** Install Docker, point your domain (and `www`, if you use it) at the server, allow ports 80 and 443 and
   nothing else from outside. Do not publish port 3000: Docker opens published ports with its own firewall rules, which `ufw`
   does not block, and a client that reaches Next directly can forge `X-Forwarded-For` (the key of every per-IP limit) and skip
   the proxy's body limits.
2. **Write `.env` with your public origin:**

   ```bash
   SITE_URL=https://example.com ./scripts/init-env.sh
   ```

   Use `https://`: the session cookies carry the `secure` flag in production, so over plain HTTP the browser drops them and
   sign-in silently does nothing. Use the real host, with no trailing slash and no path.
3. **Build and start:** `docker compose up -d --build`. The backend is production by default and its startup checks refuse a
   missing or development `JWT_SECRET`, an empty `VIEWS_TOKEN` or `CLIENT_IP_TOKEN` and an admin account with the development password. `init-env` gives you safe values.
4. **Put a reverse proxy in front** with TLS: [Caddy](#tls-with-caddy) (automatic certificates) or
   [nginx with certbot](#tls-with-nginx-and-certbot). Both examples redirect `www` to the main host, apply the body limits and
   keep one-time tokens and search terms out of the access log.
5. **Claim the site** at `https://example.com/setup` ([FIRST-RUN.md](FIRST-RUN.md)).

Defaults of a production install and how to change them:

| | Default | Change |
|---|---|---|
| Frontend port | `127.0.0.1:3000` | `SITE_PORT` (a number), `SITE_BIND` (address). `SITE_BIND=0.0.0.0` only when the proxy is on another machine, and then firewall the port to that machine alone. |
| Swagger UI, `/v3/api-docs` | off | `SPRINGDOC_ENABLED=true` (compose sets `false` explicitly). |
| Admin password sign-in | 10 attempts per 10 minutes per IP (in Next) and 20 per 10 minutes per client address (in the backend); the backend checks only a few passwords at once | Fixed. If you are blocked by mistake wait, sign in from another network, or `docker compose restart frontend` (the counter is in memory). |
| Contact form, newsletter, session refresh, first-run setup, search | Limited per client address in Next and again in the backend, plus a whole-site ceiling for the contact form, newsletter mail and search. Needs `CLIENT_IP_TOKEN`, the secret that lets the backend believe the address Next forwards | The numbers are `app.rate-limit.*` properties ([CONFIGURATION.md](CONFIGURATION.md#rate-limits)). |
| Views | 30 beacons per minute per IP, needs `VIEWS_TOKEN` | Fixed. |
| Newsletter | `NEWSLETTER_TRANSPORT=log`: accepts subscriptions, sends no mail | [Optional: sending newsletter mail](#optional-sending-newsletter-mail). |
| HSTS | `max-age=86400` when `SITE_URL` is https | `HSTS_MAX_AGE`, at image build time. |
| Logs | at most 3 files of 10 MB per container | Edit `x-logging` in `docker-compose.yml`, or ship the logs off the machine so that a flood of requests cannot push the security lines out of the window ([Security](SECURITY.md#audit-events)). |

Behind the proxy, `TRUSTED_PROXY_HOPS` must equal the number of proxies in front of Next: `1` for Caddy or nginx alone (default). With
Cloudflare in front of them keep `1` and let nginx restore the visitor address ([Behind Cloudflare](#behind-cloudflare)); `2` is right
only if the origin accepts connections from Cloudflare alone. The address it selects is also the one Next forwards to the backend for
the backend's own per-address limits, together with `CLIENT_IP_TOKEN` (the same value on both sides; compose and `init-env` take care
of it). Without the same `CLIENT_IP_TOKEN` on both sides the backend counts the Next server as one caller for every reader.

### Behind Cloudflare

Every per-IP limit, in Next and in the backend, counts the address at entry `TRUSTED_PROXY_HOPS` from the right of
`X-Forwarded-For`. nginx appends to whatever the caller sent, so that entry is the visitor only if the request really came through
Cloudflare. A caller who reaches the origin directly (its address leaked, or never hidden) would otherwise choose its own key and
rotate every per-address limit, which is why two hops is **not** the setting to copy blindly. Do one of these, the first being the
safer because it holds even when the origin is reachable:

1. **Keep `TRUSTED_PROXY_HOPS=1` and restore the visitor address in nginx** with the `ngx_http_realip_module`, trusting
   `CF-Connecting-IP` from Cloudflare's published ranges only. A request from any other address is not trusted: nginx keeps its own
   `$remote_addr`, which is the one Next reads. Build the file once and refresh it when Cloudflare changes its ranges (they are
   listed at <https://www.cloudflare.com/ips-v4> and <https://www.cloudflare.com/ips-v6>):

   ```bash
   { for range in $(curl -fsS https://www.cloudflare.com/ips-v4; echo; curl -fsS https://www.cloudflare.com/ips-v6); do
       echo "set_real_ip_from $range;"
     done
     echo "real_ip_header CF-Connecting-IP;"
   } | sudo tee /etc/nginx/cloudflare-realip.conf
   ```

   Then uncomment `include /etc/nginx/cloudflare-realip.conf;` in the main host block of `deploy/nginx.conf.example` and
   `sudo nginx -t && sudo systemctl reload nginx`. If a range is missing from the file, requests from that part of Cloudflare all
   count as one visitor (the symptom is in [Troubleshooting](TROUBLESHOOTING.md)).
2. **Use `TRUSTED_PROXY_HOPS=2` only if the origin accepts connections from Cloudflare alone**, so that nobody else can send the
   header: a firewall rule that allows Cloudflare's ranges on port 443 and nothing else, Cloudflare's Authenticated Origin Pulls
   (nginx: `ssl_client_certificate` with Cloudflare's origin-pull CA and `ssl_verify_client on`), or a Cloudflare Tunnel so the
   origin has no public port at all.

Either way, restrict the origin to Cloudflare: it keeps the Cloudflare rules (WAF, rate rules, caching) in the way of every request.

### Security headers

Next sends the security headers itself, so the proxy must not add them (a second line means two headers): `X-Frame-Options: DENY`,
a `Content-Security-Policy` (the full enforced policy, `frame-ancestors 'none'` included, see `docs/SECURITY.md`), `Reporting-Endpoints`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`
(`no-referrer` under `/api/auth/github/*` and `/newsletter/*`), `Permissions-Policy: camera=(), microphone=(), geolocation=()`, no
`X-Powered-By`, and `Strict-Transport-Security` when `SITE_URL` is https. **Do not add `Strict-Transport-Security` in the proxy:** the
response would carry two HSTS headers, the browser reads only the first and `HSTS_MAX_AGE` may stop having an effect. The
default is one day on purpose; raise `HSTS_MAX_AGE` to `31536000` only after HTTPS has run stably ([Raise HSTS](#raise-hsts-after-https-is-proven)).

### Raise HSTS after HTTPS is proven

The one-day default means a mistake in your HTTPS setup locks readers out only until tomorrow, but it also means the protection is
short: a visitor who is not on your site for a day is open to a downgrade again. ASVS asks for at least a year. So it is a dated step
of the install, not something to remember: about **two weeks** after the first public start, when the certificate has renewed (or you
know it will), every page opens over https and nothing needs plain http, do this once:

1. In `.env` set `HSTS_MAX_AGE=31536000`.
2. Only when you own every subdomain of your host and all of them are served over https, also set `HSTS_INCLUDE_SUBDOMAINS=true`. A
   subdomain without working HTTPS goes dark for the whole max-age, so leave it off when in doubt. There is no `preload` switch on
   purpose: a browser preload list is almost impossible to leave.
3. `docker compose up -d --build` (both values are compiled into the frontend image).
4. Check the header: `curl -sI https://<domain>/ | grep -i strict-transport-security` shows `max-age=31536000`.

The frontend build prints a line (`[hsts] ...`) whenever the max-age is under a year, as a reminder. `HSTS_MAX_AGE=0` is the way back:
it makes browsers forget the policy at their next visit over https.

### Body limits and why they matter

Both examples allow 1 MB for everything and 6 MB for `/admin/`. Public pages send at most 16 KB, while the admin's image upload
posts up to 5 MiB to the page URL `/admin/...`. Next reads every multipart POST to every page up to 5 MiB before it knows whether it
is a valid action, so the proxy is where junk POSTs are stopped. The backend also bounds the JSON it reads by itself (64 KiB for the
public API, 6 MiB under `/api/v1/admin/`, 413 beyond that): behind these proxies it never sees more than they let through, and it is the
only bound of a backend that runs on its own public URL. The other layers are in
[Upload size limits](CONFIGURATION.md#upload-size-limits-by-layer).

### Limit the rate of requests

Next limits the expensive reads per address ([SECURITY.md](SECURITY.md#rate-limits)), but only the proxy stops a request before it costs
Next anything, and a made-up address of a post, a picture or a share card costs a render, a read of the database or a drawn PNG. Both
examples answer `405` to `TRACE`, `TRACK` and `CONNECT` (without it Next throws a 500 and logs a stack trace for each). The nginx example
goes further, and the blocks to copy are three:

- two `limit_req_zone` lines (pages 20 requests a second per address with a burst of 100, the expensive reads 5 a second with a burst of
  10 to 60), and `limit_req_status 429`, outside every server block;
- a `proxy_cache_path` and three locations: `/media/` and `/_next/image` keep a 200 for an hour, `/api/og/` (the share cards) for five
  minutes, so a flood of requests for one picture becomes one request to Next. `/media/` is keyed by the path alone, because its route
  ignores the query string and `/media/<id>.jpg?x=<random>` must find the cached copy; `/_next/image` keeps the query in the key, since
  the query is the picture, the width and the quality. A card is not kept longer than five minutes because the card of an address asked
  for before its post existed is the site-wide one, and a post whose title changed should not keep its old card for an hour. Create the
  folder first: `sudo mkdir -p /var/cache/nginx/blog`. A deleted image leaves this cache within the hour;
- a location for the feeds and the sitemap that is limited and not cached (a withdrawn post has to leave them at once), and one for
  `/_next/static/` that is neither, because a page loads dozens of files at once.

`$binary_remote_addr` is the address nginx sees. With Cloudflare in front of nginx it is Cloudflare's, so every reader shares one limit
until you restore the reader's address with `set_real_ip_from` (Cloudflare's ranges) and `real_ip_header CF-Connecting-IP`. Caddy has no
rate limit and no cache without a plugin (for example `mholt/caddy-ratelimit`, built with xcaddy): put the same numbers in it, or a CDN
with a rate rule in front.

### A CDN in front

A CDN or a caching proxy in front of your reverse proxy is optional, and the two examples cache nothing. If you add one, three things
decide whether a withdrawn page or a deleted image is really gone:

- **Do not cache HTML at the edge.** Pages are sent with `Cache-Control: s-maxage=300, stale-while-revalidate=3300`, a 404 page too. The
  cache of Next is cleared when you save, publish, unpublish or delete in the admin, but a CDN never hears of it. A post you unpublish or
  delete stays visible at the edge for up to an hour (five minutes, then the stale window), and a 404 cached just before a post was
  published stays wrong for as long. If you cache HTML anyway, purge the post URL and its locale variants (`/posts/<slug>` and
  `/en/posts/<slug>`) after every unpublish or delete.
- **`/media/*` is cached for a year, on purpose.** An image address is a UUID that never changes its bytes
  (`Cache-Control: public, max-age=31536000, s-maxage=31536000, immutable`). Deleting an image removes it from the database at once, but an
  edge keeps serving it: purge `/media/<uuid>.<ext>` and `/_next/image?url=%2Fmedia%2F<uuid>.<ext>...` after the deletion, and recreate the
  frontend container to empty the optimized copy ([BACKUP-AND-RESTORE.md](BACKUP-AND-RESTORE.md#clearing-the-optimized-image-cache)).
- **Feeds and the sitemap** are read from the backend on every request and are sent `max-age=0, must-revalidate`; a CDN may cache them,
  but only if it revalidates.

The client address still has to come from your own proxy (`TRUSTED_PROXY_HOPS`, see above); a CDN does not change the other limits.
[SECURITY.md](SECURITY.md#caching-and-a-cdn-in-front) has the table of what each response sends and how long a withdrawn page can last.

## TLS with Caddy

[`deploy/Caddyfile.example`](../deploy/Caddyfile.example) uses Caddy v2, which obtains and renews Let's Encrypt certificates by
itself.

```bash
sudo cp deploy/Caddyfile.example /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile        # replace example.com with the host of SITE_URL (without www)
sudo systemctl reload caddy
```

The file redirects `www.example.com` to `example.com`, proxies to `127.0.0.1:3000` (change it if you changed `SITE_PORT`), applies
the 1 MB and 6 MB limits, and does not log `/api/auth/github/callback`, `/newsletter/*` and `/api/newsletter/*`. Caddy keeps the
`Host` header and sets `X-Forwarded-For` itself, which is what `TRUSTED_PROXY_HOPS=1` expects. Caddy writes no access log unless you add
`log`; its error log names the request with its query when the upstream fails, so the file's global `log` removes the query and the
`Referer` from it (a `log` you add to the site needs the same `format filter`). Behind Cloudflare set
`TRUSTED_PROXY_HOPS=2` and configure Caddy's `trusted_proxies` for Cloudflare's ranges: Caddy keeps the `X-Forwarded-For` of a request
from those ranges and replaces it for any other caller, so a caller who reaches the origin directly is not believed. Still let the
origin accept Cloudflare alone ([Behind Cloudflare](#behind-cloudflare)).

## TLS with nginx and certbot

[`deploy/nginx.conf.example`](../deploy/nginx.conf.example) is the nginx version. Copy it to `/etc/nginx/conf.d/blog.conf` and replace
`example.com`. The first time, the two port-443 blocks point at a certificate that does not exist yet, and `nginx -t` rejects the
whole file: keep only the port-80 block, get the certificate, and then add the other two blocks.

```bash
sudo mkdir -p /var/www/certbot
sudo nginx -t && sudo systemctl reload nginx      # while the file has only the port 80 block
sudo certbot certonly --webroot -w /var/www/certbot -d example.com -d www.example.com \
  --deploy-hook 'systemctl reload nginx'
sudo nginx -t && sudo systemctl reload nginx      # after adding the two 443 blocks
```

`certonly` because certbot does not need to edit any nginx file. The certbot package renews on its own through the
`acme-challenge` path in the port-80 block, and `--deploy-hook` makes nginx load the new certificate after each renewal.

Three lines of the example are not decoration:

- `proxy_set_header Host $host`: Next compares the host of the `Origin` header with the request host and cancels every Server
  Action that mismatches. Without this line nginx sends `Host: 127.0.0.1:3000` and every save, upload and reorder button in the
  admin is rejected, and the admin password form cannot sign in.
- `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`: appends the caller's real address at the end of the header, which
  is the entry every per-IP limit reads (counting from the right).
- `client_max_body_size 1m` and, under `location /admin/`, `6m`.

The example states its **TLS floor** itself, in both port-443 blocks: `ssl_protocols TLSv1.2 TLSv1.3`, `ssl_prefer_server_ciphers off`,
`ssl_session_tickets off` and `server_tokens off` (no version in the `Server` header). `certbot certonly` never adds certbot's
`options-ssl-nginx.conf`, so without these lines the protocols, the ticket keys and the version header would depend on whatever nginx
build the distribution ships. There is no `ssl_stapling` on purpose: Let's Encrypt no longer runs OCSP. The lines are in the server
blocks and not at `http` level because a Debian or Ubuntu `nginx.conf` already sets `ssl_protocols` there, and a second one is a
"directive is duplicate" error.

The example also defines a log format that drops the query string from every request (search terms and one-time tokens do not
reach the log; it writes no `Referer` either) and switches logging off for the GitHub callback. It was run on a real nginx
(`DEPLOY_EXAMPLES_DOCKER=1 python scripts/test_deploy_examples.py`). nginx's `error.log` can still copy the request line when the
upstream fails: keep proxy logs short-lived (`logrotate` daily, `rotate 7`).

## Optional: GitHub login for readers

Off by default. Without it the site works fully for visitors, but nobody can comment, like or save posts, and every sign-in
invitation leads to a page saying that sign-in is not enabled. To enable it, create a GitHub OAuth App whose callback is exactly
`<SITE_URL>/api/auth/github/callback`, put `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` into `.env` and run `docker compose up -d`.
The full procedure, the requirements (HTTPS, a single host) and `ADMIN_GITHUB_ID` are in
[CONFIGURATION.md](CONFIGURATION.md#github-login-in-production). The admin always signs in with the password from `/setup` at
`/admin/login`, with or without GitHub.

## Optional: sending newsletter mail

Readers can subscribe at `/newsletter` from the first minute, but with the default `NEWSLETTER_TRANSPORT=log` no mail leaves the
machine. To send real mail you need an SMTP provider (port 587, STARTTLS; or port 465 with `SMTP_PROTOCOL=smtps`), an authenticated sending domain (SPF, DKIM) and five
variables in `.env`: `NEWSLETTER_TRANSPORT=smtp`, `NEWSLETTER_FROM`, `NEWSLETTER_SECRET` (already random after `init-env`; never
change it after the first subscriber), `SMTP_HOST` and the credentials. The backend refuses to start with an incomplete
configuration. See [CONFIGURATION.md](CONFIGURATION.md#newsletter-in-production).

## Optional: Meilisearch search

PostgreSQL full-text search works out of the box. Meilisearch adds partial words, typo tolerance and excerpts, and is a fourth
compose service that only starts with the `search` profile:

```bash
docker compose --profile search up -d --build
```

Switching the engine on is a manual, ordered procedure (indexing first, then a reindex, then the engine switch), with a rollback
that is one variable. It is described in [CONFIGURATION.md](CONFIGURATION.md#search-with-meilisearch). The index is a copy and needs
no backup.

## After the install

- Claim the site, turn on two-step verification and load some content: [FIRST-RUN.md](FIRST-RUN.md).
- Know what you can set: [CONFIGURATION.md](CONFIGURATION.md) and [ADMIN-GUIDE.md](ADMIN-GUIDE.md).
- About two weeks after the site is public and HTTPS is stable: raise HSTS to a year ([Raise HSTS](#raise-hsts-after-https-is-proven)).
- Back up **before you need it**: [BACKUP-AND-RESTORE.md](BACKUP-AND-RESTORE.md). Uploaded images live inside PostgreSQL, so one
  `pg_dump` covers posts and images.
- Update to a newer version: [UPGRADING.md](UPGRADING.md).
- Something does not start: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
