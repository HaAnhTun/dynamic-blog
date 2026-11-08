# First run

You have installed the stack ([INSTALL.md](INSTALL.md)). This page takes a fresh site from "nobody owns it yet" to a first
published post. Vietnamese version: [vi/FIRST-RUN.md](vi/FIRST-RUN.md).

## Contents

- [What a fresh install is](#what-a-fresh-install-is)
- [Find the setup code](#find-the-setup-code)
- [Claim the site at /setup](#claim-the-site-at-setup)
- [Turn on two-step verification](#turn-on-two-step-verification)
- [Site name and languages](#site-name-and-languages)
- [Load the sample content](#load-the-sample-content)
- [Write your first post](#write-your-first-post)
- [If something goes wrong](#if-something-goes-wrong)

## What a fresh install is

A database with no content and an untouched seeded admin account is a fresh install. Nobody can sign in with a default password:
the seeded development password is locked at startup (`SETUP_LOCK_DEV_SEED`, default on). Until the site is claimed, `/setup`
is open and everything else works: the public pages show neutral placeholder content in both languages, and the admin area
rejects every sign-in.

You claim the site once, with a **setup code** that only someone with access to the server can read. After that `/setup` returns
404 for good. A deployment that existed before this mechanism is migrated as already set up and can never be claimed.

## Find the setup code

The backend decides the code at startup:

- If you set `SETUP_TOKEN` in `.env` (at least 24 characters, and make it long and random: `openssl rand -hex 32`), that value is the code.
- Otherwise it generates a random code and writes it to the file `setup-code` in its data directory (`SETUP_DATA_DIR`, which is
  `/data` in compose, a named volume). The backend log prints the **path** of that file, never the code.

In the compose install, read it with:

<!-- docs-test: run -->
```bash
docker compose exec -T backend sh -c 'cat /data/setup-code'
```

(Without `-T` you get the same output in a terminal.) On a development machine started with `mvn spring-boot:run` the file is
`backend/data/setup-code`. The file is readable only by the backend's user and is deleted when setup completes. Keep the data
directory private: the backend trusts a code file it finds there.

## Claim the site at /setup

Open `<SITE_URL>/setup`, for example <http://localhost:3000/setup>. Add `?lang=en` or `?lang=vi` to choose the page language on a
first visit. The form asks for:

| Field | Rule |
|---|---|
| Setup code | The value you read above. |
| Display name | 1 to 60 characters. Shown as the author of your posts. |
| Email | A valid address. It becomes your admin sign-in email. |
| Password | 12 to 128 characters, not a common password, not made of repeated or consecutive characters, and not containing the first part of your email ([policy](SECURITY.md#password-policy)). Hashed with Argon2id; never stored or logged in clear. |
| Confirm password | Must match. |

On success the seeded admin account becomes yours (same account, new email and password), every session it had before
ends (refresh tokens and access tokens), the code file is deleted, `/setup` answers 404 from then on, and the browser goes to
`/admin/login`. Sign in there with the email and password you just chose; the next section is what happens then.

Good to know:

- The backend limits setup attempts per client address (5 per minute, every attempt counted) and counts wrong codes for the whole
  process (120 per minute, beyond which a wrong code is answered 429): the right code is never refused for that count, so a flood
  cannot keep you out. If someone floods `/setup`, claim the instance quickly, or set `ADMIN_PASSWORD` in `.env` and restart: that
  claims the instance through the environment and closes `/setup`.
- Setting `ADMIN_PASSWORD` or `ADMIN_GITHUB_ID` in `.env` before the first start claims the instance that way instead, and `/setup`
  is closed from the start. `ADMIN_GITHUB_ID` also closes `/setup`, so without GitHub login configured use `ADMIN_PASSWORD`.
- A wrong code answers "The setup code is not correct."; the code never appears in any log.
- Open `/setup` over the address you will use for the site. With a public site that is your `https://` address.

## Turn on two-step verification

The admin account needs a second step, so the first sign-in does not open the admin area. After the password, the page asks you to
set up an authenticator app (any app that supports time-based codes, such as the one on your phone):

1. Press **Show the setup key**, then add the key to the app (type it, use **Copy**, or open the link on the phone; there is no QR
   image). The app starts showing a 6-digit code that changes every 30 seconds.
2. Type the current code. No enrollment code is asked here: you have just proved that you can read the server (the setup code), and
   for the next hour the enrollment is open to this account. Do it now, not tomorrow.
3. The page shows **ten recovery codes, once**. Download or copy them, store them away from the phone (a password manager), and
   tick the box, and **Continue to the admin area** works. A recovery code replaces a 6-digit code once; they are what you use when
   the phone is lost.

From now on every sign-in is password, then code. Your other devices were signed out by the enrollment. To change the phone, make new
recovery codes or change the password, open Security in the admin ([ADMIN-GUIDE.md](ADMIN-GUIDE.md#security-two-step-verification-and-your-password)).
Copy `MFA_ENCRYPTION_KEY` from `.env` to a safe place too: a database backup does not contain it, and without it the enrollment
cannot be read ([BACKUP-AND-RESTORE.md](BACKUP-AND-RESTORE.md#what-to-back-up)).

If you set `ADMIN_PASSWORD` or `ADMIN_GITHUB_ID` instead of using `/setup`, the first sign-in asks for the **enrollment code**: read it
with `docker compose exec backend cat /data/mfa-enrollment-code` (or use the value of `MFA_ENROLLMENT_TOKEN`).

## Site name and languages

**Site name, tagline and everything about you** are site content, stored in the database and edited per language at
**Admin, Settings** (`/admin/settings`). Start with the section **General** (site name, tagline, positioning sentence), then
**Profile and hero**, **About**, **Contact** and the rest. Until you save a section the public pages show neutral defaults such
as "Your Site Name". Each section is saved per language: switch the language of the content at the top of the Settings page
and fill both. A section saved in only one language is shown on the other language's site from the default language's version, and when neither is saved, from the packaged defaults. You can also
fill many sections at once from one Markdown file, see [ADMIN-GUIDE.md](ADMIN-GUIDE.md#import-from-a-markdown-file).

**Languages are not set in the browser.** The site speaks two languages, English and Vietnamese. Which one is the default (its
URLs have no `/vi` or `/en` prefix) was decided when you ran `init-env` (`DEFAULT_LOCALE`) and is baked into the frontend image:
changing it means editing `.env` and running `docker compose up -d --build`. The Settings page shows the default and enabled
languages read-only. Setting it right on day one is easiest, because changing the default later moves which URLs carry a prefix.
More about this in [CONTENT-AND-I18N.md](CONTENT-AND-I18N.md).

## Load the sample content

A new site is empty. Open **Admin, Settings** and use the **Sample content** panel: the button **Load sample content** adds

- four published posts: a "welcome" article and a "writing in Markdown" article, each in English and in Vietnamese, linked as
  translations of each other;
- the series "Getting started" (with a translated name and description) holding the posts of each language;
- the category "Guides" and the tags "welcome" and "markdown", with Vietnamese names.

The posts are written for this purpose, are neutral, have no images and show the Markdown features the site renders. They belong
to you (you are the author), and you can edit or delete every item. Pressing the button again never creates anything twice: it
reports what it created and what it left alone. Only an ADMIN can do this (`POST /api/v1/admin/sample-content`).

One thing to know: publishing queues a newsletter issue for each post published for the first time, as any publish does. On a fresh
site there are no subscribers, so nothing is sent; on a site that already has subscribers, loading the sample posts would
announce them. Load the sample content before you open the newsletter to readers, and delete the sample posts when you no longer
need them.

The public pages show new posts within the cache window if the change was made outside the admin; changes made in the admin (this
button included) appear at once.

## Write your first post

1. Open **Admin, Posts** and press **Write a post** (`/admin/posts/new`).
2. Choose the language of the post, write a title, a short description and the body in Markdown. A post needs a category before it
   can be published; create one right in the editor if you have none. Tags are optional.
3. Save (Ctrl or Cmd plus S). **Publish** saves first if there are unsaved changes and then publishes. Until then it is a draft that
   only you and other admins can see.
4. Open the post on the public site. To offer it in the other language, use the **Translations** panel in the editor
   ([ADMIN-GUIDE.md](ADMIN-GUIDE.md#posts-and-translations)).

## If something goes wrong

| Symptom | Likely cause |
|---|---|
| The code page refuses a code that looks right | The clock. Turn on automatic time on the phone and check the server's ([TROUBLESHOOTING.md](TROUBLESHOOTING.md#two-step-codes-are-rejected)). |
| `/setup` shows 404 | The site is already claimed (or `ADMIN_PASSWORD` or `ADMIN_GITHUB_ID` was set). Sign in at `/admin/login`. If you lost the password, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md). |
| `cat: can't open '/data/setup-code'` | The code file does not exist: the site was already claimed, or `SETUP_TOKEN` is set (then that value is the code), or the backend has not finished starting (`docker compose logs backend`). |
| Sign-in at `/admin/login` does nothing | Over plain HTTP on a non-localhost address the browser drops the `secure` cookies. Use `https://` or `http://localhost:3000`. Also open the site on the exact host of `SITE_URL`. |
| Every sign-in is refused | Use the email you typed in `/setup`, not `admin@blog.local`. |
| Pages show `localhost` in links or the sitemap | `SITE_URL` was wrong when the frontend image was built. Fix `.env` and run `docker compose up -d --build`. |

More in [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
