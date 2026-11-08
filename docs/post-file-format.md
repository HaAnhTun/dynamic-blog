# Post file format

A post file is one Markdown file that becomes one post: a block of keys (the front matter) and then the text of the post. An admin or an
author downloads a template in `Admin > Posts > Import posts`, fills it by hand or with an AI assistant, uploads up to 20 files, reviews
a preview and confirms. The "Download ZIP" button of a post writes a package in the same format (see "Round trip with "Download ZIP""). This page is the contract of the file; the keys and
the limits below are checked against the parser by a test (`PostFileFormatDocTest`), so they cannot drift apart. How to use the page is in
[ADMIN-GUIDE.md](ADMIN-GUIDE.md#import-posts-from-markdown-files). A post can also arrive as a ZIP package with its images and its
article blocks: see [ZIP packages](#zip-packages) and [ai-article-authoring.md](ai-article-authoring.md).

## Principles

- The file is **text, never code**. Nothing in it is executed, and no HTML is interpreted by the importer. A value is the text after the
  first colon of its line, nothing more: no YAML anchors, tags, block scalars, lists or quoting rules.
- An import **never publishes**. Every new post is a draft owned by the person who imports. `status: published` in a file is ignored
  (the preview says so), and so is `featured`.
- A key that is missing or empty **never clears** anything stored. It is simply not part of the file.
- Nothing is lost silently. A key the format does not know is ignored and listed in the preview (by name when it is a plain word,
  otherwise only by its line number).
- An error never repeats text from the file. A file is named by its position in the upload, a key by its name in this format and a place
  by its line number.
- The backend is the only authority. The preview is computed by the backend, and the confirm step re-reads and re-checks the files.

## Layout of a file

```
---
# A line that starts with # is a comment.
title: A short title
slug: a-short-title
language: en
excerpt: One or two sentences that sum up the post.
category: Guides
tags: welcome, markdown
series: Getting started
series_part: 1
series_description: What a new reader needs, one part at a time.
---

The post itself, in Markdown. It starts at the first line that is not blank after the closing fence.
```

Write every value as plain text. There is no unquoting: `title: "Why: x"` keeps its quotes in the title, `tags: [a, b]` makes the two tags
`[a` and `b]`, and a line such as `- item` is an error. A colon inside a value is fine. Keys are lower case; a key written with
capital letters is not a key of the format and is ignored (and listed in the preview). Always write `slug` for a new post, and so for an article
an AI assistant writes: without it the slug comes from the name of the file, and the name of a ZIP package stands for
the name of the file (`a.zip` counts as `a.md`), so two different packages with the same name would be taken for the same post. Name the
package after the slug. The [authoring prompt](ai-article-authoring.md#front-matter) tells an assistant the same rules.

| Rule | Behavior |
|---|---|
| Encoding | UTF-8. A byte order mark at the start is removed. Invalid UTF-8 rejects the file. |
| Characters | NUL and other control characters (except tab, line feed and carriage return) reject the file, with the line number. Text is normalized to Unicode NFC. |
| Line endings | `\r\n` and `\r` are read as `\n`. |
| Extension | The uploaded file name must end in `.md` (or `.zip` for a [package](#zip-packages)). An empty file is rejected. |
| Front matter | The first line that is not blank must be `---`. The block ends at the next line that holds only `---`. A file without both fences cannot be imported. |
| Front matter lines | `key: value`, a blank line or a comment (a line whose first non-blank character is `#`). Anything else is an error. Keys are lower case and written exactly as in the table below. |
| Repeated key | An error that names the key and the line of the first one. |
| Unknown key | Ignored and listed in the preview. |
| Body | Everything after the closing fence, from the first line that is not blank, to the end of the file. It has no line cap and is stored as written (after NFC and `\n` line endings). A new post needs a body that is not blank. |

## Keys

<!-- BEGIN KEYS -->
| Key | Required | What it means |
|---|---|---|
| `title` | for a new post | The title, one line. |
| `slug` | no | The URL of the post, written in lower case letters, digits and hyphens (other text is turned into that form). When it is empty or missing, the file name without `.md` is used, then the title; the preview says which. It decides what the file does: the current slug of a post you may manage means "update that post", a slug nobody uses means "create a new draft". The slug of a post of someone else you may not manage, a slug that was once the slug of any post, and a slug two files of the same import share are errors. |
| `language` | no | The language code of the post, a language enabled on the site. For a new post, when it is empty or missing, the post takes the default language of the site and the preview says so. For an existing post, empty or missing keeps its language; a different language is an error, because an import never changes the language of a post. |
| `excerpt` | no | The short description used in lists, feeds and search results. |
| `category` | no | The name of one category. It is found by its name ignoring letter case and surrounding spaces, in the language of the post first, then by its base name, then by its names in the other languages. A name that matches more than one category is an error. A name that does not exist yet creates a new category, and the preview announces it. A post without a category is a valid draft, but it cannot be published: the preview says so with a note (`category_missing`, never a problem) for a new post whose file has no category and for an existing post that has none and whose file gives none, and the editor asks for one when the post is published. On an existing post a missing or empty line keeps the stored category. |
| `tags` | no | Tag names separated by commas, found and created the same way as the category. A comma cannot be part of a tag name: a downloaded file writes it as a space, and the importer recognises that form as the tag already on the post. On an existing post a line with tags replaces the whole set of tags (a tag that is not named is removed from the post); a missing or empty line keeps the stored tags. |
| `featured` | no | `true` or `false`. Read and ignored: an import never changes what is featured. Any other value is an error. |
| `status` | no | Read and ignored: an import never publishes or unpublishes a post. |
| `translation_of` | no | The slug of the post this post translates. It is read and must be usable as a slug, but it is not applied yet (see "Not available yet"). |
| `series` | no | The name of the series the post belongs to, one line. For an **administrator** only: for an author the key is read and checked, then ignored, with a note, and nothing about series is looked up. The series is found by its name, ignoring letter case: its web address (slug) equal to the name written as a slug (so accents and spaces do not matter), or its title or any translated title equal to the name. A post that is already in a series keeps it when the name matches it. A name that matches more than one series is an error, and a name that matches none creates the series (at most 10 per import, once per name even when several files name it). The series needs `series_part`, except for a post that is already in that series. A file never takes a post out of a series. |
| `series_part` | with `series` | The number of the post in the series, digits only, from 1 to 1000. It is the number the author declared: parts can be imported in any order, one file or many at a time, and the series is put in order by these numbers. Two posts of the same language cannot have the same part in one series (an English and a Vietnamese part 3 can), and an error says so; swapping two parts in one import is an error too. Without `series` it is an error. |
| `series_description` | no | One line of at most 2000 characters. The import uses it when it creates the series, and it fills the empty description of a series that exists, so the same line can be written in every part and the first part to arrive sets it. A description that is not empty is never changed, and it is ignored with a note. An empty line writes nothing. |
| `cover` | no | The path of the cover image inside a ZIP package, such as `assets/cover.png` (at most 200 characters; JPEG, PNG or WebP; the same path rules as the images of the body). It is a problem in a plain `.md` file (a cover needs a package), when the path is not in the package, leaves it, or is not a supported image. The package wins: a new post gets the image as its cover, and an existing post gets it in place of the cover it has (see "ZIP packages"). |
| `cover_alt` | no | One line of alternative text for the cover, at most 300 characters. It is the description of the cover image and is used with `cover`; without `cover` it is ignored with a `key_ignored` note. When it is missing and the cover is the one the post already has, the stored description stays. |
<!-- END KEYS -->

## Limits

<!-- BEGIN LIMITS -->
| Limit | Value |
|---|---|
| Files per import | 20 |
| Bytes per file | 262,144 |
| Bytes in all files of one import | 4,194,304 |
| Lines of front matter | 100 |
| Characters of one front matter line | 4,000 |
| Characters of a title | 255 |
| Characters of an excerpt | 1,000 |
| Characters of a slug | 255 |
| Characters of a category name | 255 |
| Characters of a tag name | 100 |
| Characters of a language code | 8 |
| Tags per post | 20 |
| Characters of a series name | 255 |
| Characters of a series description | 2,000 |
| Highest series part | 1,000 |
| New series per import | 10 |
| New categories per import | 20 |
| New tags per import | 50 |
| Problems listed per file | 100 |
| Ignored keys listed per file | 50 |
| Bytes per ZIP package | 4,194,304 |
| Entries per ZIP package | 40 |
| Bytes per image of a package | 4,194,304 |
| Unpacked bytes in all packages of one import | 16,777,216 |
| Compression ratio of a package entry | 100 |
<!-- END LIMITS -->

A file over its size cap, or an upload over the total, is refused before any parsing. Past the caps on problems and on ignored keys the
preview lists the first ones and says how many more there are. The size of the whole upload is the cap that binds first when the files
are large: twenty files of 256 KiB would be 5 MiB. The last five rows belong to [ZIP packages](#zip-packages); the article inside a
package is a post file and has the 256 KiB cap of any other.

An author's file has one more cap, which an administrator's has not: a post carries at most `AUTHOR_MAX_TAGS_PER_POST` tags (10 by default,
[Configuration](CONFIGURATION.md#author-limits)), so a file that names more is a problem of the file on its `tags` line, in the preview,
unless the post already has all those tags.

## What a file does

- **New post.** A file whose slug no post has creates a draft, owned by the person who imports, through the same service as the editor, so
  the same rules apply (a slug is never taken back from slug history, the search index is updated, and no newsletter is queued
  because nothing is published).
- **Existing post.** A file whose final slug is the current slug of a post you may manage updates that post instead of creating a new
  one. An admin may update any post; an author only their own. The final slug is the `slug` key, else the file name without `.md`,
  else the title, so a file named after a post and without a `slug` line also matches it (the preview says where the slug came from).
  A slug that is the post of another author is the same "slug not available" error as an old slug, and nothing else about that post is
  said. The import never takes a slug from the slug history back.
- **What an update writes.** Only what the file supplies and what differs. A key that is missing or empty keeps the stored value, so a
  short file never clears the category, the tags or the description; a value equal to the stored one (compared in the normal form
  described below) also keeps it. A `tags` line replaces the whole set of tags. The language, the status, the author, the slug, the
  publication date and the featured flag never change, the cover changes only when a package brings one (see "ZIP packages"), and a file never takes a post out of a series (see "Series"); a `language` that differs from the post's is an error ("an import
  never changes the language of an existing post"), and the same language is fine. The write goes through the same service as the
  editor, so the same rules apply (for example the search index is updated).
- **Unchanged.** When every value the file supplies equals the stored one, the file is reported as unchanged and nothing is written: no
  write, no revision, no log row, no search re-index. `status` and `featured` are never compared.
- **Revision.** When the title, the description or the content really changes, the text that is replaced is kept as a revision first,
  and the ten-minute merging of the editor does not swallow it, even when the post was saved a moment ago. A change of the category or
  of the tags alone records no revision. The revision is a way back in the editor's history; the import has no undo yet.
- **Published posts.** A change to a published post goes live as soon as it is applied (the import does not unpublish it first and
  does not queue a newsletter). The preview warns about it and does not tick the file on its own; ticking it is the decision.
- **Same file twice.** The second time every value the file supplies equals the stored one in the normal form of the download, so the
  file is reported as unchanged: no second post, no revision, no log row.
- **Edited slug line.** Changing the `slug` line of a downloaded file means a new slug, so it creates a new draft and does not rename
  the post. That is the rule of the format: the slug is what identifies the post.
- **Several files.** They are applied together in one all-or-nothing step. Two files with the same final slug are both errors.
- **The preview is a promise.** The confirm step applies to each file the action the preview showed, and the preview keeps for each
  file that would be written a state: the action, the post, its status and a hash of its stored fields. When the data changed in the
  meantime (a slug was taken, a post was edited, a draft was published, a "new" file now matches a post), nothing is written and the
  answer is "preview out of date" with a count only; preview again. A file that is unchanged at confirm time is not a conflict: it
  writes nothing.

## ZIP packages

A package is one `.zip` that holds one post file and the images it uses. It is the format for an article written with the
[article blocks](content-blocks.md) and local images, and what an AI assistant is asked to return
([ai-article-authoring.md](ai-article-authoring.md)). The post file inside is exactly the format above; the importer reads the package
and then treats the article like any other file (same keys, same preview, same slug and update rules, always a draft).

```
article.zip
  article.md          the post file: front matter, then the body
  assets/
    request-flow.png  the images the body refers to
```

| Rule | Behavior |
|---|---|
| Recognised as a package | The name ends in `.zip`, or the name does not end in `.md` and the file starts with the ZIP signature. |
| The article | Exactly one `.md` entry, at the top of the package or inside the one top-level folder. Two articles, or none, is a problem of the package. The name of the `.md` file is free and never stands in for the slug (the name of the package does, see the last row). A package that holds only the article, with no `assets/` folder, is valid. |
| Images | Under `assets/`, JPEG, PNG or WebP, recognised by their first bytes and not by the name. SVG and every other format are a problem that names the supported ones. Anything else outside `assets/` is a problem too. Folders and the noise of file managers (`__MACOSX`, `.DS_Store`) are skipped. |
| Refused entries | Absolute paths, `..` and `.` segments, backslashes, drive letters, control characters, names that are not UTF-8, a name that repeats (also after NFC and case folding), links and special files, encrypted entries, ZIP64, multi-part archives, an archive inside the package, an entry that disagrees with the central directory, a truncated archive. |
| Sizes | The reader never trusts a size the archive declares: every entry is read with a bound, and the limits are in the Limits table above. A package that cannot be read is an `error` card of the preview with one problem, never a failed upload. |
| References | The body refers to an image by its path relative to the article: Markdown images and links, link definitions, the `src` of a `figure` block and the images of a `gallery` block. Code (fenced and inline) is skipped, and a raw HTML `<img>` does not count. |
| Missing image | A referenced image that is not in the package is a problem with the line of the reference. |
| Unused image | An image nothing refers to is a note, and it is not stored. |
| Unsafe content | A line-by-line check of the article of a package reports `<script`, `<style`, `<iframe`, `<object`, `<embed`, `javascript:` URLs and inline event handlers outside code as a problem of the file. It is a help for the author, not a security boundary, and plain `.md` files are not scanned: what keeps a page safe is the sanitizer of the Markdown renderer, which drops these anyway ([SECURITY.md](SECURITY.md)). |
| The name stands in for the slug | When the file has no `slug` key, the name of the package is used as the name of a `.md` file is: `a.zip` counts as `a.md`. |

**Applying a package.** The images are decoded, resized and re-encoded by the media pipeline before the transaction. In the one
transaction the post is created or updated through the normal import code, each image the body uses is stored as an image of the post
(it counts against the media quota and goes with the post), and the references in the body become `/media/<id>.<ext>#<width>x<height>`.
An image of the post with the same bytes is reused, so importing the same package again does not store a second copy. The block
syntax of the body is kept as written, so the draft can be opened and edited in the editor without losing a block. A full media quota
(422 `POST_IMPORT_MEDIA_QUOTA_EXCEEDED`) or a busy image pipeline (503 `POST_IMPORT_MEDIA_BUSY`) writes nothing. A damaged image is found
when the images are decoded, so it is a problem of the apply, not of the preview.

**The cover.** A package may name its cover image with `cover: assets/<name>` and, optionally, `cover_alt: <one line>`. The image is
an image of the package that counts as used (it is never reported as unused) and is not part of the body. The image goes through the same
media pipeline as the images of the body, before the transaction, and is stored the way the editor stores a cover upload: a **new post**
gets it as its cover; an **existing post** gets it in place of the cover it has (the package wins) and the old cover image is deleted. A cover
that is the stored one (the same bytes as the stored image) with the same description is no change. A file whose only change is the cover is
`will_change`, and the preview state covers the stored cover, so a cover that is changed between the preview and the apply makes the apply out
of date. Authors set the cover of their own posts as in the editor, administrators of any post. Problems (each names the line of `cover`): the
key in a plain `.md` file, a path that is not in the package or leaves it, and an image that is not a JPEG, PNG or WebP image. Notes:
`cover_will_be_set` (a new post, or a post without a cover) and `cover_will_be_replaced` (the post has a cover that differs from the
package's). A description alone is ignored with `key_ignored`. The preview compares the bytes of the file with the stored image, so a package
that was not downloaded from the site is reported as a change each time (as for the images of the body); the apply then writes nothing when the
processed image equals the stored cover.

**Messages.** Every message names an entry by its position and never holds a name or text of the archive. The preview shown to the
uploader may name an image path as the author wrote it (cut to 200 characters); a refusal of the apply names the line only, because
the error handler logs it. The endpoints are in [backend/README.md](../backend/README.md#zip-packages).

## Series

An **administrator's** file can put its post in a series, so that a multi-part article is imported in any order, one file or many
at a time, with no step in the admin. The three keys are `series` (the name), `series_part` (this post's number) and
`series_description` (see the table above). For an **author** the keys are read and checked like any other, then ignored with the
note `series_ignored_author`: nothing about series is looked up or written, so the answer cannot tell an author which series exist.

| Step | What happens |
|---|---|
| Finding the series | The series the post is in already, when the name matches it. Otherwise the series whose web address equals the name written as a slug (so accents, spaces and letter case do not matter, and a name never creates a `-2` copy of a series that exists), or whose title or any translated title equals the name ignoring letter case. A name that matches more than one series is an error. A name that matches none creates the series with that name as its title, in the language of the file. |
| Creating | At most 10 series per import, once per name even when several files name it; the description of the first file that gives one is used, and a later description is ignored with a note. A series that exists keeps its title and slug. Its description is filled only when it is empty (from any file of the import, the first that gives one), says `series_description_will_be_set` in the preview and is never overwritten when it has text. |
| The part | The file declares the number. The series is put in order by these numbers: a post that joins goes before the first post of the same language whose declared part is greater, or at the end. A post that is **already in the series** (every member an admin put there by hand has no declared part yet) keeps its place when the declared parts agree with it, and only its part is written: it moves only when a post of the same language before it declares a greater part, or one after it a smaller part, so re-importing the file of part 1 does not scramble a series that is already in order. Posts without a declared part stay where they are, and no other post loses its part. The number is the one the author promised; what a reader sees as "part n of m" stays the position among the **published** posts of the language, so it equals the declared numbers once all the parts are published. |
| A part already used | Two posts of the same language cannot have the same part in one series (an English part 3 and a Vietnamese part 3 can). A part held by another post is an error of the file, and so is a part two files of one import both give. Swapping two parts inside one import is an error too, because each file finds the other post holding its number: do it in two imports. |
| Series without a part | A name without `series_part` is an error, except for a post that is already in that series: it keeps its place, so a file that repeats only the name changes nothing, unless it also gives a description that fills the empty description of that series: then it is a change of the series only, and the post, its place and its revisions stay as they are. A file never takes a post out of a series. |
| Moving | A file that names another series moves the post there and gives it the declared part. The series it leaves is not touched. |
| Preview and notes | The preview shows the series and the part as a change (before and after) and says `series_will_be_created`, `series_title_differs` (the name was found by its slug or by letter case and the stored title is kept), `series_description_will_be_set` (an empty description of a series that exists will be filled), `series_description_ignored` (the series already has a description, or an earlier file sets it) or `series_ignored_author`. An apply refuses, as out of date, a file whose series or part would now be something else than the preview said (for example a series that was created in the meantime). |
| Visibility | Imported posts are drafts, so a new member is invisible to readers until it is published; the public series pages list published parts only. |
| Log | Each logged post item holds the ids of the series (and whether the import created it) and the series, position and part it had before, as numbers and ids, never a name. |

An import that only changes the series writes no revision and leaves the text and the update time of the post alone. An admin who saves
the order of a series by hand keeps the declared part of every post that stays and clears it for a post that leaves.

An import never changes the language of a post, but the editor can. The part stays with the post, so changing the language of a series
member to a language in which another post of the same series already has that part is refused with a 409 `SERIES_PART_CONFLICT` and one
fixed sentence that names nothing; when the part is free in the new language, the change works and the post keeps its part.

## What the file does not carry

Authors, publication dates, view and like counts, comments and revisions are not part of the file, and the cover is part of a
[ZIP package](#zip-packages) only. The author of an imported post is the person who imports. Images in the body of a plain `.md` file are plain Markdown and point wherever the file says;
they are not uploaded or copied. Only a [ZIP package](#zip-packages) brings its images along. The series of a post is written by
"Download ZIP" for a post that is in a series at a declared part, and not otherwise (see below).

## Round trip with "Download ZIP"

"Download ZIP" (`GET /api/v1/admin/posts/{id}/export`) is the import in reverse: it writes the **saved** post (a draft too; not the
unsaved text of the editor) as a [ZIP package](#zip-packages) that the import reads back as the same post. An author downloads their own
posts, an administrator any post. The file is named after the slug, `<slug>.zip`, ASCII only.

The ZIP holds `article.md`, the images of the body and the cover under `assets/`:

- **`article.md`** has the keys `title`, `excerpt`, `category`, `tags`, `featured`, `status`, `slug` and, when there is a value,
  `language` and, when the post has a published translation, `translation_of` (the slug of one published sibling), then, only for a post
  that is in a series **and** has a declared part, `series`, `series_part` and `series_description`, and, only for a post that has a cover,
  `cover` and, when the cover has a description, `cover_alt`; then the body. The values are
  written by the same code as before (`PostMarkdownWriter`), on one line, in the normal form below.
- **`assets/`** holds each image of the body that is a site image (`/media/<id>.<ext>`), once, with an ASCII name made from the
  description of the image (else its stored name) and a number, for example `assets/relay-overview-1.png`, and the extension of its real
  format. In the body, every reference the import finds again (Markdown images and links, link definitions, the `src` of a `figure`
  block) is rewritten to `assets/<name>`; a `/media/` path in a code fence, in a code span, in raw HTML or on another host is left as
  written. The bytes are the stored ones, so two downloads of the same post are the same file, byte for byte.
- **The cover** is written under `assets/` too, with an ASCII name such as `assets/cover-1.png` (the number is the first one no image of the
  body already uses) and the extension of its real format; the article names it with `cover` and `cover_alt`. The bytes are the stored
  ones. A cover that is not a JPEG, PNG or WebP image, is over 4 MiB or does not fit the limits of a package is left out of the package.

A value is written on one line in a normal form: line breaks inside a title, description or category become one space, a run of three or
more hyphens becomes an em dash (so a value can never look like a fence), a comma in a tag name becomes a space, and the text is NFC
with `\n` line endings. The importer compares in the same normal form on both sides (and ignores trailing line breaks and leading blank
lines of the body). So a package of a post **without images** that you do not edit, imported into the site it came from, is reported as
**unchanged** for every value it carries, and importing it creates and changes nothing. Edit one value and only that value is a change.
The older single `.md` file of a post is still available at `/admin/posts/<id>/export?format=md` and is read by the older developer script
`seed/push.py` (it publishes every file it pushes, which the import never does).

What a re-import reports and what it restores:

- **The cover round trip.** A package with a cover, downloaded and imported again, gives the same cover back: into a clean state (the post
  deleted, or another site) the post gets a cover with the same size, format and description, and the same bytes for a PNG or a WebP (the image goes through the pipeline
  again and a JPEG is re-encoded, so its bytes can differ while the picture and its size stay); imported onto the same post (without images in the body) the cover is the stored one and the file is **unchanged**.
- **A post with images is `will_change` against itself.** The preview compares the body as written: the package says `assets/...`, the
  post says `/media/<id>.<ext>#<width>x<height>`, so the card shows only the text as changed (the title, tags and category are equal)
  and applying it stores the images again as images of the post and points the body at them. Into a clean state (the post deleted, or
  another site) the package becomes the same post: same title, description, category, tags, language, series and part, the same body text
  and the same pictures.
- **The pictures go through the image pipeline again.** On import every image is decoded, resized if needed and re-encoded. A PNG came back
  with the same bytes in the tests; a JPEG may be re-encoded, so its bytes can differ while the picture and its size stay. The
  `#<width>x<height>` hint is added to each path.
- **Limits.** A package has at most 40 entries (the article and 39 images), 4 MiB, and each image at most 4 MiB; the article at most
  256 KiB. An image beyond a limit, an image that is gone from the media store and an image that is not a JPEG, PNG or WebP stays as its
  original `/media/` reference in the text and is not in the ZIP; such a reference works only on the site that holds that image. A post
  whose article alone is over 256 KiB, or whose package would be over 4 MiB even without images, is refused with 413
  `POST_EXPORT_TOO_LARGE` and one fixed sentence.

What the download does not carry, and so what an import of it cannot restore:

- **The featured flag and the featured rank.** The `featured` line is written but ignored by the import, for every role: an import never
  features or unfeatures a post, and it never touches the curated rank. A file that differs from the post only in `featured` is
  unchanged, and the preview shows a note only when the value differs from the post's state.
- **Unpublished translations.** `translation_of` names one published sibling at most, so a draft translation is not written. And the
  link is not applied by the import yet (see below).
- **A series without a declared part.** A post that an administrator put in a series by hand has no declared part, so no series key is
  written and importing the package leaves the series as it is.
- **The dates.** The publication date and the other dates of the post are not written, and an import never sets them; the author of an
  imported post is the person who imports.
- **The exact text of a value.** A title, description, category or tag name goes through the one-line normal form above, so a line break,
  a run of three hyphens or a comma in it is not restored as it was.
- **A rename.** The slug line identifies the post. Editing the slug line of a downloaded file creates a new draft with that slug and
  leaves the original post as it is.

## Not available yet

This is what the format names but the importer does not do yet. A file that uses it is not harmed: the key is read and ignored.

- Linking a post to the post it translates with `translation_of`. The key is read and checked as a slug, the link is not made, and
  the preview shows a note (`translation_of_ignored`, also for a downloaded file of a post that has a published translation; a note is
  not a change); use the Translations panel of the editor. Because of that, the link is not part of "unchanged" yet.
- Undoing an import. The status endpoint reports the last import but never offers an undo yet. A text that an update replaced is
  kept as a revision of the post in the editor.
