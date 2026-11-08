'use client'

import { useTranslations } from 'next-intl'
import Image from 'next/image'
import { useId, useRef, useState } from 'react'
import type { SettingsError } from '@/app/admin/(shell)/settings/actions'
import { ACCEPTED_UPLOAD_TYPES, UploadRejectedError, prepareUpload, uploadRejectedMessage } from '@/lib/prepare-upload'
import type { Profile } from '@/lib/site-content-types'
import { isRedirectError } from '../redirect-error'
import { ErrorAlert } from '../primitives'
import { FILE_INPUT, HINT, LABEL, STATUS_TEXT, button } from '../ui'
import { SaveBar, TextField, clean, orNull, useSave, type SaveSection } from './fields'

export type UploadAvatar = (form: FormData) => Promise<{ url: string } | SettingsError>

/**
 * The person (name, role, location, hero) and the avatar. The avatar is uploaded through the media pipeline right away (the backend
 * returns the `/media/...` URL the field accepts) but only becomes part of the profile when the form is saved.
 */
export default function ProfileForm({
  value,
  onSave,
  onUploadAvatar,
}: {
  value: Profile
  onSave: SaveSection
  onUploadAvatar: UploadAvatar
}) {
  const t = useTranslations('Admin.settings.profile')
  const tUpload = useTranslations('Admin.postImages')
  const tSettings = useTranslations('Admin.settings')
  const fileId = useId()
  const fileInput = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(value.name)
  const [role, setRole] = useState(value.role)
  const [location, setLocation] = useState(value.location)
  const [seeking, setSeeking] = useState(value.seeking ?? '')
  const [galleryLead, setGalleryLead] = useState(value.galleryLead ?? '')
  const [greeting, setGreeting] = useState(value.hero.greeting)
  const [headline, setHeadline] = useState(value.hero.headline)
  const [subline, setSubline] = useState(value.hero.subline)
  const [avatar, setAvatar] = useState<string | null>(value.avatar)
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploadNotice, setUploadNotice] = useState('')
  const save = useSave(onSave)

  async function upload() {
    if (file === null || uploading) return
    setUploading(true)
    setUploadError(null)
    setUploadNotice('')
    try {
      let ready: File
      try {
        ready = await prepareUpload(file)
      } catch (caught) {
        if (caught instanceof UploadRejectedError) setUploadError(uploadRejectedMessage(caught, tUpload))
        else setUploadError(tUpload('unreadable'))
        return
      }
      const form = new FormData()
      form.append('file', ready)
      const result = await onUploadAvatar(form)
      if ('error' in result) {
        setUploadError(result.error)
        return
      }
      setAvatar(result.url)
      setUploadNotice(t('avatarUploaded'))
      setFile(null)
      if (fileInput.current !== null) fileInput.current.value = ''
    } catch (caught) {
      if (isRedirectError(caught)) return
      console.error('Avatar upload failed', caught)
      setUploadError(tSettings('errors.unreachable'))
    } finally {
      setUploading(false)
    }
  }

  return (
    <form
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault()
        void save.run({
          name: clean(name),
          location: clean(location),
          role: clean(role),
          seeking: orNull(seeking),
          avatar,
          galleryLead: orNull(galleryLead),
          hero: { greeting: clean(greeting), headline: clean(headline), subline: clean(subline) },
        } satisfies Profile)
      }}
    >
      <fieldset className="space-y-5">
        <legend className="mb-3 text-base font-semibold text-slate-900">{t('personHeading')}</legend>
        <TextField label={t('name')} value={name} onChange={setName} required maxLength={80} />
        <TextField label={t('role')} value={role} onChange={setRole} maxLength={120} />
        <TextField label={t('location')} value={location} onChange={setLocation} maxLength={80} />
        <TextField label={t('seeking')} value={seeking} onChange={setSeeking} rows={2} maxLength={300} hint={t('seekingHint')} />
        <TextField
          label={t('galleryLead')}
          value={galleryLead}
          onChange={setGalleryLead}
          rows={2}
          maxLength={300}
          hint={t('galleryLeadHint')}
        />
      </fieldset>

      <fieldset className="space-y-5">
        <legend className="mb-3 text-base font-semibold text-slate-900">{t('heroHeading')}</legend>
        <TextField label={t('greeting')} value={greeting} onChange={setGreeting} required maxLength={120} />
        <TextField label={t('headline')} value={headline} onChange={setHeadline} required maxLength={200} />
        <TextField label={t('subline')} value={subline} onChange={setSubline} rows={2} maxLength={300} />
      </fieldset>

      <section aria-labelledby={`${fileId}-heading`} className="space-y-3">
        <h3 id={`${fileId}-heading`} className="text-base font-semibold text-slate-900">
          {t('avatarHeading')}
        </h3>
        {avatar !== null ? (
          <div className="flex items-center gap-4">
            <Image
              src={avatar}
              alt=""
              width={96}
              height={96}
              unoptimized
              className="h-24 w-24 rounded-full border border-slate-200 object-cover"
            />
            <button type="button" onClick={() => setAvatar(null)} className={button('danger', 'sm')}>
              {t('avatarRemove')}
            </button>
          </div>
        ) : (
          <p className={STATUS_TEXT}>{t('avatarNone')}</p>
        )}
        <div>
          <label htmlFor={fileId} className={LABEL}>
            {t('avatarFile')}
          </label>
          <input
            ref={fileInput}
            id={fileId}
            type="file"
            accept={ACCEPTED_UPLOAD_TYPES.join(',')}
            aria-describedby={`${fileId}-hint`}
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            className={FILE_INPUT}
          />
          <p id={`${fileId}-hint`} className={HINT}>
            {t('avatarHint')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void upload()}
            disabled={file === null || uploading}
            className={button('secondary')}
          >
            {t('avatarUpload')}
          </button>
          <p role="status" className={STATUS_TEXT}>
            {uploading ? t('avatarUploading') : uploadNotice}
          </p>
        </div>
        {uploadError !== null && <ErrorAlert>{uploadError}</ErrorAlert>}
      </section>

      <SaveBar state={save} />
    </form>
  )
}
