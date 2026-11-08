# Three stages. deps installs, build compiles, runtime carries only .next/standalone — the
# server plus the node_modules it actually reaches, rather than the whole dependency tree
# and the toolchain that produced it.

# The three stages use the same base image, pinned by digest (the tag says which version it is): a tag that moves would put different
# bytes into the published image than the ones that were tested. The Dependabot docker entry updates all three lines
# (scripts/test_image_pinning.py fails on a base image without a digest).
FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# npm ci, not npm install: it installs exactly the lockfile and fails if package.json and
# the lock disagree. An image that silently resolved a different version than the one the
# tests ran against is the worst kind of reproducible build.
# --ignore-scripts: no package runs code of its own while it is installed (as root, with network access). The four packages of the
# lock that have an install script do not need it for this build (frontend/lib/supply-chain/lockfile-install-scripts.test.ts
# names them and fails when a fifth appears).
RUN npm ci --ignore-scripts

FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# The API base URL is read at RUN time by server-side code, not inlined at build time, so
# it is deliberately NOT a build arg. NEXT_PUBLIC_SITE_URL is different: anything
# NEXT_PUBLIC_ is substituted into the bundle during the build, which is why it has to be
# here and cannot be set by docker-compose at startup. Getting that backwards produces a
# site whose canonical URLs and Open Graph tags all say localhost.
ARG NEXT_PUBLIC_SITE_URL=http://localhost:3000
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL

# The default locale (`vi` or `en`) is the one whose URLs carry no `/<locale>` prefix. Build time for the same reason as above:
# it is inlined into the bundle and the routing is decided from it, so changing it means rebuilding the image.
ARG NEXT_PUBLIC_DEFAULT_LOCALE=en
ENV NEXT_PUBLIC_DEFAULT_LOCALE=$NEXT_PUBLIC_DEFAULT_LOCALE

# Same reason, different mechanism: `headers()` in next.config.ts runs once, during this
# build, and the standalone server only replays its result. So the security headers are
# decided here: an https NEXT_PUBLIC_SITE_URL adds `Strict-Transport-Security:
# max-age=$HSTS_MAX_AGE` (86400 when unset or not a number; 0 sends max-age=0, which
# switches HSTS off). Changing either value means rebuilding the image.
ARG HSTS_MAX_AGE=86400
ENV HSTS_MAX_AGE=$HSTS_MAX_AGE

# `true` appends `; includeSubDomains` to that header, for an operator who owns every subdomain of the host and serves all of them over
# https (off by default; never preload). Build time, for the same reason.
ARG HSTS_INCLUDE_SUBDOMAINS=false
ENV HSTS_INCLUDE_SUBDOMAINS=$HSTS_INCLUDE_SUBDOMAINS

# `npm run build` is `next build && node scripts/verify-css.mjs`. The second half is not
# decoration: this project shipped a Tailwind regression that passed every other gate and
# served an unstyled site, and verify-css fails the build if the compiled CSS is missing
# the utilities the pages use. Keeping it in the image build means that cannot ship.
#
# next build also type-checks, so a type error fails the image rather than the deploy.
RUN npm run build

# The image build has no backend, so every page that revalidates (posts, writing, tags, bookmarks, newsletter, profile, case studies, ...)
# was prerendered from the neutral default site content. Next 16.4 serves such a copy once, stale, before it renders against the backend,
# after every restart of the container. In the runtime stage the tree is root-owned on a read-only file system, so the server cannot
# delete the copies at start (lib/runtime-cache.ts does that outside the image): they are removed here, from the tree that is shipped.
# Pages that never revalidate (the icons, the global error page) stay. The step fails when the build wrote no manifest.
RUN node scripts/clear-prerendered-pages.mjs .next/standalone/.next

FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS runtime
WORKDIR /app
ENV NODE_ENV=production

# The address this image was built for, kept for scripts/start-check.mjs: NEXT_PUBLIC_SITE_URL is compiled into the bundle (and decides
# whether the site sends Strict-Transport-Security), so a container run under another SITE_URL would serve a site that names the wrong
# address. The build stage's ENV does not reach this stage; the ARG has to be declared again, with the same default.
ARG NEXT_PUBLIC_SITE_URL=http://localhost:3000
ENV BAKED_SITE_URL=$NEXT_PUBLIC_SITE_URL

# Non-root, and the program is not its own to rewrite: the application tree below is copied as root:root, so the process that runs it
# (and receives the admin password and sets the session cookies) cannot patch server.js or a dependency, which would otherwise
# survive a container restart. The one writable path is Next's cache directory (a copy that is rebuilt on demand).
#
# The same RUN removes what nothing needs at run time and an attacker would like to find: npm, npx, corepack and yarn (the build
# stage has them; `node server.js` needs none), and the Alpine package manager (so nothing can be installed into a compromised
# container), plus the busybox download and relay clients nc and wget (the compose healthcheck uses node itself). The shell and the
# other busybox tools stay for `docker exec`; node has its own networking, so this narrows the toolbox, it does not close it.
RUN addgroup -S nodejs && adduser -S -G nodejs nextjs \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
        /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
    && apk --purge del apk-tools \
    && rm -f /usr/bin/nc /usr/bin/wget

# standalone already contains the pruned node_modules and server.js. `static` and `public`
# are not copied into it by Next and have to come across separately — a detail that fails
# loudly as a site with no CSS and no images, which is at least easy to diagnose.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
# `public` must exist for this COPY (Docker has no conditional copy); the tracked public/images files keep it in git. No dotfile
# placeholder in there: Next serves public/ from the web root and answers GET /.gitkeep with a 500 (frontend/test/docker-context.test.ts).
# No robots.txt or sitemap.xml either: app/robots.ts and app/sitemap.ts generate both, and a static file would shadow the route.
COPY --from=build /app/public ./public
COPY --from=build /app/scripts/start-check.mjs ./start-check.mjs
COPY --from=build /app/scripts/api-base-url-rule.mjs ./api-base-url-rule.mjs
RUN mkdir -p /app/.next/cache && chown nextjs:nodejs /app/.next/cache

USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0

# HOSTNAME=0.0.0.0 rather than the default localhost: a server bound to the loopback
# interface inside a container is unreachable from outside it, and the symptom is a
# connection refused that looks like the process never started.
CMD ["node", "start-check.mjs"]
