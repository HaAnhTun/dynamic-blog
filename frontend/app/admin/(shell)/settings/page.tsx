import { getTranslations } from 'next-intl/server'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import AdminOnly from '@/components/admin/AdminOnly'
import ImportForm from '@/components/admin/settings/ImportForm'
import SampleContentPanel from '@/components/admin/settings/sample-content/SampleContentPanel'
import SectionStatus from '@/components/admin/settings/SectionStatus'
import { PageHeader } from '@/components/admin/primitives'
import { CARD, H2, LIST, META, PAGE, SECTION_DESC, TEXT_LINK, button } from '@/components/admin/ui'
import { LOCALES, type Locale } from '@/i18n/config'
import { SessionExpiredError } from '@/lib/admin-api'
import { adminRole } from '@/lib/admin-role'
import { getSiteContentOverview, type SiteContentOverview } from '@/lib/admin-site-content'
import { ApiError } from '@/lib/api'
import { SITE_CONTENT_KEYS } from '@/lib/site-content-types'
import { importDocument, loadSampleContent } from './actions'

export default async function SettingsPage() {
  const t = await getTranslations('Admin.settings')
  const tSections = await getTranslations('Admin.settings.sections')
  if ((await adminRole()) !== 'ADMIN') return <AdminOnly title={t('title')} />

  let overviews: SiteContentOverview[]
  try {
    overviews = await Promise.all(LOCALES.map((locale) => getSiteContentOverview(locale)))
  } catch (error) {
    // Only an expired session goes to the login page; a 403 sent there is a loop.
    if (error instanceof SessionExpiredError) redirect('/admin/login')
    if (error instanceof ApiError && error.status === 403) return <AdminOnly title={t('title')} />
    throw error
  }
  const saved = new Map<Locale, SiteContentOverview['sections']>(LOCALES.map((locale, i) => [locale, overviews[i]!.sections]))
  const { defaultLocale, locales } = overviews[0]!

  return (
    <div className={PAGE}>
      <PageHeader title={t('title')} description={t('description')} />

      <p className={`mb-6 ${META}`}>
        {t('deployment', {
          defaultLocale: t(`locales.${defaultLocale}`),
          enabled: locales.map((l) => t(`locales.${l}`)).join(', '),
        })}
      </p>

      <ul aria-label={t('listLabel')} className={LIST}>
        {SITE_CONTENT_KEYS.map((key) => (
          <li key={key} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <div className="min-w-0">
              <p className="text-[15px] font-medium text-slate-900">{tSections(`${key}.title`)}</p>
              <p className={`mt-0.5 ${META}`}>{tSections(`${key}.description`)}</p>
            </div>
            <ul className="flex flex-wrap items-center gap-x-5 gap-y-2">
              {LOCALES.map((locale) => (
                <li key={locale} className="flex items-center gap-2">
                  <Link
                    href={`/admin/settings/${key}?locale=${locale}`}
                    className={TEXT_LINK}
                    aria-label={t('editAria', { section: tSections(`${key}.title`), language: t(`locales.${locale}`) })}
                  >
                    {t(`locales.${locale}`)}
                  </Link>
                  <SectionStatus saved={saved.get(locale)?.[key] !== undefined} />
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>

      <section aria-labelledby="settings-export" className={`mt-10 p-5 sm:p-6 ${CARD}`}>
        <h2 id="settings-export" className={H2}>
          {t('export.heading')}
        </h2>
        <p className={SECTION_DESC}>{t('export.hint')}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {LOCALES.map((locale) => (
            <a key={locale} href={`/admin/settings/export?locale=${locale}`} download className={button('secondary')}>
              {t('export.download', { language: t(`locales.${locale}`) })}
            </a>
          ))}
        </div>
      </section>

      <section aria-labelledby="settings-profile-import" className={`mt-6 p-5 sm:p-6 ${CARD}`}>
        <h2 id="settings-profile-import" className={H2}>
          {t('profileImport.card.heading')}
        </h2>
        <p className={SECTION_DESC}>{t('profileImport.card.intro')}</p>
        <div className="mt-4">
          <Link href="/admin/settings/import" className={button('secondary')}>
            {t('profileImport.card.open')}
          </Link>
        </div>
      </section>

      <section aria-labelledby="settings-import" className={`mt-6 p-5 sm:p-6 ${CARD}`}>
        <h2 id="settings-import" className={H2}>
          {t('import.heading')}
        </h2>
        <p className={SECTION_DESC}>{t('import.intro')}</p>
        <div className="mt-4 max-w-xl">
          <ImportForm onImport={importDocument} />
        </div>
      </section>

      <section aria-labelledby="settings-sample-content" className={`mt-6 p-5 sm:p-6 ${CARD}`}>
        <h2 id="settings-sample-content" className={H2}>
          {t('sampleContent.heading')}
        </h2>
        <p className={SECTION_DESC}>{t('sampleContent.intro')}</p>
        <div className="mt-4 max-w-xl">
          <SampleContentPanel onLoad={loadSampleContent} />
        </div>
      </section>
    </div>
  )
}
