import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { callBff } = vi.hoisted(() => ({ callBff: vi.fn() }))
vi.mock('@/lib/bff-client', () => ({ callBff }))

import { DEFAULT_LOCALE } from '@/i18n/config'
import { msg } from '@/test/intl'
import NewsletterPage, { generateMetadata } from './page'
import { pageProps } from '@/test/page-props'

const metadata = await generateMetadata(pageProps())

const ADDRESS = 'doc.gia+blog@example.com'

function emailField(): HTMLElement {
  return screen.getByRole('textbox', { name: msg('Site.newsletter.form.emailLabel') })
}

async function submit(value: string) {
  fireEvent.change(emailField(), { target: { value } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: msg('Site.newsletter.form.submit') }))
  })
}

afterEach(() => vi.clearAllMocks())

const EMAIL_INVALID = msg('Site.newsletter.errors.emailInvalid')
const SIGNUP_ACCEPTED = msg('Site.newsletter.form.accepted')

describe('/newsletter', () => {
  it('indexable (no robots declared), canonical /newsletter, through pageMetadata', () => {
    expect(metadata.robots).toBeUndefined()
    expect(metadata.alternates?.canonical).toBe('/newsletter')
    expect(metadata.openGraph?.url).toBe('/newsletter')
    expect(metadata.title).toBe(msg('Site.newsletter.page.title'))
  })

  it('title, labelled email field, and the privacy sentence: what is stored, two steps, unsubscribe link, no tracking, unsubscribing deletes', async () => {
    render(await NewsletterPage(pageProps()))

    expect(screen.getByRole('heading', { level: 1, name: msg('Site.newsletter.page.title') })).toBeInTheDocument()
    expect(emailField()).toHaveAttribute('type', 'email')
    expect(emailField()).toHaveAttribute('autocomplete', 'email')
    const privacy = within(screen.getByRole('region', { name: msg('Site.newsletter.page.privacyHeading') }))
    const items = privacy.getAllByRole('listitem').map((item) => item.textContent)
    expect(items).toEqual([
      msg('Site.newsletter.page.privacyStored'),
      msg('Site.newsletter.page.privacyDoubleOptIn'),
      msg('Site.newsletter.page.privacyUnsubscribeLink'),
      msg('Site.newsletter.page.privacyNoTracking'),
      msg('Site.newsletter.page.privacyDeletion'),
    ])
  })

  it('submit: JSON POST `{ email, locale }` with whitespace trimmed; resubmitting the same address gets the same sentence', async () => {
    callBff.mockResolvedValue({ ok: true, data: { status: 'PENDING_CONFIRMATION' } })
    render(await NewsletterPage(pageProps()))

    await submit(`  ${ADDRESS} `)
    expect(callBff).toHaveBeenCalledExactlyOnceWith('/api/newsletter/subscribe', {
      method: 'POST',
      body: JSON.stringify({ email: ADDRESS, locale: DEFAULT_LOCALE }),
    })
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent(SIGNUP_ACCEPTED)
    const first = status.textContent

    await submit(ADDRESS)
    expect(callBff).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('status').textContent).toBe(first)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each(['', '   ', 'doc.gia', 'doc gia@example.com', '@example.com'])(
    'address %j: reported right at the field, linked through aria-describedby, nothing sent',
    async (value) => {
      render(await NewsletterPage(pageProps()))

      await submit(value)

      const alert = screen.getByRole('alert')
      expect(alert).toHaveTextContent(EMAIL_INVALID)
      expect(emailField()).toHaveAttribute('aria-invalid', 'true')
      expect(emailField()).toHaveAttribute('aria-describedby', alert.id)
      expect(callBff).not.toHaveBeenCalled()
    },
  )

  it.each([
    [400, 'VALIDATION_ERROR', EMAIL_INVALID],
    [429, 'RATE_LIMITED', msg('Site.newsletter.errors.rateLimited')],
    [0, 'NETWORK', msg('Site.profile.author.errors.network')],
    [502, 'UPSTREAM_UNAVAILABLE', msg('Site.profile.author.errors.network')],
  ])('BFF returns %i %s: the matching Vietnamese sentence, no confirmation sentence', async (status, code, message) => {
    callBff.mockResolvedValue({ ok: false, status, code })
    render(await NewsletterPage(pageProps()))

    await submit(ADDRESS)

    expect(screen.getByRole('alert')).toHaveTextContent(message)
    expect(screen.getByRole('status').textContent).toBe('')
  })
})
