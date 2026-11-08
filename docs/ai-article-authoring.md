# Writing an article with an AI assistant

An AI assistant can write a complete article for this site: prose, code, tables, images and the native
[article blocks](content-blocks.md). It returns one ZIP package, you import it, look at it in the real article page and publish it from
the editor. This page is the contract between the assistant and the importer. The person who imports does not need to read it: the
**authoring prompt** that the import page offers contains everything below in a form an assistant can follow.

The site owns the page around the article (navigation, header, table of contents, author, footer, theme, width). The package provides
the article body and its images only. Nothing in a package is executed, and an article cannot add HTML, CSS or script.

## The flow

1. On `Admin > Posts > Import posts` press **Download authoring prompt** (`/admin/posts/import/authoring-prompt`, a Markdown file
   generated from the block registry, so it always lists the blocks this version supports).
2. Give the prompt to an assistant together with the topic, the audience and the source material.
3. Upload the ZIP it returns. The preview shows the files of the package, the images used and not used, the blocks counted by type and
   every problem with its line number. **Show article preview** draws the article in the real article template, with the real blocks and
   the images of the package. Nothing is stored yet.
4. Fix what the preview reports (ask the assistant to correct the package), tick the file and press **Import**. The article is a draft
   with its images stored; the result links to the saved draft preview and to the editor.
5. Read the draft, add a category if it has none, and publish it. If the package named a cover image, the draft has it as its cover and, when
   the post already had a cover, the package cover replaced it. The import checks the format, not whether a statement is true.

## The package

```text
why-two-queues.zip      named after the slug of the article
  article.md            the article: front matter, then the Markdown body
  assets/
    figure-1.png        the images the article uses
    cover.png           the cover image, when the front matter has a cover line
```

- Exactly one Markdown file, at the top of the package or in the one top-level folder, in the [post file format](post-file-format.md).
  Its name is free (`article.md` is as good as any); only the number of Markdown files matters. A ZIP that holds only the article, with no
  `assets/` folder, is valid.
- Name the ZIP file after the slug: the slug `why-two-queues` goes with `why-two-queues.zip`. The importer takes the slug from the `slug`
  line and, when there is none, from the name of the ZIP file (see [the slug trap](#the-slug-trap)).
- Images under `assets/`, JPEG, PNG or WebP. SVG and every other format are refused with the supported alternatives: draw a diagram with
  the `diagram` block, or export it as PNG.
- Name the images with lower case ASCII letters, digits, `-`, `_` and `.`, such as `figure-1.png`: no accents, no spaces, no brackets.
  The folder is `assets/`, in lower case. A reference must match the file name exactly, letter case included: `assets/Figure-1.png` does
  not find `assets/figure-1.png`. Two names that differ only in letter case are refused, and so is a package of more than 40 entries
  (folder entries count).
- Refer to an image by its path relative to the article: `![A terminal showing the answer](assets/terminal.png)` or the `src` of a
  `figure` or `gallery`. No absolute paths, no `..`, no backslashes, no spaces (a space makes Markdown show the image as plain text). Do
  not use `/media/` paths or `http://` addresses. An `https://` image is allowed but is not packed into the site, so prefer a file in the
  package. The attribute tables of the blocks may allow a `/media/` path for `src`: that is for articles written in the editor, not for a
  package.
- Every referenced image must exist in the package. An image nothing refers to is not stored and is reported as a note. The cover image
  is the exception: it is named by the `cover` line of the front matter, not by the body, and it counts as used.
- The cover image: put it under `assets/` like any image and write `cover: assets/cover.png` (and `cover_alt`) in the front matter. The
  image becomes the cover of the article and replaces the cover that an existing article has. A `cover` line in a plain `.md` file, a path that is not in the
  package and a file that is not a JPEG, PNG or WebP image are problems of the file.
- Put nothing else in the ZIP: no README, no second Markdown file, no text file and nothing outside `assets/` apart from the article.
  Every other entry is a problem of the package.
- A plain `.md` file without images is accepted in the same format (it cannot carry a cover image).

<!-- The numbers below are checked against the import code by content-blocks-doc.test.ts. -->

| Limit | Value |
| --- | --- |
| Bytes per ZIP package | 4,194,304 |
| Entries per ZIP package | 40 |
| Bytes per image | 4,194,304 |
| Bytes of the article (the .md file) | 262,144 |

The unpacked size and the compression ratio are limited as well, and unsafe archive entries are refused; the full list is in
[post-file-format.md](post-file-format.md#zip-packages) and [SECURITY.md](SECURITY.md).

## Front matter

```text
---
title: Send your first request
slug: send-your-first-request
language: en
excerpt: Install the client, send one request and read the answer.
category: Guides
tags: tutorial, http
series: Getting started with the client
series_part: 1
series_description: Install the client, send requests and read the answers, one part at a time.
---
```

The table below is the one the authoring prompt carries (the page and the prompt are generated from the same text). Every key is also
described in [post-file-format.md](post-file-format.md#keys), with the parts of the importer that decide what it does.

<!-- BEGIN FRONT MATTER -->
| Key | Required | Meaning |
| --- | --- | --- |
| `title` | yes for a new article | The title, one line, at most 255 characters. |
| `slug` | no, but write it | For a new article always write `slug`: lower case letters, digits and hyphens made from the title, for example `why-the-service-has-two-queues`. Name the ZIP file after it (`why-the-service-has-two-queues.zip`). Without a slug the ZIP file name becomes the slug, and a slug that an existing post already has means "update that post": the import preview marks it "Will change" and the person looks at the card before confirming. Choose a distinctive slug, not a bare word such as `guide`, because you cannot see which posts the site has. Never change the slug of an article that exists. |
| `language` | no | The language code of the article, for example `en`. It must be a language enabled on the site; leave it out to use the default language of the site. |
| `excerpt` | no | One or two sentences that sum up the article. |
| `cover` | no | The cover image of the article: the path of an image inside a package, such as `assets/cover.png` (JPEG, PNG or WebP, named like the other images, and not used in the body unless you want it there too). Only a package can carry it: in a plain Markdown file a `cover` line is a problem. A path that is not in the package is a problem, and so is a file that is not a JPEG, PNG or WebP image. The image becomes the cover of the article: a new article gets it, and it replaces the cover that an existing article already has, so write `cover` only for the cover the author wants. Leave it out when the author gave you no cover image. |
| `cover_alt` | with `cover` | One line that says what the cover image shows, at most 300 characters. Write `cover_alt` whenever you write `cover`: it is the alternative text of the cover for readers who cannot see the image, and it replaces the alternative text of the cover that an existing article has. |
| `category` | no | The name of one category. A name that does not exist yet creates the category. When you do not know the categories of the site, leave `category` out (an import creates at most 20 new categories). A post cannot be published without a category: a draft that has none waits until the administrator chooses one in the editor. |
| `tags` | no | Tag names separated by commas, at most 20 tags of at most 100 characters. A tag that does not exist yet is created. A hyphen in a tag is fine (`post-mortem`). When you do not know the tags of the site, leave `tags` out (an import creates at most 50 new tags). |
| `series` | only in a series | The name of the series, one line, at most 255 characters. Write `series`, `series_part` and `series_description` all three or none, and only when the author says the article belongs to a series. Use the exact same series name in every part. A series is applied only when an administrator imports the article; for an author the three lines are ignored and the import card only shows a note, so they are harmless. The article page draws the series navigation itself (part n of m, previous and next): never repeat it in the body, with no list of the parts and no "part 2 of the series" line. |
| `series_part` | with `series` | The number of this article in the series: digits only, 1 to 1000. It must be unique within a series and a language. The parts can be imported in any order. |
| `series_description` | with `series` | One line, at most 2000 characters, about the series as a whole. Write the same `series_description` line in every part, because the parts can arrive in any order. The import uses it when it creates the series, and it fills the empty description of a series that exists, from any part. It never changes a description that is not empty, and an empty line writes nothing. |

Write the front matter as plain text, not YAML: no quotes around a value (a quote would become part of the title), no `[a, b]` lists, no `- item` lines and no value that continues on the next line. A colon inside a value is fine. Every line is `key: value`, or a comment that starts with `#`. Keys are lower case and used once; a key written with capital letters is not recognised and is ignored.

Do not write `status`, `featured` or `translation_of`: they are ignored. An import never publishes anything; the article arrives as a draft.
<!-- END FRONT MATTER -->

### The slug trap

The slug is the identity of a post. A new article should always carry a `slug` line, and its ZIP file should be named after it. When the
`slug` line is missing the importer uses the name of the ZIP file instead (a package called `article.zip` gets the slug `article`), so two
different articles that both come in a file with the same name would get the same slug, and the second would be offered as an update of
the first. A slug that an existing post already has always means "update that post"; the preview says which of the two it is (an update is marked
"Will change"), so look at the card before you confirm. The assistant cannot see the posts of the site and is told to choose a distinctive
slug, not a bare word such as `guide`.

### Categories and tags

A name that does not exist yet creates a category or a tag. When the assistant does not know the categories and tags of the site it is told
to leave `category` and `tags` out; an import creates at most 20 new categories and 50 new tags. A hyphen in a tag (`post-mortem`) is fine.

### Series

An article can join a series with the three keys of the table. The importer creates the series by its name when it does not exist, puts
the article at its declared part, and it does not matter in which order, or in how many files, the parts arrive. Only an administrator
imports into a series; for an author the keys are read, checked and ignored: the import card shows a note and nothing is written, so
they are harmless. The article page draws the series navigation itself (part n of m, previous and next), so the body must not repeat it:
no list of the parts and no "part 2 of the series" line. Details and the limits are in
[post-file-format.md](post-file-format.md#keys).

## The rules of the authoring contract

The assistant is given these fourteen rules, in this order (the list is generated from the code that writes the prompt):

<!-- BEGIN RULES -->
1. Understand the topic, the audience, the purpose and the source material you are given before you write.
2. Choose a suitable structure for the article before you write it. Do not force a template such as introduction, image, code, conclusion: the structure follows the subject.
3. Write the complete article in Markdown.
4. Use the native blocks below where they materially improve understanding, and only those blocks.
5. Choose the order of the blocks from the narrative and the technical content, not from a fixed sequence. Articles may have different numbers of headings and blocks.
6. Include the images the article needs as local files in the package, and refer to them by their exact relative path.
7. Give every image useful alternative text (what it shows) and, where it helps, a caption (what the reader should take from it).
8. Give every code block an accurate language identifier. A title="file.py" on the fence names the file.
9. Use a table only where it improves a comparison, never only for visual variety.
10. Avoid unnecessary callouts, diagrams, tabs and other decorative blocks. A plain article of headings and prose is valid.
11. Do not write an article header, a table of contents, an author section or a site footer. The page provides them; the title comes from the front matter.
12. Do not write HTML or CSS, except the few tags named under "The body". Scripts, styles, iframes and inline event handlers are rejected, and other tags are silently dropped.
13. Check that every image reference points to a file in the package and that every file in the package is used. Check every block against the reference below.
14. Return one importable ZIP package, as described below, and nothing else.
<!-- END RULES -->

## Choosing a composition

The importer checks structure and safety, never a visual formula. A valid article may be nothing but headings and prose, or a long
article with diagrams, tables and several callouts; there is no required order, no required block and no template to follow. A good
article uses a block when it explains something better than plain Markdown does:

| The article needs | Reach for |
| --- | --- |
| a warning, a tip or a constraint the reader must not miss | `callout` (use few) |
| a screenshot or an illustration with a caption | `figure`, or `gallery` for several |
| two or three alternatives, or a before and an after | `compare` with `pane` children |
| options judged on several criteria | `comparison` around a table |
| an architecture or a flow | `diagram` (Mermaid) |
| a procedure | `steps` with `step` children |
| the same code in several languages | `code-tabs` |
| troubleshooting or an appendix the reader may skip | `details` (give several the same `group` for a one-at-a-time FAQ) |
| a recap, a list of things to check, a line worth remembering | `takeaways`, `checklist`, `pullquote` |
| a directory structure | `file-tree` around a nested list |
| an incident or a release history in order | `timeline` with `event` children |
| key figures of a benchmark or a case study | `metrics` with one-line `metric` children |
| the same task for macOS, Linux and Windows | `tabs` with `tab` children (`code-tabs` is for the same code in several languages) |

A `file-tree` may stand inside a `step`, a `tab` or `details`. Keep `tabs`, `timeline` and `metrics` at the top level: a tab may hold
steps, so tabs inside a step would make the colon count of every `steps` block nine.

The sample packages under `fixtures/article-packages/` show five different compositions (an architecture deep dive, a tutorial, a
concept explainer without code, a case study and a plain article of prose and a table), a sixth that shows every block variant once and
a seventh, an incident postmortem, that shows key figures, a timeline, a file tree, tabs, an accordion and highlighted code; see
[DEVELOPMENT.md](DEVELOPMENT.md#example-article-packages).

### Using the blocks well

The authoring prompt carries these notes; each one was checked against the code or a test.

<!-- BEGIN NOTES -->
- Panes of `compare`: with `variant=before-after` title the two panes `Before` and `After`; for alternatives use titles such as `Option A` and `Option B`.
- Details with the same `group` open one at a time wherever they stand in the article, so write them one after another. Leave `variant` at its default `inline` for an FAQ or a troubleshooting aside in the flow of the text, and use `appendix` for background the reader can skip.
- The `trend` of a `metric` says only which way the figure moved (`up`, `down` or `flat`), never whether that is good or bad: say that in the `note`, or leave the trend out when there is no baseline.
- The `when` of an `event` is any short text up to 40 characters: a date, a phase or a clock time such as `14:02`. Write it in double quotes.
- Items of a `file-tree`: a folder ends with a slash and holds the nested list. After a name you may write a short description, for example `main.ts - the entry point`, and mark an entry with plain words such as `(new)`, `(changed)` or `(removed)`. The list is drawn as written; nothing else in an item is read.
- A `takeaways` block may open the article as a summary.
- The panels of `tabs` and `code-tabs` that are not selected are hidden: find-in-page and print skip them, and without script only the first tab shows. Put the essential text outside the tabs and use tabs only for alternatives the reader chooses between.
<!-- END NOTES -->

## Writing the body

What the assistant is told about the text between and inside the blocks, each point checked by `frontend/lib/blocks/authoring-truth.test.tsx`
or by the validation tests:

- **Blank lines.** Put a blank line before and after every block that stands in the text. In a block that holds only other blocks the
  children follow each other directly. The importer also reads a block that directly follows a line of text or another block, but the
  examples always write the blank lines.
- **The start of the article.** A short introductory paragraph before the first `##` is fine, and so is a notice such as "This story is
  fiction". What is not allowed is a title line, a table of contents, an author section and a footer. A `takeaways` block may open the
  article as a summary. An `&` in text is fine.
- **Footnotes.** `[^1]` works in a paragraph and in the body of a block; the definition `[^1]: The note.` goes on its own line at the end of
  the article, outside any block.
- **Images.** An image alone on its line becomes a figure and its title is the caption (`![Alt text](assets/figure-1.png "Caption")`).
  Use the `figure` block only for `variant=wide` or an `attribution` (who made the image, when it is not the author). Nothing limits the alt
  text of a Markdown image (the `figure` block allows 300 characters); say in it what the image shows. The meaning of an image goes in its
  alt text and its caption, never in colour alone.
- **Code.** A label from the list of highlighted languages colours the code. Any other label (`powershell`, `mermaid`), or none, is plain
  text and not an error: for PowerShell or output write `text` and name it in the title (`title="PowerShell"`). A `shellsession` fence is a
  terminal session: prompt lines start with `$ ` and the output follows without it. A `diff` fence colours the `+` and `-` lines and also
  takes context lines and `@@` hunk headers. `highlight` counts from 1 on the first line of the code inside the fence. A `#` comment line,
  a TOML section line such as `[rules]` and a diff context line inside a fence are never headings, also inside a block.
- **HTML.** `kbd`, `sub`, `sup` and the glossary tags `dl`, `dt` and `dd` work in the body of a block too. A glossary is written as HTML (the
  prompt describes it in words, because the prompt itself carries no angle brackets):

  ```html
  <dl>
    <dt>Slug</dt>
    <dd>The last part of the address of a post.</dd>
  </dl>
  ```

- **Links.** A link keeps the path as written. To link to another article (another part of a series, or any post) write its path:
  `[Part 2](/en/posts/the-slug)` for an article in English, `[Part 2](/vi/posts/the-slug)` for one in Vietnamese: always write the language
  code of the linked article, even when you do not know the default language of the site. The site accepts the code for every language and
  sends the default language to its short address, while a path without the code (`/posts/the-slug`) opens the article in the page frame of
  the default language, which is wrong for an article in another language. Use the slug of that article, and name it in words when the slug
  is not known.
- **Tabs.** The panels of `tabs` and `code-tabs` that are not selected are hidden: find-in-page and print skip them, and without script only
  the first tab shows. Put the essential text outside the tabs.

### Diagrams

A `diagram` is Mermaid. Each type below was drawn in a browser with the Mermaid library of this site (the same options as the page: the strict
security level, no error drawing); any other type is not supported, and a diagram that cannot be drawn shows its source as text. A label with
parentheses in a flowchart needs double quotes (`A["Call (retry)"]`); the message of a sequence diagram may hold parentheses, slashes and colons.

<!-- BEGIN DIAGRAMS -->
| Type | Syntax |
| --- | --- |
| `flowchart TD` | boxes and arrows, such as A[Start] --> B{Choice} --> C[End]; TD is top down, LR is left to right. Write a label in double quotes when it holds parentheses or brackets: A["Call (retry)"] |
| `sequenceDiagram` | participant A as Client, then A->>B: message. The message text may hold parentheses, slashes and colons |
| `classDiagram` | class Name with members, and relations such as Parent <\|-- Child |
| `stateDiagram-v2` | [*] --> State, then State --> Other: event |
| `erDiagram` | relations such as POST \|\|--o{ COMMENT : has |
| `gantt` | a schedule: title, dateFormat YYYY-MM-DD, section, then Task :id, 2025-03-01, 5d |
| `pie` | a share: pie title Traffic, then one line per slice such as "Search" : 55 |
| `timeline` | events by period: timeline, then lines such as 2024 : Event : Another event |
| `xychart-beta` | a time series or a comparison as bars or a line: title "Errors per hour", x-axis [10, 11, 12], y-axis "Errors" 0 --> 100, bar [5, 20, 80], line [5, 20, 80] |
| `quadrantChart` | x-axis Low --> High, y-axis Low --> High, quadrant-1 to quadrant-4 titles, then points such as Name: [0.3, 0.6] |
| `sankey-beta` | flows: after a blank line, one line per flow as source,target,value |
| `mindmap` | root((Topic)), then the branches, one indent level deeper each |
| `journey` | title, section, then steps such as Task: 5: Actor |
| `gitGraph` | commit, branch name, checkout main, merge name |
| `block-beta` | columns 3, then blocks such as a["Client"] and links such as a --> b |
| `requirementDiagram` | requirement and element blocks joined by a relation |
| `C4Context` | Person, System and Rel lines |
| `architecture-beta` | group and service lines with the icons cloud, database or server, and edges such as db:L -- R:server |
| `packet-beta` | bit ranges such as 0-15: "Source port" |
| `kanban` | columns with indented tasks such as t1[Write the post] |
| `radar-beta` | axis a["Speed"], b["Cost"], then curve x["Option"]{3, 2} |
| `treemap` | indented names, leaves written as "Name": value |

These draw too and are rarely needed: `venn-beta`, `info`, `treeView-beta`, `ishikawa-beta`, `eventmodeling`, `cynefin-beta`, `agentflow-beta`, `railroad-ebnf-beta`.
<!-- END DIAGRAMS -->

## Two short examples

A tutorial uses steps, a figure, code tabs and a checklist:

````markdown
This guide sends one request and reads the answer.

## Send the request

:::::steps{title="Three steps"}
::::step{title="Install"}
Download the client and put it on your path.
::::
::::step{title="Send"}
Run the command below.

::figure{src="assets/terminal.png" alt="A terminal that shows the command and its answer" caption="The command and its answer."}
::::
:::::

:::code-tabs{title="The same request"}
```bash title="curl"
curl https://example.com/api/status
```
```python title="Python"
import urllib.request
print(urllib.request.urlopen("https://example.com/api/status").read())
```
:::

:::checklist{title="Done when"}
- [ ] The command printed an answer
- [ ] The status was 200
:::
````

A design article uses a diagram, a comparison table and details (a `details` block gets six colons because it may hold steps):

````markdown
## The design

:::diagram{type=mermaid title="Request flow" alt="A request goes to the router, which sends it to the fast or the slow queue"}
flowchart LR
  A[Request] --> B{Router}
  B --> C[Fast queue]
  B --> D[Slow queue]
:::

:::comparison{title="One queue or two"}
| Option | Latency of fast jobs | Complexity |
| --- | --- | --- |
| One queue | high when slow jobs arrive | low |
| Two queues | stable | medium |
:::

::::::details{title="How the router decides"}
A job that declares more than a second of expected work goes to the slow queue.
::::::
````

A block that holds other blocks needs more colons than the blocks inside it, at every level, and each block has a number that is enough
for everything it may hold (the reference gives it). A troubleshooting block with steps, and a callout inside a step, is three levels
deep:

````markdown
::::::details{title="Troubleshooting"}
Open this when the request fails.

:::::steps{title="Check in order"}
::::step{title="Read the status"}
Look at the status code first.

:::callout{type=tip title="Common cause"}
A status of 401 means the key is missing.
:::
::::
::::step{title="Try again"}
Send the request once more.
::::
:::::
::::::
````

## What is rejected, and what is only reported

| Case | Result |
| --- | --- |
| a ZIP that cannot be read, with an unsafe entry, with no article or with two | an error card; nothing is imported |
| an image the article names that is not in the package | a problem with the line; the file cannot be ticked |
| an image that is SVG or another unsupported format | a problem naming JPEG, PNG and WebP |
| `<script`, `<style`, `<iframe`, `<object`, `<embed`, `javascript:` or an inline event handler outside code | a problem of the file (a best-effort check of the package; the page drops such HTML in any case) |
| an unknown block, a bad or missing attribute, a bad nesting, a heading inside a block, a block never closed | a problem with the line and the supported alternatives; the block draws as plain content |
| a block inside a list, a quote or a table, even indented; a Docusaurus-style `:::note` or `:::callout[Title]`; the same number of colons around a block and the block inside it | a problem with the line; the block draws as plain content |
| more than 8 blocks open at once, or a block left open across a very long run of lines (blocks that are never closed) | one `too-deep` problem; no block of the article is read, they all draw as plain text |
| an article that would cost the Markdown reader too much work: thousands of quotes, of headings underlined with `---`, of HTML tags or of `*`, `_`, `[`, `]` characters (in one paragraph, or tens of thousands in the whole article), one word of tens of thousands of characters, quotes or list items nested 30 levels deep on one line, or more than about 5,000 non-blank lines | one `too-heavy` problem; the whole article is shown as plain text, with no heading, link, emphasis, code or block |
| a diagram wrapped in a code fence, an empty or oversized diagram, plain bullets in a checklist, code tabs with the same title | a problem with the line |
| a file in the ZIP that is not the article or under `assets/`, a second Markdown file, two names that differ only in letter case | a problem of the package, or the package is refused |
| a part number that another post of the same series and language already has, `series_part` without `series` | a problem of the file |
| an image the article does not use | a note; the image is not stored |

## Traps that no check reports

These import without an error and then look wrong, so the authoring prompt warns about each of them.

- **Quotes and lists in the front matter.** A value is the text after the first colon, nothing more: `title: "Why: x"` keeps its
  quotes, and `tags: [a, b]` makes the tags `[a` and `b]`.
- **HTML that vanishes.** `kbd`, `sub`, `sup` and `dl`, `dt`, `dd` render. `abbr`, `mark`, `small` and `u` do not: the tag disappears and
  only its text stays, without a warning.
- **A space in an image path.** Markdown does not read it as an image, so the text shows as it was written and the file is reported
  as unused.
- **A Mermaid diagram that cannot be read.** It imports, and the page shows its source as text. Keep to the types listed under
  [Diagrams](#diagrams), with no HTML in labels, no `click` lines and no `%%{init}%%` settings, and quote a flowchart label that holds
  parentheses.
- **GitHub-style notes.** A quote that starts with `[!NOTE]` is an ordinary quote with that literal text; use the `callout` block.
- **A task list outside a checklist.** A bare list of `- [ ]` items renders as an unstyled list of disabled checkboxes; use the `checklist` block.
- **Essential text in a tab.** The panels that are not selected are hidden from find-in-page and print, and without script only the first
  tab shows.
- **The series navigation repeated in the body.** The page draws it already.
- **Column alignment in tables, math, emoji codes and custom heading ids** are not supported and show as plain text or are ignored.
- **Levels of headings.** `##` to `####` only: they build the table of contents.

## Known limits

- Mermaid is the only diagram language, only the types listed under [Diagrams](#diagrams) are supported, and a diagram is drawn in the
  browser; a reader without JavaScript sees its source.
- SVG images are not accepted.
- A package holds one article. There are no translations in a package. The cover image is the one image with its own keys (`cover`, `cover_alt`); it becomes the
  cover of the article and replaces the cover of an existing article; the translation link of the post file format is not applied yet. A series is joined with the three series keys of the front matter, by an
  administrator; the page shows "part n of m" as the rank among the published posts of the language, which equals the declared
  numbers once every part is published.
- The assistant cannot be checked by the site: the import validates structure, safety and references, not facts.
- The article preview is a preview of the body and the header values of the file; the date, the reading time and the series of the
  published page come from the saved post.
- No block inside a list, a quote or a table: put the block at the left margin, between the paragraphs.
