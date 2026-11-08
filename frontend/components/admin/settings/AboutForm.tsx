'use client'

import Image from 'next/image'
import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import { ABOUT_BODY_MAX, type About } from '@/lib/site-content-types'
import { STATUS_TEXT, button } from '../ui'
import {
  RepeatableSection,
  RowFrame,
  SaveBar,
  TextField,
  clean,
  joinParagraphs,
  newRow,
  splitParagraphs,
  toRows,
  useSave,
  type Row,
  type SaveSection,
} from './fields'

type SectionRow = { id: string; title: string; body: string }

const MAX_SECTIONS = 10

/**
 * The about page: an intro, an optional Markdown body (the same Markdown and blocks as an article), a repeatable list of sections
 * (id, title, paragraphs) and the photo. An empty body is left out of the payload: it means none. The photo is only ever brought by
 * a ZIP import, so there is no upload here: the form keeps the stored one (a save never drops it) and can remove it.
 */
export default function AboutForm({ value, onSave }: { value: About; onSave: SaveSection }) {
  const t = useTranslations('Admin.settings.about')
  const [intro, setIntro] = useState(value.intro)
  const [body, setBody] = useState(value.body ?? '')
  const [photo, setPhoto] = useState<string | null>(value.photo ?? null)
  const photoId = useId()
  const [rows, setRows] = useState<Row<SectionRow>[]>(() =>
    toRows(value.sections.map((section) => ({ id: section.id, title: section.title, body: joinParagraphs(section.body) }))),
  )
  const save = useSave(onSave)

  const update = (uid: number, patch: Partial<SectionRow>) =>
    setRows((current) => current.map((row) => (row.uid === uid ? { ...row, value: { ...row.value, ...patch } } : row)))

  return (
    <form
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault()
        void save.run({
          intro: clean(intro),
          // Not `clean()`: line breaks and tabs are the Markdown. Stored as given (NFC), and nothing at all when empty.
          ...(body.trim() === '' ? {} : { body: body.replace(/\s+$/, '').normalize('NFC') }),
          ...(photo === null ? {} : { photo }),
          sections: rows.map(({ value: row }) => ({
            id: clean(row.id),
            title: clean(row.title),
            body: splitParagraphs(row.body).map(clean),
          })),
        } satisfies About)
      }}
    >
      <TextField label={t('intro')} value={intro} onChange={setIntro} rows={3} required maxLength={600} />

      <section aria-labelledby={`${photoId}-heading`} className="space-y-3">
        <h3 id={`${photoId}-heading`} className="text-base font-semibold text-slate-900">
          {t('photoHeading')}
        </h3>
        {photo !== null ? (
          <div className="flex items-center gap-4">
            <Image
              src={photo}
              alt=""
              width={96}
              height={96}
              unoptimized
              className="h-24 w-24 rounded-full border border-slate-200 object-cover"
            />
            <button type="button" onClick={() => setPhoto(null)} className={button('danger', 'sm')}>
              {t('photoRemove')}
            </button>
          </div>
        ) : (
          <p className={STATUS_TEXT}>{t('photoNone')}</p>
        )}
        <p className="text-xs text-slate-500">{t('photoHint')}</p>
      </section>

      <div>
        <TextField
          label={t('body')}
          value={body}
          onChange={setBody}
          rows={16}
          mono
          maxLength={ABOUT_BODY_MAX}
          hint={t('bodyHint')}
        />
        <p className="mt-1 flex flex-wrap items-center justify-between gap-x-4 text-xs text-slate-500">
          <a href="/admin/posts/import/authoring-prompt" download className="underline">
            {t('bodyPrompt')}
          </a>
          <span aria-live="polite">{t('bodyCount', { count: body.length, max: ABOUT_BODY_MAX })}</span>
        </p>
      </div>

      <RepeatableSection
        heading={t('sections')}
        count={rows.length}
        max={MAX_SECTIONS}
        addLabel={t('addSection')}
        onAdd={() => setRows((current) => [...current, newRow({ id: '', title: '', body: '' })])}
      >
        {rows.map((row, index) => (
          <RowFrame
            key={row.uid}
            title={t('sectionTitle', { n: index + 1 })}
            onRemove={() => setRows((current) => current.filter((candidate) => candidate.uid !== row.uid))}
          >
            <TextField
              label={t('sectionId')}
              value={row.value.id}
              onChange={(id) => update(row.uid, { id })}
              mono
              required
              maxLength={40}
              hint={t('sectionIdHint')}
            />
            <TextField
              label={t('sectionHeading')}
              value={row.value.title}
              onChange={(title) => update(row.uid, { title })}
              required
              maxLength={80}
            />
            <TextField
              label={t('sectionBody')}
              value={row.value.body}
              onChange={(body) => update(row.uid, { body })}
              rows={6}
              hint={t('sectionBodyHint')}
            />
          </RowFrame>
        ))}
      </RepeatableSection>

      <SaveBar state={save} />
    </form>
  )
}
