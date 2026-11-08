'use client'

import { useTranslations } from 'next-intl'
import { useState } from 'react'
import type { SettingsError } from '@/app/admin/(shell)/settings/actions'
import type { SampleContentResult } from '@/lib/admin-sample-content'
import { ErrorAlert } from '../../primitives'
import { isRedirectError } from '../../redirect-error'
import { STATUS_TEXT, button } from '../../ui'

/**
 * The "Load sample content" button and what the last call did. The backend is idempotent, so pressing it again is safe: the
 * summary then says that nothing new was created and how many items were already there.
 */
export default function SampleContentPanel({ onLoad }: { onLoad: () => Promise<SampleContentResult | SettingsError> }) {
  const t = useTranslations('Admin.settings.sampleContent')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<SampleContentResult | null>(null)

  async function load() {
    if (pending) return
    setPending(true)
    setError(null)
    setResult(null)
    try {
      const outcome = await onLoad()
      if ('error' in outcome) {
        setError(outcome.error)
        return
      }
      setResult(outcome)
    } catch (caught) {
      if (isRedirectError(caught)) return
      console.error('Loading the sample content failed', caught)
      setError(t('unreachable'))
    } finally {
      setPending(false)
    }
  }

  const created = result === null ? 0 : result.posts + result.series + result.categories + result.tags

  return (
    <div className="space-y-3">
      {error !== null && <ErrorAlert>{error}</ErrorAlert>}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void load()} disabled={pending} className={button('secondary')}>
          {t('submit')}
        </button>
        <p role="status" className={STATUS_TEXT}>
          {pending ? t('loading') : result === null ? '' : t('done')}
        </p>
      </div>
      {result !== null && (
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
          <li>{created === 0 ? t('nothingNew') : t('created', result)}</li>
          <li>{t('skipped', { skipped: result.skipped })}</li>
        </ul>
      )}
    </div>
  )
}
