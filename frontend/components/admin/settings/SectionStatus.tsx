import { useTranslations } from 'next-intl'
import { ToneBadge } from '../primitives'

/** "Saved" or "missing translation" for one key in one language (a missing row shows the packaged default or the default language). */
export default function SectionStatus({ saved }: { saved: boolean }) {
  const t = useTranslations('Admin.settings.status')
  return saved ? (
    <ToneBadge label={t('saved')} tone="text-emerald-700" />
  ) : (
    <ToneBadge label={t('missing')} tone="text-amber-700" />
  )
}
