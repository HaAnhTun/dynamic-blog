'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { isLocale } from '@/i18n/config'
import type { PostArticleCheck, PostChange, PostFileState, PostImportProblem, PostPreviewFile } from '@/lib/post-import'
import type { Translator } from '@/i18n/translator'
import { ErrorAlert, ToneBadge } from '../../primitives'
import { CHECKBOX, META, WARN_TEXT, button } from '../../ui'

/** The check of the block syntax of one file: waiting for the answer, the answer, or no answer (the call failed). */
export type FileCheck = { status: 'pending' } | { status: 'done'; result: PostArticleCheck } | { status: 'failed' }

/** The article preview of the open file: being prepared, ready to show (the elements the Server Action returned), or failed. */
export type ArticleState =
  | { position: number; status: 'loading' }
  | { position: number; status: 'ready'; node: ReactNode }
  | { position: number; status: 'error'; message: string }

const TONE: Record<PostFileState, string> = {
  new: 'text-emerald-700',
  will_change: 'text-amber-700',
  unchanged: 'text-slate-500',
  error: 'text-red-700',
}

/** The notes the page has a sentence for. The slug sources come from `slugSource`, the names to create from their own lists. */
const NOTE_CODES: readonly string[] = [
  'language_defaulted',
  'category_missing',
  'featured_ignored',
  'status_ignored',
  'translation_of_ignored',
  'asset_unused',
  'series_will_be_created',
  'series_ignored_author',
  'series_title_differs',
  'series_description_ignored',
  'series_description_will_be_set',
  'cover_will_be_set',
  'cover_will_be_replaced',
]
/**
 * Notes that the card shows in a better place (the ignored keys, the names that will be created, the warning for a published post
 * that the page makes from the published_goes_live note) and so leaves out of the list.
 */
const NOTES_SHOWN_ELSEWHERE: readonly string[] = [
  'key_ignored',
  'category_will_be_created',
  'tags_will_be_created',
  'published_goes_live',
]

function ChangeRow({ label, change }: { label: string; change: PostChange }) {
  const t = useTranslations('Admin.posts.import.preview.changes')
  return (
    <li className="break-words">
      <span className="font-medium">{label}</span>
      <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[13px]">
        <dt className="text-slate-500">{t('before')}</dt>
        <dd className="break-words text-slate-700">{change.before ?? t('none')}</dd>
        <dt className="text-slate-500">{t('after')}</dt>
        <dd className="break-words font-medium text-slate-900">{change.after ?? t('none')}</dd>
      </dl>
    </li>
  )
}

function problemText(problem: PostImportProblem, t: Translator): string {
  const where = [problem.line === null ? null : t('lineNumber', { line: problem.line }), problem.key]
    .filter((part): part is string => part !== null && part !== '')
    .join(', ')
  return where === '' ? problem.message : t('problem', { where, message: problem.message })
}

/** The facts of the file's ZIP package: a sentence, and a second one when something in it cannot be used (each such item is also a problem). */
function PackageFacts({ file }: { file: PostPreviewFile }) {
  const t = useTranslations('Admin.posts.import.preview.package')
  const format = useFormatter()
  const pkg = file.pkg
  if (pkg == null) return null
  return (
    <div className="mt-3 space-y-1 text-sm text-slate-700">
      <p>
        {t('facts', {
          assets: pkg.assets,
          kib: format.number(pkg.assetBytes / 1024, { maximumFractionDigits: 1 }),
          used: pkg.usedAssets,
          unused: pkg.unusedAssets,
        })}
      </p>
      {pkg.unsupportedItems > 0 && <p className="text-red-800">{t('unsupported', { count: pkg.unsupportedItems })}</p>}
    </div>
  )
}

/** What the check of the blocks found: how many blocks of each type the article uses (the mistakes are in the problems list). */
function BlockSummary({ check }: { check: FileCheck | undefined }) {
  const t = useTranslations('Admin.posts.import.preview.blocks')
  const format = useFormatter()
  if (check === undefined) return null
  if (check.status === 'pending') return <p className={`mt-3 ${META}`}>{t('checking')}</p>
  if (check.status === 'failed') return <p className={`mt-3 ${WARN_TEXT}`}>{t('failed')}</p>
  const { blocks, problems } = check.result
  // A refused block is not counted, so "no blocks" next to the problem that names it would be wrong: say nothing then.
  if (blocks.length === 0 && problems.length > 0) return null
  return (
    <p className="mt-3 text-sm text-slate-700">
      {blocks.length === 0
        ? t('none')
        : t('summary', { names: format.list(blocks.map((block) => `${block.type} (${block.count})`)) })}
    </p>
  )
}

/**
 * The article of the file as the post page would show it, in a region of its own below the card. The heading takes the focus when
 * the article arrives (like the preview heading of the page): the button that asked for it stays where it is and the content
 * appears below it.
 */
function ArticleRegion({ file, state }: { file: PostPreviewFile; state: ArticleState }) {
  const t = useTranslations('Admin.posts.import.preview.article')
  const tStatus = useTranslations('Admin.posts.import.status')
  const id = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const status = state.status
  useEffect(() => {
    if (status === 'ready') heading.current?.focus()
  }, [status])
  return (
    <section
      aria-labelledby={`${id}-heading`}
      aria-busy={status === 'loading'}
      className="mt-4 overflow-hidden rounded-md border border-slate-200"
    >
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-2">
        <h3 id={`${id}-heading`} ref={heading} tabIndex={-1} className="text-sm font-semibold text-slate-900 outline-none">
          {t('region', { name: file.fileName })}
        </h3>
        <p className={META}>{t('intro')}</p>
      </div>
      {state.status === 'loading' && <p className={`px-4 py-3 ${META}`}>{tStatus('articleLoading')}</p>}
      {state.status === 'error' && (
        <div className="p-4">
          <ErrorAlert>{state.message}</ErrorAlert>
        </div>
      )}
      {state.status === 'ready' && (
        // The links of the article (its category, tags and the links in its text) lead to pages of the site, which would leave this
        // page and lose the preview: they do not open here. A link to a place in the same article (the table of contents) does.
        <div
          className="min-w-0 bg-white"
          onClickCapture={(event) => {
            const href = event.target instanceof Element ? event.target.closest('a')?.getAttribute('href') : null
            if (href != null && !href.startsWith('#')) event.preventDefault()
          }}
        >
          {state.node}
        </div>
      )}
    </section>
  )
}

/**
 * One file of the preview: its state, the slug and language it will get, what changes, what will be created, what to know and what
 * is wrong, and the tick that decides whether it is imported. For a package, the facts of the package; for any file, the blocks it
 * uses and, on request, the article as the post page would show it. The problem messages never repeat a value of the file (they name
 * the file by position and the place by line).
 */
export default function PostFileCard({
  file,
  checked,
  selectable,
  published,
  onToggle,
  disabled,
  check,
  article,
  articleAvailable,
  onToggleArticle,
}: {
  file: PostPreviewFile
  checked: boolean
  selectable: boolean
  /** The post this file would change is published: the change goes live, so it is never ticked on its own. */
  published: boolean
  onToggle: (position: number) => void
  disabled: boolean
  /** The check of the block syntax; undefined for a file that is not checked (it cannot be imported anyway). */
  check?: FileCheck
  /** The article preview when it is open on THIS file, else null. */
  article: ArticleState | null
  /** Whether the backend could read the file, so there is an article to show. */
  articleAvailable: boolean
  onToggleArticle: (position: number) => void
}) {
  const t = useTranslations('Admin.posts.import.preview')
  const tLocales = useTranslations('Admin.settings.locales')
  const format = useFormatter()
  const id = useId()
  const changes = file.state === 'new' || file.state === 'will_change' ? file.changes : null
  const notes = file.notes.filter((note) => !NOTES_SHOWN_ELSEWHERE.includes(note.code))
  const language = file.language === null ? null : isLocale(file.language) ? tLocales(file.language) : file.language

  return (
    <li className="px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-start gap-3">
          <input
            type="checkbox"
            id={`${id}-check`}
            className={`${CHECKBOX} mt-1`}
            checked={checked}
            disabled={disabled || !selectable}
            aria-label={t('select', { name: file.fileName })}
            aria-describedby={`${id}-state`}
            onChange={() => onToggle(file.position)}
          />
          <div className="min-w-0">
            <p className="break-all text-[15px] font-medium text-slate-900">{file.fileName}</p>
            {file.slug !== null && <p className={`break-all ${META}`}>{t('slug', { slug: file.slug })}</p>}
            {language !== null && <p className={META}>{t('language', { language })}</p>}
          </div>
        </div>
        <span id={`${id}-state`}>
          <ToneBadge label={t(`state.${file.state}`)} tone={TONE[file.state]} />
        </span>
      </div>

      {published && <p className={`mt-2 ${WARN_TEXT}`}>{t('published')}</p>}

      <PackageFacts file={file} />
      <BlockSummary check={check} />

      {file.problems.length > 0 && (
        <div className="mt-3">
          <p className="text-[13px] font-medium text-red-800">{t('problemsHeading')}</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-red-800">
            {file.problems.map((problem, index) => (
              <li key={index} className="break-words">
                {problemText(problem, t)}
              </li>
            ))}
          </ul>
          {file.problemsTotal > file.problems.length && (
            <p className={`mt-1 ${META}`}>{t('problemsMore', { count: file.problemsTotal - file.problems.length })}</p>
          )}
        </div>
      )}

      {changes !== null && (
        <ul className="mt-3 space-y-2 text-sm text-slate-800">
          <ChangeRow label={t('changes.title')} change={changes.title} />
          <ChangeRow label={t('changes.description')} change={changes.description} />
          <ChangeRow label={t('changes.category')} change={changes.category} />
          {changes.series !== null && <ChangeRow label={t('changes.series')} change={changes.series} />}
          {changes.seriesPart !== null && (
            <ChangeRow
              label={t('changes.seriesPart')}
              change={{
                before: changes.seriesPart.before === null ? null : String(changes.seriesPart.before),
                after: changes.seriesPart.after === null ? null : String(changes.seriesPart.after),
              }}
            />
          )}
          <li>
            {t('changes.tags', {
              added: format.number(changes.tagsAdded),
              removed: format.number(changes.tagsRemoved),
              kept: format.number(changes.tagsKept),
            })}
          </li>
          <li>{t('changes.content', { differs: changes.contentDiffers ? 'yes' : 'no' })}</li>
          {changes.linkWillBeAdded && <li>{t('changes.link')}</li>}
        </ul>
      )}

      {(file.newCategories.length > 0 || file.newTags.length > 0) && (
        <div className="mt-3 space-y-1 text-sm text-slate-700">
          {file.newCategories.length > 0 && (
            <p className="break-words">{t('newCategories', { names: format.list(file.newCategories) })}</p>
          )}
          {file.newTags.length > 0 && <p className="break-words">{t('newTags', { names: format.list(file.newTags) })}</p>}
        </div>
      )}

      {(notes.length > 0 || file.slugSource !== null) && (
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-700">
          {file.slugSource !== null && (
            <li>{file.slugSource === 'file_name' ? t('notes.slug_from_file_name') : t('notes.slug_from_title')}</li>
          )}
          {notes
            .filter((note) => !note.code.startsWith('slug_from_'))
            .map((note, index) => (
              <li key={`${note.code}:${index}`} className="break-words">
                {NOTE_CODES.includes(note.code) ? t(`notes.${note.code}`, { path: note.key ?? '' }) : t('notes.other')}
              </li>
            ))}
        </ul>
      )}

      {file.ignoredTotal > 0 && (
        <div className="mt-3">
          <p className="text-[13px] font-medium text-slate-700">{t('ignoredHeading', { count: file.ignoredTotal })}</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-700">
            {file.ignored.map((key, index) => (
              <li key={index} className="break-words">
                {key.name === null
                  ? t('ignoredUnnamed', { line: key.line })
                  : t('ignoredNamed', { name: key.name, line: key.line })}
              </li>
            ))}
          </ul>
          {file.ignoredTotal > file.ignored.length && (
            <p className={`mt-1 ${META}`}>{t('ignoredMore', { count: file.ignoredTotal - file.ignored.length })}</p>
          )}
        </div>
      )}

      {articleAvailable && (
        <div className="mt-3">
          <button
            type="button"
            aria-expanded={article !== null}
            aria-controls={article === null ? undefined : `${id}-article`}
            onClick={() => onToggleArticle(file.position)}
            className={button('secondary', 'sm')}
          >
            {article === null ? t('article.show') : t('article.hide')}
          </button>
        </div>
      )}
      {article !== null && (
        <div id={`${id}-article`}>
          <ArticleRegion file={file} state={article} />
        </div>
      )}
    </li>
  )
}
