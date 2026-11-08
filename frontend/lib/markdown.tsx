import 'server-only'
import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { ReactNode } from 'react'
import type { Element, Root, Text } from 'hast'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import { toHtml } from 'hast-util-to-html'
import { toJsxRuntime } from 'hast-util-to-jsx-runtime'
import { toString } from 'hast-util-to-string'
import rehypeAutolinkHeadings from 'rehype-autolink-headings'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from 'rehype-sanitize'
// Default export only. `import { rehypeShikiFromHighlighter } from ...` is a SyntaxError.
import rehypeShikiFromHighlighter from '@shikijs/rehype/core'
import rehypeSlug from 'rehype-slug'
import remarkDirective from 'remark-directive'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript'
import { unified } from 'unified'
import { SKIP, visit } from 'unist-util-visit'
import { getTranslations } from 'next-intl/server'
import { AiBlock } from '@/components/site/blocks/AiBlock'
import { CodeBlock } from '@/components/site/CodeBlock'
import { CODE_LANGUAGES, type CodeLanguage } from '@/lib/blocks/code-languages'
import { AI_BLOCK_TAG, BLOCK_PROPERTY, blocksToPlainHtml, carryCodeMeta, finishBlocks } from '@/lib/blocks/hast'
import { boundHighlighter } from '@/lib/blocks/highlight-budget'
import { skipDirectives } from '@/lib/blocks/nesting'
import { plainTextReader } from '@/lib/blocks/parse-budget'
import { gaveUp, readingOf, type Reading } from '@/lib/blocks/reading'
import { remarkBlocks } from '@/lib/blocks/remark-blocks'
import { BLOCK_PROP_NAMES, parseHighlightValue } from '@/lib/blocks/registry'
import type { Problem } from '@/lib/blocks/types'
import { RESERVED_PAGE_IDS } from '@/lib/page-ids'
import { imageFor, type PreviewImages } from '@/lib/preview-images'
import type { Translator } from '@/i18n/translator'

export type TocEntry = { depth: number; id: string; text: string }

export type { Problem as BlockProblem } from '@/lib/blocks/types'

let highlighterPromise: Promise<HighlighterCore> | undefined

/** What `createHighlighterCore` takes for a language: the grammar module, or a promise of it. */
type Grammar = Exclude<Parameters<HighlighterCore['loadLanguage']>[number], string>

/**
 * The grammar of every language of `CODE_LANGUAGES`, one literal import each. The imports are written out literally rather than built
 * from a variable: a template-literal dynamic import defeats static analysis, so the bundler could not see which grammars to include.
 * The type makes a language without an import, and an import for a language that is not listed, a compile error.
 */
const LANGUAGE_LOADERS: Record<CodeLanguage, () => Grammar> = {
  java: () => import('@shikijs/langs/java'),
  typescript: () => import('@shikijs/langs/typescript'),
  tsx: () => import('@shikijs/langs/tsx'),
  javascript: () => import('@shikijs/langs/javascript'),
  python: () => import('@shikijs/langs/python'),
  bash: () => import('@shikijs/langs/bash'),
  sql: () => import('@shikijs/langs/sql'),
  json: () => import('@shikijs/langs/json'),
  yaml: () => import('@shikijs/langs/yaml'),
  xml: () => import('@shikijs/langs/xml'),
  diff: () => import('@shikijs/langs/diff'),
  shellsession: () => import('@shikijs/langs/shellsession'),
  go: () => import('@shikijs/langs/go'),
  rust: () => import('@shikijs/langs/rust'),
  html: () => import('@shikijs/langs/html'),
  css: () => import('@shikijs/langs/css'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
  toml: () => import('@shikijs/langs/toml'),
  markdown: () => import('@shikijs/langs/markdown'),
  ini: () => import('@shikijs/langs/ini'),
}

/**
 * One highlighter for the process. Three details are load-bearing. `langs` is listed
 * explicitly because the convenience plugin's default is every bundled grammar, which
 * costs ~2.7s on the first render instead of ~57ms. The JavaScript regex engine keeps
 * Shiki's oniguruma WASM out of the server bundle entirely. And each import is written
 * out literally (see `LANGUAGE_LOADERS`) rather than built from a variable.
 */
function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    themes: [import('@shikijs/themes/github-light'), import('@shikijs/themes/github-dark')],
    langs: CODE_LANGUAGES.map((language) => LANGUAGE_LOADERS[language]()),
    engine: createJavaScriptRegexEngine(),
  })
  return highlighterPromise
}

/** The class `remark-rehype` gives the `code` of a fence, `language-<info string word>`: letters, digits and the few signs of language names (`c++`, `c#`, `objective-c`). */
const CODE_LANGUAGE_CLASS = /^language-[A-Za-z0-9_+#.-]+$/

/** The prefix the sanitizer puts before an author's `id` and `name`: the default of the schema, named here because the fold below needs it. */
const CLOBBER_PREFIX = defaultSchema.clobberPrefix ?? 'user-content-'

/**
 * Guards only the raw HTML an author typed into the Markdown. What matters about its
 * position is that it runs before SHIKI: Shiki's output is inline `style` attributes,
 * which the default schema strips, so sanitizing afterwards erases every highlight —
 * measured, it fails five tests. Being before slug and autolink as well is tidiness
 * rather than necessity: the ids and classes those two add are not author input.
 *
 * An author is not trusted with `class`, `id` or `name`:
 *
 *  - `class`. `className` is NOT in the `*` list. A Tailwind utility that exists in the compiled stylesheet (`fixed inset-0 z-50`)
 *    would let an author lay content over the whole viewport on a public page and in the admin preview. What survives is the
 *    default schema's per-element allowlist, by exact value: `language-*` on `code` (Shiki reads the language from it),
 *    `contains-task-list` and `task-list-item` on lists (GFM task lists), `footnotes` on `section`, `sr-only` on `h2` and
 *    `data-footnote-backref` on `a` (GFM footnotes). Every other class the page shows is added AFTER this step, by the pipeline:
 *    `table-scroll`, `heading-anchor`, Shiki's, and the blocks'.
 *  - `id` and `name`. The default `clobberPrefix` (`user-content-`) is kept, so an author's `<img name="currentScript">` or
 *    `<p id="main-content">` cannot shadow a property of `document` or `window` ("DOM clobbering") nor the fixed ids the page
 *    looks up with `getElementById`. The ids of the headings are made after this step by `rehype-slug` and are not prefixed by it;
 *    `reserveHeadingIds` covers the two slugs that matter (see there).
 *    `remark-gfm` runs BEFORE sanitize and already emits prefixed footnote ids (`user-content-fn-1`, and links to them), so the
 *    sanitizer would add a second prefix; `afterSanitize` takes it off again, and the footnote test is what holds this.
 */
const schema: SanitizeSchema = {
  ...defaultSchema,
  // Unknown elements are unwrapped, not deleted, so `<style>` loses its tag and leaves
  // its CSS behind as prose — an author who pastes a style block gets `body{display:none}`
  // printed in the middle of their article. `strip` deletes the subtree instead, which is
  // already how `script` is handled; these two are the only elements whose text content is
  // never meant to be read.
  strip: [...(defaultSchema.strip ?? []), 'style'],
  /**
   * `figure` and `figcaption`, which the default schema does not list.
   *
   * An unknown element is UNWRAPPED rather than deleted, so without these a caption did
   * not merely lose its styling — it came out as a bare sentence in the middle of the
   * article, indistinguishable from prose. Measured on the real pipeline before this
   * line existed.
   *
   * No new attributes come with them: both are structural and carry nothing but what the
   * `*` list already allows (no `class`). `img` keeps the default schema's own `src`, plus
   * `alt`, `width`, `height` and `title` from the `*` list — `loading` and `decoding`
   * are NOT added, because the plugin below runs after sanitize and sets them itself.
   */
  /**
   * `ai-block`, the element the pipeline makes of a valid `:::block` directive (lib/blocks), is the one tag added for blocks. Its
   * attributes are the property names of the block registry plus `block`, the type; everything else on it is stripped. It has to be
   * allowed because the blocks pass through this schema like any other element, which also lets a raw `<ai-block>` typed by an
   * author through: `components/site/blocks/AiBlock.tsx` checks every attribute against the registry again, so a raw tag can do no
   * more than a directive can. `dataTitle` and `dataHighlight` on `pre` and `code` are the title and the highlighted lines of a fence
   * (```python title="app.py" highlight="2,5-7"), set by the pipeline from the fence's meta text.
   */
  tagNames: [...(defaultSchema.tagNames ?? []), 'figure', 'figcaption', AI_BLOCK_TAG],
  attributes: {
    ...defaultSchema.attributes,
    // `'*'` is the default list as it is: no `className` (see above). The per-element class values of the default schema stay,
    // except for `code`, where the language class is pinned to what a fence can name instead of "anything after `language-`".
    [AI_BLOCK_TAG]: [BLOCK_PROPERTY, ...BLOCK_PROP_NAMES],
    pre: [...(defaultSchema.attributes?.pre ?? []), 'dataTitle', 'dataHighlight'],
    code: [['className', CODE_LANGUAGE_CLASS], 'dataTitle', 'dataHighlight'],
  },
}

/**
 * Two corrections of what the sanitizer leaves, on a tree that is already clean.
 *
 * The ids `remark-gfm` makes for footnotes (`fn-1`, `fnref-1`, `fnref-1-2`) come out of it already prefixed, and the sanitizer then
 * prefixes every `id` again. The second prefix is taken off those ids and no others, so the `#user-content-fn-1` links of the
 * references and the back links still find their target. The label (`footnote-label`) is not made prefixed by `remark-gfm`: the
 * sanitizer prefixes its `id` and the `aria-describedby` that names it alike, so they already agree.
 *
 * A `class` whose every value was refused leaves an empty list behind (`class=""`); it is removed, so an element an author gave a
 * class carries none at all.
 */
function afterSanitize() {
  const doubled = new RegExp(`^${CLOBBER_PREFIX}(?=${CLOBBER_PREFIX}(?:fn|fnref)-)`)
  return (tree: Root) => {
    visit(tree, 'element', (node) => {
      const id = node.properties.id
      if (typeof id === 'string') node.properties.id = id.replace(doubled, '')
      if (Array.isArray(node.properties.className) && node.properties.className.length === 0) delete node.properties.className
    })
  }
}

/**
 * The text a `pre` shows: its text nodes in order, a `<br>` as the line break it draws. Not `hast-util-to-string`, which leaves the
 * `<br>` out, so `<pre>a<br>b</pre>` would read `ab` once flattened and `a` over `b` before.
 */
function preText(node: Element): string {
  return node.children
    .map((child) => {
      if (child.type === 'text') return child.value
      if (child.type !== 'element') return ''
      return child.tagName === 'br' ? '\n' : preText(child)
    })
    .join('')
}

/**
 * Makes every `pre` hold what the reader sees and nothing else, on a tree that is already clean.
 *
 * The "Copy code" button copies the `textContent` of the `pre` (`components/site/CopyCodeButton.tsx`), and Shiki rewrites only a `pre`
 * whose first child is a `code` with a language: it rebuilds that one from the text of the `code` and drops the rest. Any other `pre` keeps
 * the elements an author put in it, and the sanitizer allows some that hide text (a closed `details` with its `summary`), so
 * `<pre><details><summary></summary>SECRET</details>echo hi</pre>` showed `echo hi` and copied `SECRETecho hi`: a command the reader
 * never saw, pasted into a terminal. A `pre` that is not already plain text, or one `code` that holds only text, becomes its text: the
 * `code` element, with its language class and the title and highlight of a fence, stays when the `pre` starts with one; everything else
 * is dropped as markup and kept as text. A fence, with or without a language, is already of that shape and passes through untouched.
 */
function plainPre() {
  return (tree: Root) => {
    visit(tree, 'element', (pre) => {
      if (pre.tagName !== 'pre') return
      const head = pre.children[0]
      const code = head?.type === 'element' && head.tagName === 'code' ? head : undefined
      const plain = pre.children.every((child) => child.type === 'text')
      const fence = code !== undefined && pre.children.length === 1 && code.children.every((child) => child.type === 'text')
      if (plain || fence) return
      const text: Text = { type: 'text', value: preText(pre) }
      if (code) {
        code.children = [text]
        pre.children = [code]
      } else {
        pre.children = [text]
      }
    })
  }
}

/**
 * The directory an article may point an image at, as a URL prefix and as a path.
 *
 * One constant for both because the two must agree: the check below rejects a src that
 * does not start with the prefix, and then resolves it under the directory. Writing the
 * prefix twice is how the guard and the read end up disagreeing.
 */
const IMAGE_URL_PREFIX = '/images/'

/**
 * The absolute path of a local SVG an article references, or null if it is not one we
 * will read.
 *
 * Three refusals, each for its own reason:
 *  - not under /images/ — an article has no business pointing the dimension reader at
 *    another part of the site.
 *  - not an .svg — the diagrams are SVG, and a raster would need an image decoder to
 *    measure rather than a regex over the header.
 *  - resolves outside the directory — the decision is made on the RESOLVED path, not on
 *    the input text, because `..` is not the only way to climb out: an absolute path or
 *    a drive letter in the middle of the string does it too.
 *
 * There WAS a fourth, an `src.includes('..')` check in front. It is gone because it was
 * redundant AND harmful: the resolved-path check already covers every input it covered,
 * and because it ran first, it was the one answering the only traversal test in the
 * suite — so mutating the real guard away left all twelve tests green. Measured. Two
 * tests now reach it: the `..` spelling and an absolute path, which that cheap check
 * never caught anyway.
 */
function localSvgPath(src: string): string | null {
  if (!src.startsWith(IMAGE_URL_PREFIX) || !src.endsWith('.svg')) return null

  const dir = resolve(process.cwd(), 'public', 'images')
  const file = resolve(dir, src.slice(IMAGE_URL_PREFIX.length))
  return file.startsWith(dir + sep) ? file : null
}

/**
 * The intrinsic size of an SVG, read from its viewBox.
 *
 * Why this exists at all: markdown has no syntax for image dimensions, so an
 * `![alt](src)` renders an `<img>` with no width and no height. The browser then learns
 * the aspect ratio only when the file arrives and reflows the article around it — the
 * reader is mid-sentence and the text moves. Reading the number from the file at render
 * time is the only way to put it in the HTML without asking the author to repeat it.
 *
 * The viewBox rather than the `width`/`height` attributes: a viewBox is required for the
 * diagram to scale at all, so it is the attribute that is certainly present, and it is
 * the one that cannot disagree with the drawing.
 *
 * Reads the whole file rather than opening a descriptor for the first kilobyte: these
 * files are two to four kilobytes, so a partial read saves nothing measurable and costs
 * a branch for the case where the header runs past the window.
 */
function svgViewBoxSize(file: string): { width: number; height: number } | null {
  let head: string
  try {
    head = readFileSync(file, 'utf8')
  } catch {
    // A missing file is the normal case for a typo in an article, and it must cost the
    // dimensions only. The broken image itself is what the reader sees, and
    // seed/push.py's linter plus app/sitemap-adjacent tests are what catch it earlier.
    return null
  }

  const viewBox = /viewBox\s*=\s*"\s*[\d.+-]+\s+[\d.+-]+\s+([\d.]+)\s+([\d.]+)\s*"/.exec(head)
  if (!viewBox) return null

  const width = Math.round(Number(viewBox[1]))
  const height = Math.round(Number(viewBox[2]))
  return width > 0 && height > 0 ? { width, height } : null
}

/**
 * `/media/<file>#WxH`: the size hint the editor writes for an uploaded image (see
 * `imageMarkdown` in lib/post-markdown.ts). Uploaded bytes live in Postgres, so unlike
 * /images/*.svg there is no file on disk to read a size from at render time; the hint carries
 * the width and height the backend reported at upload, and is stripped from the src here.
 * Only a well-formed hint on a /media path counts; anything else is left exactly as written.
 */
const MEDIA_SIZE_HINT = /^(\/media\/[^#?\s]+)#([1-9]\d{0,4})x([1-9]\d{0,4})$/

function mediaSizeHint(src: string): { src: string; width: number; height: number } | null {
  const match = MEDIA_SIZE_HINT.exec(src)
  if (!match?.[1] || !match[2] || !match[3]) return null
  return { src: match[1], width: Number(match[2]), height: Number(match[3]) }
}

/** A paragraph holding one image and nothing else — whitespace between tags does not
 *  count, because `![alt](src)\n` leaves a newline behind. */
function holdsOnlyTheImage(paragraph: Element, image: Element): boolean {
  return paragraph.children.every((child) => child === image || (child.type === 'text' && child.value.trim() === ''))
}

/**
 * Turns a lone image into a `<figure>`, captions it from the markdown title, and gives
 * every image the two attributes the browser wants.
 *
 * Runs AFTER sanitize, and that placement is the reason the schema above stays narrow:
 * `loading` and `decoding` are set here, on a tree that is already clean, so they never
 * have to be allowed as author input. Author-typed `<figure>` still works, because the
 * schema lists the element — the two paths produce the same markup.
 *
 * `title` becomes the caption and is then REMOVED. A title attribute renders as a
 * tooltip, which is unreachable by keyboard and invisible on touch; once the same words
 * are on the page as a caption, keeping it only duplicates them for a mouse.
 *
 * `alt` is left alone and is not the caption. They answer different questions: alt
 * describes the image to someone who cannot see it, a caption says what the reader
 * should take from it. Using one for both is how a diagram ends up with "Diagram" as its
 * entire description.
 */
function figureImages() {
  return (tree: Root) => {
    visit(tree, 'element', (node, _index, parent) => {
      if (node.tagName !== 'img') return

      node.properties.loading ??= 'lazy'
      node.properties.decoding ??= 'async'

      const hinted = mediaSizeHint(typeof node.properties.src === 'string' ? node.properties.src : '')
      if (hinted) {
        node.properties.src = hinted.src
        if (node.properties.width == null && node.properties.height == null) {
          node.properties.width = hinted.width
          node.properties.height = hinted.height
        }
      }

      const src = typeof node.properties.src === 'string' ? node.properties.src : ''
      if (node.properties.width == null && node.properties.height == null) {
        const file = localSvgPath(src)
        const size = file ? svgViewBoxSize(file) : null
        if (size) {
          node.properties.width = size.width
          node.properties.height = size.height
        }
      }

      if (!parent || parent.type !== 'element' || parent.tagName !== 'p') return
      if (!holdsOnlyTheImage(parent, node)) return

      const title = typeof node.properties.title === 'string' ? node.properties.title.trim() : ''
      delete node.properties.title

      // The paragraph BECOMES the figure rather than being replaced inside its own
      // parent: rewriting a node in place needs no index arithmetic, and `visit` is
      // free to walk back into it — the guards above make a second pass a no-op.
      parent.tagName = 'figure'
      parent.children = title
        ? [
            node,
            {
              type: 'element',
              tagName: 'figcaption',
              properties: {},
              children: [{ type: 'text', value: title }],
            },
          ]
        : [node]
    })
  }
}

/**
 * Class applied to the table scroll wrapper; the style lives in app/globals.css (`.prose .table-scroll`).
 * Exported so the test and the CSS share one name.
 */
export const TABLE_SCROLL_CLASS = 'table-scroll'

/** Name of the scroll wrapper: the table's header cells ("Table: Command, Meaning"), else the sequence number. */
function tableName(table: Element, n: number, t: Translator): string {
  const headers: string[] = []
  visit(table, 'element', (cell) => {
    if (cell.tagName === 'th') headers.push(toString(cell).trim())
  })
  const label = headers.filter(Boolean).join(', ')
  if (!label) return t('tableNumbered', { n })
  return t('tableNamed', { label: label.length > 80 ? `${label.slice(0, 79).trimEnd()}…` : label })
}

/**
 * Each table sits in its own horizontal scroll wrapper, so one wide table does not push the whole page
 * into horizontal scroll. Measured on the QA stack: the sftp-error-255 post has a cell with unbreakable
 * inline code (`StrictHostKeyChecking=accept-new`), the table was 343px wide in a 320px frame and the
 * whole page slid sideways.
 *
 * A wrapping `<div>` rather than `display: block` on the `<table>` itself: changing a table's display makes
 * some screen readers lose the table semantics (rows, columns, headers). The wrapper has `role="region"`,
 * an accessible name and `tabIndex={0}`: keyboard users can focus it and scroll with the arrow keys, and
 * screen readers know what the region is.
 *
 * Runs AFTER sanitize, like figureImages: `role`, `tabIndex` and `aria-label` are set by the pipeline on an
 * already clean tree, not something an author is allowed to type.
 */
function scrollableTables(t: Translator) {
  return (tree: Root) => {
    let count = 0
    visit(tree, 'element', (node, index, parent) => {
      if (node.tagName !== 'table' || !parent || index === undefined) return
      count += 1
      parent.children[index] = {
        type: 'element',
        tagName: 'div',
        properties: {
          className: [TABLE_SCROLL_CLASS],
          role: 'region',
          tabIndex: 0,
          ariaLabel: tableName(node, count, t),
        },
        children: [node],
      }
      // Do not descend into the table just wrapped: there is nothing to do inside it, and descending meets it again.
      return SKIP
    })
  }
}

/**
 * Heading ids must not depend on whether the author's editor emitted NFC or NFD, and
 * `rehype-slug` reads the text as it finds it.
 *
 * Scoped to headings rather than every text node, which is what the first version did:
 * normalizing the whole document also rewrites the inside of code fences, and a code
 * sample is the one place where the exact bytes might be the point. Body prose is left
 * in whatever form the author wrote — it renders identically either way, and nothing
 * downstream compares it.
 */
/** The longest inline code that is kept on one line: `--flag` or `single-process` must not break at a hyphen on a phone. */
const SHORT_INLINE_CODE = 24

/**
 * Short inline code (up to SHORT_INLINE_CODE characters, no space) gets `data-short=""`: the stylesheet keeps it on one line. Longer code
 * still wraps, so a long command cannot push the page wider than the screen. Fenced code (a `code` inside a `pre`) is left alone.
 */
function markShortInlineCode() {
  return (tree: Root) => {
    visit(tree, 'element', (node, _index, parent) => {
      if (node.tagName !== 'code' || (parent && 'tagName' in parent && parent.tagName === 'pre')) return
      let text = ''
      visit(node, 'text', (child) => {
        text += child.value
      })
      if (text.length > 0 && text.length <= SHORT_INLINE_CODE && !/\s/.test(text))
        node.properties = { ...node.properties, dataShort: '' }
    })
  }
}

function normalizeHeadingText() {
  return (tree: Root) => {
    visit(tree, 'element', (heading) => {
      if (!/^h[1-6]$/.test(heading.tagName)) return
      visit(heading, 'text', (node) => {
        node.value = node.value.normalize('NFC')
      })
    })
  }
}

/**
 * For a document that sits under a page which already owns the `h1` (the About page body): a level-1 heading of the Markdown becomes a
 * level-2 one, so the page keeps exactly one `h1`. Runs before the ids are made, so the id (and the table of contents entry) is the
 * same as it would be for the heading as written, and `collectToc` sees it as a level 2.
 */
function demoteTopHeading({ enabled }: { enabled: boolean }) {
  // An options object, not a bare boolean: unified reads `use(plugin, true)` as "no options" and `false` as "plugin off".
  return (tree: Root) => {
    if (!enabled) return
    visit(tree, 'element', (node) => {
      if (node.tagName === 'h1') node.tagName = 'h2'
    })
  }
}

const NO_IMAGES: PreviewImages = new Map()

/**
 * Preview only: the images of a ZIP package, which are not on the site yet, shown from their bytes. The author names an image by a path
 * relative to the article (`assets/a.png`); this maps such a path to a `data:` URL.
 *
 * Runs AFTER sanitize, like figureImages, and that placement is the reason the schema stays narrow: `data:` is never an allowed URL
 * scheme for author input, so a `data:` URL typed into the Markdown is still stripped, and only a URL this plugin wrote reaches the
 * page. A path that names no image of the package is left as written. The `figure` block takes the same map in its own component
 * (`components/site/blocks/AiBlock.tsx`), after it has checked the source as the author wrote it.
 */
function previewImages(images: PreviewImages) {
  return (tree: Root) => {
    if (images.size === 0) return
    visit(tree, 'element', (node) => {
      if (node.tagName !== 'img' || typeof node.properties.src !== 'string') return
      const url = imageFor(images, node.properties.src)
      if (url !== undefined) node.properties.src = url
    })
  }
}

/**
 * Keeps a heading id from shadowing the page. `rehype-slug` makes the ids AFTER the sanitizer, so the `user-content-` prefix does not reach
 * them, and they are left unprefixed on purpose: a link to `#setup` should keep working. Two kinds of slug are not left alone, because
 * an element with that id is also a property of `window` (named access) or an element the page looks up:
 *
 *  - a slug that starts with `_` (github-slugger keeps it): `## __next_f` makes `id="__next_f"`, and Next's `self.__next_f = self.__next_f || []`
 *    then reads the heading instead of `undefined`, throws on `.push`, and the page never hydrates for any visitor;
 *  - a slug equal to a fixed id of the pages (`RESERVED_PAGE_IDS`): `## search q` makes `id="search-q"`, which the "/" shortcut of the
 *    header finds instead of opening the palette.
 *
 * Those get `user-content-` in front, like every other id an author brings. The id is made unique among the ids of the document, because
 * `rehype-slug` only dedupes what it minted. Runs right after `rehype-slug` and before the anchors and the table of contents, which
 * therefore follow the rewritten id. Every other slug is untouched, so the public URL of a heading does not change.
 */
function reserveHeadingIds() {
  const reserved = new Set(RESERVED_PAGE_IDS)
  return (tree: Root) => {
    const used = new Set<string>()
    const headings: Element[] = []
    visit(tree, 'element', (node) => {
      if (typeof node.properties.id === 'string') used.add(node.properties.id)
      if (/^h[1-6]$/.test(node.tagName)) headings.push(node)
    })
    for (const heading of headings) {
      const id = heading.properties.id
      if (typeof id !== 'string' || !(id.startsWith('_') || reserved.has(id))) continue
      let candidate = `${CLOBBER_PREFIX}${id}`
      for (let n = 1; used.has(candidate); n += 1) candidate = `${CLOBBER_PREFIX}${id}-${n}`
      used.add(candidate)
      heading.properties.id = candidate
    }
  }
}

/**
 * Reads the table of contents from the same ids the page renders, which is the whole
 * reason this pipeline hands back a tree rather than a string.
 *
 * Three exclusions, each for something observed rather than imagined:
 *   - `remark-gfm` appends its own `<h2 class="sr-only" id="footnote-label">Footnotes</h2>`
 *     inside a `<section class="footnotes">`, so every post with a footnote grew a
 *     phantom, visually-hidden entry. Matching the section is enough on its own —
 *     checked by removing the alternative, an id comparison, and seeing nothing change.
 *   - `##` on its own is a legal empty heading and yields `id=""`, which the post page
 *     would render as `href="#"`.
 *   - an author writing raw `<h2 id="x">` can collide with a slug `rehype-slug`
 *     generates, because github-slugger only dedupes ids it minted itself. Duplicate
 *     DOM ids are the author's own visible problem; duplicate React keys in the
 *     rendered table of contents would not be, so what is handed out here is unique.
 */
function collectToc(into: TocEntry[]) {
  return (tree: Root) => {
    const seen = new Set<string>()
    visit(tree, 'element', (node, _index, parent) => {
      const match = /^h([2-4])$/.exec(node.tagName)
      if (!match) return
      const id = node.properties?.id
      if (typeof id !== 'string' || id === '') return
      if (parent && parent.type === 'element' && parent.tagName === 'section') {
        const cls = parent.properties?.className
        if (Array.isArray(cls) && cls.includes('footnotes')) return
      }
      if (seen.has(id)) return
      seen.add(id)
      into.push({ depth: Number(match[1]), id, text: toString(node) })
    })
  }
}

/**
 * The start both outputs share: parse (Markdown, GFM, the block directives and their check), the guard on author HTML, and the
 * blocks' own children. One function, so the feed can never run a looser sanitize than the page. The caller adds the image rules
 * (`figureImages`) last: the feed rewrites blocks to plain HTML before them, the page does not.
 *
 * `source` is the text being rendered: the block check measures positions in it, and `run(tree)` has no file to read it from.
 * `problems` receives what is wrong with the block syntax, in line order (the same list `validateBlocks` returns).
 */
function sanitizedPipeline(source: string, problems: Problem[], reading: Reading) {
  // How the article is read was decided before any parser was built (lib/blocks/reading.ts): in full, without the directive syntax (more
  // blocks open at once than the directive parser can read in time, which grows much faster than the text), or as plain text (more work
  // than the parser may be given). The problem that says so is reported with the others.
  problems.push(...reading.problems)
  return unified()
    .use((reading.plain ? plainTextReader : remarkParse) as typeof remarkParse)
    .use(remarkGfm)
    .use(reading.directives ? remarkDirective : skipDirectives)
    .use(remarkBlocks, { source, problems, directives: reading.directives })
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, schema)
    .use(afterSanitize)
    .use(plainPre)
    .use(finishBlocks)
}

/**
 * Runs `attempt` with the way the article is read, and once more as plain text when the parser could not walk the tree to the end.
 * The budget of lib/blocks/parse-budget.ts keeps the TIME of the parse in bounds; the call stack is another limit, and some nesting
 * of raw HTML (thousands of open tags) overflows it before it costs much time. That is a RangeError, which would be a 500 on the
 * page, the preview and the feed; the article is shown as plain text with a problem instead.
 */
async function readOrGiveUp<T>(source: string, attempt: (reading: Reading) => Promise<T>): Promise<T> {
  try {
    return await attempt(readingOf(source))
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
    return attempt(readingOf(source, gaveUp()))
  }
}

/** URL-valued properties the sanitize schema can leave on an element. */
const URL_PROPERTIES = ['href', 'src', 'cite', 'longDesc'] as const

/**
 * A feed reader resolves a relative URL against the feed, not the post, so every link and image becomes absolute. It
 * must run after figureImages: the `#WxH` size hint is only recognised on a `/media/` path.
 */
function absoluteUrls(base: string) {
  return (tree: Root) => {
    visit(tree, 'element', (node: Element) => {
      for (const key of URL_PROPERTIES) {
        const value = node.properties[key]
        if (typeof value !== 'string' || value === '') continue
        try {
          node.properties[key] = new URL(value, base).href
        } catch {
          delete node.properties[key]
        }
      }
    })
  }
}

/**
 * Markdown as an HTML string for an RSS `content:encoded`. Same parse, schema and image rules as the page.
 * It leaves out Shiki (inline styles; a plain `<pre><code class="language-…">` stays portable), heading anchors, the
 * table scroll wrapper and the copy button. Links and images are absolute against `baseUrl`, the post's URL.
 */
export async function renderMarkdownToFeedHtml(markdown: string, baseUrl: string): Promise<string> {
  return readOrGiveUp(markdown, async (reading) => {
    // Blocks become plain HTML first, so the image rules and the absolute URLs reach the images they made.
    const processor = sanitizedPipeline(markdown, [], reading).use(blocksToPlainHtml).use(figureImages).use(absoluteUrls, baseUrl)
    const tree = await processor.run(processor.parse(markdown))
    return toHtml(tree)
  })
}

/**
 * The `ai-block` renderer of a preview with images: the dispatcher, told which images the package holds. The map is set here, after the
 * element's own attributes, so nothing in the Markdown can supply or replace it.
 */
function previewBlock(images: PreviewImages) {
  return function PreviewBlock(attributes: Record<string, unknown>) {
    return <AiBlock {...attributes} images={images} />
  }
}

export type RenderOptions = {
  /**
   * Preview only (the import page): the images of a ZIP package by the path the author wrote, as `data:` URLs. Nothing else in the
   * pipeline changes; the public page, the editor preview and the feed never pass it.
   */
  imageSource?: PreviewImages
  /** A level-1 heading in the Markdown is drawn as a level-2 one; for a body shown under a page title (the About page). */
  demoteTopHeading?: boolean
}

export type RenderedMarkdown = {
  content: ReactNode
  toc: TocEntry[]
  /** What is wrong with the block syntax; the content already shows those blocks as plain content. Empty for an article without blocks. */
  problems: Problem[]
}

export async function renderMarkdown(markdown: string, options: RenderOptions = {}): Promise<RenderedMarkdown> {
  return readOrGiveUp(markdown, (reading) => renderWith(markdown, options, reading))
}

async function renderWith(markdown: string, options: RenderOptions, reading: Reading): Promise<RenderedMarkdown> {
  const toc: TocEntry[] = []
  const problems: Problem[] = []
  const highlighter = await getHighlighter()
  const t = await getTranslations('Site.article')
  const { imageSource, demoteTopHeading: demote = false } = options

  const processor = sanitizedPipeline(markdown, problems, reading)
    .use(figureImages)
    .use(previewImages, imageSource ?? NO_IMAGES)
    .use(scrollableTables, t)
    .use(markShortInlineCode)
    .use(normalizeHeadingText)
    .use(demoteTopHeading, { enabled: demote })
    .use(rehypeSlug)
    .use(reserveHeadingIds)
    .use(rehypeAutolinkHeadings, {
      // `append`, not `wrap`. Wrapping puts the whole heading inside an <a>, so a
      // heading that itself contains a link emits <a><a>…</a></a> — invalid HTML that
      // the browser's parser re-nests into siblings, which means the SSR markup and the
      // client tree differ and React raises a real hydration error and re-renders the
      // subtree on the client. Appending makes the two anchors siblings, which is valid.
      behavior: 'append',
      // aria-hidden, not aria-label. An accessible name on a descendant anchor is folded
      // into the heading's own name, so labelling this made every heading announce as
      // "<heading text>, Link to this section" (the heading text plus the anchor link label) — measured, and it broke
      // getByRole('heading', { name }) in the existing suite. The table of contents
      // already gives assistive tech a labelled route to every section, so this anchor
      // is a pointer affordance: out of the accessibility tree and out of the tab order.
      properties: { className: ['heading-anchor'], ariaHidden: 'true', tabIndex: -1 },
      // No children. Text inside the <a> becomes part of the heading's own textContent,
      // which also appended a stray '#' to every table-of-contents entry. The visible
      // marker is a ::after in globals.css.
      content: [],
    })
    .use(carryCodeMeta)
    .use(
      rehypeShikiFromHighlighter,
      // The plugin declares `HighlighterGeneric<any, any>`, which a core highlighter is
      // not assignable to — `HighlighterGeneric` adds bundled-key overloads on top of
      // `HighlighterCore`, so the declared type is narrower than the plugin's own needs.
      // It calls exactly `codeToHast`, `getLoadedLanguages` and `loadLanguage`, all of
      // which `HighlighterCore` has; the highlighting tests are what prove the runtime
      // contract holds. A `@shikijs/rehype/core` plugin refusing a core highlighter is a
      // typing bug upstream, not a real mismatch.
      //
      // The highlighter is wrapped for THIS article: a fence of long lines took Shiki minutes, so what one article may spend on
      // highlighting is bounded (lib/blocks/highlight-budget.ts). A block past the limits is drawn as plain text, never dropped.
      boundHighlighter(highlighter) as Parameters<typeof rehypeShikiFromHighlighter>[0],
      {
        themes: { light: 'github-light', dark: 'github-dark' },
        // Without this, one code fence in an unlisted language throws and takes the
        // whole page with it.
        fallbackLanguage: 'text',
        // The title and the highlighted lines of a fence (`title="app.py" highlight="2,5-7"`) reach the highlighted `pre` this way:
        // carryCodeMeta puts them on the old `pre` and gives the code a meta text, so Shiki calls this, which takes them off the old `pre`
        // for the transformers below to write on the `pre` and the lines Shiki builds in its place.
        parseMetaString: (_meta: string, pre: Element) => ({
          title: pre.properties.dataTitle,
          highlight: pre.properties.dataHighlight,
        }),
        transformers: [
          {
            name: 'blog-code-meta',
            pre(node) {
              const title = this.options.meta?.title
              if (typeof title === 'string' && title !== '') node.properties.dataTitle = title
              const highlight = this.options.meta?.highlight
              if (typeof highlight === 'string' && highlight !== '') node.properties.dataHighlight = highlight
            },
          },
          {
            // The lines a fence `highlight` names carry `data-highlighted`; the code panel (`components/site/CodeBlock.tsx`) draws them.
            name: 'blog-code-highlight',
            line(node, line) {
              const highlight = this.options.meta?.highlight
              if (typeof highlight !== 'string') return
              const ranges = parseHighlightValue(highlight).ranges
              if (ranges?.some(([start, end]) => line >= start && line <= end)) node.properties.dataHighlighted = ''
            },
          },
          {
            // A `diff` fence: the `pre` says so, and every added or removed line says which, so the code panel can draw them apart and
            // describe them in text. The `+` and `-` stay in the code: colour is never the only sign. The two file header lines
            // (`--- a/x`, `+++ b/x`) and the hunk header (`@@`) are not changes.
            name: 'blog-code-diff',
            pre(node) {
              if (this.options.lang === 'diff') node.properties.dataDiff = ''
            },
            line(node) {
              if (this.options.lang !== 'diff') return
              const text = toString(node)
              if (/^(?:\+\+\+|---)(?:\s|$)/.test(text)) return
              if (text.startsWith('+')) node.properties.dataDiff = 'add'
              else if (text.startsWith('-')) node.properties.dataDiff = 'remove'
            },
          },
        ],
      },
    )
    .use(collectToc, toc)

  // `run`, not `process`. `process` insists on a compiler and there is nothing to
  // compile to — the tree itself is the output, because `toJsxRuntime` takes hast and
  // `collectToc` has to read the same ids the page renders. Faking a compiler that
  // returns the tree is what the first version did, and unified correctly rejects it:
  // a `Compiler` may not return a node. `run` is the documented way to ask for parse
  // plus transform with no stringify step.
  const tree = await processor.run(processor.parse(markdown))

  return {
    // `pre` → CodeBlock: every code block gets its "Copy code" button here, at the last step,
    // rather than as one more hast plugin. A plugin would have to emit the button as markup with
    // no behaviour; the component map is the one place hast becomes React, so the <pre> keeps
    // exactly the props the pipeline built and the button is a real client component beside it.
    // It applies to the admin preview too, which renders through this same function.
    // `ai-block` → AiBlock: the blocks of lib/blocks, drawn by components/site/blocks, for the page, the admin preview and the editor alike.
    content: toJsxRuntime(tree, {
      Fragment,
      jsx,
      jsxs,
      components: {
        pre: CodeBlock,
        [AI_BLOCK_TAG]: imageSource === undefined ? AiBlock : previewBlock(imageSource),
      },
    }),
    toc,
    problems,
  }
}
