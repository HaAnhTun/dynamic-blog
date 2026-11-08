'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import { LANGUAGE_NAMES } from '@/components/site/language-names'
import { LOCALES, isLocale } from '@/i18n/config'
import type { AdminPostTranslation } from '@/lib/admin-api'
import { ErrorAlert, StatusBadge } from './primitives'
import { isRedirectError } from './redirect-error'
import { FOCUS_RING, HINT, INPUT, LABEL, META, button } from './ui'

/** A saved post of the admin that is not in a translation group yet and can be linked to this one. */
export type TranslationCandidate = { id: string; title: string; language: string }

type Failure = { error: string; sessionExpired?: true }

export type TranslationsPanelProps = {
  /** The language of the post being edited. */
  language: string
  /** The other members of the group; null when the list could not be loaded. */
  translations: AdminPostTranslation[] | null
  /** Posts that could be linked (the page leaves out the post itself and the ones already in a group). */
  candidates: TranslationCandidate[]
  /** Creates a draft in `language` and opens it: the action redirects, so it only returns on error. */
  onCreate: (language: string, slug: string) => Promise<Failure>
  /** null: done. */
  onLink: (otherId: string) => Promise<Failure | null>
  onUnlink: () => Promise<Failure | null>
}

function languageName(language: string): string {
  return isLocale(language) ? LANGUAGE_NAMES[language] : language
}

/**
 * The other languages of this article, in the settings column of the editor of a saved post: the linked posts, a button
 * that creates a draft in a missing language, a way to link an existing post, and unlinking. Outside the post form, so none of
 * these fields is ever sent with Save. Server errors (409 conflicts, a taken slug) show in place, next to the operation.
 */
export default function TranslationsPanel({
  language,
  translations,
  candidates,
  onCreate,
  onLink,
  onUnlink,
}: TranslationsPanelProps) {
  const t = useTranslations('Admin.posts.translations')
  const tErrors = useTranslations('Errors.admin')
  const id = useId()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [createLanguage, setCreateLanguage] = useState('')
  const [slug, setSlug] = useState('')
  const [otherId, setOtherId] = useState('')

  const members = translations ?? []
  const taken = new Set([language, ...members.map((member) => member.language)])
  const missing = LOCALES.filter((locale) => !taken.has(locale))
  const linkable = candidates.filter((candidate) => !taken.has(candidate.language))
  const chosenLanguage = missing.find((locale) => locale === createLanguage) ?? missing[0]

  /** Runs one operation. A redirect rejection is the success of "create": the router is already navigating. */
  async function run(operation: () => Promise<Failure | null>) {
    if (pending) return
    setError(null)
    setPending(true)
    try {
      const failure = await operation()
      if (failure !== null) setError(failure.error)
    } catch (caught) {
      if (isRedirectError(caught)) return
      console.error('Translation action failed', caught)
      setError(tErrors('unreachable'))
    } finally {
      setPending(false)
    }
  }

  return (
    <section aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`} className={LABEL}>
        {t('heading')}
      </h3>
      <p className={HINT}>{t('hint', { language: languageName(language) })}</p>

      {translations === null ? (
        <p className={`${META} mt-2`}>{t('loadFailed')}</p>
      ) : members.length === 0 ? (
        <p className={`${META} mt-2`}>{t('none')}</p>
      ) : (
        <ul aria-label={t('listLabel')} className="mt-2 space-y-2">
          {members.map((member) => (
            <li key={member.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-5 text-slate-700">
              <span className="font-medium text-slate-900">{languageName(member.language)}</span>
              <StatusBadge status={member.status} />
              <Link
                href={`/admin/posts/${encodeURIComponent(member.id)}/edit`}
                className={`min-w-0 rounded-sm break-words underline decoration-slate-300 underline-offset-4 hover:text-slate-900 ${FOCUS_RING}`}
              >
                {member.title}
                <span className="sr-only"> ({t('edit')})</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {missing.length > 0 && (
        <form
          className="mt-4 space-y-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (chosenLanguage === undefined) return
            void run(() => onCreate(chosenLanguage, slug))
          }}
        >
          <label htmlFor={`${id}-create-language`} className={LABEL}>
            {t('createLanguage')}
          </label>
          <select
            id={`${id}-create-language`}
            value={chosenLanguage}
            disabled={pending}
            onChange={(event) => setCreateLanguage(event.target.value)}
            className={INPUT}
          >
            {missing.map((locale) => (
              <option key={locale} value={locale} lang={locale}>
                {LANGUAGE_NAMES[locale]}
              </option>
            ))}
          </select>
          <label htmlFor={`${id}-create-slug`} className={LABEL}>
            {t('createSlug')} <span className="font-normal text-slate-500">{t('optional')}</span>
          </label>
          <input
            id={`${id}-create-slug`}
            value={slug}
            maxLength={255}
            disabled={pending}
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => setSlug(event.target.value)}
            aria-describedby={`${id}-create-hint`}
            className={INPUT}
          />
          <p id={`${id}-create-hint`} className={HINT}>
            {t('createHint')}
          </p>
          <button type="submit" disabled={pending} className={button('secondary', 'sm')}>
            {t('create')}
          </button>
        </form>
      )}

      {missing.length > 0 && linkable.length > 0 && (
        <form
          className="mt-4 space-y-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (otherId === '') return
            void run(async () => {
              const failure = await onLink(otherId)
              if (failure === null) setOtherId('')
              return failure
            })
          }}
        >
          <label htmlFor={`${id}-link`} className={LABEL}>
            {t('linkLabel')}
          </label>
          <select
            id={`${id}-link`}
            value={otherId}
            disabled={pending}
            onChange={(event) => setOtherId(event.target.value)}
            className={INPUT}
          >
            <option value="">{t('linkPlaceholder')}</option>
            {linkable.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {t('linkOption', { title: candidate.title, language: languageName(candidate.language) })}
              </option>
            ))}
          </select>
          <button type="submit" disabled={pending || otherId === ''} className={button('secondary', 'sm')}>
            {t('link')}
          </button>
        </form>
      )}

      {members.length > 0 && (
        <div className="mt-4">
          <button type="button" disabled={pending} onClick={() => void run(onUnlink)} className={button('ghost', 'sm')}>
            {t('unlink')}
          </button>
          <p className={HINT}>{t('unlinkHint')}</p>
        </div>
      )}

      {error !== null && <ErrorAlert className="mt-3">{error}</ErrorAlert>}
    </section>
  )
}
