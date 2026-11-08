'use client'

import { useTranslations } from 'next-intl'
import { useState } from 'react'
import type { Contact, SocialLink } from '@/lib/site-content-types'
import {
  RepeatableSection,
  RowFrame,
  SaveBar,
  TextField,
  clean,
  newRow,
  orNull,
  toRows,
  useSave,
  type Row,
  type SaveSection,
} from './fields'

const MAX_SOCIAL = 10

/** How to reach the owner: email, GitHub, a short blurb and a repeatable list of other links. */
export default function ContactForm({ value, onSave }: { value: Contact; onSave: SaveSection }) {
  const t = useTranslations('Admin.settings.contact')
  const [email, setEmail] = useState(value.email ?? '')
  const [github, setGithub] = useState(value.github ?? '')
  const [blurb, setBlurb] = useState(value.blurb)
  const [rows, setRows] = useState<Row<SocialLink>[]>(() => toRows(value.social))
  const save = useSave(onSave)

  const update = (uid: number, patch: Partial<SocialLink>) =>
    setRows((current) => current.map((row) => (row.uid === uid ? { ...row, value: { ...row.value, ...patch } } : row)))

  return (
    <form
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault()
        void save.run({
          email: orNull(email),
          github: orNull(github),
          blurb: clean(blurb),
          social: rows.map(({ value: row }) => ({ label: clean(row.label), url: clean(row.url) })),
        } satisfies Contact)
      }}
    >
      <TextField label={t('email')} value={email} onChange={setEmail} type="email" maxLength={120} hint={t('emailHint')} />
      <TextField label={t('github')} value={github} onChange={setGithub} type="url" maxLength={200} hint={t('githubHint')} />
      <TextField label={t('blurb')} value={blurb} onChange={setBlurb} rows={3} maxLength={300} />

      <RepeatableSection
        heading={t('social')}
        count={rows.length}
        max={MAX_SOCIAL}
        addLabel={t('addSocial')}
        onAdd={() => setRows((current) => [...current, newRow({ label: '', url: '' })])}
      >
        {rows.map((row, index) => (
          <RowFrame
            key={row.uid}
            title={t('socialTitle', { n: index + 1 })}
            onRemove={() => setRows((current) => current.filter((candidate) => candidate.uid !== row.uid))}
          >
            <TextField
              label={t('socialLabel')}
              value={row.value.label}
              onChange={(label) => update(row.uid, { label })}
              required
              maxLength={40}
            />
            <TextField
              label={t('socialUrl')}
              value={row.value.url}
              onChange={(url) => update(row.uid, { url })}
              required
              mono
              maxLength={200}
              hint={t('socialUrlHint')}
            />
          </RowFrame>
        ))}
      </RepeatableSection>

      <SaveBar state={save} />
    </form>
  )
}
