import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@/lib/session-client'
import type { AuthorApplication, MyAuthorApplication, UserRole } from '@/lib/types'

const { session, callBff, setAnonymous } = vi.hoisted(() => ({
  session: { current: { status: 'loading' } as Session },
  callBff: vi.fn(),
  setAnonymous: vi.fn(),
}))
vi.mock('@/lib/session-client', () => ({ useSession: () => session.current, setAnonymous }))
vi.mock('@/lib/bff-client', () => ({ callBff }))

import { AuthorApplicationSection } from './AuthorApplication'
import { REAPPLY_DATE_TEXT, SENT_DATE_TEXT } from '@/test/fixtures/vi/author-application'
import { msg } from '@/test/render-intl'

/** A catalog message with its rich tags unwrapped to their content. */
const plain = (key: string, args: Record<string, unknown> = {}): string =>
  msg(key, { ...args, admin: (c: string) => c, time: (c: string) => c, optional: (c: string) => c } as never)

/** The content of one rich tag of a catalog message. */
const tagContent = (key: string, tag: string): string =>
  new RegExp(`<${tag}>(.*)</${tag}>`).exec(msg(key, { [tag]: (c: string) => `<${tag}>${c}</${tag}>` } as never))![1]!

/** A pattern that matches exactly the given text. */
const exact = (text: string): RegExp => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)

const API = '/api/me/author-application'

function signedIn(role: UserRole = 'USER') {
  session.current = {
    status: 'authenticated',
    user: {
      displayName: 'Octo Cat',
      githubLogin: 'octocat',
      avatarUrl: null,
      role,
      joinedAt: '2026-01-01T00:00:00Z',
      canAccessAdmin: role === 'ADMIN',
    },
  }
}

const application = (over: Partial<AuthorApplication> = {}): AuthorApplication => ({
  id: 'a1',
  status: 'PENDING',
  motivation: null,
  createdAt: '2026-10-08T03:00:00Z',
  decidedAt: null,
  ...over,
})

/** The answer of the GET (callBff already unwrapped the `{ data }` envelope). */
function serverSays(over: Partial<MyAuthorApplication> = {}) {
  callBff.mockResolvedValueOnce({ ok: true, data: { application: null, canApply: true, reapplyAfter: null, ...over } })
}

async function renderSection() {
  let view!: ReturnType<typeof render>
  await act(async () => {
    view = render(<AuthorApplicationSection />)
  })
  return view
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element)
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(() => {
  vi.clearAllMocks()
  session.current = { status: 'loading' }
})

describe('/profile: author application', () => {
  it('guest and while the session is being asked: nothing, no backend call', async () => {
    await renderSection()
    session.current = { status: 'anonymous', loggedOut: false }
    await renderSection()

    expect(screen.queryByRole('heading', { name: msg('Site.profile.author.heading') })).toBeNull()
    expect(callBff).not.toHaveBeenCalled()
  })

  it('author and admin: one line instead of the form, no backend call', async () => {
    signedIn('AUTHOR')
    await renderSection()

    expect(screen.getByRole('heading', { level: 2, name: msg('Site.profile.author.heading') })).toBeInTheDocument()
    expect(screen.getByText(new RegExp(plain('Site.profile.author.authorNote').split(':')[0]!))).toBeInTheDocument()
    expect(screen.getByRole('link', { name: tagContent('Site.profile.author.authorNote', 'admin') })).toHaveAttribute(
      'href',
      '/admin',
    )
    expect(screen.queryByRole('textbox')).toBeNull()

    signedIn('ADMIN')
    await renderSection()
    expect(screen.getByText(new RegExp(msg('Site.profile.author.adminNote').split(':')[0]!))).toBeInTheDocument()
    expect(callBff).not.toHaveBeenCalled()
  })

  it('can submit: form with label, hint, counter, at most 500 characters; sends the trimmed reason, once even when clicked twice', async () => {
    signedIn()
    serverSays()
    await renderSection()

    expect(callBff).toHaveBeenCalledExactlyOnceWith(API)
    const field = screen.getByRole('textbox', { name: plain('Site.profile.author.form.motivationLabel') })
    expect(field).toHaveAttribute('maxlength', '500')
    expect(field).toHaveAccessibleDescription(expect.stringContaining(`${msg('Site.profile.author.form.hint')} 0/500`))

    fireEvent.change(field, { target: { value: '  Writing Go  ' } })
    expect(screen.getByText('14/500')).toBeInTheDocument()

    const answer = deferred<unknown>()
    callBff.mockReturnValueOnce(answer.promise)
    const submit = screen.getByRole('button', { name: msg('Site.profile.author.form.submit') })
    submit.focus()
    await click(submit)
    await click(submit)
    expect(submit).toHaveTextContent(msg('Site.profile.author.form.sending'))
    expect(submit).toHaveAttribute('aria-disabled', 'true')
    expect(field).toHaveAttribute('readonly')

    await act(async () => answer.resolve({ ok: true, data: application({ motivation: 'Writing Go' }) }))

    expect(callBff).toHaveBeenCalledTimes(2)
    expect(callBff).toHaveBeenLastCalledWith(API, { method: 'POST', body: JSON.stringify({ motivation: 'Writing Go' }) })
    // The form goes together with the button just clicked: focus moves to the result sentence, not back to <body>.
    expect(screen.queryByRole('textbox')).toBeNull()
    const status = screen.getByText(msg('Site.profile.author.status.pending.title')).parentElement!
    expect(status).toHaveFocus()
    expect(status).toHaveTextContent(plain('Site.profile.author.status.pending.sent', { date: SENT_DATE_TEXT }))
  })

  it.each([
    ['AUTHOR_APPLICATION_COOLDOWN', 409, exact(msg('Site.profile.author.errors.cooldown'))],
    ['AUTHOR_APPLICATION_PENDING', 409, exact(msg('Site.profile.author.errors.pending'))],
    ['RATE_LIMITED', 429, exact(msg('Site.profile.author.errors.rateLimited'))],
    ['USER_SUSPENDED', 403, exact(msg('Site.profile.author.errors.suspended'))],
    ['UPSTREAM_UNAVAILABLE', 502, exact(msg('Site.profile.author.errors.network'))],
  ])('empty reason sends null; %s (%i): Vietnamese sentence in place, form stays intact', async (code, status, expected) => {
    signedIn()
    serverSays()
    await renderSection()
    callBff.mockResolvedValueOnce({ ok: false, status, code })

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } })
    await click(screen.getByRole('button', { name: msg('Site.profile.author.form.submit') }))

    expect(callBff).toHaveBeenLastCalledWith(API, { method: 'POST', body: JSON.stringify({ motivation: null }) })
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(expected)
    expect(screen.getByRole('textbox').getAttribute('aria-describedby')).toContain(alert.id)
    expect(screen.getByRole('button', { name: msg('Site.profile.author.form.submit') })).not.toHaveAttribute('aria-disabled')
  })

  it('pending review: no form; own reason shown as plain text', async () => {
    signedIn()
    serverSays({ application: application({ motivation: '<b>Go</b> and\nPostgres' }), canApply: false })
    await renderSection()

    expect(screen.getByText(msg('Site.profile.author.status.pending.title'))).toBeInTheDocument()
    expect(screen.getByText(/<b>Go<\/b> and/)).toBeInTheDocument()
    expect(document.querySelector('b')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('approved: says to sign in again, no form', async () => {
    signedIn()
    serverSays({ application: application({ status: 'APPROVED', decidedAt: '2026-10-09T00:00:00Z' }), canApply: false })
    await renderSection()

    expect(screen.getByText(msg('Site.profile.author.status.approved.title'))).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('rejected: during the waiting period the date to reapply (reader local time), no form; after the waiting period there is the form', async () => {
    signedIn()
    const rejected = application({ status: 'REJECTED', decidedAt: '2026-10-10T20:00:00Z' })
    serverSays({ application: rejected, canApply: false, reapplyAfter: '2026-11-09T20:00:00Z' })
    const waiting = await renderSection()

    expect(screen.getByText(msg('Site.profile.author.status.rejected.title'))).toBeInTheDocument()
    // 20:00 UTC is 03:00 the next day in Vietnam (the TZ of the test suite): printing the UTC date promises seven hours too early.
    const deadline = screen.getByText(msg('Site.profile.author.deadline', { time: '03:00', date: REAPPLY_DATE_TEXT }))
    expect(deadline.tagName).toBe('TIME')
    expect(deadline).toHaveAttribute('datetime', '2026-11-09T20:00:00Z')
    expect(deadline.parentElement).toHaveTextContent(
      plain('Site.profile.author.status.rejected.reapplyFrom', {
        deadline: msg('Site.profile.author.deadline', { time: '03:00', date: REAPPLY_DATE_TEXT }),
      }),
    )
    expect(screen.queryByRole('textbox')).toBeNull()

    waiting.unmount()
    serverSays({ application: rejected, canApply: true })
    await renderSection()
    expect(screen.getByText(msg('Site.profile.author.status.rejected.titleCanApply'))).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('load failure: in-place sentence and "Try again"; a dead session (401) sends the whole page back to the guest view', async () => {
    signedIn()
    callBff.mockResolvedValueOnce({ ok: false, status: 502, code: 'UPSTREAM_UNAVAILABLE' })
    await renderSection()

    expect(screen.getByText(msg('Site.profile.author.loadFailed'))).toBeInTheDocument()
    serverSays()
    await click(screen.getByRole('button', { name: msg('Site.profile.author.retry') }))
    expect(screen.getByRole('textbox')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: msg('Site.profile.author.heading') })).toHaveFocus()

    callBff.mockResolvedValueOnce({ ok: false, status: 401, code: 'UNAUTHENTICATED' })
    await renderSection()
    expect(setAnonymous).toHaveBeenCalledTimes(1)
  })
})
