import { useLocale, useTranslations } from 'next-intl'
import { DEFAULT_LOCALE, type Locale } from '@/i18n/config'
import { asLocale, numberFormat } from '@/lib/format'
import type { MediaUsage } from '@/lib/types'
import { META } from './ui'

/*
 * Image storage used versus the quota, at the top of the Images page. The quota is enforced in the backend at
 * upload time (MEDIA_QUOTA_EXCEEDED) but used to be shown nowhere: the admin only found out upon hitting
 * the ceiling — especially when running on Neon, where the README recommends a small quota.
 *
 * No directive, no hook: rendered on the server together with the page.
 */

/** From here the bar turns amber and has a reminder sentence; from `DANGER_AT` it is red. */
const WARN_AT = 0.8
const DANGER_AT = 0.95

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/**
 * Bytes → text, binary units (1 KB = 1024 B) with the decimal separator of the locale. Binary because the quota is a
 * Spring DataSize (`1GB` = 1024³ bytes): a configured "1 GB" shows as exactly "1 GB" on screen.
 */
export function formatBytes(bytes: number, locale: Locale = DEFAULT_LOCALE): string {
  let value = Math.max(0, bytes)
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const number = numberFormat(locale, { maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value)
  return `${number} ${UNITS[unit]}`
}

export type QuotaLevel = 'ok' | 'warn' | 'danger'

export function quotaLevel(ratio: number): QuotaLevel {
  if (ratio >= DANGER_AT) return 'danger'
  if (ratio >= WARN_AT) return 'warn'
  return 'ok'
}

const LOOK: Record<QuotaLevel, { bar: string; text: string }> = {
  ok: { bar: 'bg-slate-700', text: 'text-slate-600' },
  warn: { bar: 'bg-amber-500', text: 'text-amber-800' },
  danger: { bar: 'bg-red-600', text: 'text-red-700' },
}

/**
 * A `role="meter"` bar (percentage value, with a readable sentence via `aria-valuetext`) and the same figure as
 * text right below: color and bar length are never the only information. A div rather than `<meter>`: the browser's
 * native bar looks different everywhere and cannot be colored by threshold.
 *
 * The percentage rounds DOWN — the same side as the color threshold, so there is never "80%" on a bar that has not changed
 * color. Used a little but under 1% shows "under 1%", not "0%". An invalid quota draws nothing.
 */
export function MediaQuotaMeter({ usage }: { usage: MediaUsage }) {
  const locale = asLocale(useLocale())
  const t = useTranslations('Admin.common.quota')
  if (!(usage.maxBytes > 0)) return null
  const ratio = Math.max(0, usage.usedBytes) / usage.maxBytes
  const percent = Math.floor(ratio * 100)
  const percentText = percent === 0 && ratio > 0 ? t('underOnePercent') : `${percent}%`
  const level = quotaLevel(ratio)
  const look = LOOK[level]
  const used = formatBytes(usage.usedBytes, locale)
  const max = formatBytes(usage.maxBytes, locale)

  return (
    <section aria-labelledby="dung-luong-anh" className="mb-8 max-w-md">
      <h2 id="dung-luong-anh" className="text-sm font-medium text-slate-900">
        {t('title')}
      </h2>
      <div
        role="meter"
        aria-labelledby="dung-luong-anh"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(percent, 100)}
        aria-valuetext={t('valueText', { used, max, percent: percentText })}
        className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200"
      >
        <div
          data-testid="quota-bar"
          className={`h-full rounded-full ${look.bar}`}
          style={{ width: `${Math.min(100, ratio * 100)}%` }}
        />
      </div>
      <p className={`mt-2 text-[13px] leading-5 tabular-nums ${look.text}`}>
        {t('usage', { used, max, percent: percentText, count: usage.count })}
      </p>
      <p className={META}>{t('scope')}</p>
      {level !== 'ok' && (
        <p className={`mt-1 text-[13px] leading-5 font-medium ${look.text}`}>{level === 'danger' ? t('danger') : t('warn')}</p>
      )}
    </section>
  )
}
