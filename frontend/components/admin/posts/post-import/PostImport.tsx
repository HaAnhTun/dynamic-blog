'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { LOCALES } from '@/i18n/config'
import {
  POST_IMPORT_LIMIT_VALUES,
  checkPostFiles,
  type PostApplyResult,
  type PostArticleCheck,
  type PostImportProblem,
  type PostManifestItem,
  type PostPreview,
  type PostPreviewFile,
} from '@/lib/post-import'
import { isRedirectError } from '../../redirect-error'
import { ErrorAlert } from '../../primitives'
import { CARD, H2, INPUT, LABEL, LIST, META, SECTION_DESC, STATUS_TEXT, TEXT_LINK, button } from '../../ui'
import FilesDrop from './FilesDrop'
import PostFileCard, { type ArticleState, type FileCheck } from './PostFileCard'

/** `stale`: the files or the posts are not what the preview showed, so a new preview is needed. */
type Failure = { error: string; stale?: boolean }
export type PostImportActions = {
  onPreview: (form: FormData) => Promise<PostPreview | Failure>
  onApply: (form: FormData) => Promise<PostApplyResult | Failure>
  /** The block syntax of the article of ONE file (a form with one `file` part): what is wrong and which blocks it uses. */
  onCheck: (form: FormData) => Promise<PostArticleCheck | Failure>
  /** The article of ONE file drawn in the post page's template: React elements made on the server. */
  onArticle: (form: FormData) => Promise<{ article: ReactNode } | Failure>
}

type Phase = 'idle' | 'previewing' | 'preview' | 'applying' | 'applied'

const IMPORTABLE = new Set(['new', 'will_change'])

/**
 * The file as the page shows it: the preview of the backend plus, once the check of the blocks answered, its block mistakes. A file
 * with mistakes in its blocks is an error file like one the backend refused: it is listed with the problems and cannot be ticked.
 */
function withCheck(file: PostPreviewFile, check: FileCheck | undefined): PostPreviewFile {
  if (check?.status !== 'done' || check.result.problemsTotal === 0) return file
  const problems: PostImportProblem[] = check.result.problems.map((problem) => ({
    position: file.position,
    key: problem.block,
    line: problem.line,
    message: problem.message,
  }))
  return {
    ...file,
    state: 'error',
    problems: [...file.problems, ...problems],
    problemsTotal: file.problemsTotal + check.result.problemsTotal,
  }
}

/** Only a file the backend would write can be ticked; unchanged and error files cannot. */
const selectable = (file: PostPreviewFile) => IMPORTABLE.has(file.state) && file.problems.length === 0
/** The backend says so in a note when the change goes live at once: the post it would change is published. */
const goesLive = (file: PostPreviewFile) =>
  file.state === 'will_change' && file.notes.some((note) => note.code === 'published_goes_live')
/** A new post, or a change to a post that is not published, is ticked on its own; a change to a published post never is. */
const tickedByDefault = (file: PostPreviewFile) => selectable(file) && !goesLive(file)

/**
 * The steps of the post import in one page: get the template, choose the files, read the preview the backend computed, tick the
 * files, confirm. Nothing is written before the confirm. The page keeps the chosen files, so the confirm sends the same bytes the
 * preview read, and the backend compares their hashes and the state of the posts again; this component only shows and sends.
 *
 * Focus is managed where the focused control goes away: the preview heading takes it when the preview arrives, the import button
 * gets it back after a refused apply, the "preview again" button after an answer that asks for a new preview, the result heading
 * after a successful apply. The headings carry `tabIndex={-1}`.
 */
export default function PostImport({ onPreview, onApply, onCheck, onArticle }: PostImportActions) {
  const t = useTranslations('Admin.posts.import')
  const tPreview = useTranslations('Admin.posts.import.preview')
  const tResult = useTranslations('Admin.posts.import.result')
  const tLocales = useTranslations('Admin.settings.locales')
  const id = useId()
  const request = useRef(0)
  const previewHeading = useRef<HTMLHeadingElement>(null)
  const resultHeading = useRef<HTMLHeadingElement>(null)
  const applyButton = useRef<HTMLButtonElement>(null)
  const previewAgain = useRef<HTMLButtonElement>(null)
  const lastPhase = useRef<Phase>('idle')

  const [language, setLanguage] = useState<string>(LOCALES[0])
  const [files, setFiles] = useState<File[]>([])
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<PostPreview | null>(null)
  // The positions of the ticked files.
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [applied, setApplied] = useState<PostApplyResult | null>(null)
  // The check of the block syntax of each file that could be imported, by position, and the article preview that is open.
  const [checks, setChecks] = useState<Map<number, FileCheck>>(new Map())
  const [article, setArticle] = useState<ArticleState | null>(null)
  // The articles already drawn, by position, so that opening one again asks the server for nothing. Cleared with the files.
  const drawn = useRef(new Map<number, ReactNode>())

  const checking = [...checks.values()].some((check) => check.status === 'pending')
  const busy = phase === 'previewing' || phase === 'applying'

  useEffect(() => {
    const before = lastPhase.current
    lastPhase.current = phase
    if (phase === 'preview' && before === 'previewing') previewHeading.current?.focus()
    else if (phase === 'preview' && before === 'applying') applyButton.current?.focus()
    else if (phase === 'idle' && before === 'applying') previewAgain.current?.focus()
    else if (phase === 'applied') resultHeading.current?.focus()
  }, [phase])

  function forgetChecks() {
    setChecks(new Map())
    setArticle(null)
    drawn.current = new Map()
  }

  function reset() {
    request.current += 1
    setFiles([])
    setPhase('idle')
    setError(null)
    setPreview(null)
    setSelected(new Set())
    setApplied(null)
    forgetChecks()
  }

  function refuse(refusal: { key: string; position?: number }) {
    reset()
    setError(t(`errors.${refusal.key}`, { ...POST_IMPORT_LIMIT_VALUES, position: refusal.position ?? 0 }))
  }

  /** The form of the requests about ONE file: the same bytes the preview read, nothing else. */
  function oneFile(file: File): FormData {
    const form = new FormData()
    form.append('file', file)
    return form
  }

  /**
   * Checks the block syntax of the articles that could be imported, one file at a time (each call unpacks a package on the server and
   * counts against the import's rate limit, so they are not sent at once). A file with mistakes in its blocks is unticked at once;
   * a call that fails leaves a note on the card and the file as it was, because a block with a mistake only shows as plain text.
   */
  async function runChecks(shown: PostPreview, chosen: File[], mine: number) {
    const targets = shown.files.filter(selectable)
    setChecks(new Map(targets.map((file) => [file.position, { status: 'pending' }])))
    for (const file of targets) {
      let check: FileCheck
      try {
        const chosenFile = chosen[file.position - 1]
        const outcome = chosenFile === undefined ? { error: '' } : await onCheck(oneFile(chosenFile))
        if (mine !== request.current) return
        check = 'error' in outcome ? { status: 'failed' } : { status: 'done', result: outcome }
      } catch (caught) {
        if (mine !== request.current || isRedirectError(caught)) return
        console.error('Post import block check failed', caught)
        check = { status: 'failed' }
      }
      setChecks((current) => new Map(current).set(file.position, check))
      if (check.status === 'done' && check.result.problemsTotal > 0) {
        setSelected((current) => {
          const next = new Set(current)
          next.delete(file.position)
          return next
        })
      }
    }
  }

  /** Opens the article of a file in the post page's template, or closes it when it is the open one. */
  async function toggleArticle(position: number) {
    if (article?.position === position) {
      setArticle(null)
      return
    }
    const cached = drawn.current.get(position)
    if (cached !== undefined) {
      setArticle({ position, status: 'ready', node: cached })
      return
    }
    const mine = request.current
    const chosenFile = files[position - 1]
    if (chosenFile === undefined) return
    setArticle({ position, status: 'loading' })
    try {
      const outcome = await onArticle(oneFile(chosenFile))
      if (mine !== request.current) return
      if ('error' in outcome) {
        showIfWanted(position, { position, status: 'error', message: outcome.error })
        return
      }
      drawn.current.set(position, outcome.article)
      showIfWanted(position, { position, status: 'ready', node: outcome.article })
    } catch (caught) {
      if (mine !== request.current || isRedirectError(caught)) return
      console.error('Post import article preview failed', caught)
      showIfWanted(position, { position, status: 'error', message: tPreview('article.failed') })
    }
  }

  /** Another file may have been opened, or this one closed, while it was being drawn: only a file that is still wanted is shown. */
  function showIfWanted(position: number, next: ArticleState) {
    setArticle((current) => (current?.position === position ? next : current))
  }

  async function runPreview(chosen: File[]) {
    const mine = ++request.current
    setFiles(chosen)
    setError(null)
    setPreview(null)
    setSelected(new Set())
    setApplied(null)
    forgetChecks()
    setPhase('previewing')
    try {
      const form = new FormData()
      for (const file of chosen) form.append('file', file)
      const outcome = await onPreview(form)
      // A newer choice, or a reset, has taken over while the backend was reading: this answer is for files no longer shown.
      if (mine !== request.current) return
      if ('error' in outcome) {
        setError(outcome.error)
        setPhase('idle')
        return
      }
      setPreview(outcome)
      setSelected(new Set(outcome.files.filter(tickedByDefault).map((file) => file.position)))
      setPhase('preview')
      void runChecks(outcome, chosen, mine)
    } catch (caught) {
      if (mine !== request.current || isRedirectError(caught)) return
      console.error('Post import preview failed', caught)
      setError(t('errors.unreachable'))
      setPhase('idle')
    }
  }

  function choose(chosen: File[]) {
    const refusal = checkPostFiles(chosen)
    if (refusal !== null) refuse(refusal)
    else void runPreview(chosen)
  }

  async function apply() {
    if (preview === null || selected.size === 0 || busy || checking) return
    setPhase('applying')
    setError(null)
    try {
      const form = new FormData()
      for (const file of files) form.append('file', file)
      const manifest: PostManifestItem[] = preview.files.map((file) => ({
        sha256: file.sha256,
        selected: selected.has(file.position),
        state: file.previewState,
      }))
      form.append('manifest', JSON.stringify(manifest))
      const outcome = await onApply(form)
      if ('error' in outcome) {
        setError(outcome.error)
        if (outcome.stale === true) {
          // What was previewed is not what the backend has now: the old preview must not be confirmed again.
          setPreview(null)
          setSelected(new Set())
          forgetChecks()
          setPhase('idle')
        } else {
          setPhase('preview')
        }
        return
      }
      setApplied(outcome)
      setPhase('applied')
    } catch (caught) {
      if (isRedirectError(caught)) return
      console.error('Post import failed', caught)
      setError(t('errors.unreachable'))
      setPhase('preview')
    }
  }

  const toggle = (position: number) =>
    setSelected((current) => {
      const next = new Set(current)
      if (!next.delete(position)) next.add(position)
      return next
    })

  const status =
    phase === 'previewing'
      ? t('status.previewing')
      : phase === 'applying'
        ? t('status.applying')
        : phase === 'applied'
          ? t('status.applied')
          : phase === 'preview'
            ? checking
              ? t('status.checking')
              : article?.status === 'loading'
                ? t('status.articleLoading')
                : article?.status === 'ready'
                  ? t('status.articleReady')
                  : t('status.previewReady')
            : ''

  // The files as shown: the backend's preview with the block mistakes of the check merged in (a file with such mistakes is an error file).
  const shownFiles = preview?.files.map((file) => withCheck(file, checks.get(file.position))) ?? []
  const filesWithProblems = shownFiles.filter((file) => file.state === 'error').map((file) => file.position)

  const canApply = phase === 'preview' && preview !== null && selected.size > 0 && !checking
  const count = (wanted: string) => applied?.files.filter((file) => file.result === wanted).length ?? 0
  const nameOf = (file: { position: number; fileName: string }) => file.fileName || (files[file.position - 1]?.name ?? '')

  return (
    <div className="space-y-6">
      <p role="status" aria-live="polite" className={STATUS_TEXT}>
        {status}
      </p>

      <section aria-labelledby={`${id}-a`} className={`p-5 sm:p-6 ${CARD}`}>
        <h2 id={`${id}-a`} className={H2}>
          {t('template.heading')}
        </h2>
        <p className={SECTION_DESC}>{t('template.intro')}</p>
        <div className="mt-4 max-w-xs">
          <label htmlFor={`${id}-language`} className={LABEL}>
            {t('template.language')}
          </label>
          <select id={`${id}-language`} value={language} onChange={(event) => setLanguage(event.target.value)} className={INPUT}>
            {LOCALES.map((code) => (
              <option key={code} value={code}>
                {tLocales(code)}
              </option>
            ))}
          </select>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <a href={`/admin/posts/import/template?locale=${language}`} download className={button('secondary')}>
            {t('template.download')}
          </a>
        </div>
        <p className={`mt-5 ${SECTION_DESC}`}>{t('template.authoringIntro')}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <a href="/admin/posts/import/authoring-prompt" download className={button('secondary')}>
            {t('template.authoringDownload')}
          </a>
        </div>
      </section>

      <section aria-labelledby={`${id}-b`} className={`p-5 sm:p-6 ${CARD}`}>
        <h2 id={`${id}-b`} className={H2}>
          {t('files.heading')}
        </h2>
        <p className={SECTION_DESC}>{t('files.intro', POST_IMPORT_LIMIT_VALUES)}</p>
        <div className="mt-4">
          <FilesDrop
            errorId={error === null ? undefined : `${id}-error`}
            files={files}
            onFiles={choose}
            onRemove={reset}
            disabled={phase === 'applying'}
          />
        </div>
        {error !== null && (
          <div id={`${id}-error`} className="mt-3">
            <ErrorAlert>{error}</ErrorAlert>
          </div>
        )}
        {phase === 'idle' && files.length > 0 && (
          <div className="mt-3">
            <button ref={previewAgain} type="button" onClick={() => void runPreview(files)} className={button('secondary')}>
              {t('files.previewAgain')}
            </button>
          </div>
        )}
      </section>

      {preview !== null && phase !== 'applied' && (
        <section aria-labelledby={`${id}-c`} className={`p-5 sm:p-6 ${CARD}`}>
          <h2 id={`${id}-c`} ref={previewHeading} tabIndex={-1} className={`${H2} outline-none`}>
            {tPreview('heading')}
          </h2>
          <p className={`mt-1 ${META}`}>{tPreview('nothingWritten')}</p>

          {filesWithProblems.length > 0 && (
            <ErrorAlert className="mt-4">{tPreview('filesWithProblems', { count: filesWithProblems.length })}</ErrorAlert>
          )}

          <ul aria-label={tPreview('listLabel')} className={`mt-4 ${LIST}`}>
            {shownFiles.map((file, index) => (
              <PostFileCard
                key={file.position}
                file={file}
                checked={selected.has(file.position)}
                selectable={selectable(file)}
                published={goesLive(file)}
                onToggle={toggle}
                disabled={busy}
                check={checks.get(file.position)}
                article={article?.position === file.position ? article : null}
                // The backend read the file: there is an article to show, whatever the block check found.
                articleAvailable={preview.files[index]!.problems.length === 0 && preview.files[index]!.state !== 'error'}
                onToggleArticle={(position) => void toggleArticle(position)}
              />
            ))}
          </ul>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button
              ref={applyButton}
              type="button"
              disabled={!canApply || busy}
              onClick={() => void apply()}
              className={button('primary')}
            >
              {tPreview('apply', { count: selected.size })}
            </button>
            {selected.size === 0 && <p className={META}>{tPreview('nothingSelected')}</p>}
          </div>
        </section>
      )}

      {phase === 'applied' && applied !== null && (
        <section aria-labelledby={`${id}-d`} className={`p-5 sm:p-6 ${CARD}`}>
          <h2 id={`${id}-d`} ref={resultHeading} tabIndex={-1} className={`${H2} outline-none`}>
            {tResult('heading')}
          </h2>
          <p className="mt-1 text-sm text-slate-800">
            {tResult('summary', {
              created: count('created'),
              updated: count('updated'),
              unchanged: count('unchanged'),
              skipped: count('skipped'),
            })}
          </p>
          <ul className="mt-3 space-y-2 text-sm text-slate-700">
            {applied.files.map((file) => (
              <li key={file.position} className="flex flex-wrap items-baseline gap-x-3 break-words">
                <span>{tResult('file', { name: nameOf(file), status: file.result })}</span>
                {file.postId !== null && (
                  <Link
                    href={`/admin/posts/${file.postId}/edit`}
                    aria-label={tResult('openFor', { name: nameOf(file) })}
                    className={TEXT_LINK}
                  >
                    {tResult('open')}
                  </Link>
                )}
                {/* The saved draft in the article template: what the page will show once the post is published. */}
                {file.postId !== null && (
                  <Link
                    href={`/admin/posts/${file.postId}/preview`}
                    aria-label={tResult('previewFor', { name: nameOf(file) })}
                    className={TEXT_LINK}
                  >
                    {tResult('preview')}
                  </Link>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-4">
            <button type="button" onClick={reset} className={button('secondary')}>
              {tResult('another')}
            </button>
          </div>
        </section>
      )}
    </div>
  )
}
