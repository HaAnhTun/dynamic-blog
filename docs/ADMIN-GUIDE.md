# Admin guide

For the person who runs the site. Everything here happens in the browser at `/admin` unless it says otherwise. Install and first
sign-in are in [INSTALL.md](INSTALL.md) and [FIRST-RUN.md](FIRST-RUN.md). Vietnamese version: [vi/ADMIN-GUIDE.md](vi/ADMIN-GUIDE.md).

## Contents

- [Roles and permissions](#roles-and-permissions)
- [The admin area](#the-admin-area)
- [Security: two-step verification and your password](#security-two-step-verification-and-your-password)
- [Settings: the content of the site](#settings-the-content-of-the-site)
- [Import from a Markdown file](#import-from-a-markdown-file)
- [Import the About page as a ZIP package with a photo](#import-the-about-page-as-a-zip-package-with-a-photo)
- [Export and import the whole profile as one ZIP package](#export-and-import-the-whole-profile-as-one-zip-package)
- [Sample content](#sample-content)
- [Posts and translations](#posts-and-translations)
- [Import posts from Markdown files](#import-posts-from-markdown-files)
- [Import an article package with images and blocks](#import-an-article-package-with-images-and-blocks)
- [Download a post as a ZIP package](#download-a-post-as-a-zip-package)
- [Topics, series, Best posts and the gallery](#topics-series-best-posts-and-the-gallery)
- [Comments, users and author applications](#comments-users-and-author-applications)
- [Newsletter](#newsletter)
- [Contact messages](#contact-messages)
- [Analytics and privacy](#analytics-and-privacy)
- [Search](#search)

## Roles and permissions

There are three roles. The backend enforces them; the interface only hides what you cannot use.

| Role | Who | How they sign in |
|---|---|---|
| `USER` (reader) | Every account a GitHub sign-in creates. | GitHub (when you have enabled it). |
| `AUTHOR` | A reader an admin promoted, by hand or by approving their application. | GitHub only: authors have no password. An author may turn on two-step verification in Security; from then on every sign-in asks for a code. |
| `ADMIN` | The owner account made in `/setup`, and any account an admin promoted. | Email and password at `/admin/login`, or GitHub if linked ([CONFIGURATION.md](CONFIGURATION.md#link-the-admin-account-to-github)), **then a code from an authenticator app**: two-step verification is mandatory for admins. |

A reader who opens `/admin` is sent to the sign-in page with a "forbidden" reason.

| What | Anonymous | `USER` | `AUTHOR` | `ADMIN` |
|---|---|---|---|---|
| Read public pages, comments, like counts, search | yes | yes | yes | yes |
| Subscribe to the newsletter | yes | yes | yes | yes |
| Comment, reply, like, save posts, notifications | no | yes | yes | yes |
| Apply to become an author | no | yes | not needed | not needed |
| Write, edit, publish, unpublish, delete **own** posts, with covers, body images, revisions and translations | no | no | yes | yes (any post) |
| Import posts from Markdown files (new drafts, or updates of your own posts; an admin updates any post) | no | no | yes | yes |
| List and create categories and tags (in the editor) | no | no | yes | yes |
| View analytics | no | no | own posts only | whole site |
| Mark a post as Best post, set the Best posts order | no | no | no | yes |
| Rename, delete, merge categories and tags (Topics) | no | no | no | yes |
| Series, gallery, image storage usage | no | no | no | yes |
| Moderate comments (hide, show, delete) | no | no | no | yes |
| Users: suspend, unsuspend, change roles | no | no | no | yes |
| Author applications: approve, reject | no | no | no | yes |
| Newsletter page (counts), release or discard a held newsletter | no | no | no | yes |
| Contact messages: read, mark as read, delete | no | no | no | yes |
| Site content (Settings), Markdown profile import, export, sample content | no | no | no | yes |
| Search index: reindex and status (API) | no | no | no | yes |

Rules worth knowing:

- An AUTHOR's account has no access to site-wide things: series are curated by admins, so a translation draft made by an author does
  not join a series. An AUTHOR may link posts into a translation group only when every post in the group is theirs.
- Changing a role revokes all of that person's sessions. A demotion takes effect on the next request; a promotion takes effect
  when the person signs in again. A promotion to ADMIN makes the next sign-in an enrollment of two-step verification; a demotion to
  `USER` deletes the enrollment and the recovery codes.
- The last active ADMIN cannot be demoted, and the site owner account (the one made in `/setup`) is changed only at the owner's own
  request.
- ADMIN and AUTHOR cannot be suspended: demote them to `USER` first.
- Through the public comment endpoints an admin edits and deletes only their own comments, like anyone else.

## The admin area

Sign in at `/admin/login`: email and password (or GitHub), then the 6-digit code of your authenticator app. The very first time an
admin signs in, the page enrols the app instead ([Security](#security-two-step-verification-and-your-password)). The left sidebar (a "Menu" button on a phone) shows, for an ADMIN: Posts, Analytics, Topics, Series, Best
posts, Gallery, Comments, Users, Author applications, Newsletter, Contact, Security and Settings. An AUTHOR sees "My posts", Analytics and Security. A page that
needs a different role shows "This page is for admins only". The admin has its own language switcher (a cookie), independent of
the languages of the site.

The first page is the post list, with an overview, an accent-insensitive search box, filters by status, category, tag and language,
and bulk actions on the selected posts (publish, unpublish, delete; 1 to 20 at a time). A "Needs attention" block counts drafts
without a category, Best posts that are not published, posts without a short description and posts without tags; each row is a
filter, and none of it blocks publishing.

## Security: two-step verification and your password

`/admin/security` (admins and authors) shows whether two-step verification is on and how many recovery codes are left, and lets you
manage it. Everything on this page except "Sign out everywhere" needs a sign-in **from the last 10 minutes**: when it says "sign in
again to continue", sign in again and you return here.

- **First enrollment of an admin.** After the password (or GitHub), the enrollment page has a **Show the setup key** button. It shows
  the key as text in groups of four, with a **Copy** button and a link that opens an authenticator app on a phone (there is no QR
  image), and asks for the first 6-digit code. Then it shows **ten recovery codes once**: download or copy them and tick the box
  before **Continue to the admin area** works. Each code works once, if you lose the phone. A site that already existed before
  two-step verification first asks for the **enrollment code**, which only whoever can read the server can find
  (`MFA_ENROLLMENT_TOKEN`, or `docker compose exec backend cat /data/mfa-enrollment-code`;
  [Upgrading](UPGRADING.md#release-with-two-step-verification)). Enrolling signs out your other devices.
- **Turn on, for an author.** "Turn on", then **Show the setup key**: the same key and first code as above. No enrollment code is
  needed: the author is already signed in.
- **Generate new recovery codes** asks for a code (from the app, or a recovery code) and replaces all ten. The old ones stop working.
- **Replace authenticator** (a new phone) asks for a code from the current app **or a recovery code**, and for your password if the
  account has one, then shows the new key and asks for the first code of the new app. Until that code is accepted, the old app keeps
  working. You get ten new recovery codes.
- **Turn off** exists for authors only (it asks for a code). An admin cannot turn it off.
- **Change password** (accounts with a password): the current password, the new one twice, and a code. The new password must meet the
  [password policy](SECURITY.md#password-policy): 12 to 128 characters, not common, not made of repeated or consecutive characters,
  not containing the first part of your email. Other devices are signed out; this one stays signed in. When `ADMIN_PASSWORD` is set in
  `.env` the page says the server manages the password: remove the variable to change it here.
- **How long you stay signed in.** An admin or author session ends after 7 days without use and, however active you were, 30 days
  after you signed in; then you sign in again, with a new code if you use two-step verification. The server owner can change both
  limits ([Configuration](CONFIGURATION.md)). A reader's session does not have a fixed end.
- **Sign out everywhere** ends every session of your account, this one included. It asks "Sign out of every device?" first, then takes you to the sign-in page.
- If the sign-in page says the server could not end your session after you signed out, the backend was not reachable at that
  moment: you are signed out on this device, but the session stays valid until it expires. Sign in again and use "Sign out
  everywhere" to end it now.

**Lost the phone?** Sign in with a recovery code instead of the 6-digit code, then use "Replace authenticator". Without recovery
codes, an admin who lost the phone needs the server owner ([Security](SECURITY.md#when-the-phone-or-the-codes-are-lost)): set
`MFA_RESET_EMAIL` and `MFA_RESET_TOKEN` and restart. If a code is refused although it is right, check the clock of the phone and of
the server ([Troubleshooting](TROUBLESHOOTING.md#two-step-codes-are-rejected)); each code also works only once, so wait for the next.

## Settings: the content of the site

Everything "about one person" is data, not code, and lives under **Admin, Settings** (`/admin/settings`, ADMIN only). Nothing
about an owner is built into the software; a fresh install shows neutral placeholder text.

The page lists the sections. Each one is edited **per language**: choose the language of the content at the top, and every
section shows the other language's version as a reference.

| Section | What it holds |
|---|---|
| General | Site name (header, footer, page titles, feeds), tagline, positioning sentence (default page description and footer). |
| Profile and hero | Name, role, location, what you are looking for, the home page greeting, headline and subline, the gallery lead, the avatar (JPEG or PNG; an upload does not change the profile until you save). |
| About | An introduction, an optional Markdown body with article blocks, and sections of paragraphs for the About page. |
| Skills | Groups of skills with a level for each item (used in a project, worked with, learning). They are shown as tabs on the About page. |
| Now | What you are working on at the moment, with optional links. |
| Timeline | Education and experience entries, each with the company or school, a link, the period, location, department, a short description, bullet highlights, technologies and a logo. A form: add, remove and move entries. |
| Contact | Email, GitHub link, a short note and other links. |
| Blogroll | Sites worth reading. |
| Case studies | Write-ups with problem, solution and measured results (a measurement needs a source). |

**The timeline form.** The Timeline section is a form, not a JSON box. Each entry has a type (experience or education), the role or
degree, the company or school, a link (`https://`) that the name links to, the period (free text such as `09/2023 - Present`), a
location, a department, a short description, the highlights (one bullet point per line, up to 12) and the technologies (one per
line, shown as pills, up to 30). **Add an entry**, **Remove** and **Move up** / **Move down** change the list and the order the
public pages show. A logo comes only from importing a ZIP package ([below](#export-and-import-the-whole-profile-as-one-zip-package)):
the form shows it, keeps it when you save and has **Remove logo**, and it cannot upload one. The form names a list that is too long
before it lets you save. An older entry that has only a title, a company or school, a period and a description stays valid.

**Where it shows.** The home page "Journey" lists the experience and education entries with these details in a compact layout; the
About page shows each one as a card (the company or school as the heading, linked when it has a link, with the logo at the top
right). The home page has no skills section: the skills are the tabs on the About page. Right after the best posts, the home page
has a **Series** block with the newest published series of the language (title, description, number of parts, link). There is
nothing to set: publish a series and it appears; with none published the block is hidden.

Good to know:

- **Each save keeps the previous version**; the 10 most recent per section and language are listed under "Earlier versions" with a
  Restore button.
- **Export and import (JSON).** "Download <language> (JSON)" exports the saved sections of one language. Import takes a file made by
  the export (at most 512 KiB; the language is read from the file); every section is validated first and if anything is invalid
  nothing is imported.
- **The server validates everything.** Text is plain text and is shown escaped; links must be `https://` or `mailto:`; no field can
  carry a role or permission. Saves, restores and imports are rate limited (60 per 10 minutes per admin).
- **Saving shows at once** on the public pages. This assumes one backend and one Next process, which is what compose runs.
- **Languages are shown read-only** at the top ("Default language ... Enabled languages ..."): they are deployment settings
  ([CONTENT-AND-I18N.md](CONTENT-AND-I18N.md)).
- A language with nothing saved shows the default language's version, then the packaged defaults.

## Import from a Markdown file

Instead of filling every section by hand, import a whole profile from one Markdown file: **Admin, Settings, Import Markdown**
(`/admin/settings/import`). Nothing is written until you confirm. The file format is documented in
[site-profile-format.md](site-profile-format.md).

1. **Pick the language and download the template.** The template lists every section and field with its limits, and carries
   instructions for an AI assistant. The language you pick decides which language the file writes to. "Export current content"
   downloads your saved content in the same format, so you can edit it and import it back; "Export ZIP with images" does the same
   with the images ([below](#export-and-import-the-whole-profile-as-one-zip-package)).
2. **Fill it.** By hand, or with an AI assistant (below).
3. **Upload** one `.md` file of at most 256 KiB, or one `.zip` package of at most 4 MiB when the About page has a photo or images
   ([below](#import-the-about-page-as-a-zip-package-with-a-photo)); choose it or drop it.
4. **Review the preview.** For each section it says: new, will change (with before and after), unchanged, missing (optional) or
   error, and it lists everything it ignored (unknown sections and fields). A section with errors blocks the apply until fixed. A
   missing or empty value never deletes anything; a list in the file replaces the whole stored list (the preview counts added,
   removed and kept items).
5. **Choose the sections and a mode.** *Create only* skips sections that already have content in that language; *Update* writes
   the chosen sections. Press **Apply**.
6. **Undo.** The page offers **Undo this import** while none of its sections has been changed afterwards: it restores the
   previous version of every section the import wrote and removes the sections it created.

The file is text, never code. It cannot set roles, permissions, passwords or any security setting, and the backend validates and
re-parses it at apply time (checking that it is the file you previewed). The import log keeps who, when, a hash and counts, never
content. The format covers General, Identity, Career goals, About, Skills, Now, Timeline, Contact and Blogroll; case studies and the
avatar stay in their own editors.

**The About page body.** The About page is not a fixed set of elements. Besides the introduction and the sections, the About editor
has a **Page body** field (up to 20000 characters) that takes the same Markdown and [blocks](content-blocks.md) as an article:
callouts, metrics, a timeline, tabs, a file tree, steps, details, takeaways, figures, comparisons, diagrams and code tabs. The page
shows the body after the introduction and before the section cards, adds its `##` and `###` headings to "On this page", and shows a
`#` heading as a second-level one (the page title is the only top-level heading). Leave the field empty for no body; an invalid
block is shown as plain text and unsafe HTML is removed, as in an article. To import it, fill the `# About page` section of the
profile file: everything up to the next `#` heading outside a code fence is the body, with its blocks, fences, tables and lists kept
as written ([site-profile-format.md](site-profile-format.md)). The editor links to the same authoring prompt as the post import, so
an assistant knows the supported blocks. An empty section writes nothing and never deletes an existing body.

**Using an AI assistant.** Download the template, give the whole file to an assistant together with your CV or notes, and ask it
to fill the template and return only the file. Then check:

- every fact (names, dates, links) against your own records: the assistant can invent details, and the preview shows what would
  change but cannot tell whether a statement is true;
- that the answer is the file itself and not wrapped in a code block (a line starting with three backticks is an error), and that
  section names stay in English whatever the language of the text;
- that nothing in it is private. Do not give an assistant data you would not publish, and never put passwords or tokens in the
  file: the format has no field for them.

## Import the About page as a ZIP package with a photo

The About page can show a photo at the top of the page and images in its body. They arrive through the same profile import, as a
**ZIP package**: Admin, Settings, Import Markdown, and choose a `.zip` file instead of a `.md` file. There is no image upload in the
About editor: it shows the stored photo with a **Remove photo** button, and saving the page never drops the photo.

**What the package holds.** One `.md` file in the [site profile format](site-profile-format.md), at the top of the archive or in one
top folder, and the images under `assets/` (JPEG, PNG or WebP; the content of the file decides, not its name). It follows the same
archive rules and limits as an [article package](#import-an-article-package-with-images-and-blocks): at most 4 MiB, 40 entries, no
path tricks, nothing but the one `.md` file and the images.

```text
about.zip
  profile.md
  assets/me.jpg
  assets/diagram.png
```

**The photo.** In the `# About` section of the file, add the line `- photo: assets/me.jpg`. The page shows this photo in the top band;
without one it shows the profile avatar, and without that, no photo. A line `- photo: /media/<id>.jpg` (a path of an image the site
already stores, which is what **Export current content** writes) imports back unchanged. Leave the line out and the stored photo
stays; to drop it, use **Remove photo** in the About editor.

**Images in the page body.** In the `# About page` section, refer to images as `assets/diagram.png` in Markdown images, `figure`
blocks and `gallery` blocks. They are stored like the avatar and the references are rewritten to the stored addresses. An image
that nothing uses is listed in the preview as unused and is not stored; a reference to an image that is not in the package is a
problem and blocks the apply.

**What the preview says.** The preview shows the photo and the images as changes of the About section: the new photo path, and how
many body images are added, removed or kept. It never shows file contents. It reports as problems an `assets/` path in a plain `.md` file (a
plain Markdown file cannot carry images: use a package, or a `/media/...` path), a path that is not in the package, and an entry
that is not a JPEG, PNG or WebP image (SVG included). Nothing is written until you confirm. The images are stored when you apply,
before the content is written; an image that turns out to be damaged is found then, and nothing is written.

**Importing twice and undoing.** The same package again is **unchanged** (identical image bytes reuse the stored image). **Undo this
import** restores the previous About content, including the previous photo; the images the import stored stay in the media store.

A plain `.md` file works exactly as before.

## Export and import the whole profile as one ZIP package

**Admin, Settings, Import Markdown** has two downloads of your saved content of one language: **Export current content** (the `.md`
profile file) and **Export ZIP with images** (`site-profile-<language>.zip`). The package holds the profile file and every image the
content uses: the About page photo, the images of the About page body and the timeline logos. The file refers to each image by its
path inside the package, so one ZIP is the whole profile.

Upload the same ZIP again on the same site and the preview says **unchanged**. Upload it on a clean site, or into the other language
of the site, and the import restores the content and the images. So the package is the backup, the way to move a profile to another
site, and the thing an AI assistant can edit and hand back. Everything else about packages (the limits, the preview, **Undo this
import**) is described in the section above. To give a timeline entry a logo by hand-written file, add the line `- logo: assets/company.png`
under the entry and put the image in the package ([site-profile-format.md](site-profile-format.md#timeline)); use **Remove logo** in
the timeline form to drop it.

## Sample content

On the Settings page, the **Sample content** panel has a **Load sample content** button (ADMIN only). It adds four published
posts (a "welcome" article and a "writing in Markdown" article, each in English and Vietnamese, linked as translations), the series
"Getting started", the category "Guides" and the tags "welcome" and "markdown". It reports what it created and what it left
alone; pressing it again changes nothing. The posts belong to you; edit or delete them whenever you like. They also queue a
newsletter issue like any first publish, so load them before you open the newsletter to readers.

## Posts and translations

**Writing.** Press "Write a post". The editor takes the whole screen. Ctrl or Cmd plus S saves; with unsaved changes **Publish**
saves first and then publishes; the browser warns before you leave with unsaved changes. The meta line shows the word count and
reading time. You set the title, short description (used in lists, feeds, newsletter and search results), category (required to
publish), tags, the cover image (with alt text) and the body in Markdown. Body images are uploaded in the editor and are attached
to that post. A preview page shows the post as readers will see it. If the preview says the article is **too heavy** for the Markdown reader (thousands of
quotes, of headings underlined with `---`, of HTML tags, a very long run of `*`, `_`, `[` or `]` characters in one paragraph or tens of thousands of them in the whole article, a word
of tens of thousands of characters, thousands of web or e-mail addresses written out, of table cells or of colons in one stretch of text,
a long code sample with no blank line in it, or more than about 5,000 lines), the article is shown as plain text, headings and links
included, so readers see it the same way until you split it (a long code sample into several code blocks) or remove the markers.
Code is coloured within limits: a line of 300 characters or more, a code block of about 375 lines or more and the code beyond 120,000
characters or 2,000 lines in one article are shown without colour (the text is all there). A post you unpublish or delete here disappears from
the site at once; one changed outside the admin (a script, the API) can show for up to an hour, and a CDN in front keeps what it
has until you purge it ([Install](INSTALL.md#a-cdn-in-front)). Deleting a post is at the bottom of the settings column. **An
administrator deletes for good**: the cover, body images, revisions, old slugs, the readers' comments, likes and saved copies and the
newsletter record go with the post. **An author's delete only hides the post**: it leaves the site, the search and the author's list,
and everything that belongs to other people is kept (comments, likes, saved posts, the newsletter record, the images). The address stays
reserved, and the post leaves its group of translations, so that its sibling can be linked to another post. An administrator sees a hidden post in the post list as "Archived" and can delete it for good, or publish it again to bring
it back. An author is told this in the confirmation (the post leaves their list and the site, an administrator keeps it and can restore it or delete it for good); only an administrator's confirmation says "permanently". Every deletion is logged with the post id, who did it and how many comments it had (no text).

**An unsaved copy.** While you type, the editor keeps a copy of the unsaved text in this browser, one second after the last
keystroke, so that a crashed tab or a closed window does not lose it; reopening the post offers to restore it. The copy belongs to your
account (another account on the same browser is never offered it) and is deleted when you save, when you sign out (the **Sign out**
button, the account menu on the site, or **Sign out everywhere**, which also stops an editor open in another tab from writing it back)
and after 7 days. If your session only expires, the copy stays, so that signing in again can restore it.

**Revisions.** When a save changes the title, description or body, the previous text may be kept as a revision (up to 20, newest
first); restoring one keeps the current text as a revision first and does not touch the slug, status or taxonomy.

**Slugs.** The slug is the URL of the post. It is never re-derived from the title once set, so correcting a title does not move a
published post. When you change the slug of a post that was ever published, the old URL keeps working through a redirect. A slug
already used gets a numeric suffix (after fifty numbers, a random one). A post written by an author keeps only its newest five old
addresses; to free an old address at once, an administrator calls `DELETE /api/v1/admin/slug-history/<old-slug>` (it stops redirecting,
and any post can take it).

**Publishing.** A draft is visible to its author and to admins only. Publishing makes it public and, the first time, queues the
newsletter issue ([Newsletter](#newsletter)); the issue of a post an AUTHOR publishes waits for an administrator. Unpublish takes it off the site but keeps it; an administrator's delete removes it for good, an author's delete only hides it (see
[Posts and translations](#posts-and-translations)), and the author's confirmation says so. Only an
ADMIN can mark a post as featured (Best posts).

**Languages and translations.** Every post has one language, chosen in the editor. To offer an article in another language, use
the **Translations** panel of the editor:

- *Create a translation in*: pick the language, optionally a path (empty means this post's path plus the language). The new draft
  copies the title, description, category and tags and has no content yet; write it and publish when ready.
- *Link an existing post*: pick another post of a different language to link them as translations of each other.
- *Unlink this post*: removes only the link; the posts stay.

Readers see "Read this article in another language" only when a **published** translation exists, and `hreflang` and the sitemap
alternates follow the same rule. A translation has its own status: publishing one language does not publish the other. The post
list has a language filter. Details: [CONTENT-AND-I18N.md](CONTENT-AND-I18N.md#translating-posts).

## Import posts from Markdown files

When an article already exists as a Markdown file (written in another tool, or drafted with an AI assistant), import it instead of
copying every field into the editor: **Admin, Posts, Import posts** (`/admin/posts/import`). Both admins and authors can use it. This
is not the profile import in Settings ([Import from a Markdown file](#import-from-a-markdown-file)): that one fills the content of
the site and is for admins only. The file format is documented in [post-file-format.md](post-file-format.md).

**Who can do what.**

| Role | Import posts |
|---|---|
| `AUTHOR` | Yes. Every new post is a draft that belongs to the author. A file can also update the author's own posts, never the posts of others. |
| `ADMIN` | Yes. New posts are drafts that belong to the admin. A file can also update any post; the author of an updated post does not change. |
| `USER` (reader), anonymous | No. The backend refuses with 403 and 401. |

Importing never publishes anything and never changes a post's author, slug, language, status or featured flag. A ZIP package can set the cover of a post, and then the cover of the package replaces the one the post has (see below). An administrator's file can create a series by name and join a post at the part it declares (`series`, `series_part`, `series_description`; [post-file-format.md](post-file-format.md#series)); for an author those keys are ignored. Previews and imports are rate limited (60 together per 10 minutes
per person, [CONFIGURATION.md](CONFIGURATION.md)).

1. **Download the template.** Pick the language you write in and press **Download template**. The file lists the keys it uses with their
   limits (it leaves out `translation_of`, which the import does not apply yet), carries instructions for an AI assistant (do not invent facts, numbers, dates or links; return only the file) and a
   neutral example post. The **Download ZIP** button of a post writes the same format as a package ([below](#download-a-post-as-a-zip-package)).
2. **Choose the files.** Up to 20 files, one post per file: `.md` files of at most 256 KiB, or `.zip` packages of at most 4 MiB that
   hold an article with its images ([below](#import-an-article-package-with-images-and-blocks)); 4 MiB in all (choose them or drop
   them). A file needs a title and some text; every other key is optional.
3. **Review the preview.** Nothing is written yet. Each file says whether it is a **new post** or has an **error**, and shows the
   slug that will be used (and whether it came from the `slug` key, the file name or the title), the language (the site default
   when the file names none), the categories and tags that do not exist yet and will be created, for an administrator's file the
   series that will be created and the series and part of the post, and a list of keys the import
   ignores. A post that has no category, and whose file names none, gets a note: it is imported as a draft, but you choose a category in
   the editor before you can publish it. An error names the key and the line, never the text of your file. Two files that would get the same slug are errors on
   both. A file whose slug is the slug of a post you may manage is a **change** to that post (an author: own posts; an admin: any
   post) or **unchanged** when it holds nothing new; a key that is missing or empty keeps the stored value, and a change to a
   published post is warned about and not ticked. The slug of someone else's post is an error.
4. **Select and confirm.** New posts are ticked; untick the ones you do not want yet. A file with an error cannot be ticked and
   is left out of the import. Press **Import**: all ticked files are created in one step (all or nothing), as drafts, together with the
   categories and tags (and the series) that did not exist. If anything changed since the preview (for example a slug was taken meanwhile), nothing
   is written and you are asked to preview again.
5. **Open the drafts.** The result lists what was created, with a link that opens each draft in the editor. Review it (a
   package that had a cover image has set it as the cover), choose a category if the file had none, and publish it there. A post without a category cannot be published.

Importing the same file again creates no second post: its slug now belongs to the first one, so the file is an update of it, and
when nothing in the file differs from the post it is shown as **unchanged** and nothing is written. Changing the `slug` line of a
file creates a new draft; it does not rename the post.

**Updating a post.** A file updates the post whose current slug it has (the `slug` key, else the file name, else the title; the
preview says which). An author's file can only match the author's own posts; an admin's file matches any post. The slug of a post
you may not manage, or an old slug of any post, is an error that says nothing else about that post. Only what the file supplies
and what differs is written: a key that is missing or empty keeps the stored value, so a short file never clears the category, the
tags or the description. A `tags` line replaces the tags of the post. The language never changes: a file with another language than
the post's is an error (the same language, or none, is fine). When the title, the description or the text changes, the text that is
replaced is kept as a revision that you can restore in the editor, even if the post was saved a moment ago; a change of the
category or the tags alone records none. A change to a **published** post goes live at once: the preview warns about it and does
not tick it, so tick it only when you mean it. If a draft was published, or a post was edited, between the preview and the
confirm, nothing is written and you are asked to preview again.

**The cover.** A ZIP package can carry the cover image of the post: `cover: assets/cover.png` (JPEG, PNG or WebP) and an optional
`cover_alt` line with its alternative text, written in the front matter. A new post gets it as its cover. A post that exists gets it
too, **and it replaces the cover the post has**: the package wins, the same way a new upload in the editor replaces a cover. The preview
says which of the two happens (the post has no cover yet, or the cover will be replaced) and counts a file whose only difference is the cover
as **will change**. A cover with the same bytes and the same alternative text as the stored cover is no change. A `cover` line in a plain
Markdown file, a path that is not in the package, and a file that is not a JPEG, PNG or WebP image are problems of the file, and the file
is not imported until they are fixed. The cover image counts as used, not as an unused image. If the cover changed between the preview and
the import, nothing is written and you are asked to preview again. An author can set the cover of their own posts this way, as in the editor.

**What the file does not carry.** The author (always the person who imports), the publication date, uploaded body
images, comments, likes, views and revisions. `status` and `featured` in a file are ignored (an import never features a
post and never changes its rank). A package downloaded with **Download ZIP** and imported again on the same site is **unchanged** when the post has no images in its text (a cover does not count: the same cover is no change; with images in the text the preview says **will change**, because it compares the text as written, `assets/...` against the stored image address; nothing else differs);
what it cannot restore is the featured flag and rank, draft translations and the dates, and a title, description or tag
name is kept on one line. Its series keys are only for a post in a series at a declared part, and only an administrator's import uses them. Categories and tags are
matched by name ignoring letter case, also across languages; a name that does not exist is created; a name that matches more than
one is an error. The import log keeps who, when, how many files and a hash of each, with the posts it wrote, never any text.

**Series from an import (administrators).** Three keys in the front matter put a post in a series without a visit to the Series page:
`series` (the name), `series_part` (this post's number) and `series_description` (sets the description of a new series and fills an empty description of an existing one; a description that has text is never changed). Write them
in any order. Only an administrator's file uses them; for an author they are checked and ignored, with a note in the preview. Use
**one name for all the parts**: the import finds the series by that name (its web address is made from the name, so accents and
letter case do not matter), or creates it when it does not exist. The parts may be imported in any order, in one batch or in separate
imports, and the series is put in order by the declared numbers. Two posts of the same language cannot have the same part. A new
member is a draft, and readers see the published parts only, so a series reads right once its parts are published: the "Part n of m"
a reader sees is the rank of the post among the **published** parts, which equals the declared number when all the parts are
published. Details and limits: [post-file-format.md](post-file-format.md#series).

**Using an AI assistant.** Give the template to the assistant with your notes and ask it to return only the finished file. Then read
the draft in the editor before you publish it: the import checks the format, not whether a statement is true.

**Not available yet.**

- Linking a post to the post it translates (`translation_of`): the key is read and ignored, and the preview shows a note; use the
  Translations panel of the editor.
- Undoing an import; restore a replaced text from the revisions of the post, and delete unwanted drafts in the post list.

## Import an article package with images and blocks

An article that needs images, diagrams, steps, comparisons or callouts is imported as a **ZIP package**: one Markdown article and its
images, written in the [post file format](post-file-format.md#zip-packages) with the [article blocks](content-blocks.md). The usual
author is an AI assistant: on the import page press **Download authoring prompt** (`/admin/posts/import/authoring-prompt`), give the
prompt to the assistant with your topic and material, and upload the ZIP it returns. The prompt is generated from the blocks this
version supports, so it is always current. What the assistant is asked to do is in [ai-article-authoring.md](ai-article-authoring.md).

1. **Upload the package** like any other file (the same page, the same preview, the same rules: always a draft, never published).
2. **Read the card of the package.** Besides the usual facts it says how many images the package holds, how many the article uses and
   how many it does not (an unused image is a note and is not stored), and it names the blocks the article uses ("Blocks used:
   callout, steps"). **Problems** are listed with their line number and what to use instead: an image that is not in the package, an
   image that is not JPEG, PNG or WebP, unsafe HTML, an unknown block, a missing or wrong attribute, a heading inside a block. A file
   with a problem cannot be ticked; ask the assistant to fix the package, or edit it, and upload it again. A package that cannot be
   read at all (an unsafe archive, no article, two articles) is an error card.
3. **Show article preview.** The button draws the article in the real article page: the real header, table of contents, blocks,
   typography and code highlighting, with the images of the package. Nothing has been stored; links to other pages do not open
   from the preview. The blocks look the same as they will on the published page.
4. **Import.** The draft is created with its images, in one all-or-nothing step. Each image becomes an image of the post (it counts
   against the media quota and is removed with the post). If the quota is full or the image processing is busy, nothing is imported
   and the message says so. Importing the same package again reuses the images and creates no copies. The result links to each draft
   in the editor and to its saved preview page.
5. **Review and publish.** Open the draft, add a category if it has none (the package set the cover if it named one), and publish. Reopening and saving the
   draft in the editor keeps the block syntax: the body is stored as written. Blocks that have a mistake show as plain text, never
   lost; the preview of the editor and "Check before publishing" list them with their lines.

A package is checked for safety before anything else: archive entries with unsafe paths, links, encryption, nested archives or an
oversized unpacking are refused, and a check of the article reports scripts, styles, iframes and inline event handlers (the page never runs them, whatever the check finds). The limits are in
[post-file-format.md](post-file-format.md#limits) and [SECURITY.md](SECURITY.md). Block reference: [content-blocks.md](content-blocks.md).

## Download a post as a ZIP package

**Download ZIP** saves a post as a ZIP package in the same [format the import reads](post-file-format.md#zip-packages), so the
conversion works both ways: a package you import becomes a post, and a post you download becomes a package that the import reads
back as the same post. There is nothing new to learn. The button is under **Download and duplicate** in the post editor, and a
**Download ZIP** link is in the actions of every row of the post list.

- **What is in the package.** `article.md` at the root: the front matter (`title`, `slug`, `language`, `excerpt`, `category`, `tags`,
  `featured`, `status`, `translation_of` when the post has a published translation, and `series`, `series_part` and
  `series_description` when the post is in a series at a declared part, and `cover` and `cover_alt` when the post has a cover) and then the text exactly as stored. The images of the post
  are under `assets/`, and the image links in the text are rewritten to `assets/<file name>`, so the package also works on another
  site. Each image is stored once, with a readable name and the extension of its real format.
- **The saved version.** The package holds what is saved, drafts included. Unsaved changes in the editor are not in it; save first
  (the editor says so). An author can download their own posts, an administrator any post.
- **Importing it again.** On the same site a package of a post without images in its text is **unchanged** (its cover included), or an update of the post if you edited it; a package with images in the text shows **will change** even when you edited nothing (only the image addresses in the text differ), so check the preview before confirming. On another site
  it becomes a new draft with its images. Only the keys of the file format are read; the usual rules of an import apply.
- **The cover.** When the post has a cover, the package holds it under `assets/` (for example `assets/cover-1.png`) and `article.md`
  gets `cover:` and `cover_alt:` lines, so importing it on another site gives the draft the same cover, with the same pixels and bytes.
  Importing it again on the same site changes nothing about the cover, because the stored cover is the same image.
- **What it does not carry.** The dates, comments, likes, views, revisions and the author,
  and translations that are not published. A title, description or tag name is kept on one line, as in any post file.
- **Too large.** A post whose package would go over the limits of the import ([post-file-format.md](post-file-format.md#limits)) is
  refused with a message. An image that is missing from the media store, or too big for the package, stays as its original link.
- **The older Markdown file.** `/admin/posts/<id>/export?format=md` still returns the single Markdown file that the developer script
  `seed/push.py` reads. The editor does not link to it.

## Topics, series, Best posts and the gallery

- **Topics** (`/admin/topics`): add, rename, describe and delete categories and tags, and give each a translated name and
  description per language. Renaming never changes the slug, so old links keep working. A category that still has posts, drafts
  included, cannot be deleted; instead of the delete button there is a link to exactly those posts, and you can move the posts to
  another category and then delete, or merge two topics. Deleting a tag removes it from every post. Public category and tag pages exist
  only while they have a published post.
- **Series** (`/admin/series`): a series gathers posts in reading order ("Part n of m"). Create it, assign posts and order the parts.
  Name and description can be translated. Posts of every language can sit in one series. An import can also create a series and join its
  posts at their declared parts; saving the order here keeps the declared part of every post that stays in the series.
- **Best posts** (`/admin/curated`): the ordered list behind `/start-here`; the first three published posts also appear on the home
  page. Adding or removing takes effect at once; a new order needs "Save order".
- **Gallery** (`/admin/gallery`): upload many photos, edit the caption, alt text and date taken (read from EXIF when you leave it
  empty), hide or show, reorder, delete. Hidden photos are listed nowhere.
- **Images** are stored in the database and limited by `MEDIA_MAX_TOTAL_SIZE`; only JPEG, PNG and WebP are accepted; large ones are
  shrunk (see [CONFIGURATION.md](CONFIGURATION.md#upload-size-limits-by-layer)).

## Comments, users and author applications

- **Comments** (`/admin/comments`): every comment on every post, newest first, filterable by status and searchable by content or
  author. A hidden comment can be shown again; a deleted one cannot (readers no longer see it, the admin still does). The list
  never shows an email.
- **Users** (`/admin/users`): suspend and unsuspend reader accounts, and change roles after you retype that person's login. A
  suspended user can no longer comment or like and is signed out on the next page load; nothing is deleted, and a suspended
  author's posts leave the search results. For an author who lost the device **and** the recovery codes, "Reset two-step
  verification" on the row (it asks for your own code and a recent sign-in) removes the author's enrollment and signs the author out;
  the next sign-in can enrol again. It does not work on another admin: that is the server owner's job.
  A role change to or from admin, or a reader becoming an author, also asks for **your own code** (from the authenticator app, or a
  recovery code) and a sign-in from the last 10 minutes: if the page asks you to sign in again, do, then repeat the change.
  Promoting someone to admin removes their authenticator: at their next sign-in they set one up again with the enrollment code from
  the server ([Security](SECURITY.md#authentication-and-sessions)).
- **Author applications** (`/admin/applications`): approving or rejecting an application to become an author. Approving also needs
  the login retyped, and, when it makes a reader an author, your own code and a sign-in from the last 10 minutes. A rejected
  applicant may apply again 30 days later.

Notifications about likes and comments on a post go to the post author's account. For the owner's posts that is the admin account,
so link the admin to GitHub ([CONFIGURATION.md](CONFIGURATION.md#link-the-admin-account-to-github)) if you also read the blog through
GitHub sign-in.

## Newsletter

Readers subscribe at `/newsletter` (linked in the footer) with no account. Each post, when published **for the first time**, is sent
as a plain-text mail to those who confirmed, in the subscriber's own language and only for posts of that language. Unpublishing,
republishing, editing and drafts send nothing.

**A post an author publishes waits for you.** The mail carries text an author wrote and goes out under your site's name to every
subscriber, so when an AUTHOR publishes a post for the first time its newsletter is **held** until an administrator decides. A post
you publish yourself (also one an author wrote) is queued at once. Held newsletters are listed first on `/admin/newsletter`, with the
title and the excerpt exactly as subscribers would read them (the excerpt is cut at 300 characters), the author, the language and how
many confirmed subscribers of that language would get it. **Release** queues it: the title, the excerpt and the language you saw are stored
with it, so an edit made afterwards does not change the mail or who gets it. If the author changed the post after you opened the page,
the release is refused ("the post was changed"), nothing is sent, and the card shows the new text: read it, then release again. **Discard** keeps a record and never sends it; the post itself is not
touched. A held newsletter of a post that is not published at the moment waits for the post to be published again. Nothing expires:
a held newsletter stays until you decide. Releasing or discarding is logged with the post and your account id (no text).

| Step | What happens |
|---|---|
| Subscribe | The form always gets the same answer for any well-formed address, so nobody can probe who is subscribed. No mail is sent by the request. |
| Confirmation mail | A worker sends it within about 30 seconds. The link works for 48 hours. |
| Confirm | The link only draws a button; clicking "Confirm subscription" confirms, so a mail scanner opening the link changes nothing. |
| New-post mail | Title, short description, post link and an unsubscribe link. |
| Unsubscribe | A link in every mail (and the mailbox's one-click button). No sign-in. Subscribing again must be confirmed again. |

**Data kept:** the address, its status (pending or confirmed), its language, timestamps and which posts were mailed. After an
unsubscribe only a one-way hash of the address is kept so that it is never mailed again. A pending subscription is deleted after 7
days. Not stored: the IP or user agent of the subscriber and any tracking pixel. Failures are retried after 1 minute, 5 minutes, 30
minutes, 2 hours and 12 hours, then marked failed; a provider outage never blocks publishing.

**The admin page** (`/admin/newsletter`, ADMIN only) shows the held newsletters, then counts only, never addresses: subscribers by
status, unsubscribed hashes, the 10 latest sends by post (waiting for approval, discarded, waiting to split, split, with sent,
retrying, failed and waiting mails) and errors by code.

**Sending mail is off until you configure it.** With the default `NEWSLETTER_TRANSPORT=log` the site accepts subscriptions but
sends nothing (the admin page then counts every mail as sent). Sending real mail has not been verified by the project's own checks;
follow the checklist in [CONFIGURATION.md](CONFIGURATION.md#newsletter-in-production) and test with your own mailbox first.

## Contact messages

The contact form in the Contact section of the home page sends a visitor's name, email, optional subject and message to the backend. Every
message is **stored first**, so none is lost even when mail is off or fails. The inbox is `/admin/contact` (ADMIN only; an AUTHOR gets
the "admins only" page), newest first, 20 per page.

| What you see or do | How it works |
|---|---|
| A message | Name, the email as a link that opens your mail program, the subject (or "no subject"), the date and time in UTC, the language of the page it was sent from, and the full text with the visitor's line breaks. The text is always shown as plain text, never as HTML or Markdown. |
| Unread | A new message has an "Unread" badge and a bar on its left. The header of the page counts the unread messages of the whole inbox, not only the page you are on. |
| Mark as read | The button on an unread message. It only changes the badge; nothing is sent to the visitor. |
| Delete | Asks for confirmation, then removes the message for good. It cannot be restored. |

**Email copy:** set `CONTACT_RECIPIENT` in `.env` to one address and each new message is also mailed there as plain text, with the
visitor's address as `Reply-To`, so you can answer from your mailbox. Leave it empty to read messages only in the inbox. The mail
follows `NEWSLETTER_TRANSPORT`: with the default `log` nothing is sent. All settings and the limits (5 messages per visitor address and per email address per hour, 60 for the whole site)
are in [CONFIGURATION.md](CONFIGURATION.md#contact-form). The site never logs a name, address or message text; replying is up to you, the
blog does not send an answer.

**Retention and erasing one person's data.** A message is personal data, so it is not kept for ever: a nightly job deletes the messages
older than `CONTACT_RETENTION_DAYS` days (365 by default), read or not; set it to `0` to keep every message until you delete it. To erase
one person's data sooner, delete their messages here, remove their newsletter address by following the unsubscribe link of any mail (or
ask them to), and, for a reader account, ask the site owner: there is no self-service deletion of an account today.

## Analytics and privacy

`/admin/analytics` shows **recorded views** over a date range (default the last 30 days, at most 366): the total in the range and
all-time, a chart and a per-day table, the 10 most-read posts and six source groups (internal, search, social, GitHub, other,
direct). An ADMIN sees the whole site; an AUTHOR sees only their own posts. Nothing aggregate is public apart from each post's own
view count.

What is and is not stored:

| Stored | Not stored |
|---|---|
| The all-time total of each post. | IP address, user agent. |
| A count per post, day and source group (at most 6 rows per post per day, kept indefinitely). | The URL or host of the referring page, query string. |
| | Session or visitor identifiers, cookies, a row per view. |

Notes: the metric is "recorded views", not unique visitors (without a visitor identifier they cannot be counted honestly). A view
counts once per post per browser tab session, repeats within 30 minutes collapse, and a limit of 30 beacons per minute per IP applies;
this is decided in memory of the Next server and nothing about the visitor reaches the database. Bot filtering reduces bots and does
not eliminate them. The per-day series starts on the day the feature was deployed, and the day boundary follows
`ANALYTICS_TIME_ZONE` (set your own on a fresh install; changing it later does not move days already recorded).

## Search

Readers search from the quick search panel (press `/` or Ctrl/Cmd plus K) and from `/search`. Results cover posts, topics, series,
case studies, authors and pages, in the language of the page they are on, and never include drafts, unpublished posts or posts of
a suspended author.

There is nothing to configure for PostgreSQL search. The optional Meilisearch engine, its enabling order, the reindex and the
status are in [CONFIGURATION.md](CONFIGURATION.md#search-with-meilisearch); reindex and status are admin API calls, there is no
screen for them. The admin post list has its own accent-insensitive search box.
