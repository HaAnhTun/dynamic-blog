import { useTranslations } from 'next-intl'
import { useId, type ComponentProps } from 'react'
import { parseHighlightValue } from '@/lib/blocks/registry'
import { CopyCodeButton } from './CopyCodeButton'

/**
 * `data-title` is the title of a fence (```python title="app.py"): lib/markdown.tsx writes it on the `<pre>` as the `dataTitle` property
 * and `toJsxRuntime` hands it over as this attribute. `data-highlight` is the checked list of highlighted lines (`2,5-7`) of a fence
 * written with `highlight="2,5-7"`, and `data-diff` marks the `<pre>` of a `diff` fence; the lines themselves carry `data-highlighted`
 * and `data-diff="add|remove"`, set by the transformers of lib/markdown.tsx.
 */
type CodeBlockProps = ComponentProps<'pre'> & { 'data-title'?: string; 'data-highlight'?: string; 'data-diff'?: string }

/**
 * The lines of the code that have a mark (a highlight or a diff change) are drawn as full-width bands that reach over the padding of
 * the `<pre>` (1rem), so the start border sits on the edge of the panel and the text stays where it was. `inline-block` rather than
 * `block`: a block line followed by the line break of the code would add an empty line. A mark is never colour alone: the highlight has
 * its border and a description in text, a diff line keeps its `+` or `-` and the description says what they mean.
 */
const BAND =
  '[&_.line:is([data-highlighted],[data-diff])]:-mx-4 [&_.line:is([data-highlighted],[data-diff])]:inline-block [&_.line:is([data-highlighted],[data-diff])]:min-h-[1lh] [&_.line:is([data-highlighted],[data-diff])]:min-w-[calc(100%+2rem)] [&_.line:is([data-highlighted],[data-diff])]:border-s-[3px] [&_.line:is([data-highlighted],[data-diff])]:border-transparent [&_.line:is([data-highlighted],[data-diff])]:ps-[calc(1rem-3px)] [&_.line:is([data-highlighted],[data-diff])]:pe-4'

/**
 * The colours of the marks. In the dark theme the rules of app/globals.css paint a background on every span of a code block with
 * `!important` (the token spans too, which would cover a band), so the dark band is `!` as well and the tokens inside it give their
 * background up; a layered `!important` beats an unlayered one. A highlight wins over a diff colour on a line that has both.
 */
const HIGHLIGHT =
  '[&_.line[data-highlighted]]:border-brand [&_.line[data-highlighted]]:bg-brand/8 dark:[&_.line[data-highlighted]]:bg-brand/15! dark:[&_.line[data-highlighted]_span]:bg-transparent!'
const DIFF_ADD =
  '[&_.line[data-diff=add]:not([data-highlighted])]:border-green-600 [&_.line[data-diff=add]:not([data-highlighted])]:bg-green-600/6 dark:[&_.line[data-diff=add]:not([data-highlighted])]:border-green-400 dark:[&_.line[data-diff=add]:not([data-highlighted])]:bg-green-400/12! dark:[&_.line[data-diff=add]:not([data-highlighted])_span]:bg-transparent!'
const DIFF_REMOVE =
  '[&_.line[data-diff=remove]:not([data-highlighted])]:border-red-600 [&_.line[data-diff=remove]:not([data-highlighted])]:bg-red-600/6 dark:[&_.line[data-diff=remove]:not([data-highlighted])]:border-red-400 dark:[&_.line[data-diff=remove]:not([data-highlighted])]:bg-red-400/12! dark:[&_.line[data-diff=remove]:not([data-highlighted])_span]:bg-transparent!'

/**
 * The frame of a block that has a title: one border and one rounded corner for the title bar and the code together, so the two read
 * as a single panel. The `<pre>` gives up its own margin, top corners, border and the strip reserved for the copy button (the rules
 * of app/globals.css are out of any layer, so only `!` beats them); the title bar is the strip now, as tall as the button, so the
 * button sits in it and never covers the first line of code. Colours follow the neutral scale of the page in both themes.
 */
const TITLED_FRAME =
  'my-6 rounded-lg border border-neutral-200 dark:border-neutral-800 [&>pre]:m-0 [&>pre]:rounded-t-none! [&>pre]:border-0! [&>pre]:pt-4!'

/** The title bar: 40px on a phone, 32px from 640px (the height of the button, see CopyCodeButton), clear of the button on the right. */
const TITLE_BAR =
  'flex h-10 items-center rounded-t-[calc(0.5rem-1px)] bg-neutral-50 pr-12 pl-4 font-mono text-xs font-medium text-neutral-600 sm:h-8 sm:pr-10 dark:bg-neutral-900 dark:text-neutral-300'

/**
 * Every `<pre>` of a post: lib/markdown.tsx hands this tag to `toJsxRuntime` (`components.pre`), so
 * Shiki code blocks, blocks without a language and a `<pre>` the author typed in HTML all go through here — on the
 * post page and in the admin preview alike, the same pipeline.
 *
 * A server component that only wraps (it reads the catalog and an id for the description, nothing else). The `<pre>` receives the props the pipeline built unchanged (class, Shiki's multi-theme
 * style, `tabIndex` for horizontal keyboard scrolling), nothing added or removed — the tests of
 * lib/markdown.tsx keep its `textContent` exactly as before this frame existed.
 *
 * The frame is `relative` so the button anchors to the top-right corner. Without a title it has no padding, border or own `display`, so
 * the top and bottom margins of the `<pre>` still collapse with the paragraphs around it as before: spacing in the post does not change. The strip
 * reserved for the button sits in the padding-top of the `<pre>` itself (app/globals.css), inside the block's background.
 *
 * With a title (a fence written ```lang title="file.py") a bar with the title goes above the `<pre>` and the frame draws the border, see
 * {@link TITLED_FRAME}. The title is text of the page, not of the code: the button copies the `<pre>` and nothing else.
 *
 * A fence with a highlight or a diff language gets a description for screen readers (`sr-only`, outside the `<pre>`, so the button
 * does not copy it): the highlighted line numbers in words, and what `+` and `-` mean in a diff. The `<pre>` points to it with
 * `aria-describedby`. The marked lines are drawn with the classes {@link BAND}, {@link HIGHLIGHT}, {@link DIFF_ADD} and {@link DIFF_REMOVE}.
 *
 * The button comes AFTER the `<pre>`: Tab reaches the code's scroll frame first, then the button that copies it.
 */
export function CodeBlock(props: CodeBlockProps) {
  const t = useTranslations('Site.code')
  const descriptionId = useId()
  const { 'data-highlight': highlight, 'data-diff': diff, ...preProps } = props
  const title = props['data-title']
  const hasTitle = typeof title === 'string' && title !== ''
  const ranges = typeof highlight === 'string' ? parseHighlightValue(highlight).ranges : undefined
  const sentences: string[] = []
  if (ranges !== undefined) {
    const lines = ranges.map(([start, end]) => (start === end ? String(start) : t('lineRange', { start, end }))).join(', ')
    const count = ranges.reduce((sum, [start, end]) => sum + (end - start + 1), 0)
    sentences.push(t('highlightedLines', { count, lines }))
  }
  if (diff !== undefined) sentences.push(t('diffHint'))
  const described = sentences.length > 0
  const marked = ranges !== undefined || diff !== undefined
  return (
    <div
      data-code-block=""
      className={[
        hasTitle ? `relative ${TITLED_FRAME}` : 'relative',
        marked ? `${BAND} ${HIGHLIGHT} ${DIFF_ADD} ${DIFF_REMOVE}` : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {hasTitle ? (
        <div data-code-title="" className={TITLE_BAR}>
          <span className="truncate">{title}</span>
        </div>
      ) : null}
      {described ? (
        <span id={descriptionId} data-code-description="" className="sr-only">
          {sentences.join(' ')}
        </span>
      ) : null}
      <pre {...preProps} data-highlight={highlight} data-diff={diff} aria-describedby={described ? descriptionId : undefined} />
      <CopyCodeButton />
    </div>
  )
}
