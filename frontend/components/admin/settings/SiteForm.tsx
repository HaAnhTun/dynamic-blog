'use client'

import { useTranslations } from 'next-intl'
import { useState } from 'react'
import type { SiteData } from '@/lib/site-content-types'
import { SaveBar, TextField, clean, useSave, type SaveSection } from './fields'

/** The brand of the site: name, tagline and positioning (the `site` key). */
export default function SiteForm({ value, onSave }: { value: SiteData; onSave: SaveSection }) {
  const t = useTranslations('Admin.settings.site')
  const [name, setName] = useState(value.name)
  const [tagline, setTagline] = useState(value.tagline)
  const [positioning, setPositioning] = useState(value.positioning)
  const save = useSave(onSave)

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault()
        void save.run({ name: clean(name), tagline: clean(tagline), positioning: clean(positioning) } satisfies SiteData)
      }}
    >
      <TextField label={t('name')} value={name} onChange={setName} required maxLength={80} hint={t('nameHint')} />
      <TextField label={t('tagline')} value={tagline} onChange={setTagline} maxLength={160} hint={t('taglineHint')} />
      <TextField
        label={t('positioning')}
        value={positioning}
        onChange={setPositioning}
        rows={3}
        maxLength={300}
        hint={t('positioningHint')}
      />
      <SaveBar state={save} />
    </form>
  )
}
