'use client'

import { useFormatter, useLocale, useTranslations } from 'next-intl'
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { isLocale, LOCALES } from '@/i18n/config'
import { getPathname } from '@/i18n/navigation'
import { formatDate } from '@/lib/date'
import { asLocale } from '@/lib/format'
import { formatLocalDateTime } from '@/lib/local-time'
import { isPackageName } from '@/lib/post-import'
import { checkProfileFile } from '@/lib/site-import'
import type { ApplyResult, ImportMode, ImportPreview, ImportStatus, LastImport, UndoResult } from '@/lib/admin-site-import'
import { isRedirectError } from '../../redirect-error'
import { ErrorAlert } from '../../primitives'
import { CARD, H2, INPUT, LABEL, LIST, META, SECTION_DESC, STATUS_TEXT, TEXT_LINK, button } from '../../ui'
import FileDrop from './FileDrop'
import SectionCard from './SectionCard'
import { problemText } from './problem'

/** `stale`: the import on the page is not the undoable one any more (a newer one exists), so the status must be reloaded. */
type Failure = { error: string; stale?: boolean }
export type ProfileImportActions = {
  onPreview: (form: FormData) => Promise<ImportPreview | Failure>
  onApply: (form: FormData) => Promise<ApplyResult | Failure>
  onUndo: (importId: number) => Promise<UndoResult | Failure>
  onStatus: () => Promise<ImportStatus | Failure>
}

const SELECTED_BY_DEFAULT = new Set(['new', 'will_change'])
const MODES: ImportMode[] = ['create-only', 'update']

type Phase = 'idle' | 'previewing' | 'preview' | 'applying' | 'applied'
type UndoPhase = 'idle' | 'confirm' | 'undoing' | 'done'

function subscribeNever(): () => void {
  return () => {}
}

/**
 * The four steps of the profile import in one page: choose a language and get the template, choose the file, read the
 * preview the backend computed, confirm. Nothing is written before the confirm; the backend checks the file again (and its
 * hash) when it applies, so this component only shows and sends.
 *
 * Focus is managed where the focused control goes away: the preview heading takes it when the preview arrives, the Apply button
 * gets it back after a refused apply, the result heading after a successful one, the Cancel button when the undo confirmation opens
 * (and the undo button when it is cancelled), the undo result heading when the undo is done. The headings carry `tabIndex={-1}`.
 *
 * The undo always names the import it shows: the one this page just wrote (`ownId`), otherwise the dated last import of the status.
 * An apply that wrote nothing creates no import, so the dated card and its id stay. After an undo, or one the backend refused
 * because a newer import exists, the status is loaded again so only what the backend would still undo is offered.
 *
 * The time of the last import follows the admin's clock, so it only exists after hydration (the pattern of RevisionsPanel): the
 * server HTML carries the UTC date, then it is replaced, and the server and client snapshots of useSyncExternalStore keep React
 * from reporting a mismatch.
 */
export default function ProfileImport({
  lastImport,
  onPreview,
  onApply,
  onUndo,
  onStatus,
}: { lastImport: LastImport | null } & ProfileImportActions) {
  const t = useTranslations('Admin.settings.profileImport')
  const tPreview = useTranslations('Admin.settings.profileImport.preview')
  const tLocales = useTranslations('Admin.settings.locales')
  const locale = asLocale(useLocale())
  const format = useFormatter()
  const id = useId()
  const request = useRef(0)
  const hydrated = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  )
  const previewHeading = useRef<HTMLHeadingElement>(null)
  const resultHeading = useRef<HTMLHeadingElement>(null)
  const undoHeading = useRef<HTMLHeadingElement>(null)
  const applyButton = useRef<HTMLButtonElement>(null)
  const undoButton = useRef<HTMLButtonElement>(null)
  const undoCancel = useRef<HTMLButtonElement>(null)
  const lastPhase = useRef<Phase>('idle')
  const lastUndoPhase = useRef<UndoPhase>('idle')

  const [language, setLanguage] = useState<string>(LOCALES[0])
  const [file, setFile] = useState<File | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [mode, setMode] = useState<ImportMode>('update')
  const [applied, setApplied] = useState<ApplyResult | null>(null)
  // The last import of the status (loaded with the page, and again after an undo); the dated card describes it.
  const [current, setCurrent] = useState<LastImport | null>(lastImport)
  // The id of an import made on this page that wrote something: newer than `current`, so it is the one to undo and to describe.
  const [ownId, setOwnId] = useState<number | null>(null)
  const [undoPhase, setUndoPhase] = useState<UndoPhase>('idle')
  const [undoError, setUndoError] = useState<string | null>(null)
  const [undone, setUndone] = useState<UndoResult | null>(null)

  const busy = phase === 'previewing' || phase === 'applying' || undoPhase === 'undoing'
  const fileErrors = preview?.errors ?? []
  const headingOf = (sectionId: string | null) => preview?.sections.find((s) => s.id === sectionId)?.heading ?? null
  const languageName = (code: string | null) => (code !== null && isLocale(code) ? tLocales(code) : (code ?? ''))

  useEffect(() => {
    const before = lastPhase.current
    lastPhase.current = phase
    if (phase === 'preview' && before === 'previewing') previewHeading.current?.focus()
    else if (phase === 'preview' && before === 'applying') applyButton.current?.focus()
    else if (phase === 'applied') resultHeading.current?.focus()
  }, [phase])

  useEffect(() => {
    const before = lastUndoPhase.current
    lastUndoPhase.current = undoPhase
    if (undoPhase === 'confirm') undoCancel.current?.focus()
    else if (undoPhase === 'idle' && (before === 'confirm' || before === 'undoing')) undoButton.current?.focus()
    else if (undoPhase === 'done') undoHeading.current?.focus()
  }, [undoPhase])

  function reset() {
    request.current += 1
    setFile(null)
    setPhase('idle')
    setError(null)
    setPreview(null)
    setSelected(new Set())
    setApplied(null)
  }

  async function choose(next: File) {
    // A Markdown file or a ZIP package; the limits are the backend's, the check here only saves a round trip.
    const refusal = checkProfileFile(next)
    if (refusal !== null) {
      reset()
      setError(t(`errors.${refusal}`))
      return
    }

    const mine = ++request.current
    setFile(next)
    setError(null)
    setPreview(null)
    setApplied(null)
    setPhase('previewing')
    try {
      const form = new FormData()
      form.append('file', next)
      const outcome = await onPreview(form)
      if (mine !== request.current) return
      if ('error' in outcome) {
        setError(outcome.error)
        setPhase('idle')
        return
      }
      setPreview(outcome)
      setSelected(new Set(outcome.sections.filter((s) => s.selectable && SELECTED_BY_DEFAULT.has(s.status)).map((s) => s.id)))
      setPhase('preview')
    } catch (caught) {
      if (mine !== request.current || isRedirectError(caught)) return
      console.error('Profile preview failed', caught)
      setError(t('errors.unreachable'))
      setPhase('idle')
    }
  }

  async function apply() {
    if (file === null || preview === null || selected.size === 0 || busy) return
    setPhase('applying')
    setError(null)
    try {
      const form = new FormData()
      form.append('file', file)
      form.append('sha256', preview.sha256)
      form.append('mode', mode)
      for (const section of preview.sections) if (selected.has(section.id)) form.append('sections', section.id)
      const outcome = await onApply(form)
      if ('error' in outcome) {
        setError(outcome.error)
        setPhase('preview')
        return
      }
      setApplied(outcome)
      if (outcome.importId !== null) {
        setOwnId(outcome.importId)
        setUndone(null)
        setUndoPhase('idle')
      }
      setPhase('applied')
    } catch (caught) {
      if (isRedirectError(caught)) return
      console.error('Profile import failed', caught)
      setError(t('errors.unreachable'))
      setPhase('preview')
    }
  }

  /** Loads the status again; a failure leaves nothing to offer rather than an id that may be stale. */
  async function reloadStatus() {
    setOwnId(null)
    try {
      const status = await onStatus()
      setCurrent('error' in status ? null : status.lastImport)
    } catch (caught) {
      if (isRedirectError(caught)) throw caught
      console.error('Profile import status failed', caught)
      setCurrent(null)
    }
  }

  async function undo() {
    if (undoPhase === 'undoing' || undoTarget === null) return
    setUndoPhase('undoing')
    setUndoError(null)
    try {
      const outcome = await onUndo(undoTarget)
      if ('error' in outcome) {
        setUndoError(outcome.error)
        if (outcome.stale === true) {
          // The confirmation named an import that is not the undoable one any more: close it and show the current state.
          await reloadStatus()
          setUndoPhase('idle')
        } else {
          setUndoPhase('confirm')
        }
        return
      }
      setUndone(outcome)
      await reloadStatus()
      setUndoPhase('done')
    } catch (caught) {
      if (isRedirectError(caught)) return
      console.error('Profile undo failed', caught)
      setUndoError(t('errors.unreachable'))
      setUndoPhase('confirm')
    }
  }

  const toggle = (sectionId: string) =>
    setSelected((current) => {
      const next = new Set(current)
      if (!next.delete(sectionId)) next.add(sectionId)
      return next
    })

  const status =
    phase === 'previewing'
      ? t('status.previewing')
      : phase === 'applying'
        ? t('status.applying')
        : undoPhase === 'undoing'
          ? t('status.undoing')
          : undoPhase === 'done'
            ? t('status.undone')
            : phase === 'applied'
              ? t('status.applied')
              : phase === 'preview'
                ? t('status.previewReady')
                : ''

  const canApply =
    phase === 'preview' && preview !== null && selected.size > 0 && fileErrors.length === 0 && preview.locale !== null
  const ignored = preview?.ignored ?? []
  const count = (wanted: string) => applied?.sections.filter((s) => s.status === wanted).length ?? 0
  const when = (iso: string) => (hydrated ? formatLocalDateTime(iso) : formatDate(iso, 'medium', locale)) ?? iso
  const undoTarget = ownId ?? (current?.undoable === true ? current.id : null)
  const undoNamesLast = ownId === null && current !== null

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
          <a href={`/admin/settings/import/template?locale=${language}`} download className={button('secondary')}>
            {t('template.download')}
          </a>
          <a href={`/admin/settings/import/export?locale=${language}`} download className={button('secondary')}>
            {t('template.export')}
          </a>
          <a href={`/admin/settings/import/export?locale=${language}&format=zip`} download className={button('secondary')}>
            {t('template.exportZip')}
          </a>
        </div>
        <p className={`mt-3 ${STATUS_TEXT}`}>{t('template.exportHint')}</p>
      </section>

      <section aria-labelledby={`${id}-b`} className={`p-5 sm:p-6 ${CARD}`}>
        <h2 id={`${id}-b`} className={H2}>
          {t('file.heading')}
        </h2>
        <p className={SECTION_DESC}>{t('file.intro')}</p>
        <div className="mt-4">
          <FileDrop
            errorId={error === null ? undefined : `${id}-error`}
            file={file}
            onFile={(next) => void choose(next)}
            onRemove={reset}
            disabled={phase === 'applying' || undoPhase === 'undoing'}
            accept=".md,.zip,text/markdown,application/zip,application/x-zip-compressed"
          />
        </div>
        {error !== null && (
          <div id={`${id}-error`} className="mt-3">
            <ErrorAlert>{error}</ErrorAlert>
          </div>
        )}
      </section>

      {preview !== null && phase !== 'applied' && (
        <section aria-labelledby={`${id}-c`} className={`p-5 sm:p-6 ${CARD}`}>
          <h2 id={`${id}-c`} ref={previewHeading} tabIndex={-1} className={`${H2} outline-none`}>
            {t('preview.heading')}
          </h2>
          <p className="mt-1 break-words text-sm font-medium text-slate-800">
            {preview.willWriteTo === null
              ? t('preview.noLanguage')
              : t('preview.willWriteTo', { language: languageName(preview.willWriteTo) })}
          </p>
          <p className={`mt-1 ${META}`}>{t('preview.nothingWritten')}</p>
          {file !== null && isPackageName(file.name) && <p className={`mt-1 ${META}`}>{t('preview.packageNote')}</p>}
          {preview.pack != null && (
            <div className="mt-2 space-y-1 text-sm text-slate-700">
              <p>
                {tPreview('package.facts', {
                  assets: preview.pack.assets,
                  kib: format.number(preview.pack.assetBytes / 1024, { maximumFractionDigits: 1 }),
                  used: preview.pack.usedAssets,
                  unused: preview.pack.unusedAssets,
                })}
              </p>
              {preview.pack.unsupportedItems > 0 && (
                <p className="text-red-800">{tPreview('package.unsupported', { count: preview.pack.unsupportedItems })}</p>
              )}
            </div>
          )}
          {(preview.notes ?? []).length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
              {(preview.notes ?? []).map((note, index) => (
                <li key={index} className="break-words">
                  {note.code === 'asset_unused' && note.key !== null
                    ? tPreview('notes.asset_unused', { path: note.key })
                    : tPreview('notes.other')}
                </li>
              ))}
            </ul>
          )}

          {fileErrors.length > 0 && (
            <div className="mt-4">
              <ErrorAlert>{t('preview.fileErrors')}</ErrorAlert>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-red-800">
                {fileErrors.map((problem, index) => (
                  <li key={index} className="break-words">
                    {problemText(problem, headingOf(problem.sectionId), tPreview)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <ul aria-label={t('preview.listLabel')} className={`mt-4 ${LIST}`}>
            {preview.sections.map((section) => (
              <SectionCard
                key={section.id}
                section={section}
                checked={selected.has(section.id)}
                onToggle={toggle}
                disabled={busy}
              />
            ))}
          </ul>

          {preview.ignoredTotal > 0 && (
            <div className="mt-4">
              <h3 className="text-sm font-semibold text-slate-900">
                {t('preview.ignoredHeading', { count: preview.ignoredTotal })}
              </h3>
              <p className={META}>{t('preview.ignoredHint')}</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
                {ignored.map((item, index) => (
                  <li key={index} className="break-words">
                    {t('preview.ignoredItem', { kind: item.kind, name: item.name, line: item.line ?? 0 })}
                  </li>
                ))}
              </ul>
              {preview.ignoredTotal > ignored.length && (
                <p className={`mt-1 ${META}`}>{t('preview.ignoredMore', { count: preview.ignoredTotal - ignored.length })}</p>
              )}
            </div>
          )}

          <fieldset className="mt-6">
            <legend className={LABEL}>{t('mode.legend')}</legend>
            <div className="space-y-3">
              {MODES.map((value) => (
                <div key={value} className="flex items-start gap-2">
                  <input
                    type="radio"
                    name={`${id}-mode`}
                    id={`${id}-mode-${value}`}
                    value={value}
                    checked={mode === value}
                    disabled={busy}
                    aria-describedby={`${id}-mode-${value}-hint`}
                    onChange={() => setMode(value)}
                    className="mt-1 h-4 w-4 shrink-0 accent-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 outline-brand"
                  />
                  <div className="min-w-0">
                    <label htmlFor={`${id}-mode-${value}`} className="text-sm font-medium text-slate-800">
                      {t(`mode.${value}.label`)}
                    </label>
                    <p id={`${id}-mode-${value}-hint`} className={META}>
                      {t(`mode.${value}.hint`)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </fieldset>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button
              ref={applyButton}
              type="button"
              disabled={!canApply || busy}
              onClick={() => void apply()}
              className={button('primary')}
            >
              {t('apply', { count: selected.size })}
            </button>
            {fileErrors.length > 0 && <p className={META}>{t('preview.applyBlocked')}</p>}
          </div>
        </section>
      )}

      {phase === 'applied' && applied !== null && (
        <section aria-labelledby={`${id}-d`} className={`p-5 sm:p-6 ${CARD}`}>
          <h2 id={`${id}-d`} ref={resultHeading} tabIndex={-1} className={`${H2} outline-none`}>
            {t('result.heading')}
          </h2>
          <p className="mt-1 text-sm text-slate-800">
            {t('result.summary', {
              created: count('created'),
              updated: count('updated'),
              unchanged: count('unchanged'),
              skipped: count('skipped'),
            })}
          </p>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-700">
            {applied.sections.map((section) => (
              <li key={section.id} className="break-words">
                {t('result.section', { name: headingOf(section.id) ?? section.id, status: section.status })}
              </li>
            ))}
          </ul>
          <p className="mt-4 text-sm">
            <a
              href={getPathname({ href: '/', locale: isLocale(applied.locale) ? applied.locale : LOCALES[0] })}
              className={TEXT_LINK}
            >
              {t('result.viewSite', { language: languageName(applied.locale) })}
            </a>
          </p>
        </section>
      )}

      {(undoTarget !== null || undone !== null || undoError !== null) && (
        <section aria-labelledby={`${id}-u`} className={`p-5 sm:p-6 ${CARD}`}>
          <h2 id={`${id}-u`} ref={undoHeading} tabIndex={-1} className={`${H2} outline-none`}>
            {t('undo.heading')}
          </h2>
          {undone !== null ? (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
              {undone.sections.map((section) => (
                <li key={section.key}>{t('undo.section', { key: section.key, status: section.status })}</li>
              ))}
            </ul>
          ) : (
            <>
              <p className={SECTION_DESC}>
                {undoTarget === null
                  ? t('undo.none')
                  : undoNamesLast
                    ? t('undo.last', { when: when(current.createdAt), language: languageName(current.locale) })
                    : t('undo.hint')}
              </p>
              {undoTarget !== null && (
                <div className="mt-4">
                  <button
                    ref={undoButton}
                    type="button"
                    disabled={busy}
                    aria-expanded={undoPhase === 'confirm' || undoPhase === 'undoing'}
                    aria-controls={`${id}-confirm`}
                    onClick={() => {
                      setUndoError(null)
                      setUndoPhase('confirm')
                    }}
                    className={button('danger')}
                  >
                    {t('undo.button')}
                  </button>
                </div>
              )}
              <div id={`${id}-confirm`} className="mt-3">
                {(undoPhase === 'confirm' || undoPhase === 'undoing') && (
                  <div className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3">
                    <p className="text-sm text-slate-800">{t('undo.confirmText')}</p>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={undoPhase === 'undoing'}
                        onClick={() => void undo()}
                        className={button('dangerSolid')}
                      >
                        {t('undo.confirm')}
                      </button>
                      <button
                        ref={undoCancel}
                        type="button"
                        disabled={undoPhase === 'undoing'}
                        onClick={() => setUndoPhase('idle')}
                        className={button('secondary')}
                      >
                        {t('undo.cancel')}
                      </button>
                    </div>
                  </div>
                )}
                {undoError !== null && <ErrorAlert className="mt-3">{undoError}</ErrorAlert>}
              </div>
            </>
          )}
        </section>
      )}
    </div>
  )
}
