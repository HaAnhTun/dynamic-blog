# Content and languages

How Blog Engine handles two (or more) languages: which languages exist, how URLs look, how posts and topics are translated, what
search and the newsletter do per language, and how a developer adds another language end to end. The rules for contributors are
in [CONVENTIONS.md](CONVENTIONS.md) (sections 4 to 6); this page is the product view.

## Contents

- [Languages](#languages)
- [URL scheme](#url-scheme)
- [Translating posts](#translating-posts)
- [Topics, series and site content](#topics-series-and-site-content)
- [hreflang, canonical and the sitemap](#hreflang-canonical-and-the-sitemap)
- [Search](#search)
- [Newsletter](#newsletter)
- [Glossary](#glossary)
- [Add a language end to end](#add-a-language-end-to-end)

## Languages

The site ships with **English (`en`) and Vietnamese (`vi`)**. Three layers know about languages:

| Layer | What it holds | Where the set is defined |
|---|---|---|
| Interface text | Every label, message, error and metadata string of the public site and the admin. | `frontend/messages/<locale>.json` and `LOCALES` in `frontend/i18n/config.ts`. |
| Content | Posts (one language each), category, tag and series names, newsletter subscribers, the owner's site content. | `app.i18n.locales` in the backend, pinned by database CHECK constraints (migration V35 and later). |
| Owner text | Site name, profile, about, contact and so on, one version per language. | The `site_content` table, edited in **Admin, Settings** ([ADMIN-GUIDE.md](ADMIN-GUIDE.md)). |

The **default language** is a deployment setting, not something an owner clicks. It is `DEFAULT_LOCALE` in `.env` (`en` or `vi`),
read twice: by the frontend image at build time (`NEXT_PUBLIC_DEFAULT_LOCALE`, which decides the URLs) and by the backend at run
time (the language of posts created without one). Keep them equal; compose does. Changing it means editing `.env` and running
`docker compose up -d --build`. It also moves which URLs have no prefix, so choose it before you publish: moving it later breaks
links that were already shared and indexed.

One more consequence of the backend reading it: **on the first start after migration V34 only**, the default locale is stamped on
every existing post and newsletter subscriber. It cannot be repeated. A fresh install has no posts, so there is nothing to stamp;
an older install should set `DEFAULT_LOCALE` to the language its posts are written in before it upgrades.

## URL scheme

The default language has **no prefix**; every other language lives under `/<locale>`. With `DEFAULT_LOCALE=en`:

| Page | English (default) | Vietnamese |
|---|---|---|
| Home | `/` | `/vi` |
| Writing | `/writing` | `/vi/writing` |
| A post | `/posts/<slug>` | `/vi/posts/<slug>` |
| Category, tag, series | `/categories/<slug>`, `/tags/<slug>`, `/series/<slug>` | `/vi/categories/<slug>` ... |
| RSS | `/feed.xml` | `/vi/feed.xml` |

With `DEFAULT_LOCALE=vi` the roles swap (`/writing` is Vietnamese, `/en/writing` is English). Rules:

- `/<default>/...` redirects to the unprefixed URL; an unknown prefix is the 404 page.
- There is **no language detection**: no `Accept-Language` redirect and no locale cookie on public pages. The language is chosen
  by link; the switcher in the header keeps the current page. So a page is identical for every visitor and stays cacheable.
- `/admin`, `/api`, `/media`, `/random`, `/setup`, `/opengraph-image`, `robots.txt` and `sitemap.xml` have no language in the URL.
  The admin's language is a cookie (`admin_locale`) set by the switcher in the admin; `/setup?lang=en` picks the language of the
  setup page on a first visit.
- `<html lang>`, the canonical URL, `og:locale`, the JSON-LD `inLanguage` and the RSS `<language>` follow the page's language.
- Numbers, dates, sorting and case mapping follow the page's language; no code hard-codes a locale.

## Translating posts

- **One language per post.** A post has a `language` and, if it has translations, a `translation_group_id` shared by the
  translations of one article (at most one post per language in a group). The slug stays globally unique, so slug history and
  redirects work as before. A translation is its own post: its own title, text, slug, status and publication date.
- **The Translations panel** of the post editor ([ADMIN-GUIDE.md](ADMIN-GUIDE.md#posts-and-translations)) creates a draft
  translation (copying title, description, category and tags, with no body), links an existing post, or unlinks one.
- **Public lists show only the current language's posts**: the home page, `/writing`, categories, tags, series, search, feeds and the
  sitemap. A list with nothing in the current language says so and offers a link to the other language when it has posts.
- **"Read this article in another language"** appears on a post only when a **published** translation exists. The `translations`
  field of a public post response is built from published siblings only; a draft translation is never exposed.
- An AUTHOR can link and unlink only their own posts; linking posts of two authors is an admin action.
- **Imported posts.** A post made by the [post import](ADMIN-GUIDE.md#import-posts-from-markdown-files) has the `language` of its file (a language
  the site enables; the site default, with a note in the preview, when the file names none). Its category and tags are matched by
  name in the language of the post first, then by base name, then by the names in the other languages, and are created when missing.
  It is always a draft, so it never appears as a translation on a public page. The `translation_of` key is read and ignored (the preview shows a note), so
  the link is not made: link imported posts in the Translations panel ([post-file-format.md](post-file-format.md)).
- The backend API takes an optional `lang` on the public lists (`/posts`, `/posts/search`, `/categories`, `/tags`, `/series`,
  `/search`): absent means all languages (older clients keep working), an unknown code is a 400. Public pages always send the page
  language. `GET`, `POST`, `PUT` and `DELETE /api/v1/admin/posts/{id}/translations` manage links.

## Topics, series and site content

- **Categories, tags and series** keep a base name and description plus optional per-language `translations`; a missing
  translation falls back to the base text. Edit the translated names in **Admin, Topics** and **Admin, Series**. A post's category
  and tags are shown in the post's own language. Public taxonomy lists filtered by language return only topics that have a
  published post in that language, while a topic's own page opens in any language (with a "no posts in this language yet" note).
- **Site content** (profile, about, skills, contact, ...) is stored per language. The public pages read the language's row; if it
  is missing, the default language's row; if that is missing too, the packaged neutral default in
  `frontend/content/defaults/<locale>/`. The packaged defaults contain no real person's data.
- The import and export of site content, and the Markdown profile import, are per language too: a file writes to exactly the
  language named in it ([site-profile-format.md](site-profile-format.md)).

## hreflang, canonical and the sitemap

- A post's canonical is its **own** language URL. `hreflang` alternates, the sitemap's alternates and the "read in another
  language" link exist only between real, **published** siblings: an alternate to a page that does not exist is worse than none.
- Pages that exist in every language (home, writing, ...) list every language as an alternate, plus `x-default` pointing at the
  default language.
- `sitemap.xml` is one file with one entry per page and language. Language-specific pages (a post, a category that has posts in
  one language only) list alternates only among the languages that have them.
- Alternates come from page metadata and the sitemap only; the server does not add `Link: hreflang` headers.

## Search

- **PostgreSQL (default).** Full-text search that ignores case and diacritics on both sides, for every language: `hoc` finds the
  Vietnamese word written with marks, upper and lower case forms are the same query, and decomposed (NFD) Unicode matches too. It uses a text-search
  configuration `vi_unaccent`: PostgreSQL's `simple` configuration (lowercase, no stemming, no stop words) with the `unaccent`
  dictionary in front. English words are therefore not stemmed (searching "post" does not find "posts"). Trade-off: Vietnamese
  words that differ only by their marks become one word, so a query typed with marks cannot narrow the result. The query is
  `plainto_tsquery`: the words are ANDed, punctuation is ignored, and nothing a reader types is a syntax error. Filters (`category`,
  `series`, up to 5 `tag`s) combine with the text, and `lang` limits to one language.
- **Meilisearch (optional).** The same endpoint with `lang` as a filter; prefixes, typos, technical tokens. Apply the `language`
  filter with an admin reindex after upgrading to a version that has it; until then the engine falls back to PostgreSQL. Setup and
  operation: [CONFIGURATION.md](CONFIGURATION.md#search-with-meilisearch).
- **Static pages and case studies** that search also finds come from a generated file,
  `backend/src/main/resources/search/static-content.json`, built from the Vietnamese catalog and defaults
  (`npm run search:export` in `frontend/` rewrites it, and a test fails when it drifts). They are not per language.
- The search query is never logged.

## Newsletter

A subscriber has a language, taken from the page where they subscribed. The confirmation mail and the new-post mails are sent in
that language, and **only for posts of that language**. The mail text lives in
`backend/src/main/resources/i18n/newsletter_<locale>.properties` (UTF-8). If a locale has no file, the English text is used.
Links in a mail carry the language prefix of the subscriber. See [ADMIN-GUIDE.md](ADMIN-GUIDE.md#newsletter).

## Glossary

One term per concept in each language, in every screen, `aria-label`, error message and document. The table is
[vi/glossary.md](vi/glossary.md) (Vietnamese term and English term side by side, for example post, series, category, tag, Best
posts, sign in). When you add or change an interface string, use the term from that table. English is sentence case ("Sign in",
not "Sign In"), buttons are imperative verbs, and the site owner says "I" where the Vietnamese version uses the first-person pronoun.

## Add a language end to end

This is a developer task: a new language needs code, a database migration and translated text. The example adds French, `fr`.
Nothing here is done from the admin. Do it on a branch and run the full checks at the end.

### Backend

1. **Enable the code.** In `backend/src/main/resources/application.yml` set `app.i18n.locales` to `vi,en,fr`. Every `lang`
   parameter and body field goes through `com.blog.common.i18n.Languages`, so after this the API accepts `fr`. (`DEFAULT_LOCALE`
   changes only if `fr` becomes the default.)
2. **Add a migration** with the next free number (`V42` after `V41`) that replaces the CHECK constraints which pin the set. Never edit
   V35, V37, V38, V39, V40 or V41: Flyway validates checksums and the backend would refuse to start. The constraints and tables are:

   | Table | Constraint |
   |---|---|
   | `posts` | `chk_posts_language` |
   | `categories`, `tags`, `series` | `chk_categories_translations`, `chk_tags_translations`, `chk_series_translations` |
   | `newsletter_subscribers` | `chk_newsletter_subscribers_locale` |
   | `site_content` | `chk_site_content_locale` |
   | `site_content_revision` | `chk_site_content_revision_locale` |
   | `site_import_log` | `chk_site_import_log_locale` |

   Drop each and add it back with the new list, for example:

   ```sql
   ALTER TABLE posts DROP CONSTRAINT chk_posts_language;
   ALTER TABLE posts ADD CONSTRAINT chk_posts_language CHECK (language IN ('vi', 'en', 'fr'));

   ALTER TABLE categories DROP CONSTRAINT chk_categories_translations;
   ALTER TABLE categories ADD CONSTRAINT chk_categories_translations CHECK (
       jsonb_typeof(translations) = 'object' AND (translations - ARRAY['vi', 'en', 'fr']) = '{}'::jsonb);
   -- the same for tags and series, then the three locale constraints
   ```
3. **Newsletter text.** Copy `i18n/newsletter_en.properties` to `newsletter_fr.properties` and translate every key (UTF-8).
4. **Profile import template.** Add `backend/src/main/resources/site-import/defaults-fr.json`, the example document the template
   download is generated from (same shape as `defaults-en.json`). A test keeps it equal to `frontend/content/defaults/fr`.
5. The **sample content** (Admin, Settings) stays English and Vietnamese; its loader does not create posts in other languages.

### Frontend

6. **Register the locale.** Add `'fr'` to `LOCALES` in `frontend/i18n/config.ts` and to `OG_LOCALES` there (`fr_FR`). Run
   `npm run typecheck`: every `Record<Locale, ...>` that lacks `fr` fails to compile, for example the BCP 47 map in
   `lib/format.ts`, `LANGUAGE_NAMES` in `components/site/language-names.ts` (each language is named in itself) and the catalog map
   in `app/global-error.tsx`. Fix each one.
7. **Message catalog.** Create `frontend/messages/fr.json` with exactly the keys and ICU arguments of `en.json`, including
   `Admin.settings.locales.fr` (and the same key in the other catalogs). Use the glossary (add a
   `docs/fr/glossary.md`). The catalog tests fail on a missing or extra key, an empty value or a changed ICU argument.
8. **Site content defaults.** Create `frontend/content/defaults/fr/` with the nine files of `en/` (`site`, `profile`, `about`,
   `skills`, `now`, `timeline`, `contact`, `blogroll`, `case_studies`) and register them in `content/defaults/index.ts`. Keep them
   neutral: no real person's name, employer or link.
9. **Routing.** `i18n/routing.ts` reads `LOCALES`, so `/fr/...` appears by itself; the switcher, sitemap alternates and feeds follow.
10. **Default language.** To make `fr` the default, set `DEFAULT_LOCALE=fr` by hand in `.env` (the `init-env` scripts accept only
    `en` and `vi`) and rebuild the frontend.

### Search, tests and the English guard

11. **Search.** PostgreSQL search needs nothing: `vi_unaccent` folds marks for any language and does not stem. The generated
    `static-content.json` stays Vietnamese. After deploying, run an admin reindex if Meilisearch is on.
12. **English guard.** `python scripts/validate-english.py check --strict` allows non-English letters only in listed paths
    (`messages/vi.json`, `frontend/content/`, `docs/vi/`, `fixtures/vi/`, the Vietnamese newsletter file, the
    Vietnamese import example and the Vietnamese sample content). If your files trip it, extend the allowlist in the script and
    document why.
13. **Run:** `cd backend && mvn -B -ntp clean verify`; `cd frontend && npm run lint && npm run typecheck && npm test`; then the E2E
    journeys in the new language (`E2E_LOCALE`; the browser-language map in `frontend/playwright.config.ts` knows only `en` and
    `vi`, extend it) and a full docker compose smoke test with `docker compose up -d --build`.
14. **Document it:** update this page, [FEATURES.md](FEATURES.md) and [CONVENTIONS.md](CONVENTIONS.md) in the same change.
