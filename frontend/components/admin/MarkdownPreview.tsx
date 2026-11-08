import { getTranslations } from 'next-intl/server'
import { renderMarkdown } from '@/lib/markdown'

/**
 * A server component, and that is the whole design: the preview goes through the exact
 * `renderMarkdown` the public page uses — Shiki, the sanitizer, the heading anchors —
 * instead of a second client-side renderer that would drift from it and would also mean
 * shipping the whole unified pipeline to the browser.
 */
export default async function MarkdownPreview({ markdown }: { markdown: string }) {
  if (markdown.trim() === '') {
    return <p className="text-slate-400">{(await getTranslations('Admin.editor'))('emptyPreview')}</p>
  }
  // Destructured, not rendered whole. `renderMarkdown` returns `{ content, toc, problems }` — it
  // hands back a tree rather than a string so the post page can read its table of
  // contents from the same ids it renders. The plan's `{await renderMarkdown(markdown)}`
  // passes that object to React as a child, which throws
  // "Objects are not valid as a React child". `toc` is deliberately dropped: the preview
  // is checking the body, and the public page's own contents nav is not part of it.
  // `problems` is what the public page cannot show: the block syntax mistakes, each of which the content
  // above already draws as plain text, listed with the line to fix.
  const { content, problems } = await renderMarkdown(markdown)
  const t = await getTranslations('Admin.editor')
  return (
    <>
      {problems.length > 0 ? (
        <section
          aria-label={t('blockProblemsTitle')}
          className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-[13px] leading-5 text-amber-900"
        >
          <h3 className="mb-1 font-semibold">{t('blockProblemsTitle')}</h3>
          <ul className="space-y-1">
            {problems.map((problem, index) => (
              // The same code can repeat on one line; the order is the order in the text.
              <li key={`${problem.line}-${problem.code}-${index}`} className="break-words">
                {t('blockProblemLine', { line: problem.line, message: problem.message })}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <article className="prose prose-slate max-w-none">{content}</article>
    </>
  )
}
