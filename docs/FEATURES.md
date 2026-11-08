# Current feature list

What the blog engine does today, grouped by area. The labels V3 to V9 name the development stages a feature came from; they carry no other meaning. Compiled from the routes, backend controllers and migrations. Not every item has been tried by hand. For how to run and configure it, see [INSTALL.md](INSTALL.md) and [CONFIGURATION.md](CONFIGURATION.md); for how it is built, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Overview

A self-hostable, bilingual (English and Vietnamese) blog engine for one person or a small group of authors: posts, series, a photo gallery, case studies, an About page and a newsletter, all editable in an admin area. Everything about the owner is content in the database, not code (section 21).

- **Architecture:** Browser → Next.js (App Router, SSR/ISR) → Spring Boot REST API → PostgreSQL 18.
- **Deployment:** Docker Compose (postgres, backend, frontend) on a single VPS ([INSTALL.md](INSTALL.md)).
- **Security:** the browser never calls the API directly. The Next server calls the backend. The JWT lives in an httpOnly cookie, so no CORS is needed.
- **Stack:** Java 25 / Spring Boot 4 / Flyway (41 migrations, `V1`–`V41`); Next.js / React / TypeScript; Shiki (code highlighting).

## 1. Public pages

- Home (post feed, photo feed), About (an introduction, an optional Markdown body with the same article blocks as a post, and sections).
- Writing (`/writing`): post list, statistics, an Explore block.
- Topics (`/topics`) and the archive by year (`/archive`).
- Best posts (`/start-here`): a pinned, ordered list.
- Series: a list page and a detail page, read in part order.
- Case studies: list and detail.
- Category (`/categories/[slug]`) and Tag (`/tags/[slug]`).
- Full-text search (`/search`), using the Postgres search vector. Removed posts no longer appear. Filters by category, series and tag (V7b, section 14).
- Photo gallery (`/gallery`) with a lightbox, keyboard and swipe support.
- `/random`: opens a random post.
- Newsletter (`/newsletter`, link in the footer; V7c, section 15).
- Contact form: a visitor sends a name, email, optional subject and a message; it is stored (V42), optionally mailed to `CONTACT_RECIPIENT`, and read in the ADMIN-only inbox `/api/v1/admin/contact/messages`.
- A public profile `/u/<slug>` for each person (section 16); the site owner (the first admin account) is redirected to `/about`.
- A sticky header that hides on scroll down and shows on scroll up; a "Back to top" button on long pages (section 16).
- Light/dark theme, its own icon set, cover art generated from the slug, responsive.

## 2. Post page

- Markdown rendered on the server, code highlighted with Shiki, extended with native article blocks (callouts, figures, galleries, comparisons, diagrams, steps, code tabs, details, takeaways, checklists, pull quotes; section 23).
- Breadcrumb, cover image, reading time, author, share buttons. The author box at the end of the post has an avatar and a name that links to the profile `/u/<slug>` (the site owner links to `/about`; section 16).
- **Site-wide reading frame** (every public page; the post page is the reader variant): the header, the menu bar, the page body and the footer sit inside one centred 1400px frame with a hairline on each side, from a window width of 89rem (1424px); below that the frame is fluid. The frame is pure CSS (no JavaScript, no layout shift). The admin area and `/setup` keep their own shell and are not framed. Inside the frame each page uses one of three patterns:
  - **BROWSE** (writing, topics, archive, series, categories, tags, case studies, gallery, search, saved posts, start here, public profiles): a 260px tinted left sidebar (224px at `lg`, 260px from `xl`) with the "Explore" group (the section links and "Start here", the current page marked with `aria-current`, plus a page-specific group where the page has data for one, for example the case studies list) and a fluid main column. Below `lg` the sidebar folds into a closed block above the content, and a skip link jumps from the sidebar to the page content.
  - **SHOWCASE** (home and About): full-frame bands, with the content paired into two-column rows where it helps; text blocks keep a readable line length.
  - **CARD** (login, newsletter, confirm, unsubscribe, error and not-found pages): a centred 768px card inside the frame.
- **Three-column layout of a post page**: on a wide screen the columns are 260px (left sidebar), a fluid centre (908px at full width) and 230px (right column). Below `lg` the sidebar folds into a collapsed block above the article, and below the right-column breakpoint (`rail`, 68rem) the right column folds into the inline table of contents plus an actions toolbar after the article; on a phone it is one column. A case study page keeps its sidebar and gets an "On this page" column from `rail`.
  - **Left sidebar** (full height below the header, hairline on its inner edge, scrolls on its own when taller than the window): an "Explore" group with the section links and a "Start here" link, each with an icon; a collapsible group for the current series (open by default) with a numbered list of its parts, muted numbers and the current part on a grey background (`aria-current`); a collapsible group with more posts of the category; the archive link. Long titles are cut with an ellipsis and the full title shows in a tooltip on hover or keyboard focus (not on touch). A skip link jumps from the sidebar straight to the article.
  - **Hero block** (spans the centre and right columns): breadcrumb, a series badge ("n / m"), the series title, reading time and updated date, the title, the dek, the tags, then an author row with the avatar, the name (linking to the profile) and a Subscribe link to `/newsletter`, and the actions Copy link, Share and Next (the next part of the series, otherwise the next post; hidden when there is none). Copy link lives in the hero only. The cover image opens the article column below it.
  - **Right column**: reading progress, the table of contents with a bar on the section being read, like and save, and the share icons (Facebook, LinkedIn, X, the device share sheet where it exists); the floating "Back to top" button stays at the bottom of the window. Below the right-column breakpoint the progress is a thin bar at the top of the window and like, save and share form a toolbar after the article.
- View counting, with no IP or user agent stored. Since V7c there are also per-day counts and source groups, still aggregate numbers with no row per view (section 15).
- **Comments** (with replies) and a **post like button**, which need a GitHub sign-in (see section 3).
- **Save a post** to read later, with the `/bookmarks` page (V7b, section 14).
- A table of contents from 3 or more h2–h4 headings; since V7b it is nested, highlights the section being read and lives in the sticky right reading rail on wide screens, and as a collapsed `<details>` above the article below that (section 14).

## 3. Reader accounts and GitHub sign-in (V5)

- Readers sign in with a **GitHub OAuth App** from the "Sign in" button in the header, which then shows an account menu. Page `/login`.
- **Off by default.** Without `GITHUB_CLIENT_ID` or `GITHUB_CLIENT_SECRET` the backend still runs, and the sign-in entry points lead to `/login` with a message that sign-in is not enabled.
- The GitHub user's email is neither requested nor stored.
- The first GitHub sign-in always creates a reader account (`USER`); since V7a, an ADMIN can change its role (section 13). To make the owner's GitHub resolve to the admin account itself, set `ADMIN_GITHUB_ID` (the numeric id); the backend attaches that id to the admin account at startup.
- The callback is a Next route: `<SITE_URL>/api/auth/github/callback`.
- Rate limited (`common/ratelimit`).
- How to configure it: [CONFIGURATION.md](CONFIGURATION.md#github-login-in-production) (production) and [INSTALL.md](INSTALL.md#optional-github-login-for-readers); on your own machine, [DEVELOPMENT.md](DEVELOPMENT.md#github-sign-in-on-your-machine).

## 4. Admin / CMS (`/admin`, needs an ADMIN sign-in; AUTHOR since V7a, section 13)

- Sign in, sign out, refresh token. A session that expires mid-use is handled correctly and does not break a Server Action.
- **Two-step verification** (TOTP, RFC 6238): mandatory for admins, optional for authors. An authenticator app, ten single-use recovery codes, a forced enrollment at the first sign-in after an upgrade, replace and regenerate in `/admin/security` (which also has Sign out everywhere), a password change that signs other devices out, a reset of an author from the Users page, and an operator reset for a lost phone ([SECURITY.md](SECURITY.md#two-step-verification-and-recovery)).
- The interface was redesigned in an editorial (Ghost) style for every screen.
- Dashboard, with a **Needs attention** section.
- **Settings** (`/admin/settings`, ADMIN only): the site name, profile, About, skills, timeline, contact and other owner content, per language, with a Markdown import and a sample content loader (section 21).
- **Posts:** create, edit, delete, publish/unpublish, mark as featured (ADMIN only since V7a). The list filters by category and tag. Editing a deleted post gives a 404. A Markdown editor with preview and a cover image (upload, replace, remove); errors show in place and the post being written is not lost.
- **Import posts** (`/admin/posts/import`, ADMIN and AUTHOR, section 22): upload Markdown files, review a preview and confirm; new posts are drafts.
- **Topics** (`/admin/topics`): rename and delete categories/tags (ADMIN only). Quick creation of a category/tag directly in the post editor (`InlineCreate`).
- **Best posts** (`/admin/curated`): set the order.
- **Series:** create, edit, delete with confirmation, assign posts and order the parts; an administrator's import can also create a series and join posts at their declared parts (section 22).
- **Gallery:** upload many images, edit the caption and the date taken, reorder, delete.
- **Comments** (`/admin/comments`): see every comment on every post, newest first; filter by status, search by content or author; hide (can be shown again) or delete (cannot be undone; the content is still kept in the admin).
- **Users** (`/admin/users`): list reader accounts and change their status; change roles (V7a, section 13).
- **Author applications** (`/admin/applications`, V7a): approve or reject applications to become an author.
- **Statistics** (`/admin/analytics`, V7c): views over a date range, most-read posts, sources; ADMIN sees the whole site, AUTHOR sees their own posts (section 15).
- **Newsletter** (`/admin/newsletter`, V7c, ADMIN only): the newsletters of AUTHOR posts that wait for approval, then counts only, no addresses (section 15).

## 5. Backend API (`/api/v1/...`)

- **Public:** `posts`, `posts/search`, `posts/{slug}`, `posts/{slug}/views`, `categories`, `tags`, `series`, `gallery`, `media`, `stats`, `health`; `GET users/{slug}` (public profile) and the `author` parameter of `GET posts`; `POST newsletter/subscriptions`, `newsletter/confirm`, `newsletter/unsubscribe` (no sign-in needed).
- **Comments and likes (writing needs a sign-in):**
  - `GET/POST /posts/{slug}/comments`, `POST /comments/{id}/replies`, `PUT/DELETE /comments/{id}`
  - `GET/PUT/DELETE /posts/{slug}/like`
- **Admin:** `admin/posts`, `admin/categories`, `admin/tags`, `admin/series`, `admin/gallery`, `admin/comments` (`GET`, `PATCH /{id}/status`, `DELETE /{id}`), `admin/users` (`GET`, `PATCH /{id}/status`, `PATCH /{id}/role`), `admin/author-applications` (`GET`, `POST /{id}/approve`, `POST /{id}/reject`), `admin/analytics` (`GET`, V7c), `admin/newsletter` (`GET`, ADMIN only, V7c).
- **The caller's own author application (needs a sign-in):** `GET/POST /me/author-application`.
- **The caller's own saved posts (needs a sign-in, V7b):** `GET /me/bookmarks`, `GET/PUT/DELETE /me/bookmarks/{slug}`.
- **First run and site content (V9, section 21):** `GET setup/status` and `POST setup` (setup code), `GET site-content?locale=`; `admin/site-content`, `admin/site-import`, `POST admin/sample-content` (ADMIN only). Full table: [backend/README.md](../backend/README.md#setup-site-content-import-and-sample-content).
- **Post import (section 22):** `GET admin/post-import/template`, `POST admin/post-import/preview`, `POST admin/post-import/apply`, `GET admin/post-import/status` (ADMIN and AUTHOR). Full table: [backend/README.md](../backend/README.md#post-import).
- **Auth:** `login` (200 with tokens, or 202 with a challenge when a second step is needed), `mfa/verify`, `mfa/enroll/begin`, `mfa/enroll/confirm`, `logout`, `refresh`, `me`. Passwords hashed with Argon2id; refresh tokens stored in the DB (replaced on every use; 30 days for a reader, 7 days idle and 30 days in all for an admin or author, both configurable).
- **The caller's own security (needs a sign-in):** `GET /me/mfa`, `POST /me/mfa/enroll/begin|confirm`, `POST /me/mfa/recovery-codes/regenerate`, `POST /me/mfa/replace/begin|confirm`, `DELETE /me/mfa`, `POST /me/password`; an administrator resets an author with `POST admin/users/{id}/mfa/reset`. Full table: [backend/README.md](../backend/README.md#endpoints).
- Swagger UI at `/swagger-ui.html`, off by default (`SPRINGDOC_ENABLED`, see [CONFIGURATION.md](CONFIGURATION.md)). The endpoint reference is [backend/README.md](../backend/README.md#endpoints).
- Pagination: at most 100 posts per page.

## 6. Image processing

- Magic-byte check, EXIF rotation, downscaling, re-encoding to strip metadata.
- Unusual images are rejected: lossless JPEG, oversized progressive JPEG, images that claim a side longer than 65,535 pixels; Display P3 PNGs are converted to sRGB.
- Images are stored in Postgres and served immutably through `/api/v1/media`. There is an image quota and a body size limit.
- **Sharpness:** the stored file is a high-quality master (long edge up to 2400 px, JPEG quality 0.92). The site serves it through `/_next/image` as AVIF with a WebP fallback, in the widths the layout needs for 1x to 3x screens, once re-encoded at quality 75 (thumbnails) or 85 (post cover, gallery tiles, the viewer); optimized copies are cached for a year. Next.js never enlarges an image, so the admin cover panel warns when a cover is narrower than 1200 px (2400 px is recommended).

## 7. SEO

- `sitemap.xml` (it also lists profiles of authors who are not the site owner and have published posts; reader profiles are `noindex` and outside the sitemap), `feed.xml` (RSS; since V7b it carries the full post, and there are separate feeds for categories, series and tags, section 14).
- JSON-LD for posts, series and the Best posts page, CollectionPage for the list pages; a visible breadcrumb on the series page.
- Per-post OG image (a post with a cover image uses the 1200px version), centralized metadata (`frontend/lib/metadata.ts`).
- `/admin` is blocked from indexing.
- Pages are built to score well in Lighthouse (accessibility, best practices, SEO); run it against your own production build to measure your site.

## 8. Cache and performance

- ISR: lists and single posts are cached for 300 seconds (tag `posts` and a per-slug tag), search is cached for 60 seconds (tag `search`).
- Publishing or editing a post in the admin clears the cache at once with `updateTag`. Content written outside the admin (calling the API directly) shows up when the cache expires, up to 5 minutes; on a page nobody has opened for a long time, the first visit still gets the old version while Next refreshes it in the background. The sitemap and every feed read straight from the backend each time, with no cache; since V7b the HTML of posts in the feeds is remembered in the process by post URL + `updatedAt`.

## 9. Content and operations

- A fresh install is empty. An admin can load four neutral sample posts from the Settings page (section 21).
- Documentation: [INSTALL.md](INSTALL.md), [CONFIGURATION.md](CONFIGURATION.md), [UPGRADING.md](UPGRADING.md), [BACKUP-AND-RESTORE.md](BACKUP-AND-RESTORE.md) (images included, and clearing the image cache), [SECURITY.md](SECURITY.md), [TROUBLESHOOTING.md](TROUBLESHOOTING.md), [ADMIN-GUIDE.md](ADMIN-GUIDE.md) and [DEVELOPMENT.md](DEVELOPMENT.md).
- Test suites: frontend (Vitest), backend (JUnit and Testcontainers), E2E (Playwright, with a "fake GitHub" running on loopback for sign-in, security, comments, post likes, moderation, an author's journey, saved posts and the newsletter; no real mail is sent). CI (`.github/workflows/ci.yml`) runs the suites on every push; `codeql.yml` and `release.yml` cover code scanning and releases. E2E is run by hand because it needs a whole running stack ([DEVELOPMENT.md](DEVELOPMENT.md#e2e-playwright)).

## 10. Not available yet / not confirmed

- Newsletter / email subscription: available since V7c (section 15); **sending real mail is not verified** (there is no SMTP provider yet).
- Languages: English and Vietnamese only. Adding a third language needs a migration and a frontend change, so it comes with a release, not with a setting ([CONTENT-AND-I18N.md](CONTENT-AND-I18N.md#add-a-language-end-to-end)).
- External analytics: none. Since V7c there are first-party view statistics (per day, source, most-read posts; section 15); there are no unique visitors or sessions.
- A separate media library: not yet (images inside a post body are attached to that post, section 12). Bulk actions on posts: available since V6. A warning when leaving the page with unsaved changes already exists, since the V3 admin redesign: the post editor asks again when the tab is closed or reloaded (`beforeunload`), and when an in-app link is clicked while there are unsaved changes.
- Running the E2E suite against your own stack is described in [DEVELOPMENT.md](DEVELOPMENT.md#e2e-playwright).

## 11. Notifications, comment likes, comment timestamps (V6)

- **Notifications** for signed-in readers: someone likes or comments on their post, or replies to or likes their comment. A person's own actions (liking or replying to themselves) create no notification; neither does an unpublished post. A bell in the header with the unread count, and the `/notifications` page (filter all / unread, mark as read, mark all, delete). No email, no push, no websocket: the frontend asks for the unread count on page load, when returning to the tab and every 60 seconds.
- **Comment likes:** a heart and a like count on every comment; guests only see the count. It shares the limit of 30 likes per minute with post likes.
- **Comment timestamps:** each comment shows the date and time it was posted in the reader's time zone, and the edit time when it is "edited".
- **API:** `PUT/DELETE /comments/{id}/like`; `GET /notifications`, `GET /notifications/unread-count`, `POST /notifications/{id}/read`, `POST /notifications/read-all`, `DELETE /notifications/{id}`. Migration `V21` (comment likes), `V22` (notifications).
- **Notifications about a post go to the post author's account**, that is the admin. The site owner only sees them when signing in to the admin with the password, or with a GitHub account linked through `ADMIN_GITHUB_ID`. A GitHub account that is not linked is a separate reader account: it does not see them, and its likes and comments are reported to the admin ([backend/README.md](../backend/README.md#the-admin-account-admin_email-admin_password) and [CONFIGURATION.md](CONFIGURATION.md#link-the-admin-account-to-github)).

## 12. V6: security, search, editing, operations

Upgrade guide: [UPGRADING.md](UPGRADING.md); the startup checks are listed in [CONFIGURATION.md](CONFIGURATION.md#startup-checks-of-a-public-site) and [SECURITY.md](SECURITY.md#startup-refusals).

- **Production security.** When `SITE_URL` is public, the backend refuses to start with the dev `JWT_SECRET` or when the admin still has the dev password, and always refuses the dev password at sign-in. `ADMIN_EMAIL` renames the existing admin's email.
- **Sign-in and view limits.** Admin sign-in is 10 attempts per 10 minutes per IP in Next and 20 per 10 minutes per client address in the backend; the backend checks only a few passwords at the same time. Views use the IP of the trusted proxy, 30 beacons per minute per IP. IPv6 is counted per /64.
- **Limits by client address in the backend.** Next forwards the reader address it derives to the backend, proved by the shared `CLIENT_IP_TOKEN`; the backend then limits the contact form, newsletter, sign-in, refresh, first-run setup and search per address, on top of the per-email limits and a whole-site ceiling for the contact form, newsletter mail and search, so a backend reached without Next is not unlimited.
- **Deployment defaults.** Compose publishes Next only on 127.0.0.1, `VIEWS_TOKEN` and `CLIENT_IP_TOKEN` are required. Swagger is off by default. Next sends `nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS when the site is https, and no longer sends `X-Powered-By`.
- **Public taxonomy** only contains categories and tags that have published posts; a slug with only drafts returns 404.
- **Accent-insensitive search** (`unaccent`, migration `V23`): "hoc" finds the accented h&#x1ECD;c, "duong" finds the accented &#x110;&#x1B0;&#x1EDD;ng. `/search` highlights keywords, focuses the search box automatically, supports the `/` key, and shows "Suggested reading" when there are no results (filters since V7b, section 14).
- **Renaming a slug does not break links** (`V24`): the old slug of a published post returns a 308 to the new slug.
- **Post page.**
  - A "Copy code" button on every code block.
  - "Updated <date>" when the post was edited after its publication date.
  - Related posts by shared category and tags; previous/next across all published posts.
  - A table of contents from 3 entries, collapsed on mobile (V7b added nesting and scroll-spy; it now lives in the sticky right reading rail of the post page; section 14).
  - The print version contains only the post, always light.
  - A "Site owner" badge on the site owner's comments (since V7a: only the seeded admin account, not every ADMIN).
- **SEO and cache.** The sitemap `lastmod` follows the edit date. The sitemap and feeds read straight from the backend each time. RSS has at most 20 posts (since V7b it carries the full post, section 14). Error pages keep the header/footer. `color-scheme` follows the site theme.
- **Editing.**
  - Drafts are autosaved on the machine, with restore.
  - Preview a draft like the real page.
  - Images in the post body (`V25`): insert, paste, drag and drop; there is a list of the post's images.
  - Revision history with restore (`V26`): 20 versions, merging saves within 10 minutes.
  - Pre-publish checks. Download as a ZIP package that the post import reads back. Duplicate a post.
- **Admin.**
  - Post list: sorted by "Recently edited", per-row and bulk actions.
  - Merge tags, move posts and then delete a category.
  - Moderation filter by post.
  - Image storage bar.
  - Skip link.
  - Removed the "archived" status (it was never assigned).
- **Sign-in sessions.**
  - A nightly job cleans up expired refresh tokens.
  - Reusing a rotated token revokes all sessions of that person.
  - Changing `ADMIN_PASSWORD` revokes the admin's old sessions.
- **Operations.**
  - Compose log limits.
  - CI on GitHub Actions (frontend, backend, python).
  - Runbooks: TLS with Caddy or nginx ([INSTALL.md](INSTALL.md#tls-with-caddy)), backup and restore ([BACKUP-AND-RESTORE.md](BACKUP-AND-RESTORE.md)), upgrade, roll back and post-upgrade checks ([UPGRADING.md](UPGRADING.md)), changing `JWT_SECRET` ([SECURITY.md](SECURITY.md#rotating-jwt_secret-and-ending-sessions)).
  - Indexes `post_tags(tag_id)` and `posts(category_id)` (`V27`).
  - Clamping the page number in the public API.
- **Deliberately deferred (P4):** a CSP with a nonce, scheduled publishing, `loading.tsx`, image zoom, a view chart (done in V7c, section 15), comment counts on lists, a UI for AUTHOR (done in V7a, section 13), admin shortcuts, ISR for dynamic pages, merging request chains. Also deferred: a sticky table of contents, scroll-spy and full-content RSS (all three done in V7b, section 14), and "sign out everywhere" in the UI.

## 13. V7a: roles, a CMS for authors, author applications

- **Role changes** at `/admin/users` (`PATCH /admin/users/{id}/role`, ADMIN only): confirmed by retyping the login; a change to or from ADMIN, or a reader becoming an author (also by approving an application), asks for the acting admin's own code and a recent sign-in, and a promotion to ADMIN removes the account's authenticator so it enrols again with the enrollment code. At least one active ADMIN always remains; the site owner's role can only be changed by the site owner; an account that is suspended cannot be promoted. A real change revokes every refresh token of that person and writes a log line with ids only. Limited to 20 per 10 minutes per admin.
- **Effective immediately:** an ADMIN/AUTHOR token is checked against the role and status in the DB on every request, so a demotion takes effect on the next request. A promoted reader has to sign in again.
- **A CMS for authors:** an AUTHOR enters `/admin` (the "Sign in with GitHub" button at `/admin/login`) and sees "My posts": write, edit, publish, unpublish, delete, download as a ZIP package, duplicate, revision history, preview, cover image and body images, create categories and tags in the editor. Admin-only pages and other people's posts show a "no permission" state. "Featured posts" becomes ADMIN only.
- **Public author attribution:** a post has an `author` (name, GitHub login, avatar, site-owner flag); a minimal author box for other authors, JSON-LD, `dc:creator` in RSS and the OG image all use the actual author. The "Site owner" badge follows only the seeded admin account. There is a public profile `/u/<slug>` per author with the published posts (section 16).
- **Application to become an author** (`V28`): a reader submits it at `/profile` ("Apply to become an author"), with an optional note of at most 500 characters, one pending application per person; after a rejection they may only apply again 30 days later; 5 submissions per hour. An ADMIN approves (by retyping the login) or rejects it at `/admin/applications`. There is no way to withdraw an application and no notification is sent.

## 14. V7b: smart table of contents, advanced search, saved posts, full RSS

- **Table of contents:** still built from 3 or more h2–h4 headings, now a list nested by level. The section being read is highlighted by scroll position, by the `#section` in the URL and by the Back button (`aria-current="location"`). On the public post page the table of contents is the sticky list of the right reading rail from the rail breakpoint (68rem), and a collapsed `<details>` above the article below it; the admin preview always shows the collapsed `<details>`, at every width. Jumping to a section leaves 32px above it, with no smooth scrolling; the height of the sticky header (`--site-header-h`) is added, and the sticky table of contents sits below the header.
- **Advanced search:** filter by category, series and up to 5 tags; all filters are ANDed; filters without any text list the matching posts, newest first. `/search` has a "Filters" block, a chip to remove each filter and "Clear filters"; pagination keeps the filters; a page with a keyword or a filter is `noindex`.
- **Bad parameters no longer give a 500 or 409:** `q` over 200 characters, more than 5 tags and a broken `%` code are 400; NUL is dropped from `q`; a malformed slug gives an empty page (`GET /posts` too). No index was added: `EXPLAIN` on 2,000 fake posts showed the existing indexes are enough.
- **Code in posts is searchable**, within the limits of Postgres tokenization ([backend/README.md](../backend/README.md#search)): `json.loads` is one word, `snake_case` is split, `C++`/`C#` become `c`, and there is no substring search.
- **Saved posts** (`V29`): a "Save post" button next to the like button; the `/bookmarks` page ("Saved posts" in the account menu), newest saved first, unsave, load more; `noindex`, outside the sitemap. An unpublished post is hidden and shown again when republished; deleting a post removes the saves with it. 30 saves/unsaves per minute per person. A suspended account can neither view nor save. Merging a GitHub account into the admin also moves its saved posts.
- **Full RSS:** each item carries the whole post in `content:encoded` (HTML sanitized like the post page, no Shiki, absolute URLs), `description` stays a short description, at most 20 items. Separate feeds `/categories/<slug>/feed.xml`, `/series/<slug>/feed.xml`, `/tags/<slug>/feed.xml`; the category, series and tag pages advertise both the general feed and their own feed. Added the dependency `hast-util-to-html` 9.0.5.
- **New API:** the `category`, `tag` and `series` parameters of `GET /posts/search`; `GET /me/bookmarks`, `GET/PUT/DELETE /me/bookmarks/{slug}`.
- **New E2E:** `e2e/bookmarks.spec.ts`; scroll-spy and hash in `e2e/article.spec.ts`; `seo`, `overflow` and `security` add `/bookmarks`, the filter pages and the saved-post route.

## 15. V7c: first-party view statistics, newsletter

Stored data and privacy: [backend/README.md](../backend/README.md#analytics), [backend/README.md](../backend/README.md#newsletter), [SECURITY.md](SECURITY.md#data-the-site-stores) and, for production mail, [CONFIGURATION.md](CONFIGURATION.md#newsletter-in-production).

- **Views per day** (`V30`, `post_view_daily`): every view still adds to the `post_views` total as before, and in the same transaction adds to the row (post, day in `ANALYTICS_TIME_ZONE`, source group). No IP, UA, URL or referrer host, no session or visitor identifier, no row per view; this reverses the V16 decision "do not store per view" in a way that is still aggregate. The day series starts on the deployment day, with no old numbers; it is kept indefinitely.
- **Sources:** the beacon sends the host of the previous page (after navigation inside the site, the site's own host); the backend files it under `direct`, `search`, `social`, `github`, `internal` or `other` from a fixed list, without storing the host.
- **Wider bot filtering** at `/api/views`: empty UA, command-line tools and HTTP libraries, headless browsers, Lighthouse, SEO and AI crawlers. It reduces bots, it does not remove them all.
- **The Statistics page** (`/admin/analytics`; ADMIN sees the whole site, AUTHOR their own posts, filtered in the backend): a date range (30 days by default, at most 366), totals for the range and for all time, a small SVG chart beside the day table, the 10 most-read posts, six source groups with percentages, an empty state. The figure is "recorded views", not unique visitors or sessions.
- **Newsletter** (`V31`): the `/newsletter` page (form + a privacy sentence; a "Newsletter" link in the footer). Two-step signup, and the signup response is always the same; the confirmation token lasts 48 hours, only its SHA-256 is stored, and it is single use; unsubscribing needs no sign-in, using an HMAC token with no expiry, including the mailbox one-click unsubscribe button (RFC 8058); unsubscribing deletes the address and keeps only a blocking hash; a pending signup older than 7 days is deleted. The confirmation and unsubscribe pages are `noindex`, GET changes nothing, `Referrer-Policy: no-referrer`.
- **Sending mail:** only when a post is published for the first time (an outbox in the same transaction). When an AUTHOR publishes, the issue is `HELD` until an ADMIN releases it (`POST /admin/newsletter/issues/{postId}/release`, with the `version` of the list row it read: 409 if the post changed since) or discards it (`.../discard`); `GET /admin/newsletter/held` lists them (V48); a background worker with `FOR UPDATE SKIP LOCKED`, 5 retries (1 minute to 12 hours) and then `DEAD`, the error stored as a safe code, at least once. Plain-text mail: subject, short description, post URL, unsubscribe link, `List-Unsubscribe` header.
- **Mail:** the default transport `log` sends no mail; `smtp` only when `NEWSLETTER_TRANSPORT=smtp`, and the backend refuses to start if `SITE_URL` is not a public https URL, `NEWSLETTER_FROM` is invalid, `SMTP_HOST` is empty or `NEWSLETTER_SECRET` is shorter than 32 bytes. **Sending real mail: NOT VERIFIED** (there is no SMTP provider yet and no real mail has been sent).
- **The Newsletter page** (`/admin/newsletter`, ADMIN only): the number of people by status, the number of block rows, the last 10 sends, errors by code; no addresses.
- **Limits:** per IP in Next (signup 5, confirm 20, unsubscribe 20 per hour); per address in the backend (`newsletter-signup` 3 per hour, silent when exceeded; `newsletter-token` 20 per hour).
- **Admin menu:** "Statistics" right after "Posts" (ADMIN and AUTHOR), "Newsletter" last (ADMIN only).
- **New API:** `GET /admin/analytics`, `GET /admin/newsletter`; `POST /newsletter/subscriptions`, `/newsletter/confirm`, `/newsletter/unsubscribe`; the `X-View-Referrer` header of `POST /posts/{slug}/views`. New environment variables: `ANALYTICS_TIME_ZONE`, `NEWSLETTER_TRANSPORT`, `NEWSLETTER_FROM`, `NEWSLETTER_SECRET`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_STARTTLS`.
- **New E2E:** `e2e/newsletter.spec.ts`; `seo`, `security`, `overflow` and `navigation` add the newsletter pages and routes; the view spec in `e2e/article.spec.ts` changes `HeadlessChrome` to `Chrome` in the UA, because the route treats a headless browser as a bot.

## 16. Sticky header, back to top and public profiles

- **Dynamic sticky header** (T-001): the public header is sticky, hides on scroll down and shows on scroll up.
  - It does not hide within the first `max(100px, 2 times the header height)` of the page; it only changes state on a difference of 8px (4px going up); the transition uses `transform`; motion is turned off when the user prefers reduced motion.
  - It only becomes sticky after its height has been measured, so the server HTML and the page without JS keep the old header.
  - Always shown when keyboard focus is inside the header or a menu is open; a mouse click does not pin the header.
  - `--site-header-h` (default 0px, unchanged in the admin) feeds the `scroll-padding-top` of `<html>`: anchors and keyboard focus do not end up under the header. The sticky rails and the "currently reading" bar of `TocSpy` follow this variable too.
  - The account and notification menus return focus to their button with `preventScroll`.
- **"Back to top" button** (T-002): one button in the public layout, bottom right.
  - Shown only when the page is longer than 4 screens and has been scrolled past 1.5 screens; hidden while typing in an input and when printing.
  - An icon with text (the text is hidden below `sm`, the accessible name stays); clicking it goes to the top of the page and then puts focus on `#main-content`.
- **Public profile `/u/<slug>`** (T-003; migration `V32`, `users.public_slug`):
  - `public_slug` is a unique handle that never changes, even when the GitHub login changes. Existing accounts are filled from the GitHub login, or from the display name if there is none; new people get a slug at their first GitHub sign-in, under an advisory lock.
  - `GET /api/v1/users/{slug}` returns only the name, GitHub login, avatar, site-owner flag, join date and number of published posts; no email, role, status or id. A missing slug, a malformed one or a person who is suspended all give an identical 404. `GET /api/v1/posts` gains an `author` filter; `profileSlug` is on the author of a post and of a comment (null for a suspended person, so there is no link).
  - The `/u/<slug>` page: avatar, name, GitHub, an "Author" badge, join date, published posts with pagination. The site owner is redirected to `/about`; reader profiles are `noindex`. Author profiles are in the sitemap and the `author.url` of the post JSON-LD points to them.
  - The name and avatar in comments and in the author box at the end of a post link to the profile (the author line at the top of the post does not). Suspending or unsuspending an account refreshes the `users` tag; the profile cache also carries the `posts` tag.
- **Site owner avatar in the author box** (T-004): if the site owner has not set `profile.avatar`, the GitHub image of the site owner's account is used (when linked through `ADMIN_GITHUB_ID`); still no initial-letter circle.
- **New E2E:** `e2e/scroll-ui.spec.ts`, `e2e/profile.spec.ts`.
- **Privacy note:** the public profile exposes the GitHub login and avatar of a reader at `/u/<slug>`, which were visible before only in comments. The page is `noindex` and outside the sitemap for readers, and a suspended person's profile is a 404.

## 17. V8a: quick search panel (Ctrl/⌘+K)

- **Opening it:** click the search button in the header, press `/` (outside an input), or Ctrl/⌘+K (even while typing). There is a single keyboard handler in the header. Ctrl/⌘/Shift/Alt + click, the middle button, no JS or a chunk that fails to load all still leave a plain link to `/search`. On `/search`, all three put the cursor in the page's own box.
- **The panel:** a native modal `<dialog>`; the input is an ARIA combobox, the results are a grouped listbox, and every row is a real link. ↑/↓ wrap around, Home/End, Enter opens, Esc closes and returns focus. Tab is not taken over: switch tabs with ←/→ on a tab or Ctrl/⌘+←/→ from the input.
- **Tabs:** All · Posts · Topics · Series · Case studies · Authors, showing only the kinds that have results; there is no Code tab (code lives in the post body and cannot be detected cheaply).
- **Before typing:** quick navigation (the 4 nav items + Topics, Archive, Series, Photos, Newsletter, with descriptions shared with the page metadata), "Saved posts" when signed in, "Most read" only when real views pass a threshold, "Recent searches" (in `localStorage` only, at most 5, can be cleared, and are cleared by every sign-out). A single character only filters locally, with no network call.
- **Search as you type:** from 2 characters, a 180 ms debounce, the old request is cancelled, an old response does not overwrite a newer one, a small cache per opening. Enter while the results still belong to the previous query goes to `/search?q=…`. No search while an input method is composing text.
- **Sources:** posts through the existing Postgres search (whole-word match, like `/search`); topics (with post counts), series, authors with published posts (the site owner goes to `/about`), case studies, and static pages are filtered locally by word prefix, ignoring accents. No internal id, email or status is exposed.
- **States:** loading (a grey skeleton only the first time), results, no results (a hint for the next step), "Can't search right now" (broken route, timeout) and "You're searching a bit fast" (429) are all clearly different.
- **New routes:** `GET /api/search/suggest?q=&type=` (same-origin, 120 requests/minute/IP, `no-store`, 3 s timeout, 400/403/429/502/504, does not echo `q`), `GET /api/search/popular`. Contract `{ query, groups: [{ type, total, items: [{ id, title: Segment[], description?, href, meta? }] }] }`, no HTML.
- **Privacy:** `searchPosts` no longer goes through the Next data cache (previously every query sat in `.next/cache/fetch-cache`); API errors do not carry the query string; `next dev` does not print the URLs `/search`, `/api/search`.
- **Interface:** below 640px it is a full-screen sheet (resized by `visualViewport` when a virtual keyboard is open); from 640px it is a top-anchored panel, at most 48rem wide (56rem from lg) and at most 85dvh tall. Solid background, one shadow, no motion, hidden when printing. BackToTop is hidden while a modal dialog is open.
- **No new dependency.**

## 18. V8b: Meilisearch behind the same search contract

- **One endpoint, two engines:** `GET /api/v1/search` (public, a shared ceiling of 1200 per minute; in Next 120 per minute per IP, one shared bucket for the quick search panel and the `/search` page) returns groups of posts, topics, series, case studies, authors and pages, with pre-highlighted `Segment[]`, `engine` and `degraded`. `SEARCH_ENGINE=postgres` (default) or `meilisearch`. The quick search panel and `/search` both use it.
- **Meilisearch** `v1.54.3`, a `RestClient` client (no SDK), two scoped keys (search, indexing) derived from the master key; the master key stays in the backend only. Prefixes, typos, technical tokens (`C++`, `C#`, `json.loads`, `Next.js`), body excerpts. Text the post page does not show (HTML comments, `<script>` and `<style>` content) does not enter the index; a query with no letters or digits matches nothing, like Postgres.
- **Safe reads:** after Meilisearch returns ids, the backend re-checks visibility with one query per kind (published posts by an active author, topics/series that still have posts, authors that still have posts): unpublishing a post or suspending an author takes effect immediately even if the index has not caught up. When the engine fails (lost connection, over 800 ms, 5xx, missing index), the Postgres result is returned with `degraded: true`, counted and logged at most once a minute, and the query is never logged.
- **Sync:** the `search_outbox` table (`V33`) is written in the same transaction as every change to posts, categories, tags, series, author suspend/unsuspend and GitHub renames; a worker sends in batches (SKIP LOCKED, waits for tasks, backs off, FAILED after 10 attempts); reconciliation by `contentHash` every hour and after every rebuild. Guarantees: at least once, eventually consistent, and reads fail closed immediately.
- **Admin:** `POST /api/v1/admin/search/reindex` (ADMIN only, a dry run by default, builds a new index and then swaps, and never drops the serving index before the new one is complete) and `GET /api/v1/admin/search/status` (engine, index, document counts by type compared with Postgres, outbox, last reconciliation, counters).
- **Operations:** a `meilisearch` service in the compose `search` profile (`127.0.0.1:7700`, 512 MiB, no telemetry); setup in [CONFIGURATION.md](CONFIGURATION.md#search-with-meilisearch); the backend refuses to start on a public site with a short master key or the placeholder value. The index needs no backup: restoring means rebuilding.
- **Search and suspended authors:** posts by a temporarily suspended author do not appear in search results in either engine (`/api/v1/posts/search` included); the `/posts` list is unchanged.
- **No new Maven or npm dependency.**

## 19. V9: two languages in the interface

- **URLs:** the default locale (`DEFAULT_LOCALE` in `.env`, `en` unless you change it; baked into the frontend at build time as `NEXT_PUBLIC_DEFAULT_LOCALE`) has no URL prefix; the other language lives under `/<locale>/...` (pages, feeds, sitemap entries). `/<default>/...` redirects to the unprefixed URL; an unknown prefix is the 404 page. `/admin`, `/setup`, `/api`, `/media`, `/random` have no prefix. There is no language detection from `Accept-Language`: the reader chooses by link, so a page is the same for every visitor and stays cacheable ([CONTENT-AND-I18N.md](CONTENT-AND-I18N.md#url-scheme)).
- **Switcher:** the header has a language dropdown (a flag pill that opens a list of flags and names with a check on the current one; a native `<details>` with plain links, so it works without JavaScript, and it keeps the current page); the admin has one too (cookie `admin_locale`). The search panel stays the only owner of the `/` and Ctrl/⌘+K shortcuts; the dropdown listens for Escape only, and only while it is open.
- **Head and SEO:** `<html lang>`, canonical, `hreflang` alternates (with `x-default`), `og:locale`, JSON-LD `inLanguage` and RSS `<language>` follow the page locale; the sitemap lists both languages with alternates, but only between pages that really exist in both (section 20).
- **Text:** every piece of interface text, public and admin (labels, `aria-label`, `alt`, placeholders, metadata, error and empty states, toasts, the search panel), comes from the message catalogs `frontend/messages/{en,vi}.json`; a test checks equal keys and ICU arguments, no missing or unused key and no literal user-facing text in components. Signing in, a failed sign-in and the search form keep the reader on the language they were reading.
- **Formatting:** numbers, dates, relative times, sorting and case mapping follow the page locale.

## 20. V9: posts and topics in two languages

- **Each post has one language** (English or Vietnamese) and can be linked to its translations in a translation group. Lists, search, feeds and the sitemap show a language's own posts; a page with nothing in the current language says so and links to the other language. The article offers "Read this article in another language" only when a published translation exists; `hreflang`, canonical and sitemap alternates exist only between real published translations, so a draft translation never leaks. A post canonicalizes to itself. The slug stays globally unique.
- **Admin:** a language selector in the editor, a Translations panel (create a draft translation that copies title, description, category and tags, link an existing post, unlink), a language filter in the post list, and English names and descriptions for categories and tags in `/admin/topics`. An author can only link their own posts; linking posts of two authors is an admin action.
- **API:** `lang` on `GET /posts`, `/posts/search`, `/categories`, `/tags`, `/series` and `/search` (absent = all languages, unknown = 400); post responses carry `language` and `translations` (published only); `GET/POST/PUT/DELETE /admin/posts/{id}/translations`.
- **Newsletter:** a subscriber has a language; the confirmation and the new-post mail are sent in it, and only for posts of that language.
- **Search:** PostgreSQL search keeps its Vietnamese-friendly configuration for both languages (English words are not stemmed); Meilisearch gets a `language` filter (apply it with an admin reindex; until then the engine falls back to PostgreSQL).
- More: [CONTENT-AND-I18N.md](CONTENT-AND-I18N.md) (including how to add a language) and [docs/CONVENTIONS.md](CONVENTIONS.md), sections 4 and 5.

## 21. V9: site content, first-run setup, profile import, sample content

- **Site content per language.** Everything "about one person" (site name, tagline, profile, About, skills, now, timeline, contact, blogroll, case studies) is stored in the database, one version per key and language (`site_content`), and edited in `/admin/settings` (ADMIN only). No owner text is in the code: a fresh install shows neutral placeholders from `frontend/content/defaults`, and a language without a row falls back to the default language. The last 10 versions of each section can be restored, and a whole language can be exported and imported as JSON. Public pages read it through `getSiteContent(locale)`; saving in the admin shows at once ([ARCHITECTURE.md](ARCHITECTURE.md#site-content-and-first-run-setup), [ADMIN-GUIDE.md](ADMIN-GUIDE.md#settings-the-content-of-the-site)).
- **Markdown profile import with undo.** In Settings an admin downloads a template (per language, with instructions for an AI assistant), uploads one `.md` file and sees a preview computed by the backend: each section is new, will change (with before and after), unchanged, missing, error or ignored. The admin picks the sections and a mode (create only, or update) and confirms; the public pages change in the language of the file. A missing value never deletes. The previous versions are kept and **Undo last import** restores them unless a section changed since; an export in the same format round-trips. The import log keeps hashes and counts, never content. Format: [site-profile-format.md](site-profile-format.md).
- **First-run `/setup` with a setup code.** A fresh database has no usable credential: the seeded development password is disabled at startup. The public `/setup` page claims the instance with a setup code, either `SETUP_TOKEN` or a random code the backend writes once to `<SETUP_DATA_DIR>/setup-code` (never to the log). The claim gives the seeded admin account your name, email and password, revokes its sessions and closes `/setup` (404). Attempts are rate limited, and an existing database is never claimable. See [FIRST-RUN.md](FIRST-RUN.md) and [SECURITY.md](SECURITY.md#first-run-setup-code).
- **Sample content loader.** In Settings, the **Sample content** panel has a **Load sample content** button (ADMIN only; `POST /api/v1/admin/sample-content`). It adds four published posts (a welcome post and a "writing in Markdown" post, each in English and Vietnamese, linked as translations), the series "Getting started", a category and two tags. It is idempotent: it reports what it created and what already existed, and pressing it again changes nothing. The posts belong to the caller, and like any first publish they queue newsletter mail ([ADMIN-GUIDE.md](ADMIN-GUIDE.md#sample-content)).

## 22. Post import from Markdown files

- **Import posts.** From the posts list (a secondary button, also in the empty state), an admin or an author reaches `/admin/posts/import`. The page downloads a template per language (the exact keys with their limits, instructions for an AI assistant and a neutral example post taken from the packaged sample posts), takes up to 20 files (`.md` files of 256 KiB, or [ZIP packages](post-file-format.md#zip-packages), 4 MiB in all), shows a preview computed by the backend, and applies the ticked files in one all-or-nothing step: a new slug creates a draft, the current slug of a post the caller may manage updates that post ([ADMIN-GUIDE.md](ADMIN-GUIDE.md#import-posts-from-markdown-files)).
- **Always drafts, never published.** New posts are drafts owned by the person who imports and are absent from every public response. `status` and `featured` in a file are ignored (an import never publishes, unpublishes or features a post); no newsletter is queued.
- **Preview first, and nothing written by it.** Each file is a new post, a change to an existing post (with before and after), unchanged or an error, with the slug that will be used and where it came from, the language (the site default when the file names none), the categories and tags that will be created, for an administrator's file the series that will be created and the series and part each post will take, and the keys that are ignored. An error names the key and the line, never text from the file. Confirm checks that the files are the previewed ones and that nothing changed since (a slug taken, a post edited, a draft published), and writes nothing otherwise.
- **Download ZIP: the import in reverse.** The "Download ZIP" button of the editor and of the post list saves the saved version of a post (drafts included) as a ZIP package in the format the import reads ([post-file-format.md](post-file-format.md)): `article.md` with the front matter (including the slug, the language, the translation link and, for a post in a series at a declared part, the series keys) and the images of the post under `assets/`, with the image links rewritten to match. Conversion works both ways: a package becomes a post, and a post becomes a package that the import reads back as the same post. An author downloads their own posts, an administrator any post; a post too large for a package is refused with a message. The earlier single Markdown file stays at `/admin/posts/<id>/export?format=md`; a test keeps the documented keys and limits in line with the parser.
- **Log without content.** Each apply is one row in `post_import_log` (V40): who, when, file count and sizes, the SHA-256 of each file and, per post, its id and counts. Never a title, a name or any text. Previews and applies share a rate limit of 60 per 10 minutes per person (`app.rate-limit.post-import-write.per-ten-minutes`).
- **Updating by slug.** An admin may update any post, an author only their own; the slug of someone else's post is the same "slug not available" error as an old slug. A key that is missing or empty keeps the stored value, a `tags` line replaces the tags, and the language never changes (a different one is an error). A file whose values all equal the stored ones is **unchanged** and writes nothing (no revision, no log row, no re-index); a downloaded, unedited file imports as unchanged. When the title, description or content changes, the replaced text is kept as a revision first. A published post is warned about and not ticked, and a draft published between preview and confirm makes the confirm refuse (409, a count only).
- **Series from an import (admin only).** The keys `series` (the name), `series_part` (1 to 1000) and `series_description` (sets the description of a new series and fills an empty one of a series that exists, never one that has text) put a post in a series at the part it declares, so a multi-part article can be imported in any order, one file or many at a time. The series is found by its slug, title or translated title, or created (at most 10 per import). Migration V41 adds `posts.series_part`, unique per series and language. The part a reader sees ("Part n of m") stays the position among the published parts. For an author the keys are read, checked and ignored with a note. Saving a series order in the admin keeps the declared parts. Details: [post-file-format.md](post-file-format.md#series).
- **Not available yet.** Linking a post to the one it translates with `translation_of` (the key is read and ignored, and the preview shows a note) and undoing an import.

## 23. Article blocks, ZIP packages and AI authoring

- **Native article blocks.** An article body is Markdown plus sixteen blocks written with `:::name{attributes}` ... `:::` lines: callout
  (info, note, tip, warning, danger; compact or prominent), figure (standard or wide, with caption and attribution), gallery (two or three
  columns), compare (two or three panes, or before and after), comparison (a titled table), diagram (Mermaid), steps (sequential or
  grouped), code tabs, details (inline or appendix; several with the same `group` open one at a time), key takeaways, checklist, pull
  quote, file tree, timeline (events), metrics (one-line figures with a trend) and tabs (the same task for several systems). A fenced
  code block can carry `title="file.py"` for a titled panel and `highlight="2,5-7"` for marked lines, and twenty languages are
  highlighted, `diff` among them. Each block has an entry in one registry (attributes, variants, allowed children, accessibility
  notes) and a native component with its own responsive, keyboard and dark-mode behavior. Reference: [content-blocks.md](content-blocks.md).
- **One pipeline, nothing lost.** The public page, the admin preview, the editor preview, the import's article preview and the feeds all
  run the same `renderMarkdown`. A block that does not pass its registry entry renders as plain content and is listed with its line
  number and the supported alternatives; the editor's "Check before publishing" and the import page list them too. Blocks fill the
  article column of the page, whatever its width, and never change the page frame. Feeds get plain HTML; search text and reading time
  ignore the marker lines.
- **ZIP packages.** The post import accepts a `.zip` with one article and its images (JPEG, PNG, WebP). The backend reads the archive
  with bounded, defensive reads (4 MiB, 40 entries, a compression ratio cap, no unsafe paths, links, encryption or nested archives),
  reports a missing or unsupported image with its line, notes an unused one, and on apply stores each used image with the post
  (re-encoded, counted in the media quota, removed with the post) and rewrites the references to `/media/` paths in one transaction.
  The body keeps its block syntax verbatim ([post-file-format.md](post-file-format.md#zip-packages)).
- **Article preview and block check.** For each importable file the import page checks the blocks, shows the blocks used and the
  problems, and draws the proposed article in the real article template with the images of the package, before anything is stored
  (`POST /api/v1/admin/post-import/article-preview`). Each imported draft links to its saved preview page.
- **AI authoring prompt.** `/admin/posts/import/authoring-prompt` serves a Markdown prompt generated from the block registry: the
  fourteen rules of the authoring contract, the package layout, the front matter keys, every block with its attributes and two examples.
  A test keeps it equal to the registry ([ai-article-authoring.md](ai-article-authoring.md)).
- **Examples.** `fixtures/article-packages/` holds seven example articles (five different compositions, one that shows every block variant and an incident postmortem) with their images and the scripts that build the
  ZIP files ([DEVELOPMENT.md](DEVELOPMENT.md#example-article-packages)).
- **Known limits.** Mermaid is the only diagram language; SVG images are refused; a gallery has no lightbox; the unsafe-content scan of a
  package is a lint (the sanitizer is the barrier); the default PostgreSQL search still indexes the block marker lines of a body (the
  Meilisearch text does not); an article with block problems can still be imported by the API (the import page blocks it, the backend
  does not parse blocks).
