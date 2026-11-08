# Security notes

What the product protects, how, and where its limits are. This page is for the person who runs a site and for a reviewer. To
report a vulnerability, read [the policy](../SECURITY.md) at the root of the repository instead.

## Contents

- [Model in one page](#model-in-one-page)
- [Authentication and sessions](#authentication-and-sessions)
- [Password policy](#password-policy)
- [Two-step verification and recovery](#two-step-verification-and-recovery)
- [Audit events](#audit-events)
- [Outgoing mail](#outgoing-mail)
- [First-run setup code](#first-run-setup-code)
- [Rate limits](#rate-limits)
- [Reverse proxy and the client address](#reverse-proxy-and-the-client-address)
- [Containers and networks](#containers-and-networks)
- [Response headers](#response-headers)
- [Upload limits, by layer](#upload-limits-by-layer)
- [Article blocks and ZIP packages](#article-blocks-and-zip-packages)
- [The newsletter of an author's post is held](#the-newsletter-of-an-authors-post-is-held)
- [What the database enforces](#what-the-database-enforces)
- [Deleting a post](#deleting-a-post)
- [What an author may write](#what-an-author-may-write)
- [Caching, and a CDN in front](#caching-and-a-cdn-in-front)
- [What is public and what is not](#what-is-public-and-what-is-not)
- [Data the site stores](#data-the-site-stores)
- [Rotating `JWT_SECRET` and ending sessions](#rotating-jwt_secret-and-ending-sessions)
- [Startup refusals](#startup-refusals)
- [Supply chain: what the build trusts](#supply-chain-what-the-build-trusts)
- [What is not protected](#what-is-not-protected)

## Model in one page

- **One public entry point.** The frontend is the only service Compose publishes for public traffic, on `127.0.0.1` by default. A
  reverse proxy on the same machine terminates TLS. PostgreSQL and the backend are not published; the browser never calls the backend.
  The optional `search` profile also publishes Meilisearch on `127.0.0.1:7700`, for manual checks from the machine itself; it is
  protected by `MEILI_MASTER_KEY` and is not reachable from outside.
- **Authorization lives in the backend.** The frontend hides buttons and routes, but every protected request is decided by the
  backend, whose last rule is `denyAll()`. Every token is checked against the database on every request (role, status, revocation).
- **The admin API is closed by default.** Everything under `/api/v1/admin` is for an ADMIN, except five trees that an AUTHOR may
  enter (posts, post import, tags, categories, analytics); inside them an AUTHOR is narrowed to their own posts, or to the shared
  tag and category pool (create and list only). A controller added under `/api/v1/admin` without a decision is therefore refused to an
  AUTHOR, and `AdminRouteAuthorizationCoverageIT` fails for a handler in an AUTHOR tree that is neither owner-checked, ADMIN only nor
  on its reviewed list.
- **Secrets stay in `.env`**, which is git-ignored. They are never logged, returned or put in a URL.
- **A fresh install has no credential.** It is claimed through `/setup` with a one-time code that only someone with access to the
  server can read.

## Authentication and sessions

- **Admin sign-in**: email and password, then a second step ([Two-step verification](#two-step-verification-and-recovery)).
  Passwords are hashed with Argon2id at the OWASP minimum for the algorithm (19 MiB of memory, 2 iterations, 1 degree of parallelism).
  A hash stored with weaker parameters (every account made before this setting used Spring's 16 MiB) is replaced by a stronger one
  right after its owner signs in with the correct password, with no change for the person; a wrong password, a suspended account and a
  password changed in the meantime never rewrite it, and the line `password hash upgraded userId=...` records it. Only two checks run
  at the same time in the whole backend, so a login holds about 38 MiB of heap at most; a login that waits
  more than 5 seconds gets 429 `RATE_LIMITED`. The **password step has no per-account lock**: knowing the owner's email is not enough
  to lock the owner out. The second step has a brake, and it can only be reached by someone who already holds the first factor.
  Attempts are limited per client address, in Next (10 per 10 minutes) and again in the backend (20 per 10 minutes, counted before the
  password is checked), so a backend reached without Next is not unlimited ([Rate limits](#rate-limits)). An unknown email and an
  account that has no usable password (a GitHub account, or the seeded administrator while the first-run setup is pending) run the
  same Argon2 check against a fake hash and get the same 401, so the answer is no faster for any address.
- **A new password** (the first-run claim, `ADMIN_PASSWORD`, the password change) must meet the [password policy](#password-policy).
  Changing it in `/admin/security` needs the current password and, with two-step verification on, a code. It ends every other session
  of the account and signs the changing browser in again. While `ADMIN_PASSWORD` is set the change is refused (409): the variable would
  undo it at the next start.
- **Reader and author sign-in**: GitHub OAuth (authorization code flow with PKCE S256, scope `read:user`). The email is neither
  requested nor stored. The account is tied to GitHub's numeric id. Accounts are never merged by email.
- **Tokens**: an access token (JWT, HS256, 15 minutes) and a refresh token (a random string; only its SHA-256 is stored, rotated on
  every use). **How long a session lives depends on the role.** A reader's refresh token lives 30 days from each use, so a session in
  use never ends. A session of an **ADMIN or AUTHOR** ends after 7 days without use (`PRIVILEGED_SESSION_IDLE_TTL`; every refresh renews
  it) and, however active it was, 30 days after the person signed in (`PRIVILEGED_SESSION_ABSOLUTE_TTL`); the person then signs in
  again, and an account with two-step verification enters a new code. The start of a session is `refresh_tokens.authenticated_at`:
  rotation copies it, and so does the new session a password change or an enrollment issues to the caller, so neither pushes the end
  back. The backend tells the frontend how long the refresh token lives (`refreshExpiresIn`, in seconds, next to `expiresIn`), and the
  cookie's `Max-Age` follows it, so the cookie ends when the backend would refuse the token. Reuse of an old refresh token is
  detected and ends **that session**: the chain of rotations of that one sign-in, successor included, so whoever holds a copy loses
  it. The person's other sessions stay, because a copy of one device's cookie says nothing about another, and a rotation whose
  response was lost on the way (a proxy answering 502 after the backend rotated) must not sign a second device out. Changes of who
  may hold the account (a suspension, a password change, a role change, "sign out everywhere") still end every session. A token that was rotated moments ago may
  come back within `app.security.refresh-token-reuse-grace` (2 minutes by default) without an alarm: that is two requests carrying the
  same cookie, and the loser gets 401 `REFRESH_TOKEN_REVOKED` and is issued nothing. Next shares one refresh between the requests of a
  page that arrive together and gives the new pair to those only: once the refresh has answered, the retired token is remembered as
  revoked for a minute and is never answered with the new pair again (a token someone copied cannot be turned into a session through
  Next). A password change (in `/admin/security` or
  through `ADMIN_PASSWORD`), an enrollment of two-step verification, every role change and every suspension revoke the account's
  refresh tokens. So do the other changes of who may hold the admin account: the first-run claim, the startup lock of the
  development password, the rename to `ADMIN_EMAIL` and the first link of `ADMIN_GITHUB_ID`.
- **Signing out** revokes the refresh token at the backend (one more attempt after a network error, a timeout or a 5xx) and clears
  the cookies of the browser whatever the backend answers: the browser session always ends. When the backend could not be reached the
  refresh token stays valid until it expires, and the admin's sign-in page says so and points to "Sign out everywhere". A WARN line in
  the Next server log says `refresh token revoke failed at sign-out` with the status and nothing of the token. A sign-in over an
  existing session revokes the old refresh token the same way.
- **What an access token must be.** Besides a good signature the decoder accepts only HS256 (a token with `alg` `none`, HS512 or
  anything else is refused before a claim is read), a token that carries `exp` and `iat` and is not expired, and the issuer and
  audience this backend gives: `iss` is `blog-backend` and `aud` is `blog-api`. So a token signed with the same secret for some other
  purpose, or by a tool that left a claim out, is not an access token of this API. `JWT_SECRET` must also have at least 8 different
  bytes (32 identical characters were accepted before; `openssl rand -base64 48` has dozens). The OAuth cookie key is derived from
  the same secret with its own label, and the JWT key is the secret itself; deriving it too was considered and left out, since
  nothing else is keyed with the raw secret and it would only end the tokens in flight.
- **Access token revocation**: the backend reads the account on every request, for every role. An access token is rejected (401)
  when it was issued before the account's `users.tokens_valid_after` (set by a password change, an enrollment of two-step
  verification, a role change, a suspension, "sign out everywhere", the operator's reset, the
  first-run claim, the lock of the development password, the `ADMIN_EMAIL` rename and the first link of `ADMIN_GITHUB_ID`; a
  restart that changes nothing sets nothing), or when its login session is over: every access token carries a `sid` claim
  (the session of its refresh token, kept across rotations) and is refused once that session has no live refresh token, so logout
  ends the access token of that session at once. Logout ends the whole session of the token it is given, also a token that was already rotated
  (a lost rotation answer): its live successor is revoked too, and the person's other sessions stay. The admin Sign out button counts only an answer
  of the sign-out route as signed out: a proxy error, a refused origin or a limiter leaves the drafts and says so. `POST /api/v1/auth/sessions/revoke-all` (any signed-in account) is "sign out
  everywhere": it revokes every refresh token of the caller and sets `tokens_valid_after`, the calling session included. The
  cut-off has second resolution (`iat`): a token issued in the same second as the bump is still accepted, and the refresh tokens are
  revoked anyway. The `sid` is required and is checked against the **subject** of the token: a token without one is refused (401), and so
  is a token whose `sid` names a session of another account, however good its signature. A holder of `JWT_SECRET` alone therefore
  cannot mint a working token: it must name a live session of the very account, a random UUID that only that session's holder sees.
- **A session carries its proof.** Two columns of `refresh_tokens` are copied unchanged by every rotation: `authenticated_at` (when the
  person signed in with a first factor; it is also the informational `auth_time` claim of the session's access tokens) and `mfa_verified_at` (when a
  second factor was verified, null if none was). The refresh token of an account that needs a second factor (every ADMIN, and an AUTHOR
  who enrolled) whose session never verified one is **revoked and expired** at its next refresh (401 `MFA_REQUIRED`): an old session of
  an admin cannot keep refreshing, whatever happened to the account after it started. Sessions are started in one place only
  (`AuthService.issueSession`) and ArchUnit keeps it that way
  ([CONVENTIONS.md](CONVENTIONS.md#10-sessions-the-second-step-and-secrets-at-rest-backend)).
- **A second proof for role changes.** Granting or taking away a privileged role is how a stolen administrator session would leave
  a durable foothold (a new administrator, a new author). A role change **to or from ADMIN**, and a change that **makes a reader an
  AUTHOR** (by hand in `/admin/users`, or by approving an application), therefore needs what the other takeover-capable changes need: a
  sign-in from the last 10 minutes (401 `REAUTHENTICATION_REQUIRED`, checked first) and the acting administrator's **own code** in the
  request (`code`: an authenticator code or a recovery code; 401 `MFA_CODE_INVALID` when missing or wrong, then the same per-account
  brakes as at sign-in: a delay from the fifth wrong code, 429 `MFA_RATE_LIMITED`, a freeze after 100 in a row, 403 `MFA_FROZEN`). Taking
  an author back to a reader, and a change to the role the account already has, need nothing. The check happens before anything is
  written, under the lock every role change takes, so the role it decides on is the role the change then finds. A **promotion to ADMIN
  also deletes the account's two-step enrollment** (it used to keep an author's own authenticator): the promoted account enrols again at
  its next sign-in with the operator's enrollment code, like every new administrator, so a promotion made from a stolen session cannot
  hand the role to a second step the operator never saw. The frontend asks for the code in the role-change and approval panels.
- **A recent sign-in for changes.** Enrolling an authenticator ends every other session, so a stolen session could otherwise become a
  durable takeover. Every change of two-step verification, the password change and an administrator's reset of an author therefore
  first require that the session started with a sign-in **within the last 10 minutes** (read from the session row, never from the token;
  `app.mfa.reauth-window`): 401 `REAUTHENTICATION_REQUIRED` otherwise, before any code is looked at or counted. Rotation never refreshes
  it; signing in again
  is the only way to a fresh one.
- **Cookies**: the session cookies are `httpOnly`, `SameSite=Lax`, path `/`. The refresh cookie's `Max-Age` is the life the backend
  states for that token (above). In production (the frontend running with
  `NODE_ENV=production`, as the Docker image does) they are `Secure` and carry the **`__Host-` prefix**: `__Host-access_token` (a
  session cookie) and `__Host-refresh_token`. A browser accepts a `__Host-` cookie only from a secure origin, with `Path=/` and no
  `Domain`, which is exactly how they are set, so a sibling subdomain or a network attacker on plain HTTP cannot plant a session
  cookie that the site would read before the real one (cookie tossing: session fixation into the attacker's account). Outside
  production (the dev server on plain HTTP) the names are plain, `access_token` and `refresh_token`, and the cookies are not `Secure`,
  because the prefix needs `Secure`. Every reader and writer of the cookies goes through `accessCookieName()` and
  `refreshCookieName()` in `frontend/lib/auth-cookies.ts`. A cookie of the plain name that a production browser still holds from
  an older release is never read (it could be a planted one), and every response that sets or clears the session deletes it, so an
  upgrade costs one sign-in and leaves nothing behind. The GitHub flow cookie is `__Host-oauth_flow` too. The one cookie that cannot
  carry the prefix is `mfa_challenge` (`Path=/admin/login`, five minutes, single use, bound to the account that passed the first
  factor). Over plain HTTP in production a browser drops the cookies and sign-in silently has no effect: use HTTPS (Chrome and
  Firefox accept `Secure` and `__Host-` cookies on `http://localhost`, which is how the E2E stack runs). `SameSite=Strict` would break
  the GitHub callback, so it is not used.
- **CSRF**: tokens travel in cookies, so the write routes that act on a cookie (comment, like, save, sign out, the admin password
  form, setup) reject a request whose `Origin` differs from the `Host` header. That is one reason the proxy must keep `Host`
  ([Reverse proxy](#reverse-proxy-and-the-client-address)). The newsletter unsubscribe route also accepts a cross-origin one-click
  POST (RFC 8058); the token in the link is its authority.
- **Forms before the script has loaded**: the admin login form and its second step, the contact form, the newsletter form, the setup
  form and the forms of the Security page (a code, the enrollment code, a password) say `method="post"` and name, as `action`, the
  route their script posts to (`/admin/login/submit`, `/admin/login/mfa/submit`, `/api/contact`, `/api/newsletter/subscribe`,
  `/setup/submit`, `/admin/security/password` and the others of `components/admin/security/endpoints.ts`). A submit before hydration (a slow connection, a blocked script) is then a `POST`
  that the route refuses with 415, because it takes JSON from the same origin only, instead of a `GET` that would put the password,
  the address or the message in the URL, the browser history and the access log. The forms of the public area, the login and the Security page must
  state a method: `frontend/components/forms-native-submit.test.tsx` fails for one that does not.
- **Suspension**: a suspended account cannot comment, like or save, is signed out on the next page load, and has no permissions
  even with a valid token. ADMIN and AUTHOR accounts cannot be suspended: demote them first.
- **Comments** are plain text, stored and rendered as text. No HTML, Markdown or automatic links.
- **Markdown in posts** is written by ADMIN and AUTHOR accounts, and an AUTHOR is not trusted with the page: every post is rendered
  through a sanitizing schema (`rehype-sanitize`) that strips scripts, event handlers, `style` and iframes. It also drops the `class`
  an author writes, except the exact values the renderer itself needs (`language-*` on code, the GFM task list and footnote
  classes): a utility class such as `fixed inset-0` cannot lay content over the page or the admin preview. And it prefixes every
  `id` and `name` an author writes with `user-content-`, so `<img name="currentScript">` cannot shadow a property of `document` or
  `window` ("DOM clobbering") or an id the page looks up. The ids of the headings are made by the renderer, not written by the
  author: they are lowercase slugs of the heading text and are left unprefixed so that a link such as `#setup` stays stable. The
  exception is a slug that starts with `_` or equals a fixed id of the pages (`main-content`, `search-q`, ...; the list is
  `RESERVED_PAGE_IDS` in `frontend/lib/page-ids.ts`), which gets the same prefix: `## __next_f` would otherwise become
  `id="__next_f"`, which the scripts of Next read through the named access of `window`, and no visitor's page would hydrate.
  `frontend/lib/markdown.test.tsx` holds all four. A `<pre>` an author types in HTML is reduced to its text (`plainPre`), so the
  "Copy code" button, which copies the text of the `<pre>`, copies what the page shows: without this a closed `details` inside a
  `<pre>` hid a command on the page and put it on the clipboard. A fenced block is already of that shape. The renderer also limits how many blocks an article may leave open at once (8, or
  16 written behind a quote, a list marker or a footnote definition) and how long it may keep them open: the directive parser
  (`remark-directive`) re-checks every open block for each line, so its cost is (blocks open) x (lines). 3.5 KB of unclosed
  `:::callout` took 0.3 s, 14 KB took 6 s and 28 KB took 38 s on the one Node process that serves the site, on every render of the
  page and the feeds, and a few open blocks followed by a long run of short lines (8 blocks and 200 KB of blank lines, 64 quotes and
  128 000 lines of `>`) took 25 to 32 s although they stayed under the depth limits. So the scan adds up, over every line, the blocks
  open at that line, and reports the article when the sum passes 100 000 (`MAX_BLOCK_WORK`); the reference of the blocks, the most
  syntax-heavy page of the repository, sums to under 5 000. Past a limit the article is read without the block syntax (its text
  stays, the blocks show as plain text) and one `too-deep` problem is reported in the editor preview and on the import page
  (`frontend/lib/blocks/nesting.ts`; `lib/blocks/nesting.test.ts` and `lib/markdown-blocks.test.tsx` hold it). The count is a line scan
  that is built to be too high and never too low, not a copy of the parser. A block name may start with a digit, a letter outside ASCII,
  an emoji or a tab (any character that is not white space or punctuation), a block can be opened behind a footnote marker or any other
  prefix, and a line the scan takes for an open can be text (`:::a b`). So the scan counts every line the parser might open a block on,
  takes blocks off the count only from the top (a fence long enough for a block ends it and everything inside it, so the parser always
  closes at least as many as the scan does), and counts the lines behind a prefix without ever taking them off. A differential test
  parses generated texts with the real parser and fails when the count is lower than the nesting the parser builds. The price of an
  upper bound is that a text can be reported as too deep although the parser would have read it in time (a code sample that opens
  blocks and never closes them, or more than 16 lines with `:::` and a name in the middle of the text); the author sees the problem
  and closes the blocks. What the limits admit is not free, and it is bounded: measured on the real parser, a text at the budget
  takes 0.4 to 0.6 s to parse whatever its shape (8 open blocks and 12 400 blank lines 0.41 s, one block and 99 000 lines 0.58 s,
  16 quotes and 6 000 lines of `>` 0.39 s), and the page and the feed parse a body once, the check of an import three times. The
  worst shapes at the real caps (256 KiB of an import file, 500 000 characters of a post) are now read as plain Markdown in 0.3 to
  1.2 s, which is what the same text costs without any block (before the budget they took 32 s and 63 s per parse).

  **The Markdown parser itself is slower than linear for much more than blocks, and the size limit of a post does not bound it.** A run
  of emphasis or bracket characters, thousands of quotes, thousands of headings underlined with `---`, a line that opens quotes and list
  items a hundred levels deep, thousands of HTML tags and one unbroken word of 40,000 characters each cost the square of their number
  (measured on the real parser, on a loaded laptop: 24 KB of `*]` took 25 s, 100 KB of a line of text and `---` took 46 s, 100 KB of quotes
  took 42 s, 500,000 characters of `` `a` `` took 16 s, and a post may have 500,000). Not all of it is the parser: a link literal
  (`www.a.co`), a table cell and a text directive (`:name`, read by `remark-directive` at every colon) each make a node, and the stages after
  the parser are not linear in the nodes of one paragraph or one table row (450 KB of `www.a.co ` parsed in 3.5 s and took 24 s through the
  page pipeline; a table of 5 rows and 20,000 columns took 11 s; 40,000 colons took 1.5 s and 80,000 several seconds), and an unclosed `<!--`, `<?` or
  `<![CDATA[` in the middle of a paragraph is tried against the whole rest of it (1,600 of them in 225 KB took 10 s). The parser cannot be
  interrupted once it has started (it is synchronous, on the one Node process), so every parser of an article asks `readingOf`
  (`frontend/lib/blocks/reading.ts`) before it is built, and `frontend/lib/blocks/parse-budget.ts` estimates the work in one pass over the
  lines, without parsing anything. It adds up, each priced from the worst measurement of the real parser and of the pipeline after it:
  the non-blank lines (0.3 ms each), each marker `*`, `_`, `~`, `[`, `]` and backtick wherever it stands (0.04 ms), each footnote reference
  `[^` (0.16 ms more: a back-reference link in its definition), the squares of the markers in each run of non-blank lines (up
  to 0.12 ms per marker squared), of the quotes that start after a line that is not a quote, of the headings underlined with `=` or `-`, of
  the HTML tags, and of the length of each word, the link literals (`www.`, `://`, `@`: 0.07 ms each and the square of their number in a
  paragraph), the colons (0.04 ms each and the square in a paragraph), the `|` of table rows (0.1 ms each and the square in a row), the
  unclosed openers times the characters of their paragraph, and the levels of quotes, list items and indent that every line sits in (at
  most 32 on one line). An article whose total passes **1,500** is not given to the parser: it is shown as plain text (its paragraphs,
  merged into at most 400 when there are more, every character as text, then the usual sanitizer; a line break inside a paragraph is a
  space, as in Markdown), the editor preview and the import page report one `too-heavy` problem with the reason, the feed shows the same
  plain text, and nothing is lost. A parse that overflows the call stack (thousands of open tags) is caught and shown the same way instead
  of answering 500.

  What the budget admits is bounded, with one floor. Seventy-five shapes at the biggest text the budget lets in
  (`frontend/lib/blocks/parse-budget.probe.test.ts`) were read in 0.002 to 0.9 s by the whole page pipeline (the parser alone and the feed
  pipeline are faster), the fastest of two runs, on a workstation that was running other jobs; the sweeps of the track and of the review,
  on laptops, read up to twice as slow, so plan for two seconds. The shapes that earlier versions of the prices let through at that size
  took 24 s (`www.a.co`), 11 s (a table of 5 rows and 20,000 columns), 10 s (unclosed comments) and, for colons, up to several seconds;
  and, the last family found, **constructs spread over many short paragraphs**: the square of one paragraph's markers cannot see 62,400
  links of 25 to a paragraph, which cost 4 s (5.6 s on the laptop of the review) at an estimate of 1,500, or 14,400 references to one
  footnote, 2.1 s. They are now priced one by one (0.04 ms a marker character, 0.16 ms a footnote reference) and the same shapes are read
  in 0.5 to 0.85 s.
  The floor is the linear cost: a post of 500,000 characters costs a second or two to read whatever it holds, because the estimate
  bounds what grows faster than the text. The busiest legitimate document of the repository (the 144 KB `backend/README.md`) costs 838, the
  113 KB `docs/SECURITY.md` 508 and the reference of the blocks 357; an article that is reported although the parser would have read it quickly is split by its author
  (a code sample of hundreds of lines full of brackets and underscores, with no blank line in it: micromark reads a well-formed fence
  without parsing it inline, but the estimate cannot tell a fence from text without trusting the very text it guards, so a long sample is
  split into several code blocks). The estimate is a bound built from measured shapes, **not a proof**. The first version was checked
  against a parser run without `remark-directive` and without the stages after it, and missed the four families above; the second against a
  sweep of 55 tokens and their ordered pairs (about 3,000 units) run through the whole page pipeline, whose flagged units were timed again,
  each alone, in fresh processes (a sweep in one long process slows down tenfold with the state of the heap, and its slow lines are not
  the shapes' own). A shape that nobody has tried can still cost more
  (see "What is not protected"). After an upgrade of `remark`, `micromark`, `remark-directive` or `rehype` repeat the measurement
  ([DEVELOPMENT.md](DEVELOPMENT.md#measuring-the-markdown-parse-budget)).

  **The syntax highlighting of code fences is bounded by a clock, because the estimate cannot see it.** The parser reads a fence in one
  piece, but a fence with a language in `CODE_LANGUAGES` is then tokenized by a Shiki grammar, one regular expression match after another,
  on the same Node process, and Shiki has no limit of its own: the time of a line is 500 ms by default for each of the two themes, the
  cost of a line grows with the square of its length, and nothing limits the lines. Measured: 20 lines of 2,000 characters took 20 s when
  the characters were `a<`, 10 lines of 5,000 characters of `a` took 12 s through `renderMarkdown`, and a review run took 118 s for a
  fence of about 500 KB. So `frontend/lib/blocks/highlight-budget.ts` wraps the highlighter of every render (never shared between
  articles) and applies these limits: a line of 300 characters or more is not tokenized (Shiki's `tokenizeMaxLineLength`); the fences of
  one article are highlighted up to 120,000 characters and 2,000 lines together; and all the highlighting of one article may take 1.5 s
  of wall-clock time. The time is shared out before each block: a block of `n` lines and `t` themes gets `left / (n x t)` ms as the time
  limit of one line (Shiki's `tokenizeTimeLimit`, per theme), at most 25 ms, so that even if every line used all of its time the block
  ends inside what is left; a line that hits its limit keeps the tokens found so far and the rest of it is plain; a block that cannot
  give each line 2 ms (about 375 lines when the whole budget is left) is not highlighted. Shiki compiles a grammar when it first needs a
  rule (the first line of TypeScript takes 100 ms, the next new constructs another 60, against 2 ms once hot), which would cut the first
  lines of the first article after a restart short, so the first block of a language in a process is preceded by a sample of that
  language of ours (`frontend/lib/blocks/code-warmup.ts`, about a quarter of a second for all twenty languages together, not charged to the
  article). A block that is not highlighted is still drawn
  as a code block, with the text intact, without colour; nothing is dropped. Legitimate code is far from every limit (a realistic line
  of TypeScript takes about 8 microseconds a character). The bound is a clock, so what is coloured can differ between two renders of the
  same article on a machine that is much slower or busier; the text never does. `lib/blocks/highlight-budget.test.ts` holds the rules
  with a fake highlighter and a fake clock, and `lib/markdown-heavy.test.tsx` the page.
- **Site content** (profile, about, ...) is plain text rendered as escaped text. URLs must be `https://` or `mailto:`. No field can
  carry a role or credential.

## Password policy

One component (`PasswordPolicy`) decides every new account password: the first-run `/setup`, the `ADMIN_PASSWORD` variable and the
password change. A password is refused (400 `VALIDATION_ERROR`, or a startup refusal for `ADMIN_PASSWORD`) when it is:

- shorter than 12 or longer than 128 characters;
- on the bundled list of the 10,000 most common passwords (compared case-insensitively, ignoring surrounding whitespace), or such
  a word with only digits and symbols around it (`Welcome12345!`, `2024password`): length alone lets those through;
- made of fewer than 5 different characters, or one run of consecutive characters (`aaaaaaaaaaaa`, `123456789012`);
- containing the local part of the account's email address (at least 4 characters) or the development password of the seeded admin;
- equal to the current password (the password change only).

Every weak case gets the same message, so the answer does not tell which list entry matched, and no message contains the password.
Existing hashes are never re-checked at login. `ADMIN_PASSWORD` is checked only when its value really changes; an unchanged value
that the policy now rejects keeps working and logs one warning at start, so an upgrade never refuses to start over it. No outside
service is contacted (a breached-password lookup would make the instance depend on one).

## Two-step verification and recovery

TOTP (RFC 6238) with `javax.crypto` and no new dependency: HMAC-SHA1, 6 digits, 30-second steps, a 160-bit secret. The page shows a
base32 key and an `otpauth://` link; there is no QR image.

| Account | Two-step verification | Applies to |
|---|---|---|
| ADMIN | **mandatory**: no session is issued until a second factor is verified, or enrolled on the spot | password sign-in, GitHub sign-in, refresh |
| AUTHOR | optional, turned on in `/admin/security`; once on, it is enforced like for an admin and cannot be turned off without a code | password sign-in (if the account has one), GitHub sign-in, refresh |
| USER (reader) | none | |

- **One gate.** Password sign-in and the GitHub callback end in the same method; neither can reach a session around it. A correct
  password (or a completed GitHub callback) of an account that needs a second step answers **202 with a single-use challenge and no
  token**; the code answers with the session. A wrong password, an unknown email and an account without a password stay
  byte-identical, and a suspended account is told `USER_SUSPENDED` before any challenge exists, so the second step of an account is
  never visible to someone without the first factor.
- **The challenge** is 256 random bits (only its SHA-256 is stored), lives 5 minutes (`app.mfa.challenge-ttl`, at most 15), allows 5
  evaluated codes, and is dead once the account's `tokens_valid_after` moves (a password change, "sign out everywhere", a role change,
  the operator's reset). A second sign-in does not cancel an older challenge (someone with the password must not be able to kill the
  owner's pending one); at most 20 live ones exist per account and the 21st sign-in is refused with 429.
- **Window and replay.** A code is accepted for the current 30-second step and the one before, and **each step only once**: a code that
  was used already, or an older one, is refused, and the person waits for the next code (RFC 6238 section 5.2). The comparison is in
  constant time and both candidates are always computed. If nothing matched but a code up to 10 steps away would have, the log says the
  clock is off (`offsetSteps`) and the code is still refused.
- **Attempt brake, keyed by the account.** Every check of a second-step code (sign-in, enrollment, replacement, every step-up, the
  password change) runs in one transaction that first locks the account's rows, so parallel requests cannot all read "not locked"
  before one of them counts. The first four wrong codes cost nothing but themselves; the fifth starts a delay that doubles with each
  further wrong code (30, 60, 120, 240, 480 seconds) and stays at 15 minutes from the tenth. While a delay runs the second step answers
  429 `MFA_RATE_LIMITED` with `retryAfterSeconds`, and a correct code is refused too. **After 100 consecutive failures (about 23
  hours) the second step is frozen**: every attempt answers 403 `MFA_FROZEN`, a correct code included, until the operator acts. The
  arithmetic: a window of two values in 10^6 gives one evaluated guess a probability of 2x10^-6, so a person who holds only the password
  has at most 100 x 2x10^-6 = 2x10^-4 (1 in 5,000) per freeze, whatever the number of IPs and challenges. The per-IP counter in Next is
  not what this rests on: a backend with its own public URL, or a client-chosen `X-Forwarded-For`, bypass any per-IP counter.
- **The lockout question, answered honestly.** Knowing the owner's email is not enough to lock the owner out: the second step is
  reachable only with the first factor. But someone who holds the **password** can keep the second step rate-limited (failing again as
  soon as each delay ends) and, after 100 failures, freeze it. The remedy is the operator's: change `ADMIN_PASSWORD` (a real change
  clears the counters and kills every pending challenge) or run [the reset](#when-the-phone-or-the-codes-are-lost).
- **Recovery codes.** Ten per enrollment, each 24 characters of the Crockford base32 alphabet (120 bits), shown once as six groups of
  four characters and stored only as a SHA-256. 120 bits is deliberate: ASVS 5.0 6.5.2 lets a lookup secret of at least 112 bits be
  hashed with a standard hash, which keeps one lookup per attempt and means that changing `MFA_ENCRYPTION_KEY` never voids a code. A
  recovery code signs in once and **leaves the authenticator enrolled**; the status endpoint reports only how many remain.
  Regenerating replaces all ten.
- **The secret at rest** is encrypted with AES-256-GCM under `MFA_ENCRYPTION_KEY`, a key of its own (base64 of 32 bytes), with the
  account id and the purpose as authenticated data, so a ciphertext copied to another row, or a pending secret pasted into the active
  column, fails to decrypt. The key is not derived from `JWT_SECRET` (rotating that after a leak must not lock everybody out, and a JWT
  leak must not decrypt seeds) and is not stored in the database (a dump would then carry the key next to the ciphertext). **A database
  backup does not contain the key: keep a copy outside the server.** A row that cannot be decrypted is logged at ERROR and answers like
  a wrong code. Changing the key makes every enrolled account need [the reset](#when-the-phone-or-the-codes-are-lost); a rotation with
  a second, previous key is not part of this release.
- **Enrollment cannot be hijacked.** An admin without an authenticator is enrolled at sign-in. `enroll/begin` stores a PENDING secret
  and changes nothing else (abandoning it locks nobody out); `enroll/confirm` activates it, writes the recovery codes, ends every other
  session of the account and signs the new one in. A stranger who holds only the password must not be able to enrol an authenticator of
  their own first, so `enroll/begin` asks for a second proof unless the enrollment **window** is open:
  - the window is open for one hour after the first-run claim (the owner has just proved the setup code), and a confirmed enrollment
    closes it; on an opted-in development run (`dev` profile, or `APP_ALLOW_DEV_DEFAULTS=true` with an empty or loopback `SITE_URL`) it
    is always open, which is what a throw-away E2E stack relies on;
  - otherwise the proof is the **enrollment code**: `MFA_ENROLLMENT_TOKEN` (at least 24 characters) or a generated file
    `<SETUP_DATA_DIR>/mfa-enrollment-code`, a proof of access to the server that cannot be phished together with the password. The
    generated file is created at startup when an administrator is pending (never while the first-run setup is pending: one code at a
    time) or at the first enrollment challenge of an account promoted to admin at runtime, is deleted after each confirm (or replaced
    when another administrator is still pending) and has no time expiry (a known deviation from ASVS 6.4.1: it is a proof of server
    access, never a password, and it is readable only by the operator). A wrong or missing code is 403 `ENROLLMENT_CODE_INVALID`,
    counted against the challenge's five attempts;
  - a **grace period** in which an admin may sign in without the second step is deliberately not offered: it turns "mandatory" into a
    promise and leaves the hijack window open for its whole length.
- **GitHub is a second way to become admin** (`ADMIN_GITHUB_ID`), so the GitHub callback gets the same 202 and the same rules.
- **Replacing the authenticator** (a new phone) needs a code of the current authenticator **or a recovery code**, and the current
  password where the account has one. The new secret waits next to the active one, which keeps working until the first code of the new
  app swaps them. An admin never passes through a disabled state. The old recovery codes become void and ten new ones are shown.
- **Turning it off** is possible for an author only (with a code); an admin gets 403 `MFA_REQUIRED`. A demotion to USER deletes the
  enrollment and the recovery codes; a demotion to AUTHOR keeps them; a promotion to ADMIN makes the next sign-in an enrollment (an
  author who already enrolled is asked for the code, not for a new enrollment).

### When the phone or the codes are lost

The person who controls the server can always reset two-step verification; nobody else can.

1. **Lost phone, recovery codes saved.** Sign in with a recovery code (it burns one), open `/admin/security` and choose "Replace
   authenticator", entering a second recovery code and the password. No operator needed.
2. **Lost phone and lost codes, an author.** An administrator opens the user row and resets it (`POST /api/v1/admin/users/{id}/mfa/reset`;
   it needs the administrator's own code and a recent sign-in, never works on another administrator, and ends the author's sessions).
   The next sign-in can enrol again.
3. **Lost phone and lost codes, an administrator** (or the second step is frozen). Set `MFA_RESET_EMAIL` to the account's email and
   `MFA_RESET_TOKEN` to a new random value (at least 24 characters) in `.env`, and restart the backend. It acts **once per distinct
   token** (the SHA-256 of the token is stored in `app_settings.mfa_reset_applied_hash`, so a forgotten variable cannot wipe the new
   enrollment at every restart): the enrollment and the recovery codes are deleted, every session of the account is revoked (which also
   kills pending challenges) and the log has one WARN line with the user id. It does **not** open the enrollment window: the next
   sign-in is an enrollment that still asks for the enrollment code. Remove both variables afterwards. An unknown email logs a line
   without any value and uses up nothing, so a typo is fixed without changing the token.
4. **SQL fallback** (the backend cannot start, or the environment cannot be changed). The email below is a placeholder:

   ```sql
   DELETE FROM user_mfa WHERE user_id = (SELECT id FROM users WHERE email = 'admin@example.com');
   DELETE FROM user_mfa_recovery_code WHERE user_id = (SELECT id FROM users WHERE email = 'admin@example.com');
   UPDATE refresh_tokens SET revoked_at = now(), expires_at = LEAST(expires_at, now())
     WHERE user_id = (SELECT id FROM users WHERE email = 'admin@example.com') AND revoked_at IS NULL;
   UPDATE users SET tokens_valid_after = GREATEST(COALESCE(tokens_valid_after, now()), now()) WHERE email = 'admin@example.com';
   UPDATE mfa_challenge SET consumed_at = now()
     WHERE consumed_at IS NULL AND user_id = (SELECT id FROM users WHERE email = 'admin@example.com');
   ```

   The next sign-in is an enrollment. The last two statements matter: the bump ends the access tokens already issued, and the
   consumed challenges stop a leaked password from finishing a sign-in that was started before the reset.
5. **`MFA_ENCRYPTION_KEY` lost or changed.** The ciphertexts cannot be read; every enrolled account answers `MFA_CODE_INVALID` and the
   log has `mfa secret undecryptable`. Recovery codes are hashed, not encrypted, so a person who kept them can still sign in with one and
   replace the authenticator (path 1); for everyone else use path 3 or 4. Put the saved key back first if you still have it.
6. **The second step is frozen, or the owner is being kept rate-limited:** change `ADMIN_PASSWORD` (a real change clears the counters
   and ends the pending challenges) or use path 3 or 4.
7. If the only administrator loses the phone, the recovery codes **and** access to the server, the account is not recoverable, by
   design.

## Audit events

One greppable line per event, `key=value`, through SLF4J, with the user id (the pseudonymous id the log already uses) and never the
code, the secret (plain or encrypted), a recovery code, the challenge, the enrollment code or token, the password, the email, the
`otpauth://` link or the encryption key. The backend sees the Next server's address anyway, so no client address is added.
A line that records an act or a refusal names the account that did it by id (`actor=<id>`, or `anonymous`), never by address; the id is not
added to every line of the log (no MDC), only to the lines below.

| Level | Line | Notes |
|---|---|---|
| INFO | `password login ok userId=<id>` | the first factor passed; a second step may follow |
| WARN | `password login failed reason=no_account_or_no_password\|bad_password\|dev_password_refused` | the response is identical for all of them |
| WARN | `password login refused userId=<id> reason=suspended` | after a correct password |
| INFO | `mfa challenge issued userId=<id> purpose=VERIFY\|ENROLL firstFactor=PASSWORD\|GITHUB` | |
| INFO | `mfa verify ok userId=<id> method=totp\|recovery recoveryLeft=<n>` | |
| WARN | `mfa verify failed userId=<id> reason=bad_code\|replay\|locked\|frozen\|challenge_exhausted` | `replay` and `bad_code` look identical to the client |
| WARN | `mfa challenge rejected reason=unknown_or_expired` | no user id exists |
| WARN | `mfa code matched outside window userId=<id> offsetSteps=<n>` | the clock is off (server or phone); the code is still refused |
| ERROR | `mfa second step frozen userId=<id>` | once, when the counter reaches 100 |
| WARN | `mfa session refused at refresh userId=<id>` | a session without a verified second factor was ended at refresh |
| INFO | `mfa enrolled userId=<id>`, `mfa authenticator replaced userId=<id>`, `mfa enrollment removed userId=<id> by=self\|admin\|operator\|role_change` | for `by=admin` the line ends with `actorId=<administrator id>` and is written even when the author had no enrollment left |
| INFO | `mfa step-up ok userId=<id> purpose=enroll_confirm\|recovery_codes\|replace_begin\|replace_confirm\|disable\|reset_author\|password_change method=totp\|recovery` | a correct code of a signed-in person for a change of their security (for `reset_author` the person is the administrator) |
| INFO | `user status changed actor=<administrator id> target=<id> status=SUSPENDED\|ACTIVE` | a reader was suspended or reactivated |
| INFO | `role changed actor=<administrator id> target=<id> from=<role> to=<role>` | after the change is committed |
| INFO | `admin request actor=<id> method=<M> path=<path> handler=<Controller.method> status=<n>` | every request that is not a read (`POST`, `PUT`, `PATCH`, `DELETE`) under `/api/v1/admin/**`, an author's included, after it ended: a refused or malformed one is there with its status. The path only, never the query string or the body |
| INFO | `site content saved key=<k> locale=<l> actor=<id>`, `site content restored key=<k> locale=<l> actor=<id>` | the owner's profile and pages |
| WARN | `Access denied method=<M> path=<path> actor=<id\|anonymous> traceId=<id>` | a refusal by the URL rules (a signed-in person without the role) |
| WARN | `Access denied method=<M> path=<path> actor=<id\|anonymous> message=<text> traceId=<id>` | a refusal by an ownership or role rule inside the service (an author editing another author's post) |
| WARN | `ApiException code=<CODE> status=<n> actor=<id\|anonymous> traceId=<id>` | a 401, a 403 and (once a minute per code) a 429 name the caller; `anonymous` when no token was sent. A 5xx adds `message=<text>` before the trace id. Other 4xx answers are DEBUG |
| WARN | `mfa enrollment code rejected userId=<id>` | |
| INFO | `mfa recovery codes regenerated userId=<id>` | |
| INFO | `password changed userId=<id> sessionsRevoked=<n>` | |
| WARN | `mfa operator reset userId=<id> sessionsRevoked=<n>` | |
| ERROR | `mfa secret undecryptable userId=<id>` | the key changed or the row was damaged |
| WARN | `refresh refused reason=invalid\|expired\|revoked\|suspended` | no token material |
| WARN | `refresh token reuse detected userId=<id> revokedSecondsAgo=<n> tokensRevoked=<n>` | an old refresh token was presented again: the session it belonged to is ended (the account's other sessions are not) |

Repeated `mfa verify failed ... reason=locked` or `frozen` lines are the sign of someone guessing with the password: see
[the lockout question](#two-step-verification-and-recovery).

**What is deliberately not in the log.** An answer that anonymous traffic can cause without any limit must not be able to fill the
rotating log (3 files of 10 MB with Compose) and push the lines above out of it. So a 404 for an unknown slug or path, a malformed
request, a request the firewall refuses, a refusal by the container (`TRACE`), a conflict and a request that carries no credential at all (a 401 for
an anonymous call, whatever its path) are logged at DEBUG (off by default), with the error code and the trace id
only and never the message, which often repeats what the caller sent (a slug, for example). A request line that reaches WARN
(a refused token, a 403) quotes at most the first 120 characters of the path, never the query, and no control character. A 429,
a token that was sent and refused (`Authorization: Bearer <anything>`, which costs a caller nothing) and an upload over the
multipart limit are logged at WARN once per minute and reason (the error code, the exception class), with the number of similar
answers left out since the previous line (`... (N similar answers left out since the last line)`), and at DEBUG for the repeats, so
a crowd that is past a ceiling, or a caller who sends junk tokens, writes one line a minute, not one per request. A 5xx keeps its message. The trace id in the answer is what ties a report to a line when DEBUG is on.

**What can still fill the log.** The lines of the table above are audit events and are written one per event, so volume can still
push older lines out of the window: a signed-in account with a low role
that keeps asking for what it may not have (403), and wrong passwords, codes or refresh tokens from many addresses (each address has its own
allowance). Each of these is bounded by what a caller needs to send, but not by a number you set. If the lines matter to you, do not rely
on the container's own window: ship the logs off the machine (`docker compose logs -f`, a log driver such as `syslog` or `journald`,
or a collector), or raise `max-size` and `max-file` in `x-logging` of `docker-compose.yml`.

## Outgoing mail

The newsletter, its confirmation mail and the copy of a contact message go out through one place (`SmtpMailTransport`), and only with
`NEWSLETTER_TRANSPORT=smtp` ([Startup refusals](#startup-refusals) lists what that needs).

- **The connection is encrypted.** STARTTLS is on and required (port 587), or implicit TLS is chosen with `SMTP_PROTOCOL=smtps` (port 465);
  both check that the server certificate matches `SMTP_HOST`. `SMTP_STARTTLS=false` is refused for a host that is not on this machine,
  because the SMTP password and every confirmation link would cross the network in clear text.
- **A subject is one line.** A line break, any control character and the invisible and text-direction characters are removed before the
  subject is set, so a post title written by an author cannot add a header (`Bcc:`) or a recipient. The mail library folds a line break
  too, and a test pins both.
- **A recipient and a Reply-To are plain addresses.** One address, ASCII, no display name; a local part with `=?` (the start of an RFC 2047
  encoded word, which a mail client decodes into something else) is refused when the address is taken (`EmailAddresses`) and again at
  send time, where it becomes a delivery failure with the code `INVALID_ADDRESS` and nothing is sent. A stored address that an older
  rule accepted can still unsubscribe: the link carries a token, not the address.

**A line is one line.** Text that a caller typed can reach a log line through an error message (a tag that already exists repeats its
name). The handler writes every such message through `UserText.forLog`: a control character (a line break, a tab, NUL), a line or
paragraph separator and a text-direction character become U+FFFD, and the text is cut at 300 characters, so a name cannot forge a
second line. A tag or category name (and its translated names) is also refused at the request when it holds a control character,
so the stored name is one line too.

## First-run setup code

`/setup` exists only while `app_settings.setup_completed` is false, which is true only on a provably fresh database.

- **Where the code comes from.** `SETUP_TOKEN` if you set it (at least 24 characters, otherwise the backend refuses to start).
  Otherwise the backend generates a random 32-byte code, writes it once to `<SETUP_DATA_DIR>/setup-code` (`/data/setup-code` in the
  `backend_data` volume with Compose), and never overwrites that file. On POSIX file systems the directory and the file are
  owner-only. The log prints the **path**, never the code.
- **Who can read it.** Whoever can run `docker compose exec backend sh -c 'cat /data/setup-code'`, that is whoever administers the server.
  The page is public, the code is not. Keep `SETUP_DATA_DIR` a private directory: the backend trusts a code file it finds there.
- **Guessing.** The comparison is constant-time. Attempts are limited per IP in Next (10 per 10 minutes) and per client address in the
  backend (5 per minute, every attempt counted, a correct code included, before anything else). A flood of attempts from one address
  is refused before a database connection is taken, and so is every request to an instance whose setup is finished (a plain read
  of the flag answers 404 without a transaction or the setup lock, so a crowd cannot queue lock-taking transactions on a running
  site). Wrong codes are also counted for the whole backend (120 per minute, after the
  comparison): beyond that a wrong code is answered 429 instead of 403, but the right code is **never** refused for it, so a crowd
  cannot keep the owner from claiming a fresh instance. The price is that guesses are bounded per address and not for the whole
  process, which is safe for the generated 256-bit code and for a `SETUP_TOKEN` of the length the documentation asks for: make it
  long and random (`openssl rand -hex 32`), never a phrase. If someone floods `/setup` on a public site, claim the instance yourself
  quickly, or set `ADMIN_PASSWORD` and restart: that closes setup.
- **The claim.** One transaction under an advisory lock: the seeded admin row gets your name, email and a password that meets the
  [password policy](#password-policy) (hashed with Argon2id), its sessions are revoked, setup is marked completed, the one-hour
  window for the first two-step enrollment opens ([below](#two-step-verification-and-recovery)), and the code file is deleted.
  Afterwards `/setup` answers 404.
- **Until then** the seeded development password is disabled at startup (`SETUP_LOCK_DEV_SEED`, default true), so no default
  credential works on a fresh install. Setting `ADMIN_PASSWORD` or `ADMIN_GITHUB_ID` claims the instance through the environment
  and closes `/setup`. On a production run `SETUP_LOCK_DEV_SEED=false` is ignored and a database error while the lock runs stops the
  start (the runner is idempotent: the restart policy tries again) instead of leaving the default credential in place with one log
  line; the migrations V2 and V8 still seed that credential, and three layers keep it unusable: this lock, the refusal of
  `DevCredentialWarning`, and the password login of `AuthService`, which rejects the development password on a production run.
- **Existing databases** are migrated as already set up and can never be claimed ([Upgrading](UPGRADING.md#an-existing-deployment-is-never-re-claimable)).
- The page sends `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. The code, the password and the backend's own error
  text are never logged or returned.

## Rate limits

All counters are in process memory: a restart resets them, and a second instance would double them
([Architecture](ARCHITECTURE.md#caching-and-why-there-is-one-backend-and-one-next)). Values are defaults; the backend ones are
`app.rate-limit.*` properties. Beyond a limit the answer is 429 unless noted.

The anonymous endpoints are limited in **both** layers: Next counts per client IP, and the backend counts per **client address**
too, so a backend that is reached without Next (a public backend URL, a bypassed or restarted Next counter) is not unlimited. The
backend's numbers are equal to Next's or looser (for example 20 sign-in attempts per 10 minutes against Next's 10, which a success
clears), so behind a working Next they fire only when Next's counter is out of reach. The backend learns the reader's address from Next: Next sends the address it
derives ([Reverse proxy](#reverse-proxy-and-the-client-address)) in `X-Client-Ip`, with the shared secret `CLIENT_IP_TOKEN` in
`X-Client-Ip-Token`. The backend believes the address **only when the secret matches** (constant-time compare); otherwise it
ignores both headers and counts the socket address, so a caller who reaches the backend directly cannot choose its own key by
writing a header. A request that carries the secret but no usable address counts as one shared "unknown" caller. IPv6 is
counted per `/64` (a provider gives one customer a whole `/64`), and an IPv4-mapped IPv6 address as that IPv4 address.

**In the backend**

| What | Default | Counted per |
|---|---|---|
| Comments and replies | 5 per minute and 30 per hour | user |
| Comment edits and deletes | 20 per 10 minutes | user |
| Likes (posts and comments) | 30 per minute | user |
| Saving and unsaving posts | 30 per minute | user |
| Author applications | 5 per hour | user |
| Role changes and approving applications | 20 per 10 minutes | admin |
| Contact form | 5 per hour per client address, then 60 per hour for the whole site, then 5 per hour per email address (from the stored rows) | client address, the whole backend, email address |
| Newsletter subscribe | 5 per hour per client address, 3 per hour per email address, 120 queued confirmations per hour for the whole site. Over any of them it still answers 202 and queues no mail | client address, email address (hashed key), the whole backend |
| Newsletter confirm | 40 per hour per client address (shared with unsubscribe), then 300 per hour for the whole site, both counted before the token is looked at; then 20 per hour per subscriber address | client address, the whole backend, address (hashed key) |
| Newsletter unsubscribe | 40 per hour per client address (shared with confirm), counted before the token is looked at; then 20 per hour per subscriber address. **No whole-site ceiling**, so stray tokens can never leave real unsubscribes without budget | client address, address (hashed key) |
| Admin password sign-in | 20 per 10 minutes, every attempt counted, before the password is checked | client address |
| Session refresh | 60 per 10 minutes | client address |
| Admin password checks running at once | 2, a waiting login gives up after 5 s | the whole backend |
| Second-step codes | 4 free, then a delay of 30 s that doubles to 15 min; frozen at 100 failures in a row ([details](#two-step-verification-and-recovery)) | the account (its rows are locked) |
| Live sign-in challenges | 20 (the 21st sign-in gets 429 `MFA_RATE_LIMITED`) | the account |
| Second step of a sign-in (verify, begin and confirm an enrollment) | 20 per 10 minutes, every attempt counted (`app.rate-limit.mfa-client`); a backend reached without Next is limited too | client address |
| Changes of two-step verification, the admin reset of an author | 10 per 10 minutes (`app.rate-limit.mfa-step-up`) | user |
| Password changes | 5 per 10 minutes, every attempt counted (`app.rate-limit.password-change`) | user |
| First-run setup attempts | 5 per minute, every attempt counted, checked first; then **wrong codes** only, 120 per minute for the whole backend (a wrong code beyond that answers 429 instead of 403; a right code is never counted there) | client address, the whole backend |
| Site content writes (save, import, avatar) | 60 per 10 minutes | admin |
| Post import (previews, applies and undos together) | 60 per 10 minutes | admin or author |
| Search reindex | 3 per 10 minutes | admin |
| Search requests | 120 per minute per client address (checked first), then 1200 per minute | client address, the whole backend |
| Images read from the database at once, to be served (`GET /api/v1/media/<id>.<ext>`; a `304` reads no bytes) | 8; a ninth waits 2 seconds and then gets 503 `MEDIA_BUSY`, which Next shows as a 502 that is never cached. Each read holds the whole image (up to 4 MiB) in the heap, so 8 is at most 32 MB | the whole backend |

The maps behind the client-address and email-address limits are bounded, because the caller chooses those keys: each holds at
most 20,000 keys. Keys whose window has passed are swept first. What happens when every key is still inside its window depends on
what the bucket protects:

- **Contact, newsletter and search** refuse a **new** key (429, or the quiet "queues nothing" for a newsletter signup) while the keys
  already counted keep their exact quota. A flood of invented addresses can neither grow memory without bound nor push a running
  counter out of the map, at the price that new readers are refused while it lasts.
- **The sign-in path** (the password step, the second step, session refresh and the first-run setup) never refuses a new key: the
  stalest keys, those whose last accepted attempt is the oldest (a sixteenth of the map at a time), are dropped to make room. The owner
  signs in from a new address, enters a code and refreshes the session whatever a crowd does; before this a crowd of about 20,000
  invented addresses (one IPv6 prefix holds tens of thousands of `/64`) kept all three answering 429 for as long as it lasted. The
  price is that a flood of that size can make the counter of an idle address start over, which a fresh address would have given the
  flooder for nothing. The Next server's own counters work the same way: one table of 10,000 keys per kind of limit (so view
  beacons, search suggestions and CSP reports cannot push a running sign-in counter out), the entry that ends first dropped when a
  table is full, and a new key always served.

**In the Next server** (per client IP, read as described in the next section)

| What | Limit |
|---|---|
| GitHub sign-in (starts and finishes) | 20 per 10 minutes. Only a person's own navigation starts a round: a request with Fetch Metadata that is not a top-level navigation from this site (an `<img>`, an iframe, a `fetch`, a link from another site or from a sibling host) is sent to `/login` before the limit and before any backend call, so another page cannot use up the attempts of a visitor's address. A browser that sends no Fetch Metadata is let through |
| Admin password sign-in | 10 per 10 minutes, counting every attempt; a success clears the counter; the 11th gets 429 with `Retry-After` |
| Second step of a sign-in and enrollment (bucket `mfa`) | 10 per 10 minutes, apart from the password bucket; a success clears it |
| Changes on the Security page (`/admin/security/*`, bucket `security`) | 20 per 10 minutes, every call counted, apart from the buckets above; the account's own brakes (a delay after five wrong codes, five password changes per 10 minutes) are the backend's |
| First-run setup | 10 per 10 minutes |
| View beacons | 30 per minute; beyond that they are dropped silently (204) |
| Contact form | 5 per hour |
| Newsletter | subscribe 5, confirm 20, unsubscribe 20 per hour |
| Content-Security-Policy violation reports (`/api/csp-report`) | 100 per 10 minutes, counted before the body is read; the 101st gets 429 |
| Search suggestions and the `/search` page | 120 per minute together; an unknown address counts in the shared "unknown" bucket and is not exempt |
| Pictures (`/media/*`) and the image optimizer (`/_next/image`) | 1,200 per minute per address for each (a gallery page of a hundred pictures is far below it); the 1,201st gets 429 with `Retry-After` and costs the backend nothing. The optimizer is counted in `proxy.ts`, on the reader's own request. The request it makes to `/media/<id>` for itself has no headers and carries the address of the proxy, not the reader's, so the route does not count it (counted, one source making 20 requests a second answered 429 for every picture of every reader); it tells that request by the missing `Host` header |
| Share cards (`/api/og/posts/*`) | 60 per minute per address. An address that cannot be a post (a slash, a control character, more than 255 characters) is answered without asking the backend, and every address that is not a post gets one picture, drawn once and kept in memory, with a five minute `Cache-Control` |
| RSS feeds (the main, category, series and tag feeds) | 120 per minute per address, together |
| Sitemap (`/sitemap.xml`) | 60 per minute per address, counted in `proxy.ts` (a metadata route cannot answer 429); it reads every published post from the backend on each request |

The reads at the end of the table (pictures, the optimizer, share cards, feeds, the sitemap) are the expensive anonymous ones: an image is
read whole from the database into the heap (up to 4 MiB; the backend serves at most 8 at once and answers the ninth with 503 after 2
seconds, and the owner's exports read through their own path so that a flood never makes a package leave its pictures out), the optimizer
decodes and re-encodes it, a share card is drawn by Satori and resvg on demand, a feed poll or the sitemap reads the list from the backend.
Unlike the other limits they are **not** applied to a caller whose address cannot be read (no proxy header, `TRUSTED_PROXY_HOPS` too
high): the shared "unknown" bucket would answer 429 to every reader of the site and break every picture. The proxy examples limit the
same paths before Next does any work ([INSTALL.md](INSTALL.md#limit-the-rate-of-requests)).

If an admin is blocked by mistake: wait for the window, sign in from another network, or `docker compose restart frontend` (the
counter is in memory).

A session refresh that the backend answers with 429 (or 408, or a 5xx) does **not** sign anyone out, in `/admin` or on the public
pages: the cookies stay and the next request tries again. Only a refresh the backend really refuses (expired, unknown or suspended)
clears them.

## Reverse proxy and the client address

Every per-IP limit in Next reads the address at entry number `TRUSTED_PROXY_HOPS` counting **from the right** of `X-Forwarded-For`.
The first entry is something the client writes itself, so it is never used.

- `TRUSTED_PROXY_HOPS=1` (default) for one reverse proxy that appends the real address (nginx with `$proxy_add_x_forwarded_for`,
  Caddy). Values 1 to 5 are accepted; anything else becomes 1.
- **Behind Cloudflare, do not copy `2` blindly.** nginx appends to whatever `X-Forwarded-For` the caller sent, so the second entry
  from the right is the visitor only when the request came through Cloudflare. A caller who reaches the origin directly (its address
  leaked, or never hidden) writes its own header and chooses the key of every per-address limit, in Next and in the backend (what
  still holds is listed under "What is not protected"). Two safe setups: keep `TRUSTED_PROXY_HOPS=1` and let nginx restore the
  visitor address with `set_real_ip_from` for Cloudflare's published ranges and `real_ip_header CF-Connecting-IP`
  (`/etc/nginx/cloudflare-realip.conf`, built as [INSTALL.md](INSTALL.md#behind-cloudflare) says): a request from any other address
  keeps its own socket address as the key, even if the origin is reachable; or use `2` only if the origin accepts connections from
  Cloudflare alone (firewall allow-list of Cloudflare's ranges on 443, Authenticated Origin Pulls, or Cloudflare Tunnel). Caddy
  with `trusted_proxies` set to Cloudflare's ranges replaces the header for every other caller, so `2` is safe there; lock the origin
  anyway.
- Set lower than reality, readers behind one proxy share one limit. Set higher, the key is something the client sends itself.
- An entry that is not an IP address, a header with fewer entries than hops, or no header at all makes the address "unknown", and all
  such requests share one key per limit. The sign-in, second-step, Security page, GitHub sign-in and setup limits give that key the
  allowance of **one** address, so a caller cannot get ten times as much by making its address unreadable; the other limits (views,
  search, contact, newsletter) give it a wider one (100 per 10 minutes). In production Next also writes one `[client-ip]` line to its
  log, once per process, when a request arrives with a header shorter than `TRUSTED_PROXY_HOPS` or with none: a sign that Next is
  reached without the proxy, or that the number of hops is too high. The line carries no address. While it keeps happening, the
  shared "unknown" key has the sign-in allowance of one address (10 attempts per 10 minutes) for everybody together, so a stranger
  can use it up with ten requests and keep the owner's sign-in from working until the window ends; that line is the cue to fix the
  proxy ([Troubleshooting](TROUBLESHOOTING.md)).
- **Next must not take requests straight from the internet.** Compose publishes it on `127.0.0.1` for this reason. Do not set
  `SITE_BIND=0.0.0.0` when the proxy is on the same machine: Docker opens published ports with its own iptables rules, which `ufw`
  does not block. Anyone who can call Next's port can choose their own limit key and skip the proxy's body limits. The backend
  cannot tell: it believes the address Next derived, and Next derived it from a header the caller wrote. In that situation the
  per-address limits can be rotated, and only the per-email limits and the whole-site ceilings still hold.
- **The proxy refuses `TRACE`, `TRACK` and `CONNECT`.** Both examples answer 405 before the request is forwarded. Next cannot refuse them
  itself: its request adapter throws `'TRACE' HTTP method is unsupported` before any of your code runs, so each such request answers 500
  and writes a stack trace to the log (no data is returned; it is log noise and a cheap way to trip 5xx monitoring). That is another reason
  to keep Next on `127.0.0.1` behind a proxy of your own.
- The proxy must pass **`Host: $host`** ([deploy/](../deploy)). Next compares the `Origin` of every Server Action with the request
  host and cancels a mismatch, so without it every save and upload in the admin fails and the admin cannot sign in.
- The proxy keeps the one-time OAuth `code`, the newsletter tokens and **search terms** out of its access log
  (`/api/auth/github/callback`, `/newsletter/*`, `/api/newsletter/*`, `/search?q=`, `/api/search/suggest?q=`); the example
  configurations do it. Neither the backend nor Next ever logs them. nginx logs `$uri` instead of the request line and no
  `Referer` (the referer of a click on a search result is the search URL), in every server block, and was checked on a real nginx
  (`DEPLOY_EXAMPLES_DOCKER=1 python scripts/test_deploy_examples.py`). Caddy writes no access log unless you add `log`, but its error
  log names the request with its query when the upstream fails, so the example's global `log` cuts the query from `request>uri` and
  drops the `Referer`; a `log` you add to a site needs the same filter. What is left in a proxy is the error log of nginx (it copies
  the request line when the upstream fails) and your own additions: keep proxy logs short-lived (a week is plenty: logrotate
  `daily` with `rotate 7`, journald `MaxRetentionSec=7day`) and do not copy them to a service that keeps them longer.
- **`CLIENT_IP_TOKEN`** is the shared secret that lets the backend believe the address Next forwards (see [Rate limits](#rate-limits)).
  Compose passes the same value to both sides and `init-env` writes a random one. Outside Compose set the same value on both. If the
  two differ, or the frontend has none, the backend counts the socket address, which is the Next server: every reader then counts as
  **one** caller and the per-address limits trip for everybody. The backend refuses to start in production without it.
- **A backend with a public URL** (a platform such as Koyeb or Render, instead of Compose) is reachable by anyone, so it counts the
  **socket address** of every direct caller (the platform's load balancer address, shared by all of them): contact, newsletter
  signup, confirm and unsubscribe, admin sign-in, refresh, first-run setup and search are limited there too, together, instead of
  being unlimited. Readers who come through Next keep their own count, told apart by the forwarded address. Two things stay open:
  its two GitHub OAuth paths, which are directly callable and bypass every per-IP limit (a sign-in still needs the signed blob and
  GitHub's one-time code, so this is a loosening, not a hole), and the reading endpoints, which have no per-address limit at all.
  Set `SITE_URL`, `JWT_SECRET`, `VIEWS_TOKEN`, `CLIENT_IP_TOKEN` and the other secrets in the platform's configuration: it does not
  read Compose, and the backend refuses to start without them.

## Containers and networks

The backend decodes uploaded images and reads ZIP packages, the frontend renders author Markdown, so the compose file limits what a
bug in either can do once it has code running inside the container (`docker-compose.yml`, the `x-hardened` block;
`python scripts/test_container_hardening.py` fails when one of these disappears):

- **No privilege gain, no capabilities.** Every service runs with `no-new-privileges` and `cap_drop: ALL`. Postgres adds back only
  `CHOWN`, `SETUID`, `SETGID`, `FOWNER` and `DAC_OVERRIDE`, which its entrypoint needs to chown the data directory and switch to the
  postgres user.
- **A read-only root file system.** The application code cannot be rewritten while the container runs. What is written lives in a
  tmpfs (gone when the container stops: `/tmp` everywhere, `/app/.next/cache` of the frontend, `/run/postgresql`) or in a named volume
  (`postgres_data`, `backend_data` for the setup code, `meili_data`). tmpfs counts against the memory limit of its container:
  the backend's `/tmp` (up to 96 MB, where uploads and ZIP packages spill) is charged to the same 768 MB that
  `-XX:MaxRAMPercentage=70` sizes the heap against, so heavy uploads leave less headroom than before; if the backend is killed for
  memory under load, raise `BACKEND_MEM_LIMIT`. The frontend's two tmpfs (32 MB `/tmp`, 96 MB `.next/cache`, of which Next fills at
  most 64 MB with optimized images) are charged to its 384 MB; the rendered pages and the data cache are in the memory of the Next
  process (`frontend/cache-handler.mjs`), so a restart of the frontend empties every cache it has.
- **Root-owned code.** In the images the application tree is `root:root`, even though the process runs as `nextjs` or `blog`: the
  frontend `server.js` and its dependencies, and the backend jar, are not writable by the process that runs them, with or without
  `read_only`. The only writable path in the frontend image is the cache directory.
- **A process limit** per container (`pids_limit`; the backend and postgres get more because a thread or a process serves each request
  or connection).
- **Two networks.** `db` is `internal` (no route out, none in) and holds postgres and the backend only; `app` holds the frontend, the
  backend and Meilisearch. The frontend cannot open a connection to postgres, whatever code runs in it, and postgres cannot reach
  the internet. The backend is on both because it needs the way out for GitHub sign-in and SMTP. Only the frontend publishes a port
  (on `127.0.0.1`), plus Meilisearch on `127.0.0.1:7700` when the optional `search` profile is on.
- **Three database roles.** The backend connects to PostgreSQL as a runtime role that can `SELECT`, `INSERT`, `UPDATE` and `DELETE` rows
  and use sequences, and nothing else: it cannot create or drop objects, install extensions, create roles, truncate a table, or read
  files and run programs on the database host. The migrations run as a second role that owns the schema and is not a superuser, and the
  superuser exists for administration only (`deploy/postgres-init`, `DatabaseRoleIT`). A new Compose install has them from the start;
  an existing one keeps its single role until the operator moves it ([Upgrading](UPGRADING.md#moving-to-the-three-database-roles)),
  and the backend says so in its log at every start on a public site. The runtime role can still change every row, including the
  Flyway history table: the roles limit what an SQL bug can do to the server and the schema, not to the data.
- **Smaller runtime images.** The frontend image has no npm, npx, corepack, yarn, Alpine package manager, `nc` or `wget`; the backend
  image has no package manager and no `nc` (its `wget` stays, the healthcheck uses it). The shell and the other busybox tools stay for
  `docker exec`, and the JVM and Node have their own networking, so this narrows an attacker's toolbox without closing it. A
  distroless base image would, at the price of no shell and a different healthcheck; it is not done.

If you add a mount or a feature that writes (a custom log directory, a plugin), give it a volume or a tmpfs: a "Read-only file system"
error in a service log means a write to the root file system. `docker compose exec` still works for debugging. The images themselves
(not the compose file) are what `docker run` uses: they run as a non-root user and keep the root-owned code and the missing tools, but
not the read-only root, capabilities and networks, which are compose settings.

## Response headers

Sent by Next on every path, so the proxy does not need to add them (adding them again means two lines per header, and a browser
reads only the first `Strict-Transport-Security`):

| Header | Value |
|---|---|
| `X-Frame-Options` | `DENY` |
| `Content-Security-Policy` | the full policy of [Content Security Policy](#content-security-policy), enforced, `frame-ancestors 'none'` included |
| `Reporting-Endpoints` | `csp-endpoint="/api/csp-report"`: where the `report-to` of the policy sends its reports |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin`; `no-referrer` under `/api/auth/github/*`, `/newsletter/*` and `/setup/*` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` |
| `Strict-Transport-Security` | `max-age=86400` when `SITE_URL` is `https` (`HSTS_MAX_AGE`, fixed at build time); `includeSubDomains` only with `HSTS_INCLUDE_SUBDOMAINS=true`; never `preload` |
| `X-Powered-By` | not sent |

`/media/*` additionally sends `Content-Security-Policy: script-src 'none'; frame-src 'none'; sandbox; frame-ancestors 'none'`, and
`/setup/*` sends `Cache-Control: no-store`.

HSTS starts at one day so that an HTTPS mistake only locks readers out until tomorrow. Once the certificate renews on its own and
every page opens over HTTPS, raise it to a year (`HSTS_MAX_AGE=31536000`, then `docker compose up -d --build`; a dated step of the
install, [INSTALL.md](INSTALL.md#raise-hsts-after-https-is-proven)); the frontend build prints one `[hsts]` line while the value is
under a year, so the default does not stay by forgetting. ASVS 3.4.1 asks for a year, and the one-day default is the documented
exception for the first days. `HSTS_INCLUDE_SUBDOMAINS=true` adds `; includeSubDomains`, only for an operator who owns every
subdomain of the host and serves all of them over https (a subdomain without working HTTPS goes dark for the whole max-age); it is
off by default, only the exact word `true` turns it on, and `max-age=0` never carries it. There is no `preload` switch on purpose: a
browser preload list is almost impossible to leave. `HSTS_MAX_AGE=0` sends `max-age=0`, which makes browsers forget the policy.

### Content Security Policy

Raw author HTML goes through `rehype-raw` and a sanitizer, so a sanitizer bypass would be stored XSS on the main origin. A
Content Security Policy is the second layer. It is enforced on every page, with no nonce (stage 2 of the plan below); the nonce is a
decision of its own.

`frontend/csp-policy.mjs` builds the policy and `next.config.ts` sends it as one `Content-Security-Policy` header on every path:
`default-src 'self'`; `script-src 'self' 'unsafe-inline'` (plus `'unsafe-eval'` only in `next dev`);
`style-src 'self' 'unsafe-inline'`; `img-src 'self' data: blob: https:`; `font-src 'self' data:`; `connect-src 'self'`;
`frame-src 'none'` (no block embeds a frame); `object-src 'none'`; `base-uri 'none'`; `form-action 'self'`;
`frame-ancestors 'none'`; `upgrade-insecure-requests` when `SITE_URL` is https; `report-uri /api/csp-report; report-to csp-endpoint`.
`/media/*` keeps its own stricter policy (`script-src 'none'; frame-src 'none'; sandbox; frame-ancestors 'none'`).

- **Why no nonce.** The theme boot script and the React Server Components payload are inline scripts. A per-request nonce makes every
  page dynamic and loses the static and ISR cache, and a hash cannot cover the RSC payload, which differs on every page. So
  `'unsafe-inline'` stays in `script-src` and the policy does **not** stop an injected inline script. It does stop script from another
  origin, plugins, `<base>`, form posts to another origin, a page calling any other origin from script (`connect-src`), framing and eval.
- **Images from any `https` host are allowed, on purpose.** The product lets an author put an `https` image in a `figure` block or in
  Markdown ([content-blocks.md](content-blocks.md)), and listing only the hosts the code itself uses would break those pictures on
  the day the policy is enforced. An image cannot run code, so this costs privacy, not integrity: a third-party host sees the
  reader's address when the picture loads (see "What is not protected"). A site that wants no third-party images can narrow
  `img-src` in `frontend/csp-policy.mjs` to `'self' data: blob:` and rebuild the frontend image; the pictures of such a post then
  show their alt text, and each blocked one is reported.
- **`form-action 'self'`** does not stop a same-origin Server Action.
- **Reports.** `report-uri` (Firefox, Safari) and `report-to csp-endpoint`, which the `Reporting-Endpoints` header above defines
  (Chrome, Edge), send what a browser blocks to `/api/csp-report`. `app/api/csp-report/route.ts` accepts `application/csp-report` and
  `application/reports+json` only (415 otherwise), at most 8 KiB (413), 100 requests per 10 minutes per client address (429), and
  answers 204. It logs one line per violation, `[csp] violation <directive> blocked=<origin>`, and nothing else: the address of the
  page, its query string, the referrer, the source file and the script sample are never read, because a page address can hold a
  search query or a token. The blocked address is cut down to scheme and host (`blocked=https://tracker.example`), or a keyword
  (`inline`, `eval`, `data`, `blob`) or `other`; a forged report cannot write a line of its own (`lib/csp-report.ts`). Read the lines
  with `docker compose logs frontend | grep "\[csp\]"`. A line you did not cause is a page or an extension that the policy
  blocks: look at the directive first.
- **How it is tested.** `e2e/security.spec.ts` ("Content Security Policy") checks the header on the main pages and collects
  `securitypolicyviolation` events on the public pages, on a post with blocks and in the admin editor, and fails on any. The whole
  E2E suite runs under the enforced policy, so a blocked script, style or request fails the journey that needs it.
- **Taking it back.** If an enforced policy ever breaks a page you cannot fix at once, send the same string as
  `Content-Security-Policy-Report-Only` for a while: `buildContentSecurityPolicy({ ..., reportOnly: true })` in
  `frontend/next.config.ts` (it leaves out `frame-ancestors` and `upgrade-insecure-requests`, which a Report-Only policy ignores,
  so keep `Content-Security-Policy: frame-ancestors 'none'` next to it), then rebuild the frontend image.

The plan, in stages: 1. Report-Only with a report endpoint (done). 2. Enforced (this release). 3. Drop `'unsafe-inline'` from
`script-src` only with a nonce from the proxy, accepting dynamic rendering, once its cost is measured.

The sanitizer schema and the Mermaid filter stay the primary defense; the policy does not replace them.

## Upload limits, by layer

Each layer blocks as early as it can, and each later layer is slightly wider than the one before, so that the error shows up at the
layer that can explain it best.

| Layer | Limit | When exceeded |
|---|---|---|
| Browser (admin) | A file over 4 MB or a side over 2400 px is shrunk to a JPEG with side at most 2400 px before sending. Smaller files are sent as they are, so the server can read the shooting date from EXIF | none |
| Reverse proxy | 1 MB for everything, 6 MB for `/admin/` | 413 from the proxy |
| Next, sign-in and other public JSON routes | 16 KB, read with a limit (`lib/read-small-body.ts`), not trusted from `Content-Length`: the admin sign-in, the second step, the Security page, first-run setup, comments, the newsletter and the CSP report. The sign-in also refuses an address over 254 characters and a password over 256 before the backend hashes anything | 413 `PAYLOAD_TOO_LARGE` (400 for a field too long) |
| Next, Server Action | `serverActions.bodySizeLimit: '5mb'`, multipart overhead included. The upload action rechecks that the file is at most 4 MB | Next rejects the action, or the action returns an error shown in place |
| Next, `proxy.ts` | `proxyClientMaxBodySize: '10mb'`, always larger than the limit above (`next-config.test.ts` pins this) | the body is cut off **silently**, which is why it must be wider |
| Spring | multipart `max-file-size` 10MB, `max-request-size` 11MB; `app.media.max-upload-size` 10MB rechecked in code | 413 `MEDIA_TOO_LARGE` |
| Backend, size of a JSON body | `RequestSizeLimitFilter`, before anything reads the body and before the security chain: 64 KiB for every `/api/**` path except `/api/v1/admin/**` (`app.request-limit.public-body`), 6 MiB under `/api/v1/admin/**` (`app.request-limit.admin-body`, at most 8 MiB). A request that declares its length above the ceiling is refused without reading a byte; one that does not (chunked) is counted as it is read. Multipart uploads are left to the Spring limits above. Tomcat refuses a form-encoded POST body over 64 KB (`server.tomcat.max-http-form-post-size`, which also bounds the text parts of a multipart request), and no endpoint takes a form body: the filter that would read a PUT, PATCH or DELETE form is off (`spring.mvc.formcontent.filter.enabled`), and a chunked body that any other filter reads past the ceiling is answered with the same 413, not with a 500 and a stack trace in the log | 413 `VALIDATION_ERROR` ("The request body is too large") |
| Backend, JSON reader | one string at most 1,000,000 characters and one document at most 8 MiB (`spring.jackson.factory.constraints.read`), for every JSON the backend parses. The Jackson 3 defaults are 100 million characters and no limit on the document | 400 `VALIDATION_ERROR` ("Malformed request body") |
| Backend, fields of the anonymous requests | `@Size` before the service copies a field: sign-in address 254 and password 512, refresh token 512, contact name 200, subject 300, message 10,000 (the service then applies its own 100, 150 and 5,000 after stripping control characters), newsletter address 254 and locale 16 | 400 `VALIDATION_ERROR` |
| Image pipeline | at most 50 million pixels, read from the header before decoding; one image processed at a time (a request that waits 20 s gets 503 `MEDIA_BUSY`). A stored image has its long side at most 2400 px and at most 4 MiB | 422 `MEDIA_DIMENSIONS_TOO_LARGE`; 413 `MEDIA_TOO_LARGE` when even shrunk to 800 px it is over 4 MiB |
| Post import (Markdown files) | per file 256 KiB, in total 4 MiB, at most 20 files, so at most 21 multipart parts (the files and one manifest). The total is the cap that binds first for large files (20 x 256 KiB would be 5 MiB, more than the Next limit above). Files are decoded as strict UTF-8 text, never executed, and are not stored | 413 `VALIDATION_ERROR` for a file or a total over its cap; 400 `POST_IMPORT_INVALID_FILE` for more than 20 files, an empty file or one that is not UTF-8 text |
| Post import (ZIP packages) | a package is at most 4 MiB, 40 entries, an article of 256 KiB, an image of 4 MiB, 16 MiB unpacked in all packages of one request, a compression ratio of at most 100. The reader uses `java.util.zip` only, reads the central directory by hand, never trusts a declared size and refuses absolute paths, `..`, backslashes, drive letters, control characters, duplicate names (also after NFC and case folding), links, encryption, ZIP64 and archives inside a package. An image is accepted by its magic bytes (JPEG, PNG, WebP; never SVG), re-encoded by the media pipeline before it is stored, and stored with the post it belongs to. A check for unsafe HTML (`script`, `style`, `iframe`, `object`, `embed`, `javascript:` URLs, event handlers) outside code reports the usual mistakes as problems of the file. It is a best-effort lint over lines, not a security boundary: it does not parse Markdown or HTML, a determined author can write around it, and a plain `.md` file is not checked at all. What keeps a post safe is the sanitizing schema of the renderer (`rehype-sanitize`, see "Markdown in posts" above), which cleans every post when it is rendered, whatever its source | a package that cannot be read is an `error` card of the preview; 400 `POST_IMPORT_INVALID` for a selected file with a problem; 422 `POST_IMPORT_MEDIA_QUOTA_EXCEEDED`; 503 `POST_IMPORT_MEDIA_BUSY` |
| Quota | total of all images at most `MEDIA_MAX_TOTAL_SIZE` (default 1GB); replacing a cover image counts only the increase. An author's own images at most `AUTHOR_MEDIA_MAX_SIZE` (100MB) and all authors' together at most `AUTHOR_MEDIA_SHARE_PERCENT` percent (50) of it | 422 `MEDIA_QUOTA_EXCEEDED` |
| Post text (create and update through the API) | the body at most 500,000 characters and the excerpt at most 1,000, counted in UTF-16 units. The editor already warns at 400 characters for the excerpt. Imported files are capped lower (256 KiB each, above), and an excerpt over 1,000 characters in a file is a problem of that file. The database repeats both limits in CHECK constraints (migration `V46`) for a write that does not come through the API; restoring an older revision that is longer than a post may be answers 400 | 400 `VALIDATION_ERROR` |

A backend with a public URL of its own (Koyeb, Render) has no proxy in front of it, so these three rows are its only bound: before
them, nothing limited a JSON body before it was read into memory, and a few large anonymous requests were enough to exhaust the heap and,
with `-XX:+ExitOnOutOfMemoryError`, to end the process again and again. Behind the Compose proxy the 1 MB limit still comes first.

Every list of posts (the public lists, popular, featured, search, series, bookmarks, the admin list) reads the posts **without their
body** (`PostCard`) and shows the reading time that is stored with the post, so the memory and the time of a list no longer grow with
the size of the posts it shows; only the page of one post reads its body.

**What an upload reaches.** An image sent by an author is parsed by native code in the backend process, which holds the database
credentials and the signing key: the JDK's Little CMS for a colour profile, libjpeg and the TwelveMonkeys decoders for JPEG and
WebP. The pipeline narrows what they see: a magic-byte sniff, a pixel cap read from the header, a re-encode that drops all metadata,
and a colour profile of at most 1 MiB. Since the audit it also looks at the header of an embedded PNG profile before the colour engine
does (the `acsp` signature, an RGB profile of the display, input, output or colour-space class, a declared size that fits, at most 100
tags, every tag inside the profile); a profile that fails is treated as absent and the image is read as sRGB. The residual risk is a
flaw in a decoder that this does not narrow: keep the base image and the dependencies patched (CI scans them, and Dependabot raises
the TwelveMonkeys updates), pin the image by digest in your own deployment, and, if your authors are not people you trust, decode
images in a separate process or container without the secrets (not built here). The author's share of the image quota and the single
author gate in front of the processing slot ([above](#what-an-author-may-write)) limit how much of this one author can drive.

The 1 MB limit for public paths has real work to do: Next reads **every** multipart POST to **every** page up to 5 MiB before it
knows whether it is a valid action, so the proxy is what stops junk POSTs before they take up Next's memory. Public pages send
nothing over 16 KB (a view beacon is at most 512 bytes, a comment at most 16 KB).

The JVM heap is 70 percent of the backend container's memory limit (`BACKEND_MEM_LIMIT`, default `768m`), and images are decoded
inside it. See [INSTALL.md](INSTALL.md) for sizing. The backend JVM runs with `-XX:+ExitOnOutOfMemoryError`: after an
`OutOfMemoryError` the process ends and `restart: unless-stopped` starts a clean one, instead of staying up in a state nobody can
vouch for. A post that is still stored with a body over the limit (saved before the limit existed) keeps working; only a new save is
checked, and there is no database constraint yet.

## Article blocks and ZIP packages

An article may use native blocks (`:::callout{...}`, [content-blocks.md](content-blocks.md)) and arrive as a ZIP package
([post-file-format.md](post-file-format.md#zip-packages)). What keeps both safe:

- **A block is data, not code.** One Markdown pipeline renders every article (`renderMarkdown`). Its sanitizer (`rehype-sanitize`)
  allows one extra tag, `ai-block`, with the attribute names of the block registry and nothing else; a dispatcher validates every
  attribute against the registry again before it draws a native React component. An article cannot bring a script, an event handler,
  CSS, a frame, a `class` beyond the few exact values above or an `id` or `name` without the `user-content-` prefix (a heading's id
  is made by the renderer, and only a slug that could shadow the page is prefixed: see "Markdown in posts"; the other raw HTML an
  author can bring is the sanitizer's allowlist of elements), and a raw `<ai-block>` typed by an author is never drawn: it stays
  literal text and is reported (`reserved-tag`). Image sources are paths of the package, `/media/` paths or `https` URLs, never
  `data:` or `javascript:`.
- **Diagrams.** `mermaid` is loaded in the browser only, lazily, with `securityLevel: 'strict'`; the diagram source is kept as text.
  The library draws a label as HTML inside the drawing, so a label is author-controlled markup and two layers clean it, both in
  `frontend/components/site/blocks/`. The first is the label cleaner of the library, configured with `LABEL_PURIFY_CONFIG`
  (`diagram-safety.ts`): a few formatting tags (`b`, `i`, `em`, `strong`, `code`, `br`, `p`, `span`, lists) and no attribute. The
  second is `toSafeDrawing`, which rebuilds the drawing the library returns from allowlists and trusts nothing of the first: only
  SVG drawing elements are kept (no script, animation, `feImage` or frame), inside a label only the formatting tags (a form,
  control, `label`, link, image or style element is removed and its text stays), only known attributes, only addresses that are
  `http(s)`, a path of the site or a place in the drawing, and only a short list of style properties in a `style` attribute (a label
  cannot position, cover, paint behind or load anything through its own attribute: no `position`, `inset`, `z-index`, `background`,
  `margin`, `transform` or external `url()`). The drawing's own `<style>` element is not filtered by property: the library scopes every
  selector to the drawing and `toSafeDrawing` removes `@import`, backslashes and external `url()`, but a class definition can still
  position or enlarge a label, and the browser clips that to the box of the drawing.
  Without this an AUTHOR could place a live form (credential phishing, or a same-origin Server Action call) into a page of the site,
  the admin preview and the editor preview.
- **Plain form posts to `/admin` are refused.** The admin UI calls its Server Actions only through the client router, which sends the
  `next-action` header; its other forms are `GET`. The proxy (`frontend/proxy.ts`) answers 403 to a `POST` under `/admin` whose
  content type is `multipart/form-data`, `application/x-www-form-urlencoded` or `text/plain` and which has no `next-action` header,
  before any session logic. The matcher of the proxy lists `/admin` and `/admin/:path*` explicitly, so a dynamic admin route whose last
  segment looks like a file (`/admin/settings/about.x`) is gated too. The login POST target and the logout handler stay open. This is a second line behind the `Origin` versus
  `Host` comparison of Next, for a form planted in a page of the same origin. A form submitted before the page is interactive (or
  without JavaScript) is refused too; reload the page and submit again.
- **The unsafe-content scan is a lint.** The check of a package for `<script`, `<style`, `<iframe` and the like works line by line and
  helps the author; it is not the barrier, and plain `.md` files are not scanned. The sanitizer is the barrier.
- **The archive reader trusts nothing.** `java.util.zip` only, the central directory read by hand, bounded reads, the limits of the
  table above, and refusal of unsafe paths, links, encryption, ZIP64 and nested archives. A message names an entry by its position.
- **Images are re-encoded.** Every image of a package goes through the media pipeline (pixel cap, EXIF and GPS removed, re-encoded
  to a stored copy) before it is stored with the post, and counts against the quota. SVG is never accepted.
- **No content in logs.** A refusal, a log line and the import log carry ids, positions, line numbers and counts, never a file name,
  a path, a title, the Markdown, the bytes of an image or a diagram. Only the success answer to the uploader (the preview and the
  article preview, which are rate limited and need an admin or author) may hold text of the file.

## The newsletter of an author's post is held

A newsletter mails the title and excerpt of a post to every confirmed subscriber of its language, from the site's own sender. An
AUTHOR writes that text, so it is not sent on the author's say-so: when anyone but an ADMIN publishes a post for the first time, the
issue is stored as `HELD` (migration V48) and the worker never splits a held issue into mails. An ADMIN lists them
(`GET /api/v1/admin/newsletter/held`) and releases (`POST /api/v1/admin/newsletter/issues/{postId}/release`) or discards
(`.../discard`) one; both are ADMIN only like the rest of `/api/v1/admin`, are logged as `newsletter issue released|discarded
postId=<id> by=<adminId>` and answer 404 `NEWSLETTER_ISSUE_NOT_FOUND` for an issue that is not held. A release carries
the `version` that the list returned for the post, a hash of the address, the one-line subject, the cut excerpt and the language; under the
lock of the issue the service recomputes it from the post as it is and answers 409 `NEWSLETTER_ISSUE_CHANGED` when it differs, so an edit
the author made after the page loaded (they may save again and again) is never mailed unseen, and a title switched back to the text that
was read can be released. A release stores the subject, the excerpt and the language it checked (`approved_title`, `approved_excerpt`,
`approved_language`, migration V51) and the worker mails those to the subscribers of that language, so editing the post, or changing its
language, after the approval changes nothing in the mail or in who gets it. A subject is one line (control, invisible and text-direction characters are removed) and an
excerpt is cut at 300 code points, whatever the post holds. A post an ADMIN publishes (also one an author wrote) is queued at once.
The decision is not time limited: a held issue waits until an ADMIN decides.

## What the database enforces

Beside the rules in the services, the database refuses a post with a status that does not exist, a `PUBLISHED` post without a publish date,
a hidden post that is published, a slug that is not lower case words joined by single hyphens, an old slug that equals the current slug of
another post (and the other way round: two triggers, whichever statement writes the row), an image of more than 4 MiB in
`media_content`, and a reply to a reply. They are a backstop for a script, a hand-written statement or a future bug. Other rules stay in
code: the 30 replies of a thread, the last administrator, and which account may do what (the database has no notion of the caller).

## Deleting a post

A hard delete of a post takes everything that hangs on it (`ON DELETE CASCADE`): the readers' comments with their likes and notifications,
post likes, saved posts, the revisions, the body images and their bytes, the newsletter issue with its deliveries, the view statistics
and the slug history; the slug can then be reused, and a post left alone in a translation group is dissolved. Most of those rows belong
to other people, so an AUTHOR's delete of their own post is a **soft delete** (migration V49): `status` becomes `ARCHIVED`,
`deleted_at` and `deleted_by` are set, and nothing else is touched. No public query returns the post, the search index drops it, the
author's list and the author's routes no longer see it (`PostAccessPolicy.isOwner` is false for it), and its slug stays reserved. It also
leaves its translation group, as a deleted post does, so that its sibling can be linked to another post. Only an
ADMIN deletes for good (the same button; the hidden post shows as ARCHIVED in the ADMIN list), and publishing a hidden post as an ADMIN
brings it back. Each deletion is one log line, `post deleted postId=<id> by=<userId> role=AUTHOR|ADMIN kind=hidden|hard comments=<n>`,
with no title and no text. The database refuses a post that is both hidden and published (`chk_posts_deleted_not_published`).

## What an author may write

An AUTHOR is the least trusted writer; the account may belong to a guest. What it writes is stored in the shared database and read
whole by public pages, so an AUTHOR (never an ADMIN) is held to limits that a person at a keyboard does not meet and a script does
([Author limits](CONFIGURATION.md#author-limits)):

| What | Limit | Answer |
|---|---|---|
| Tags on a post | 10; a post that already has more can still be saved while the save adds no tag. The import preview checks it too (a problem of the file), so the apply never fails on it | 400 `VALIDATION_ERROR` |
| Creating and saving posts | 60 per 10 minutes (`post-write`); a translation draft is one write | 429 `RATE_LIMITED` |
| Posts created | 30 in 24 hours, imports and translation drafts included (unlinking or hiding a draft does not give the place back) | 429 `AUTHOR_QUOTA_EXCEEDED` |
| Creating tags and categories | 10 per hour (`taxonomy-create`) | 429 `RATE_LIMITED` |
| Tags, categories in the catalog | 1,000 and 100; above them only an ADMIN creates more | 422 `AUTHOR_QUOTA_EXCEEDED` |
| Uploading a cover or body image | 30 per 10 minutes (`media-upload`) | 429 `RATE_LIMITED` |
| Images in the body of a post | 30 | 422 `AUTHOR_QUOTA_EXCEEDED` |
| Stored image bytes | 100 MB per author, and 50 percent of the image quota for all authors together | 422 `MEDIA_QUOTA_EXCEEDED` |
| Old addresses kept by a post after renames | 5 (an administrator's own posts keep all) | the oldest is dropped |

The image pipeline has one processing slot for the whole site: an author's image waits behind a gate that holds at most one author
image at a time, so an administrator's upload waits behind at most one author image. A slug that is taken is numbered from `-2` to
`-51` and then gets a random suffix, so squatting numbered slugs cannot turn one request into thousands of queries. The newsletter of a
post an author publishes is held for an administrator ([above](#the-newsletter-of-an-authors-post-is-held)). The burst limits are
counted in the memory of one process like every [rate limit](#rate-limits); the daily number, the catalog sizes and the image shares
are read from the database. Those counts are read and then written without a lock, so requests in flight at the same moment can
overshoot a daily number or a share by about the number in flight, which the burst limits bound. Deleting a post gives no quota back: a post
an author deleted is only hidden, its images stay (and count in the author's share and in the share of all authors) and the author can no
longer delete them, because the post is no longer theirs. An administrator frees the space by deleting the post for good.

## Caching, and a CDN in front

What the site tells a cache between it and a reader (a CDN, a caching reverse proxy). The shipped nginx and Caddy examples cache
nothing; this matters when you add one.

| Response | `Cache-Control` | Why |
|---|---|---|
| RSS feeds (`/feed.xml`, and the category, series and tag feeds) | `public, max-age=0, must-revalidate` | A feed is read from the backend on every poll so that a withdrawn post disappears at once. Without a rule, CloudFront (24 hours by default), Fastly or an nginx `proxy_cache_valid` would keep the old feed, whole articles included. |
| A feed that cannot be built (503) | `no-store`, with `Retry-After: 120` | A cached 503 would outlive the incident. |
| A feed for a slug or locale that does not exist (404) | `public, max-age=0, must-revalidate` | Stored, but checked again at once. |
| Pages (post, case study and the other cached pages), a 404 included | `s-maxage=300, stale-while-revalidate=3300` (`expireTime: 3600` in `next.config.ts`) | Next revalidates every 300 seconds; an entry older than an hour is rendered fresh before it is served. A shared cache may keep a page for an hour at most, a 404 too. |
| `/media/<uuid>.<ext>` | `public, max-age=31536000, s-maxage=31536000, immutable`; an error answer is `no-store` | An image address never changes its bytes. A deleted image stays at a CDN for up to a year: purge it ([INSTALL.md](INSTALL.md#a-cdn-in-front)). |

How long a withdrawn page stays visible, by how it was withdrawn:

| Withdrawn by | Cache cleared | The page can still be served |
|---|---|---|
| Save, publish, unpublish or delete in the admin (one post or a bulk action) | at once, in the running Next process (`updateTag`), also when a bulk action finds the post already gone | not by Next; a CDN in front is not reached by `updateTag` |
| An API call, a script or SQL | never | Next serves the old copy until the entry expires (300 seconds) and, as stale-while-revalidate, **one more time** after that; a page nobody opened in the meantime serves one stale copy, but never one older than an hour (`expireTime`) |

**What Next keeps, on disk and in memory, and what the server does about it** (`frontend/cache-handler.mjs`, `frontend/instrumentation.ts`,
`frontend/lib/runtime-cache.ts`, `frontend/scripts/clear-prerendered-pages.mjs`). Left alone, Next 16.4 writes every page it renders on
demand to `.next/server/route-cache` (about 250 KB a page: the HTML, the data and the prefetch segments) and every cached backend answer
to `.next/cache/fetch-cache`. Two weaknesses came with that. Both are closed, and because the containers are read-only the way they are
closed differs between the image and a plain `next start`:

- *Anyone could fill the disk.* A 404 is a page too, and the address in `/posts/<slug>` and `/case-studies/<slug>` is the caller's:
  24 requests for made-up addresses wrote 6.3 MB to disk, and nothing ever removed them. With `frontend/cache-handler.mjs` (configured in
  every build but `next dev`, so in the image and in `next start`) nothing of the kind is written: pages rendered on demand and the data
  cache live in the in-memory LRU of Next (`cacheMaxMemorySize`, 50 MB by default, least recently used first), and a flood of made-up
  slugs pushes older entries out instead of filling a disk. `ROUTE_CACHE_MAX_MB` and the 30 second prune of `lib/runtime-cache.ts` have
  nothing to act on while the handler is configured; they bound `.next/server/route-cache` only for a build without it. This bounds the
  memory, not the work: every made-up address still costs one render and two backend calls, so the proxy examples
  limit the rate of page requests and a CDN should do the same.
- *A restart brought back a post that had been taken down.* The note of which tags `updateTag` expired lives in memory; an entry that
  outlives the process (a file on disk) was valid again after a restart while it was fresh and was served once, stale, after that
  (measured before the handler: unpublished in the admin, restart, `GET /posts/<slug>` answered `200` with `x-nextjs-cache: STALE`).
  Entries in memory die with the process, so there is nothing to bring back. What does outlive it is the build: the image build has no
  backend, so each page that revalidates was prerendered from the neutral default site content, and Next serves that copy once. In the
  image the tree is root-owned on a read-only file system, so the server cannot delete it at start; the build stage of `frontend/Dockerfile`
  does, after `next build` (`scripts/clear-prerendered-pages.mjs`), and `scripts/test_container_hardening.py` checks that the image holds
  none and that the first request after a restart is a render (`x-nextjs-cache: MISS`). Outside the image `startRuntimeCacheGuard` removes
  the same copies, `route-cache` and `fetch-cache` at every start; a log line says how many files went, never which. The optimized
  images (`.next/cache/images`, a tmpfs) and the pages that never change stay.

## What is public and what is not

- **A draft or private data is never in a public response.** Public lists, details, search, feeds and the sitemap return published
  posts only; `translations` of a post lists published siblings only; public categories and tags are those with published posts.
- **Authors** are exposed as `displayName`, `githubLogin`, `avatarUrl`, `siteOwner` and a profile slug: never an id, email or role.
- **Categories and tags are one pool shared by every author.** `GET /api/v1/admin/categories` and `/admin/tags` return every entry to an
  AUTHOR as well as an ADMIN, with its translated names, including a topic that only a draft uses, which the public lists hide. Do not
  create a category or tag whose name must stay secret before its post is published. The pool is deliberately shared (the editor
  picks from it and creates in place); scoping it per author would need an owner column and hide the duplicate check from the editor.
- **A series reference never counts unpublished parts.** `series.position` in a public answer is the number among the published parts
  (the same as `partNumber`), not the stored position, which has gaps while some parts are still drafts. The stored position only
  appears for a post that is not published, in the admin API.
- **The ZIP export of a post packages only that post's images.** "Download ZIP" puts in the package the cover and the images uploaded
  into the body of that post. In an author's export any other `/media/<id>` address in the text stays as written, whatever the image is, so
  an author cannot read the original file name or the description of a site image (a gallery photo, another post's image) through the
  names of the package entries. An administrator's export is not narrowed. (The bytes of any image are public by their address.)
- **Text an author types is cleaned when it is saved.** A post title, a tag or category name (and its translated names) and the
  original file name of an upload lose control characters and invisible or text-direction characters (U+202E and the like, which can
  make a label read as another one); a title or name with nothing visible left is refused. The excerpt and a category description
  lose them too and keep their line breaks. Zero-width joiners stay (emoji need them). Rows saved before this change are not
  rewritten, and the next save of a post cleans its title.
- **Images are unlisted, not private.** An image has one URL with a random UUID, and anyone holding it can view it, including the
  cover image of a draft and a hidden gallery image. Do not upload an image whose leak would be an incident. EXIF and GPS are
  removed on upload. Deleting an image removes it from the database at once, but the optimized copy can stay in Next's image cache
  until the container is recreated ([Backup and restore](BACKUP-AND-RESTORE.md#clearing-the-optimized-image-cache)).
- **Swagger UI and `/v3/api-docs` are off by default** (they describe the whole API, admin included, to anyone). Turn them on only
  on a development machine (`SPRINGDOC_ENABLED=true`); `mvn spring-boot:run` does it for you.
- **The health endpoint** `/api/v1/health` is public and reveals only `UP`/`DOWN` of the service and the database.
- **The view endpoint** `POST /api/v1/posts/{slug}/views` is a write that needs no sign-in. `VIEWS_TOKEN` (shared between Next and
  the backend, required in production) stops anything that is not the Next server from counting views. It does **not** protect the
  newsletter POSTs, which have their own limits. `CLIENT_IP_TOKEN` is a different secret for a different job: it only lets the backend
  believe the reader address that Next forwards, and it opens no endpoint.

## Data the site stores

| Data | Notes |
|---|---|
| Reader accounts | GitHub numeric id, login, display name and avatar URL. No email, no password |
| Admin accounts | email and an Argon2id hash |
| Two-step verification | `user_mfa`: the TOTP secret **encrypted** (AES-256-GCM, key `MFA_ENCRYPTION_KEY`, which is not in the database), a fingerprint of the key, the last used 30-second step, the failure counter and its lock. `user_mfa_recovery_code`: the SHA-256 of each recovery code and when it was used. `mfa_challenge`: the SHA-256 of each sign-in challenge, its purpose, attempts and expiry (deleted a day after it expires). Two columns of `refresh_tokens`: `authenticated_at` and `mfa_verified_at`. Never a plain secret, code or challenge |
| Comments, likes, saved posts, notifications | tied to the account |
| Newsletter | the address, its status and the SHA-256 of a pending token; a one-way HMAC of an address that unsubscribed (suppression); one delivery row per post and recipient with a safe error code; one issue per post with its status (`HELD`, `PENDING`, `EXPANDED`, `DISCARDED`), the administrator who decided and, after a release, the approved subject, excerpt and language. Never the raw token, the IP, the user agent, or a provider's error message |
| View statistics | the all-time total per post, and per post, day and source group a count. Not stored: IP, user agent, referrer URL, a session or visitor identifier, a row per view |
| Contact messages | name, email address, optional subject, message text, the page language, when it arrived and when it was read. Never an IP address or a user agent. Deleted by the administrator in `/admin/contact`, or by a nightly job after `CONTACT_RETENTION_DAYS` days (365 by default; 0 keeps them until deleted by hand) |
| Post import log | per apply: who, when, the number and sizes of the files, the SHA-256 of each file, and per post its id, counts and hashes. Never a title, a file name, a category or tag name or any text of a file or a post |
| Logs | ids and error codes. Never a token, password, setup code, second-step code, authenticator secret, recovery code, enrollment code, search query, uploaded content, or an email address ([Audit events](#audit-events)) |

### In the browser

The site keeps four things in the visitor's browser, all in storage that only that browser can read and nothing sends to the server:

| Key | Storage | What | Cleared |
|---|---|---|---|
| `bai-viet:nhap:<userId>:<postId or moi>` | `localStorage` | the editor's unsaved copy of a post (title, path, description, body, category, tags), written one second after the last keystroke so that a crashed tab does not lose it | when the post is saved or typed back to the saved version; by every sign-out; after 7 days and when another account opens the admin (see below) |
| `search.recent.v1` | `localStorage` | the last five searches of the quick search panel | the panel's clear button; by every sign-out |
| `binh-luan:nhap:*`, `binh-luan:nhap-cho:*` | `sessionStorage` | a comment that was being written when the session expired, so that signing in again brings it back | on reading; by every sign-out; when the tab closes |
| `theme`, and one mark per post viewed | `localStorage`, `sessionStorage` | the theme choice and "this tab already counted this post" | never by a sign-out: they say nothing about the person |

- **A draft belongs to the account that typed it.** The key carries the user id and so does the record, and the editor reads only
  its own account's key, so the next person who signs in on the same browser is never offered what the last one left. When the
  admin opens, the drafts of every other account, the expired ones and the records of the old format (which had no owner) are
  deleted.
- **A sign-out clears the browser.** The public Sign out (the account menu, the profile page), the admin **Sign out** button and
  **Sign out everywhere** delete the drafts, the recent searches and the comment drafts. They also stop the editor from writing:
  the admin button does it before it sends the request, so the timer that would write the text one second later, and the
  last write when the tab is hidden, find nothing to write to; and a `BroadcastChannel` tells every other tab of the browser to
  do the same, so a second editor tab cannot put the text back. A request that fails changes nothing.
- **A session that merely expires does not clear anything**, on purpose: the editor tells the writer to sign in again in a new tab
  so that the text is not lost, and the copy is offered back to the same account. It stays until that account or another one opens
  the admin (the sweep above), or until the person signs out. The server cannot clear it: the site sends no `Clear-Site-Data`
  header, because `"storage"` would also reset the theme and the view marks for every sign-out.
- A browser without `BroadcastChannel` (before Safari 15.4) still clears and stops its own tab, but cannot tell the others. Anyone who can
  open the browser's developer tools on a signed-in profile can read the storage; the controls above are for the next person at the same
  browser, not for a person who already controls it.

Details of the statistics, the newsletter and the contact form, including the retention of each table, are in
[CONFIGURATION.md](CONFIGURATION.md) and [ADMIN-GUIDE.md](ADMIN-GUIDE.md) (["Contact messages"](ADMIN-GUIDE.md#contact-messages) says how to
erase one person's data: delete their messages in the inbox and their address through the unsubscribe link; a reader account has no
self-service deletion, an administrator removes it on request). A database dump contains this data, and the admin password hash: protect backups like `.env`.
The documented backup script makes the folder 0700 and each dump 0600 (a test runs it under the umask of a cron job) and tells you to
encrypt copies kept off the host ([Backup and restore](BACKUP-AND-RESTORE.md#take-a-backup)).

## Rotating `JWT_SECRET` and ending sessions

Change `JWT_SECRET` when it may have leaked: whoever has it can sign an access token with the ADMIN role.

```bash
# .env: JWT_SECRET=<new value>, for example from `openssl rand -base64 48`
docker compose up -d    # only the backend is recreated: only it reads this variable
```

- Every existing **access token** becomes invalid at once (they live 15 minutes at most): the backend returns 401.
- **Refresh tokens are not affected.** They are random strings stored as SHA-256, not signed with the secret, so changing
  `JWT_SECRET` does **not** sign anyone out. Readers do nothing: `/api/session` and the write routes refresh the session once on a
  401 and carry on. An admin who still holds an old access token is sent to `/admin/login`: sign in again, or wait up to 15 minutes
  for the proxy to refresh it.
- **GitHub sign-ins in progress break**, because the flow cookie is signed with a key derived from `JWT_SECRET`.

Two-step verification is **unaffected** by changing `JWT_SECRET`: its secrets are encrypted with `MFA_ENCRYPTION_KEY`, a different
key on purpose. To end the sessions of one account without SQL, use "Sign out everywhere" in `/admin/security`. To really sign
everyone out, revoke every refresh token:

```bash
docker compose exec postgres sh -c \
  'psql -U "$POSTGRES_USER" "$POSTGRES_DB" -c "UPDATE refresh_tokens SET revoked_at = now(), expires_at = LEAST(expires_at, now()) WHERE revoked_at IS NULL;"'
```

`expires_at` is ended at the same time, like every bulk revocation in the backend: a revoked token that still looks valid by expiry
would be treated as an old token being reused (reuse detection) each time an old device sends it, and each time sign the user out
once more. Access tokens bound to a revoked session (`sid` claim) are refused at once; to end the access tokens of an account as well,
set `users.tokens_valid_after = now()` for it (or use "sign out everywhere", which does both). With a new `JWT_SECRET` every access
token dies at once.
If the secret leaked, changing it is enough to stop forged tokens; revoke refresh tokens too when sessions themselves may have been
taken, for example a cookie on a machine that was exposed.

To unlink the owner's GitHub account after losing control of it, remove `ADMIN_GITHUB_ID` from `.env` first (while it is set, the
next start attaches it again), then clear the link with SQL and revoke the admin's sessions. The statements are in
[CONFIGURATION.md](CONFIGURATION.md).

## Startup refusals

The backend refuses to start, with a message that names the variable and never the value, when the following holds. Some of these
checks run while the application is being built, before Tomcat opens the port (the JWT secret, the key of the second step and the
database link, which is checked when the data source is created, before Flyway or the pool opens a connection). The
others are startup runners that run right after it opens: the process still exits, and the Compose healthcheck never passes, but
for those first moments the port answers. The admin password is one of them (`DevCredentialWarning`): in that window password
sign-in already rejects the development password on a production run (`AuthService`), so nobody can use it in between.

- `JWT_SECRET` is missing, shorter than 32 bytes, or the development value that lives in the repository, unless the run opted in to
  development defaults (Spring profile `dev` or `APP_ALLOW_DEV_DEFAULTS=true`, never with a public `SITE_URL`): the backend is
  fail-closed;
- `MFA_ENCRYPTION_KEY` is missing (**in every mode**: no development default exists in code), is not base64, or does not decode to
  exactly 32 bytes (the message shows the decoded length, never the value); in production also when it is the development key that
  lives in this repository or has the same value as `JWT_SECRET`. Both are compared as the decoded bytes, so another spelling of
  the same bytes (without the `=` padding, or with another last character) is refused too (on an opted-in development run the
  development key only logs a warning);
- `MFA_ENROLLMENT_TOKEN` or `MFA_RESET_TOKEN` is set and shorter than 24 characters;
- `ADMIN_PASSWORD` is set and shorter than 12 characters or, when its value really changes, breaks the
  [password policy](#password-policy), or, in production, the admin account still accepts the development password (password sign-in
  also always rejects it in production). An unchanged value that the policy now rejects only logs one warning, so an upgrade never
  refuses to start over it;
- `VIEWS_TOKEN` or `CLIENT_IP_TOKEN` is empty or shorter than 16 characters in production;
- `JWT_SECRET`, `VIEWS_TOKEN`, `CLIENT_IP_TOKEN` or (with `smtp`) `NEWSLETTER_SECRET` is guessable: made only of placeholder words, one
  short pattern repeated, fewer than 6 different characters, or mostly a run like `abcdefghij`. The message gives the reason and the
  command that makes a good value, never the value; `openssl rand -base64 48` and `openssl rand -hex 32` always pass. A hand-filled
  `.env` is held to the same floor as a generated one; `scripts/init-env` is the supported way to fill the secrets;
- in production the backend reaches a PostgreSQL that is not on the machine itself or a single-label service name with `sslmode`
  `prefer` (the default), `allow` or `disable` (the last value of a repeated parameter counts), or through the
  `NonValidatingFactory`, and `DB_ALLOW_INSECURE_TRANSPORT` is not `true` (use `DB_SSLMODE=verify-full` with
  `&sslfactory=org.postgresql.ssl.DefaultJavaSSLFactory` or `&sslrootcert=<file>` in `DB_JDBC_PARAMS`; `require` and `verify-ca` only
  warn). The frontend image refuses to start when it is given a plain `http` `API_BASE_URL` to such a host without
  `API_ALLOW_PLAINTEXT=true` (`scripts/start-check.mjs`); a frontend started another way answers 500 on every page that reads the API
  ([Split deployment](CONFIGURATION.md#split-deployment));
- `SETUP_TOKEN` is set and shorter than 24 characters;
- `ADMIN_GITHUB_ID` is not a positive integer;
- GitHub sign-in is configured but the callback cannot be built (no `GITHUB_REDIRECT_URI` and no `SITE_URL`), is not exactly the path
  `/api/auth/github/callback`, or is `http` on a host other than loopback;
- GitHub sign-in uses an address under `app.oauth.github.provider.*` (the override that points the login at a mock GitHub for tests and
  the E2E stack) that is not `https` on `github.com` or `api.github.com` while `SITE_URL` (or `GITHUB_REDIRECT_URI`) is a public
  address: whoever answers there decides who signs in, the administrator included. On a loopback site the override stays allowed and
  logs a warning;
- `NEWSLETTER_TRANSPORT=smtp` with a `SITE_URL` that is not a public `https` URL, an invalid `NEWSLETTER_FROM`, an empty `SMTP_HOST`,
  a `NEWSLETTER_SECRET` under 32 bytes, or `SMTP_STARTTLS=false` for a host that is not a loopback address (use `SMTP_PROTOCOL=smtps`
  for implicit TLS on port 465);
- Meilisearch is in use with a `MEILI_MASTER_KEY` that is missing, shorter than 32 characters, or the placeholder of `.env.example`;
- `ANALYTICS_TIME_ZONE` or `DEFAULT_LOCALE` is not valid.

Docker Compose itself refuses to start when `DB_PASSWORD`, `JWT_SECRET`, `MFA_ENCRYPTION_KEY`, `SITE_URL`, `VIEWS_TOKEN` or `CLIENT_IP_TOKEN` is missing, so a half-filled `.env`
fails at once instead of deploying with a development value. "Production" is the default; only the `dev` profile or
`APP_ALLOW_DEV_DEFAULTS=true` opt out, and a `SITE_URL` whose host is not `localhost`, `127.0.0.0/8` or `::1` (a LAN address used to test on
a phone counts) is production even then.

## Supply chain: what the build trusts

What the repository's own build and CI take in from outside, and what stops a bad input. The rules a contributor follows are in
[CONVENTIONS.md](CONVENTIONS.md), section 9; the commands are in [DEVELOPMENT.md](DEVELOPMENT.md), "CI".

- **Java artifacts come from Maven Central only.** `maven-enforcer-plugin` runs in the `validate` phase of every build (CI, the Docker
  image, your machine) and fails when the effective build has any repository or plugin repository other than
  `https://repo.maven.apache.org/maven2`, so a pom, or the pom of a plugin, cannot add a second place that code comes from. A mirror in
  your own `settings.xml` counts as one: add its URL to the two allowed lists in your checkout and do not commit it.
  `backend/.mvn/maven.config` sets `--strict-checksums`: a checksum mismatch fails the build instead of printing a warning (the Docker
  image build copies the file, too).
- **Artifact signatures are not verified, on purpose.** Checking the PGP signatures of the dependencies (for example with
  `pgpverify-maven-plugin`) needs a reviewed key for every artifact of the tree, a few hundred of them with the transitive ones, and a
  new line of that map with almost every Dependabot bump. For a one-owner blog that cost is larger than what it blocks: the artifacts
  come over HTTPS from Maven Central, a new release is proposed only after seven days (`cooldown` in `dependabot.yml`), and the Trivy
  scan of CI fails on a known advisory. Checksums protect a transfer, not against a compromised publisher. Revisit this if the project
  gains more maintainers or publishes the backend as a library.
- **npm packages are fixed by `package-lock.json`** (a registry address and a `sha512` integrity value for each), installed with
  `npm ci --ignore-scripts` so that no package runs code while it is installed (CI and the frontend image), and checked with
  `npm audit signatures` (registry signatures and provenance) in CI. The four lock entries that declare an install script are a
  reviewed list in a test; a fifth fails the build.
- **Libraries outside the Spring Boot BOM are kept current by Dependabot.** BouncyCastle, springdoc, TwelveMonkeys and
  metadata-extractor (the last two parse uploaded images) are version-pinned by hand in `backend/pom.xml`, so a Boot upgrade does not
  move them. Dependabot proposes each in its own pull request; turn on Dependabot security updates in the repository settings so a
  fix for one of them is not held back by the seven-day wait. The Swagger UI webjar of springdoc is in the jar but switched off in
  production (the paths answer 404, `SpringDocExposureTest`). The frontend's development tool ESLint is on its last 9.x release
  because the plugins of `eslint-config-next` do not accept ESLint 10 yet; a test notices when they do.
- **Images are pinned by digest** (the Dockerfile bases, the compose images, the helper images of the release workflow, the scanner
  images) and every GitHub Action by commit SHA, so a moved tag cannot change what is built or scanned.
- **Released images are scanned, then signed.** `release.yml` scans the backend image with the pinned Trivy in a read-only job of its own, and
  only when the tagged commit is on master with a green CI run and the scan passes does the job that holds the write token start; that job pushes with provenance and an SBOM, signs the pushed
  digest with cosign (keyless, the OIDC token of the job, which only the `images` job has) and verifies the signature against the
  workflow's own identity. A finding in the image stops the release before anything is public. How to check a signature: [INSTALL.md](INSTALL.md), "Prebuilt images or
  build from source". The approval environment, the tag ruleset and the master ruleset that make the signature mean something are repository settings
  ([DEVELOPMENT.md](DEVELOPMENT.md), "Release", owner checklist).
- **CI scans** the dependencies (Trivy and `npm audit`, HIGH and CRITICAL findings with a fix fail), the files and the whole history for
  secrets (gitleaks), and the workflows for command injection (no `${{ }}` expression inside a `run:` command).

## What is not protected

Be honest about the limits when you decide how to run a site.

- **Rate limits are per process and in memory.** They reset on restart and do not work across instances. They slow abuse; they are
  not a DDoS defence. Put a CDN or a firewall in front if you expect hostile traffic.
- **A limit counted per address can be rotated by someone with many addresses.** One IPv6 `/48` holds 65,536 `/64` prefixes, each
  with its own count, and a botnet has an address per bot. The per-address limits stop one machine, not a crowd. What still holds
  against a crowd is what does not depend on the address: the per-email limits, the whole-site ceilings (contact form, newsletter
  mail, search) and the two password checks at a time. The whole-site ceilings are shared on purpose, so a crowd that
  reaches one can use it up and deny the feature (the contact form, newsletter signups, newsletter confirmations or search) to
  everybody for as long as it keeps trying; the alternative is an unbounded mail or search flood. A CDN or WAF rate rule in front of the
  proxy is the defence in depth.
- **Unsubscribing has no whole-site ceiling, on purpose.** An unsubscribe must be honored (the one-click requests of mail providers
  too), so no flood of invalid tokens may use up a shared budget. What still limits it: 40 per hour per client address, shared with
  confirmations, and 20 per hour per subscriber. A crowd cannot block other readers' unsubscribes by sending stray tokens, but it can
  still refuse an address its own 40 calls, and a flood of more than 20,000 invented client addresses within an hour fills the table
  of client addresses, so a **new** address is refused until the window passes (the maps are bounded, see
  [Rate limits](#rate-limits)). Unsubscribing from another address, or a minute later, works.
- **The content-sync tool trusts whoever holds its shared key.** `scripts/content-sync` moves posts and images between two installs
  with a `pg_dump`, and `pg_restore` runs the SQL of a dump as the database user of the target (a superuser in the stock compose
  file). So the package is authenticated before anything is restored: `export-content.ps1` signs it with HMAC-SHA256 under a shared
  secret that is never in the package (`-KeyFile` or `CONTENT_SYNC_KEY`, at least 32 characters), and `import-content.ps1` refuses a
  package it cannot verify unless the operator says `-AllowUnsigned`. The checksum inside the manifest only detects damage. As
  defence in depth the ZIP may hold only its three files and `pg_restore -l` may list only the schema `export_content` and the content
  tables, before anything is restored (also with `-DryRun`). What is not covered: anyone who has the key can make a package that
  passes both checks and has a hostile table definition, because the list checks names and not the SQL text, so keep the key as you
  keep `.env`, and never import a package from a source you do not control. It is an operator tool, not reachable from the web.
- **Author Markdown is bounded by an estimate, not by a clock, except for code highlighting.** An article that the estimate puts above
  its budget is shown as plain text ("Markdown in posts" in [Authentication and sessions](#authentication-and-sessions)); the
  highlighting of its code fences has a clock of its own (1.5 s per render, same section); one below the estimate costs the one Node process up to
  about two seconds per render on a loaded machine (every revalidation, preview and feed poll of that post; a post at the 500,000 characters
  it may have costs a second or two whatever it holds), and a shape that nobody has measured can cost more. The first estimate missed four
  families (link literals, table cells, colons and unclosed comments) that cost several seconds to 24 s each, and the second the markers and footnote references of short paragraphs, so treat the next one as likely. Only an AUTHOR or an ADMIN can save a post. If a page ever holds the process, unpublish the post in the admin.
- **An author can see whether an address is taken.** A new post, a rename or a translation draft whose slug is taken comes back
  numbered (`-2`, `-3`), and the old address of a renamed post stays reserved, so an author can learn that a slug exists, also a slug
  of someone else's draft (never its title or text). A post of an author keeps only its newest five old addresses, so the
  reservation cannot grow; an administrator can release one with `DELETE /api/v1/admin/slug-history/{slug}` (204, or 404
  `SLUG_HISTORY_NOT_FOUND`), after which any post may take it and the redirect from it stops working. Hiding the oracle completely
  would need the editor to stop telling the author the address it got, so it is accepted. A post an author deleted is hidden, not
  removed, so it keeps its address and its (at most five) old addresses reserved until an administrator deletes it for good: a post holds
  at most six addresses, and the posts-per-day limit bounds how many an author can start.
- **Bot filtering of views is best effort.** The user agent is set by the client, so a bot that pretends to be a browser is counted.
  The same goes for inflating a count: a repeat from one address is dropped for 30 minutes and an address is held to 30 beacons a minute,
  but someone with many addresses (or many IPv6 prefixes) can add views, and "Most read" and the post order by popularity follow the
  count. Treat a count as a rough guide and not as proof; a CDN or WAF rate rule in front is the defence in depth.
- **The admin shell is gated by an unsigned claim.** `proxy.ts`, the shell layout and `adminRole()` read the role of the access cookie
  without checking its signature, and need only some refresh cookie to exist. A visitor with a hand-made token (a payload that says
  `ADMIN`) and any refresh cookie sees the empty shell: the sidebar, the site name and the frames of the screens, all public. Nothing
  more: every screen, Server Action and route handler gets its data from the backend, which checks the signature and reads the role
  and the status from the database on each request, so each answers 401 or 403 and the visitor is sent to the sign-in. The shell does
  not call the backend on purpose (an outage cannot then escape the error page). The one handler that serves text generated in the
  frontend, the authoring prompt download, asks `GET /auth/me` first (`verifiedAdminRole`), and a test
  (`routes-ask-the-backend.test.ts`) keeps every route handler of the shell on a path that asks the backend.
- **The password step has no per-account lock, by design.** With two-step verification a guessed admin password alone no longer yields
  a session, and a rolling per-email block would hand any anonymous caller a way to keep the owner out. The seeds of the authenticator
  are exactly as safe as `MFA_ENCRYPTION_KEY`. Someone who holds the password can keep the second step rate-limited and, after 100
  wrong codes, freeze it until the operator resets it ([above](#two-step-verification-and-recovery)).
- **Known deviations from ASVS 5.0 and open items for sessions.**
  - 6.3.3: two-step verification is optional for an AUTHOR (the owner's decision) and absent for readers.
  - 6.5.5: a code is accepted for up to 60 seconds, not 30 (the window is the current step and the one before; accepting only the
    current step refuses many correctly typed codes).
  - 6.4.1: the generated enrollment code has no time expiry (it is a proof of server access, deleted after each enrollment).
  - 7.5.1: GitHub may approve a fresh sign-in silently, and a session younger than 10 minutes can still change two-step verification.
  - 7.4.5 and 7.5.2 (an administrator ending or listing another person's sessions) stay open. An absolute session lifetime exists for
    ADMIN and AUTHOR sessions (30 days) and not for readers, whose session slides for as long as it is used.
  - Two-step verification does not defend against a leaked `JWT_SECRET` together with a read of the database: a token must name a
    live session of its own account (`sid`), and the session ids are in `refresh_tokens`. The secret alone is not enough, since the
    ids are random UUIDs that only the holder of a session sees. Rotate the secret after a leak.
- **Sign-in is GitHub only for readers.** Anyone with a GitHub account can comment; moderation, suspension and author roles are the
  controls.
- **A published container image is only as trustworthy as the release workflow and the repository settings around it.** The workflow
  builds from a tag whose commit is on `master`, behind the approval of a `release` environment once the maintainers have set
  reviewers on it; Trivy scans the backend image before anything is pushed (HIGH and CRITICAL findings with a fix stop the release; the scan
  covers `linux/amd64`, and the pushed image is a second build of the same pinned inputs, so it is not the exact scanned digest); the
  pushed digest carries build provenance and an SBOM and is signed with cosign, keyless. A signature proves that
  this repository's release workflow built the digest, not that its code is free of bugs, and it is worth what the approval
  environment and the tag ruleset are worth: until the maintainers set them (owner checklist in [DEVELOPMENT.md](DEVELOPMENT.md),
  "Release") anyone who can push a tag can have the workflow sign an image. `latest` and `X.Y` move with every release. Check the
  signature and pin a digest ([INSTALL.md](INSTALL.md), "Prebuilt backend image or build from source"), or build from source.
- **An author can make readers' browsers load images from other hosts.** `img-src` allows any `https` host so that an `https` image in
  a post keeps working ([Content Security Policy](#content-security-policy)). The host sees the reader's address and the page it
  was loaded from (the `Referer` is cut to the origin by `Referrer-Policy`). The post is written by an author, so this is a matter of
  trust in your authors, not of an outside attacker.
- **Images are reachable by anyone with the URL**, and the optimized copy can outlive a deletion until the image cache is cleared. A CDN or
  any other cache in front keeps `/media/*` for up to a year, and the HTML pages for up to an hour: purge them by hand
  ([INSTALL.md](INSTALL.md#a-cdn-in-front)); `updateTag` never reaches a cache outside Next.
- **Real mail sending has not been verified** with a real provider in this release candidate. The `log` transport sends nothing.
  Check the steps in [CONFIGURATION.md](CONFIGURATION.md) before you rely on it.
- **A page cached by Next can be stale after a change written outside the admin.** A change made by an API call, a script or SQL clears
  no cache. A page that is opened often shows it within about five minutes (plus one load: the first visit after expiry still gets the
  old copy while Next refreshes in the background). A page nobody has opened for a long time gives its first visitor one stale copy
  if the entry is less than an hour old, and renders it fresh otherwise (`expireTime: 3600`; it used to be a year): a post unpublished by a
  script can be shown once, up to an hour late. Feeds, the sitemap and
  search are read from the backend on every request and are not affected. For an urgent takedown, unpublish or delete the post in the
  admin (that clears the cache at once, and a bulk action clears it even for a post the backend no longer has), or run
  `docker compose up -d --force-recreate frontend` ([Caching, and a CDN in front](#caching-and-a-cdn-in-front)).
- **Access logs of the proxy can contain tokens** unless you keep the newsletter and OAuth paths out of them as the example
  configurations do. The proxy's error log may still copy the request line when the upstream fails; keep logs short-lived.
- **The server operator is trusted.** Anyone who can read `.env` (it holds `MFA_ENCRYPTION_KEY`), the database, the setup code file or
  the enrollment code file can act as the owner.
- **No dependency or container image is audited by hand.** CI runs CodeQL, a secret scan, a license check, `npm audit` and a Trivy
  scan that fail on HIGH and CRITICAL findings with a fix (this does not cover the base images at runtime); run
  `docker compose pull` and rebuild for base-image updates, and follow [the reporting policy](../SECURITY.md) for vulnerabilities in
  this project.
