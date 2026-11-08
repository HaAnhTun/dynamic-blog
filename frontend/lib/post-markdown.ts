import type { Translator } from '@/i18n/translator'
import { mediaPath } from './media'
import type { MediaRef, Post } from './types'

/*
 * A post as Markdown text, for the editor and for the "Download ZIP" export (`?format=md` keeps the seed Markdown). Pure functions, without
 * touching the browser or the server: usable in both client components and route handlers.
 */

/* --- Export .md in the seed/push.py format ---------------------------------------------------- */

/**
 * The characters Python's `str.splitlines()` treats as line breaks. push.py reads the front matter line by line with it,
 * so a value containing any character here would break into a line with no colon (a parse error).
 */
const PYTHON_LINE_BREAKS = /[ \t]*(?:\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029])+[ \t]*/g

/**
 * A front matter value: one line, containing no `---`. push.py splits the file with `text.split('---', 2)`, so
 * `---` anywhere before the body, even in the middle of a title, is where the front matter gets cut. Three dashes or
 * more become an em dash "—" (also the meaning of `---` in prose), and push.py strips both ends of the value.
 */
function oneLine(value: string): string {
  return value.replace(PYTHON_LINE_BREAKS, ' ').replace(/-{3,}/g, '—').trim()
}

/**
 * The slug of the published sibling a downloaded file names in `translation_of`: the first one by language code, so the
 * choice does not depend on the order the backend lists them in. A draft is never named (the admin response lists only
 * published siblings, this is a second guard), and a post without a sibling has none.
 */
function publishedSiblingSlug(translations: Post['translations']): string | null {
  const published = (translations ?? [])
    .filter((sibling) => sibling.status === 'PUBLISHED')
    .sort((a, b) => (a.language < b.language ? -1 : a.language > b.language ? 1 : 0))
  return published.length === 0 ? null : oneLine(published[0].slug)
}

/**
 * A saved post, as a .md file that seed/push.py can read (`parse_frontmatter`): `key: value` front matter
 * with the five fields push.py requires (title, excerpt, category, tags, featured), plus `status` for information only, then
 * the keys the post import reads: `slug`, `language` and, only when the post has a published translation, `translation_of`
 * (the slug of that sibling), then the body verbatim. push.py ignores the keys it does not know, and still takes the
 * slug from the file name (`exportFileName`). The import takes it from the `slug` key, so the file names the same post.
 *
 * A round trip (export then push.py pushing it back) does NOT keep everything, on purpose:
 *  - front matter values become one line (`oneLine`): line breaks in the description become spaces, `---` becomes
 *    "—", surrounding whitespace is lost;
 *  - a comma in a tag name becomes a space (push.py splits tags on commas);
 *  - the body gets a trailing blank line if it has none, and loses leading blank lines (push.py lstrip);
 *  - `status` is not read: push.py publishes EVERY file it pushes, drafts included;
 *  - push.py also requires the category to be one of the six seed categories and at least one tag: a post that does not
 *    qualify is rejected by push.py, not guessed at;
 *  - no cover image, series, "featured posts" ranking (so `featured` is informational too), publish date, view count;
 *    images in the body remain /media/… paths of this site;
 *  - `translation_of` names one published sibling only: unpublished translations and the other siblings are not in the file.
 *    The import reads an unedited file as "unchanged" for every field the file carries.
 */
export function toSeedMarkdown(
  post: Pick<
    Post,
    'title' | 'slug' | 'language' | 'translations' | 'excerpt' | 'category' | 'tags' | 'featured' | 'status' | 'content'
  >,
): string {
  const tags = post.tags
    .map((tag) => oneLine(tag.name).replace(/,/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((name) => name !== '')
  const meta = [
    '# Exported from the admin. "status" is informational only: seed/push.py publishes every file it pushes.',
    `title: ${oneLine(post.title)}`,
    `excerpt: ${post.excerpt === null ? '' : oneLine(post.excerpt)}`,
    `category: ${post.category === null ? '' : oneLine(post.category.name)}`,
    `tags: ${tags.join(', ')}`,
    `featured: ${post.featured === true ? 'true' : 'false'}`,
    `status: ${oneLine(post.status)}`,
    `slug: ${oneLine(post.slug)}`,
  ]
  // A post from an older backend has no language: no line then, which the import reads as an absent key.
  if (post.language !== undefined && oneLine(post.language) !== '') meta.push(`language: ${oneLine(post.language)}`)
  const sibling = publishedSiblingSlug(post.translations)
  if (sibling !== null) meta.push(`translation_of: ${sibling}`)
  const body = post.content.endsWith('\n') ? post.content : `${post.content}\n`
  return `---\n${meta.join('\n')}\n---\n\n${body}`
}

/**
 * Download file name: `<slug>.md`. A backend-generated slug contains only a-z, 0-9 and hyphens; any other character (impossible
 * except for corrupt data) becomes a hyphen, so the Content-Disposition header never contains a quote or
 * a line break.
 */
export function exportFileName(slug: string): string {
  return `${safeStem(slug)}.md`
}

/**
 * Download file name of the ZIP package: the name the backend sent in `Content-Disposition` (it is `<slug>.zip`), cleaned the same
 * way as `exportFileName` and always ending in `.zip`, so nothing from a header reaches our own header unchecked. No usable name:
 * the neutral fallback.
 */
export function exportZipFileName(contentDisposition: string | null): string {
  const sent = /filename="?([^";]*)"?/i.exec(contentDisposition ?? '')?.[1] ?? ''
  return `${safeStem(sent.replace(/\.zip$/i, ''))}.zip`
}

/** A file name stem of a-z, 0-9 and hyphens only. */
function safeStem(raw: string): string {
  const safe = raw.replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '')
  return safe === '' ? 'bai-viet' : safe
}

/* --- Images in the body ------------------------------------------------------------------------- */

const MAX_ALT = 120
const SCREENSHOT = /^(screen ?shot|\u1ea3nh ch\u1ee5p m\u00e0n h\u00ecnh|ch\u1ee5p m\u00e0n h\u00ecnh)/iu
const GENERIC = /^(image|img|dsc|photo|anh|\u1ea3nh|blob|pasted|untitled)( ?\d+)?$/iu

/**
 * Default alt from the file name, so nothing has to be asked at insert time: the editor preselects this text in the field,
 * and the writer just types over it. Drops the file extension, underscores/hyphens become spaces; meaningless names ("image",
 * "IMG_2041") become the default alt "Image" (an image pasted from the clipboard is named "image.png"), screenshots become
 * "Screenshot"; both texts come from `t`, the `Admin.postImages` translator. NFC first: file names on macOS are
 * NFD, and the alt text must also be NFC like the rest of the post.
 */
export function altFromFileName(name: string, t: Translator): string {
  const base = name
    .normalize('NFC')
    .replace(/\.[^.]*$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (base === '' || GENERIC.test(base)) return t('altDefault')
  if (SCREENSHOT.test(base)) return t('altScreenshot')
  return [...base].slice(0, MAX_ALT).join('')
}

/** A Markdown image, and the position of the alt text inside it (so the editor can preselect it for the writer to type over). */
export type ImageSnippet = { markdown: string; altStart: number; altEnd: number }

/**
 * `![alt](/media/<file>)`. `\`, `[` and `]` in alt are escaped, line breaks become spaces: an alt taken
 * from a file name ("table [v2].png") must not break the image syntax. The path goes through `mediaPath`, the only place
 * that builds uploaded-image URLs (lib/media.ts).
 */
export function imageMarkdown(
  image: Pick<MediaRef, 'fileName'> & Partial<Pick<MediaRef, 'width' | 'height'>>,
  alt: string,
): ImageSnippet {
  const text = alt.replace(/[\r\n]+/g, ' ').replace(/[\\[\]]/g, (character) => `\\${character}`)
  return { markdown: `![${text}](${mediaPath(image)}${sizeHint(image)})`, altStart: 2, altEnd: 2 + text.length }
}

/**
 * `#WxH` when the size is known: the post page reads it as width/height of the `<img>` (mediaSizeHint in
 * lib/markdown.tsx), so the image does not make the page jump while loading. Uploaded images live in Postgres, there is no file
 * to read a size from at render time as with /images/*.svg. An odd size (0, a fraction) gives no hint.
 */
function sizeHint(image: Partial<Pick<MediaRef, 'width' | 'height'>>): string {
  const ok = (n: number | undefined): n is number => Number.isInteger(n) && (n as number) > 0 && (n as number) < 100_000
  return ok(image.width) && ok(image.height) ? `#${image.width}x${image.height}` : ''
}

/**
 * Inserts `block` at the selection [start, end) of `value`, as its own paragraph: enough blank lines before and
 * after. An image alone in a paragraph is built by the post page into a <figure> (figureImages in
 * lib/markdown.tsx); stuck in the middle of a sentence it is just an image inside a line of text. Returns the new string and
 * the position where `block` starts in it.
 */
export function insertBlock(value: string, start: number, end: number, block: string): { value: string; offset: number } {
  const clamp = (n: number) => Math.min(Math.max(0, n), value.length)
  const from = Math.min(clamp(start), clamp(end))
  const to = Math.max(clamp(start), clamp(end))
  const before = value.slice(0, from)
  const after = value.slice(to)
  const lead = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'
  // After the cursor only a line break remains (end of the post): one terminating line is enough, no extra blank line is padded.
  const trail = /^\n*$/.test(after)
    ? after === ''
      ? '\n'
      : ''
    : after.startsWith('\n\n')
      ? ''
      : after.startsWith('\n')
        ? '\n'
        : '\n\n'
  return { value: `${before}${lead}${block}${trail}${after}`, offset: before.length + lead.length }
}
