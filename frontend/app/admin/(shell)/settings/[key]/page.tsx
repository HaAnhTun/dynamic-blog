import { getTranslations } from 'next-intl/server'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import AdminOnly from '@/components/admin/AdminOnly'
import SectionStatus from '@/components/admin/settings/SectionStatus'
import SectionWorkbench from '@/components/admin/settings/SectionWorkbench'
import { PageHeader } from '@/components/admin/primitives'
import { defaultPayload } from '@/content/defaults'
import { CARD, META, PAGE, STATUS_TEXT, TEXT_LINK } from '@/components/admin/ui'
import { DEFAULT_LOCALE, LOCALES, isLocale } from '@/i18n/config'
import { SessionExpiredError } from '@/lib/admin-api'
import { adminRole } from '@/lib/admin-role'
import { getSectionRow, listRevisions } from '@/lib/admin-site-content'
import { ApiError } from '@/lib/api'
import { SITE_CONTENT_KEYS, type SiteContentKey } from '@/lib/site-content-types'
import { restoreRevision, saveSection, uploadAvatar } from '../actions'

const isKey = (value: string): value is SiteContentKey => (SITE_CONTENT_KEYS as readonly string[]).includes(value)

export default async function SettingsSectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>
  searchParams: Promise<{ locale?: string | string[] }>
}) {
  const t = await getTranslations('Admin.settings')
  const tSections = await getTranslations('Admin.settings.sections')
  if ((await adminRole()) !== 'ADMIN') return <AdminOnly title={t('title')} />
  const { key } = await params
  if (!isKey(key)) notFound()
  const requested = (await searchParams).locale
  const locale = isLocale(requested) ? requested : DEFAULT_LOCALE
  const other = LOCALES.find((candidate) => candidate !== locale) ?? locale

  let row, otherRow, revisions
  try {
    ;[row, otherRow] = await Promise.all([getSectionRow(key, locale), getSectionRow(key, other)])
    revisions = row === null ? [] : await listRevisions(key, locale)
  } catch (error) {
    if (error instanceof SessionExpiredError) redirect('/admin/login')
    if (error instanceof ApiError && error.status === 403) return <AdminOnly title={t('title')} />
    throw error
  }

  async function onSave(payload: unknown) {
    'use server'
    return saveSection(key, locale, payload)
  }
  async function onRestore(id: number) {
    'use server'
    return restoreRevision(key, locale, id)
  }

  return (
    <div className={PAGE}>
      <PageHeader
        back={{ href: '/admin/settings', label: t('allSettings') }}
        title={tSections(`${key}.title`)}
        description={tSections(`${key}.description`)}
      />

      <nav aria-label={t('languageSwitch')} className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2">
        {LOCALES.map((candidate) => (
          <span key={candidate} className="flex items-center gap-2">
            {candidate === locale ? (
              <span aria-current="page" className="text-sm font-semibold text-slate-900">
                {t(`locales.${candidate}`)}
              </span>
            ) : (
              <Link href={`/admin/settings/${key}?locale=${candidate}`} className={TEXT_LINK}>
                {t(`locales.${candidate}`)}
              </Link>
            )}
            <SectionStatus saved={candidate === locale ? row !== null : otherRow !== null} />
          </span>
        ))}
      </nav>

      {row === null && <p className={`mb-4 ${STATUS_TEXT}`}>{t('notSaved')}</p>}

      <details className={`mb-8 p-4 ${CARD}`}>
        <summary className="cursor-pointer text-sm font-medium text-slate-800">
          {t('otherLanguage', { language: t(`locales.${other}`) })}
        </summary>
        {otherRow === null ? (
          <p className={`mt-3 ${META}`}>{t('otherMissing')}</p>
        ) : (
          <pre className="mt-3 max-h-96 overflow-auto rounded-md bg-slate-50 p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-slate-800">
            {JSON.stringify(otherRow.payload, null, 2)}
          </pre>
        )}
      </details>

      <SectionWorkbench
        key={`${key}-${locale}`}
        sectionKey={key}
        payload={row?.payload ?? defaultPayload(locale, key)}
        revisions={revisions}
        onSave={onSave}
        onRestore={onRestore}
        onUploadAvatar={uploadAvatar}
      />
    </div>
  )
}
