# Site profile file format (version 1)

A site profile file is one Markdown file that fills the personal content of the site: who the owner is, the About page,
skills, what they are doing now, the timeline, contact details and recommended sites. The owner downloads a template in
`Admin > Settings > Import Markdown`, fills it by hand or with an AI assistant, uploads it, reviews a preview and
confirms. This page is the contract of the file. The template, the validation and the section reference below are all
generated from the same section descriptors in the backend (`com.blog.siteimport.format.SectionRegistry`), so they cannot
drift apart.

## Principles

- The file is **text, never code**. Nothing in it is executed. Values are stored as plain text and shown escaped, so HTML
  or script typed into a value appears as characters, never as markup.
- A missing field **never deletes** anything. A line that is absent or has an empty value leaves the stored value as it is.
  To clear a value, use the admin screens.
- The file cannot set roles, permissions, passwords, tokens or any security setting. The format has no such field, and
  unknown fields are never applied.
- Nothing is lost silently: whatever the parser skips is listed in the preview under "ignored".
- The backend is the only authority. The browser shows a preview the backend computed and sends the same file back to
  apply it.

## File rules

| Rule | Behavior |
|---|---|
| Encoding | UTF-8. A byte order mark at the start is accepted and removed. Invalid UTF-8 is rejected. |
| Size | At most 256 KiB (262,144 bytes); a larger file is rejected before parsing. |
| Characters | NUL and other control characters (except tab, line feed and carriage return) reject the file. Text is normalized to Unicode NFC. |
| Line endings | `\r\n` and `\r` are read as `\n`. A line longer than 4,000 characters rejects the file. |
| Extension | The uploaded file name must end in `.md` (a plain file) or `.zip` (a package, see below). |
| Comments | A block that starts with `<!--` on its own line and ends with `-->` is skipped. The template uses them for instructions. |
| Code fences | A line that starts with three backticks or three tildes is an error (a common mistake when an assistant wraps the whole file). The `# About page` section is the exception: there a fence is part of the Markdown body. |
| Thematic breaks | A body line that is only `---`, `***` or `___` is an error: a second `---` could be read as a second document. |
| Nested lists | An indented list item is an error, except in the `# About page` section. |
| Headings | `#` starts a section, `##` starts a subsection or a group. `###` and deeper are errors. In the `# About page` section only a `#` outside a code fence ends the section; `##` to `######` are body text. |
| About page | The `# About page` section is read verbatim as one Markdown document (see below): the one place where code fences, thematic breaks, `###` headings, tables and nested lists are body text, not file structure. Every other rule of this table (encoding, size, characters, line length, comments outside fences) still applies. |

## Front matter

The file starts with a block between two `---` lines. Only three keys are allowed, each as `key: value`:

```
---
schema_version: 1
content_type: site-profile
locale: vi
---
```

- `schema_version` must be `1`. Any other value is a blocking error ("unknown schema version").
- `content_type` must be `site-profile`.
- `locale` must be a language enabled on the site (`vi` or `en` today). The file writes to that language only; the preview
  says "will write to: vi".
- A value may be wrapped in matching single or double quotes. Nothing else of YAML is supported: **anchors (`&a`), aliases
  (`*a`), tags (`!x`), merge keys (`<<`), block scalars (`|`, `>`), flow collections (`[`, `{`), nested or indented
  lines and extra documents are rejected with an error and never interpreted.**
- An unknown key, a repeated key, a missing key or a missing closing `---` is a blocking error.

## Sections

Each section starts with a level-1 heading. Heading names are English whatever the language of the content, and they
are matched ignoring case. Sections may appear in any order. A section that appears twice is an error (the message names
both lines). A heading that is not in the table below is **ignored and listed in the preview**; its content is never
applied. Text before the first heading is an error. A section that is present but has no values changes nothing.

Inside a section the file may use these building blocks:

- **Fields**: `- name: value` lines. The name is matched ignoring case; spaces and hyphens read as `_`. The value is
  everything after the first colon, trimmed, on one line. An empty value counts as absent. An unknown name is ignored and
  listed. A name that appears twice is an error.
- **Paragraph**: free text up to the next blank line, soft-wrapped lines joined with a space. A second paragraph where
  only one is allowed is an error. A paragraph line that starts with a backslash followed by `\`, `#`, `-`, `*`, `+`,
  `~`, a backtick, `<` or `_` loses that one backslash and is plain text, never a heading, list item, code fence, comment
  or break: write `\# Looking for work` for a paragraph that starts with `#`. The export adds the backslash where needed.
- **Rows**: `- cell | cell | cell` lines, one list item per line, cells by position. Trailing empty cells may be left out.
  To write a literal `|` or `\` before a `|` in a cell, write `\|` and `\\`. When rows are present they **replace the
  whole list** stored for that section.
- **Groups**: `## Title {#id key=value}` headings, each followed by rows, paragraphs or field lines. `{#id}` is the stable
  identifier (lowercase letters, digits, hyphens); if left out it is derived from the title (accents removed). A group with
  attributes such as `level=worked-with` writes them inside the braces. When groups are present they **replace the whole
  list**. A list whose items have no identifier (the Timeline entries) has no `{#id}`: its braces hold the attributes only.
- **Field lines in a group**: `- name: value` lines below a group heading, one per detail of the item (the Timeline
  entries). The name is matched like a field of a section. An empty value counts as absent, an unknown name is ignored and
  listed, and a name given twice in one group is an error, except a **repeatable line** (`- highlight: ...`), which adds one
  text to a list each time it is written, and a **pipe-separated line** (`- tech: Java | Spring Boot`), whose cells are the
  texts of a list (write `\|` for a pipe inside a text).

Saving what is already stored changes nothing, so importing the same file twice gives the same result.

<!-- BEGIN GENERATED: sections -->
### Site

Writes to the `site` content. The name of the site and the sentences that describe it in the page title, the footer and search results.

| Name | Required | Kind | Description |
|---|---|---|---|
| `name` | required | field, a `- name: value` line | The site name, 1 to 80 characters. |
| `tagline` | optional | field, a `- name: value` line | A short phrase after the name in the home page title, up to 160 characters. |
| `positioning` | optional | field, a `- name: value` line | One or two sentences about the site, up to 300 characters. |

### Identity

Writes to the `profile` content. The person behind the site and the home page hero.

| Name | Required | Kind | Description |
|---|---|---|---|
| `name` | required | field, a `- name: value` line | The person's name, 1 to 80 characters. |
| `role` | optional | field, a `- name: value` line | The current role or title, up to 120 characters. |
| `location` | optional | field, a `- name: value` line | City and country, up to 80 characters. |
| `greeting` | required | field, a `- name: value` line | The first line of the home page, 1 to 120 characters. |
| `headline` | required | field, a `- name: value` line | One line about what the person does, 1 to 200 characters. |
| `subline` | optional | field, a `- name: value` line | One line about what the site covers, up to 300 characters. |
| `gallery_lead` | optional | field, a `- name: value` line | One sentence above the photo gallery, up to 300 characters. |

### Career goals

Writes to the `profile` content. What the person is looking for, as one paragraph of up to 300 characters.

| Name | Required | Kind | Description |
|---|---|---|---|
| `seeking` | optional | paragraph below the heading | One paragraph, up to 300 characters. |

### About

Writes to the `about` content. The About page: an optional photo, one introduction paragraph, then titled groups of paragraphs.

| Name | Required | Kind | Description |
|---|---|---|---|
| `photo` | optional | field, a `- name: value` line | The photo at the top of the page: a path under assets/ in a ZIP package (JPEG, PNG or WebP), or a /media/<id>.jpg or .png path of an uploaded image. Leave it out to use the profile avatar. |
| `intro` | required | paragraph below the heading | One paragraph, 1 to 600 characters. |
| `title` | required | group title, the text of the `##` heading | The heading text, 1 to 80 characters. |
| `id` | required | group id, written as `{#id}` | Written as {#id}: 1 to 40 lowercase letters, digits or hyphens, unique in the file; derived from the title when left out. |
| paragraph | required | paragraph in a group, separated by blank lines | The text of one paragraph. |
| Groups | | limit | Up to 10 groups. Each group holds 1 to 6 paragraphs of up to 1000 characters; separate paragraphs with a blank line. |

### About page

Writes to the `about` content. The body of the About page, written as Markdown with the same article blocks as a post (callout, metrics, timeline, tabs and more). Everything up to the next level 1 heading is the body, code fences included; the body itself must not use a level 1 heading.

| Name | Required | Kind | Description |
|---|---|---|---|
| `body` | optional | Markdown document below the heading, read verbatim | Markdown, up to 20000 characters. Blank lines, fences, tables, lists and ## to ###### headings are kept as written. |

### Skills

Writes to the `skills` content. Skills in titled groups. Each row is one skill.

| Name | Required | Kind | Description |
|---|---|---|---|
| `title` | required | group title, the text of the `##` heading | The group name, 1 to 60 characters. |
| `id` | required | group id, written as `{#id}` | Written as {#id}: 1 to 40 lowercase letters, digits or hyphens, unique in the file; derived from the title when left out. |
| `level` | required | group attribute in the braces | Written as level=...: the level of every skill in the group that has none of its own: used-in-project, worked-with or learning. |
| `name` | required | row column 1, in a group | The skill, 1 to 60 characters. |
| `level` | optional | row column 2, in a group | used-in-project, worked-with or learning; the group level when left out. |
| `note` | optional | row column 3, in a group | A short remark, up to 120 characters. |
| Groups | | limit | Up to 12 groups of up to 30 skills. |

### Now

Writes to the `now` content. What the person is doing at the moment.

| Name | Required | Kind | Description |
|---|---|---|---|
| `last_updated` | required | field, a `- name: value` line | The date of the last update, YYYY-MM-DD. |
| `intro` | optional | field, a `- name: value` line | One sentence above the list, up to 300 characters. |
| `text` | required | row column 1, under `## Items` | What is going on, 1 to 300 characters. |
| `label` | optional | row column 2, under `## Items` | The text of a link that backs it up, up to 80 characters; needs a link. |
| `link` | optional | row column 3, under `## Items` | An https:// address or a path on this site such as /writing; needs a label. |
| Rows under `## Items` | | limit | Up to 20 rows. |

### Timeline

Writes to the `timeline` content. Education and work, newest first. Write each entry as a ## group with its details on lines below it; the older five-column rows under ## Entries are still read.

| Name | Required | Kind | Description |
|---|---|---|---|
| `experience_summary` | optional | field, a `- name: value` line | A sentence or two about the experience, up to 600 characters. |
| Rows under `## Entries` | | limit | The older way to write entries, still read and never written by the export: up to 30 rows with only these five columns. A file gives the entries either as rows or as groups, not both. |
| `title` | required | group title, the text of the `##` heading | The degree or role, the text of the heading, 1 to 120 characters. |
| `kind` | required | group attribute in the braces | Written as kind=...: education or experience. |
| `org` | optional | entry field, a `- name: value` line | The school or employer, up to 120 characters. |
| `url` | optional | entry field, a `- name: value` line | An https:// address for the school or employer, up to 300 characters. |
| `logo` | optional | entry field, a `- name: value` line | The logo: a path under assets/ in a ZIP package (JPEG, PNG or WebP), or a /media/<id>.jpg or .png path of an uploaded image. |
| `location` | optional | entry field, a `- name: value` line | City and country, up to 80 characters. |
| `department` | optional | entry field, a `- name: value` line | The team or department, up to 80 characters. |
| `period` | optional | entry field, a `- name: value` line | When, free text such as 09/2023 - Present, up to 60 characters. |
| `summary` | optional | entry field, a `- name: value` line | What was done or learned, up to 600 characters. |
| `tech` | optional | entry field, one `- name: value` line with items separated by pipes | Technologies or subjects as one line, separated by pipes (Java \| Spring Boot); up to 30 items of up to 40 characters. |
| `highlight` | optional | entry field, a `- name: value` line that may repeat, one item each | One achievement per line; write the line again for the next one. Up to 12 lines of up to 300 characters. |
| Groups | | limit | Up to 30 entries, each a ## heading with the title and {kind=...}, then its detail lines. Leave a detail line empty to leave the detail out. |

### Contact

Writes to the `contact` content. How readers reach the person.

| Name | Required | Kind | Description |
|---|---|---|---|
| `email` | optional | field, a `- name: value` line | A plain address such as name@example.com; shown publicly. |
| `github` | optional | field, a `- name: value` line | An https:// address, up to 200 characters. |
| `blurb` | optional | field, a `- name: value` line | One sentence about how to get in touch, up to 300 characters. |
| `label` | required | row column 1, under `## Social links` | The link text, 1 to 40 characters. |
| `url` | required | row column 2, under `## Social links` | An https:// or mailto: address, up to 200 characters. |
| Rows under `## Social links` | | limit | Up to 10 rows. |

### Blogroll

Writes to the `blogroll` content. Sites the person recommends.

| Name | Required | Kind | Description |
|---|---|---|---|
| `name` | required | row column 1, below the heading | The site name, 1 to 80 characters. |
| `url` | required | row column 2, below the heading | An https:// address, up to 200 characters. |
| `note` | optional | row column 3, below the heading | Why it is recommended, up to 200 characters. |
| Rows below the heading | | limit | Up to 50 rows. |
<!-- END GENERATED: sections -->

## Timeline entries

Each job or school is a `##` group of the `# Timeline` section: the heading holds the degree or role and the kind
(`education` or `experience`) in braces, and one line per detail follows. Every detail line may stay empty, and an export
writes all of them so that each can be found and filled in by hand.

```
# Timeline
- experience_summary: Years of backend work.

## Platform Engineer {kind=experience}
- org: Example Corp
- url: https://example.com/
- logo: assets/example-corp.png
- location: Example City
- department: Platform
- period: 09/2023 - Present
- summary: Builds and runs the services behind the product.
- tech: Java | Spring Boot | PostgreSQL
- highlight: Cut the build time from ten minutes to two.
- highlight: Wrote the onboarding guide for new engineers.

## BSc Software Engineering {kind=education}
- org: Example College
- period: 2019 - 2023
```

- The older form still imports unchanged: five-column rows under `## Entries`
  (`- experience | Engineer | Example Corp | 2020 - 2024 | Built things.`). A file gives the entries either as rows or as
  groups, never both. The export and the template always write groups.
- `org`, `period` and `summary` behave like the five columns (an empty `org` or `period` is stored as null, an empty `summary`
  as an empty text). The other details are left out of the stored entry when empty, so an entry saved before they existed
  stays valid and exports without them.
- The limits are in the table above: up to 30 entries, up to 12 highlights of up to 300 characters, up to 30 technologies of up
  to 40 characters, a link of up to 300 characters, a location and a department of up to 80 characters. A technology that
  contains a pipe is written with `\|`.
- `logo` is an image like the About photo: a path under `assets/` in a ZIP package, or the `/media/<id>.jpg` or `.png` path
  of an image the site already stores. Only a ZIP package can add a logo; a plain `.md` file with an `assets/` path is
  refused.

## URLs and text

- A URL must be `https://`, or `mailto:` where the field says so. `javascript:`, `data:`, `http:`, protocol-relative and
  scheme-less values are errors. The one exception is the link of a "now" item, which may also be a path on this site
  that starts with a single `/`.
- Text values are plain text: no control characters, no leading or trailing spaces, and within the length limit of the
  field.
- The avatar is not part of the file. It is uploaded in `Admin > Settings > Profile`.
- The link of a timeline entry is an `https://` address of up to 300 characters.

## ZIP package

The About page and the timeline can carry images. Upload a `.zip` instead of a `.md`: the same site profile file plus the images.

- The archive holds exactly one `.md` file in the format above, at the top or in one top-level folder, and its images under
  `assets/` (JPEG, PNG or WebP, recognized by their first bytes, not by their names).
- The archive follows the same safety rules and limits as the post packages (`docs/post-file-format.md`): no encrypted
  entries, links, nested archives or ZIP64, no absolute paths or `..`, capped sizes, entry counts and compression ratio.
  A package that breaks a rule is refused as a whole.
- The photo of the page is the field `- photo: assets/me.jpg` of the `# About` section. A path of an image the site already
  stores (`/media/<id>.jpg` or `.png`, as an export writes it) is kept as it is, so an export imports back unchanged.
  Without a photo the About page shows the avatar of the profile.
- The images that the `# About page` body names under `assets/` (Markdown images, the `src` of a figure, the images of a
  gallery) are stored like the avatar and the references are rewritten to `/media/<id>.<ext>#<width>x<height>`.
- The logo of a timeline entry is the field `- logo: assets/example-corp.png` of its group. It is stored like the photo and
  the entry keeps its `/media/<id>.<ext>` path. A logo that is not in the package is a problem of the `# Timeline` section.
- An image that nothing uses is a note and is not stored. An image the file names that is not in the package, a `photo` or
  an `assets/` path in a plain `.md` file, and a path that points outside the package are problems that block the apply.
- The preview shows the photo and the body image changes without any file content. The images are processed before the
  write transaction. The same package imported twice is unchanged: the same image bytes reuse the stored image. Undo
  restores the previous content; the stored images stay (delete them in the media library).
- The export of a profile is a `.md` file by default (the photo and the logos are written as their `/media/` paths), or a ZIP
  package with `GET /api/v1/admin/site-import/export?locale=<l>&format=zip` (the button "Export ZIP" in `Admin > Settings >
  Import Markdown`). The package holds `profile.md` and, under `assets/`, every image of the stored content that is a site
  image: the About photo (`assets/photo-1.jpg`), the body images (named after their description) and the logos
  (`assets/logo-<company>-<n>.png`), each stored once however often it is used. The profile file names them by those paths,
  so the package is exactly what this section imports. An image that is gone, is not a JPEG, PNG or WebP image or would not fit
  the limits of a package keeps its `/media/` path in the file and is not in the package.
- Importing an export on the **same site** changes nothing: an image whose bytes are those of an image the About page or the
  timeline already uses is not processed again, so no copy is stored and the preview says "unchanged". On a **clean site** the
  content is restored and the images are stored again, processed like any upload. The export and the import are one pair: edit the
  profile file inside the package to change the content, keep the `assets/` paths it names.

## Import behavior

- **Preview** writes nothing. It reports for each section whether it is new, will change (before and after), is unchanged,
  is missing from the file (optional) or has errors, and lists everything ignored.
- **Apply** takes the same file, the chosen sections, a mode and the SHA-256 of the previewed file. It parses and validates
  the file again and refuses to run when the hash differs. Modes: `create-only` never overwrites a section that already has
  content in that language; `update` writes the chosen sections. Only the chosen sections are written.
- **Object sections** (Site, Identity, Career goals, the fields of Now, Timeline and Contact) change only the fields the
  file gives. **List parts** replace the whole list; the preview says how many items are added, removed and kept.
- A section that does not exist yet in that language needs all its required fields in the file.
- Everything happens in one transaction: the previous version of each written section is kept (the last ten per section
  are available in `Admin > Settings`), an entry is added to the import log (who, when, file hash, sections and counts, never
  content) and the public pages are refreshed. If anything fails, nothing is written.
- **Undo last import** restores the previous versions. It names the import it undoes and refuses when a newer import
  exists, when a section was changed after the import, or when the previous version is no longer kept.
- **Export** writes the stored content of one language in this same format, in NFC. Exporting and importing the result
  changes nothing, within the limits below.

## Limits

- The About page body is at most 20,000 characters (code points), counted after the blank lines at both ends are removed; a longer
  body is an error that names the section and the limit, never the text. It may not contain a level 1 heading, because that line
  ends the section; an export of a stored body that has one cannot be read back whole.
- A list (the rows of a part, the groups of a section, the rows or paragraphs of one group) is read up to 100 items; the
  first line past that is an error and the rest of the list is not read.
- An empty optional note and a text that differs only in whitespace cannot round-trip: the file has no way to write them,
  so the import reads them as absent or trimmed.
- An export larger than 256 KiB cannot be imported back; it happens only with content near every length limit.

## Not supported in version 1

Case studies, the avatar and any binary other than the images of a package (the About photo, the About page body images and the timeline logos), images in any other section, articles, and any AI provider integration. Case studies keep their editor in
`Admin > Settings`; they can be added later as one more section descriptor.
