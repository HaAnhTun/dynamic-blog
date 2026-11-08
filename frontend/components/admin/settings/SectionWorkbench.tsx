'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useState } from 'react'
import type { SectionSaved, SettingsError } from '@/app/admin/(shell)/settings/actions'
import { dateFormat, asLocale } from '@/lib/format'
import type { RevisionSummary } from '@/lib/admin-site-content'
import type { SiteContentKey, SiteContentPayloads } from '@/lib/site-content-types'
import { isRedirectError } from '../redirect-error'
import { ErrorAlert } from '../primitives'
import { CARD, H2, LIST, META, SECTION_DESC, STATUS_TEXT, button } from '../ui'
import AboutForm from './AboutForm'
import ContactForm from './ContactForm'
import JsonEditor from './JsonEditor'
import ProfileForm, { type UploadAvatar } from './ProfileForm'
import SiteForm from './SiteForm'
import SkillsForm from './SkillsForm'
import TimelineForm from './TimelineForm'
import type { SaveSection } from './fields'

export type SectionWorkbenchProps = {
  sectionKey: SiteContentKey
  /** The values the editor starts from: the saved row, or the packaged default when this language has none. */
  payload: unknown
  revisions: RevisionSummary[]
  onSave: SaveSection
  onRestore: (id: number) => Promise<SectionSaved | SettingsError>
  onUploadAvatar: UploadAvatar
}

/** The dedicated form of a key, or the JSON editor for the keys that have none yet. */
function Editor({
  sectionKey,
  payload,
  onSave,
  onUploadAvatar,
}: Pick<SectionWorkbenchProps, 'sectionKey' | 'payload' | 'onSave' | 'onUploadAvatar'>) {
  switch (sectionKey) {
    case 'site':
      return <SiteForm value={payload as SiteContentPayloads['site']} onSave={onSave} />
    case 'profile':
      return <ProfileForm value={payload as SiteContentPayloads['profile']} onSave={onSave} onUploadAvatar={onUploadAvatar} />
    case 'about':
      return <AboutForm value={payload as SiteContentPayloads['about']} onSave={onSave} />
    case 'contact':
      return <ContactForm value={payload as SiteContentPayloads['contact']} onSave={onSave} />
    case 'skills':
      return <SkillsForm value={(payload as SiteContentPayloads['skills']).groups} onSave={onSave} />
    case 'timeline':
      return <TimelineForm value={payload as SiteContentPayloads['timeline']} onSave={onSave} />
    default:
      return <JsonEditor value={payload} onSave={onSave} />
  }
}

/**
 * The editor of one key plus its history. A restore replaces what the editor shows, so the editor is remounted (new `key`) with
 * the restored values; a save keeps the editor as it is.
 */
export default function SectionWorkbench({
  sectionKey,
  payload,
  revisions,
  onSave,
  onRestore,
  onUploadAvatar,
}: SectionWorkbenchProps) {
  const t = useTranslations('Admin.settings.revisions')
  const locale = asLocale(useLocale())
  const [current, setCurrent] = useState({ payload, version: 0 })
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState('')

  async function restore(id: number) {
    if (pending) return
    setPending(true)
    setError(null)
    setNotice('')
    try {
      const result = await onRestore(id)
      if ('error' in result) {
        setError(result.error)
        return
      }
      setCurrent((previous) => ({ payload: result.payload, version: previous.version + 1 }))
      setNotice(t('restored'))
    } catch (caught) {
      if (isRedirectError(caught)) return
      console.error('Site content restore failed', caught)
      setError(t('unreachable'))
    } finally {
      setPending(false)
    }
  }

  const when = dateFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })
  return (
    <div className="space-y-10">
      <Editor
        key={current.version}
        sectionKey={sectionKey}
        payload={current.payload}
        onSave={onSave}
        onUploadAvatar={onUploadAvatar}
      />

      <section aria-labelledby="settings-revisions" className={`p-5 sm:p-6 ${CARD}`}>
        <h2 id="settings-revisions" className={H2}>
          {t('heading')}
        </h2>
        <p className={SECTION_DESC}>{t('hint')}</p>
        {revisions.length === 0 ? (
          <p className={`mt-4 ${STATUS_TEXT}`}>{t('empty')}</p>
        ) : (
          <ul className={`mt-4 ${LIST}`}>
            {revisions.map((revision) => (
              <li key={revision.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <span className={META}>{when.format(new Date(revision.createdAt))}</span>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => void restore(revision.id)}
                  aria-label={t('restoreAria', { time: when.format(new Date(revision.createdAt)) })}
                  className={button('secondary', 'sm')}
                >
                  {t('restore')}
                </button>
              </li>
            ))}
          </ul>
        )}
        {error !== null && <ErrorAlert className="mt-4">{error}</ErrorAlert>}
        <p role="status" className={`mt-3 ${STATUS_TEXT}`}>
          {notice}
        </p>
      </section>
    </div>
  )
}
