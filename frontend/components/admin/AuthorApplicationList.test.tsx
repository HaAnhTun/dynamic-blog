import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AdminAuthorApplication, AuthorApplicant } from '@/lib/types'
import AuthorApplicationList from './AuthorApplicationList'
import { createTranslator } from 'next-intl'
import { msg } from '@/test/render-intl'
import { CATALOGS } from '@/test/intl'
import {
  APPLICANT_NAME,
  APPLICANT_NAME_LOWER_CASE,
  APPLICANT_NAME_TYPED,
  DECIDED_DATE_TEXT,
  SUBMITTED_DATE_TEXT,
} from '@/test/fixtures/vi/adminUnit-author-application-list'

// The reload-list button (StaleListNotice) is router.refresh(): here we only need to know it was called.
const router = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => router,
}))

const onApprove = vi.fn()
const onReject = vi.fn()

afterEach(() => vi.clearAllMocks())

const listText = createTranslator({
  locale: 'vi',
  messages: CATALOGS.vi as never,
  namespace: 'Admin.applications.list' as never,
}) as unknown as { markup: (key: string, values?: Record<string, unknown>) => string }

/** A catalog message that carries markup (`<strong>`, `<bdi>`, `<b>`, `<date>`), as plain text: the tags are dropped. */
const plain = (key: string, values: Record<string, unknown> = {}) =>
  listText.markup(key, { strong: (c: string) => c, bdi: (c: string) => c, b: (c: string) => c, date: () => '', ...values })

const approveName = (handle: string) =>
  `${msg('Admin.applications.list.approve')} ${msg('Admin.applications.list.ofApplicant', { handle })}`
const rejectName = (handle: string) =>
  `${msg('Admin.applications.list.reject')} ${msg('Admin.applications.list.ofApplicant', { handle })}`
const endsWith = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\]]/g, '\\$&') + '$')
const PENDING_LABEL = msg('Admin.applications.listLabel', {
  status: msg('Admin.statuses.application.PENDING').toLowerCase(),
  page: '1',
  totalPages: '1',
})

const SELF = '99999999-9999-9999-9999-999999999999'
const ID = '11111111-1111-1111-1111-111111111111'

const applicant = (over: Partial<AuthorApplicant> = {}): AuthorApplicant => ({
  id: '22222222-2222-2222-2222-222222222222',
  displayName: 'Octo Cat',
  githubLogin: 'octocat',
  avatarUrl: null,
  role: 'USER',
  status: 'ACTIVE',
  ...over,
})

const application = (over: Partial<AdminAuthorApplication> = {}): AdminAuthorApplication => ({
  id: ID,
  status: 'PENDING',
  motivation: 'Writing about Go and Postgres',
  createdAt: '2026-10-02T19:00:00Z',
  decidedAt: null,
  applicant: applicant(),
  ...over,
})

function renderList(applications: AdminAuthorApplication[], selfId: string | null = SELF) {
  return render(
    <AuthorApplicationList
      applications={applications}
      label={PENDING_LABEL}
      status="PENDING"
      selfId={selfId}
      onApprove={onApprove}
      onReject={onReject}
    />,
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element)
  })
}

/** The administrator's own code: the approval of a reader's application asks for it (audit 111). */
const STEP_UP_CODE = '482913'
const STEP_UP_LABEL = msg('Admin.stepUp.codeLabel')

function typeStepUpCode(panel: HTMLElement, code = STEP_UP_CODE) {
  fireEvent.change(within(panel).getByRole('textbox', { name: STEP_UP_LABEL }), { target: { value: code } })
}

/**
 * Opens the review panel of `handle`, types the confirmation text (and the administrator's code when the approval asks for one);
 * returns the panel and the confirm button.
 */
async function prepareApproval(handle: string, typed: string) {
  await click(screen.getByRole('button', { name: approveName(handle) }))
  const panel = screen.getByRole('group', { name: plain('confirmApprove', { handle }) })
  // The retyped login is the first text box; the code, when there is one, comes after it.
  fireEvent.change(within(panel).getAllByRole('textbox')[0]!, { target: { value: typed } })
  if (within(panel).queryByRole('textbox', { name: STEP_UP_LABEL }) !== null) typeStepUpCode(panel)
  return { panel, confirm: within(panel).getByRole('button', { name: msg('Admin.applications.list.approveApplication') }) }
}

describe('AuthorApplicationList: rendering', () => {
  it('each application: name in <bdi>, @login, submitted date, reason as plain text; button has its own name; own application has no button', () => {
    renderList([
      application({ motivation: '<img src=x onerror=alert(1)> Go' }),
      application({
        id: '33333333-3333-3333-3333-333333333333',
        motivation: null,
        applicant: applicant({ id: SELF, displayName: 'Myself', githubLogin: 'me' }),
      }),
    ])

    const list = screen.getByRole('list', { name: PENDING_LABEL })
    const [first, mine] = within(list).getAllByRole('listitem')
    expect(within(first!).getByText('Octo Cat').tagName).toBe('BDI')
    expect(first).toHaveTextContent('@octocat')
    // Dates are in UTC like every admin date: 19:00 UTC on the 2nd is still the 2nd.
    expect(first).toHaveTextContent(listText.markup('submittedOn', { date: () => SUBMITTED_DATE_TEXT }))
    expect(within(first!).getByText('<img src=x onerror=alert(1)> Go')).toBeInTheDocument()
    expect(first!.querySelector('img[src="x"]')).toBeNull()
    expect(
      within(first!)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([approveName('@octocat'), rejectName('@octocat')])

    expect(within(mine!).getByText(msg('Admin.users.table.you'))).toBeInTheDocument()
    expect(within(mine!).getByText(msg('Admin.applications.list.noReason'))).toBeInTheDocument()
    expect(within(mine!).queryAllByRole('button')).toEqual([])
    // The notification region exists from the start: only content that changes later gets announced.
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })
})

describe('AuthorApplicationList: the administrator code of an approval (audit 111)', () => {
  it('the code is trimmed and travels with the application id', async () => {
    onApprove.mockResolvedValue(application({ status: 'APPROVED', decidedAt: '2026-10-10T08:00:00Z' }))
    renderList([application()])
    await click(screen.getByRole('button', { name: approveName('@octocat') }))
    const panel = screen.getByRole('group', { name: plain('confirmApprove', { handle: '@octocat' }) })
    fireEvent.change(within(panel).getAllByRole('textbox')[0]!, { target: { value: 'octocat' } })
    expect(within(panel).getByText(msg('Admin.stepUp.codeHint'))).toBeInTheDocument()
    typeStepUpCode(panel, '  123 456  ')

    await click(within(panel).getByRole('button', { name: msg('Admin.applications.list.approveApplication') }))

    expect(onApprove).toHaveBeenCalledExactlyOnceWith(ID, '123 456')
  })

  it('an applicant who is already an author or admin keeps the role: nothing changes, so no code is asked for or sent', async () => {
    onApprove.mockResolvedValue(application({ status: 'APPROVED', decidedAt: '2026-10-10T08:00:00Z' }))
    renderList([application({ applicant: applicant({ role: 'AUTHOR' }) })])
    await click(screen.getByRole('button', { name: approveName('@octocat') }))
    const panel = screen.getByRole('group', { name: plain('confirmApprove', { handle: '@octocat' }) })

    expect(within(panel).queryByRole('textbox', { name: STEP_UP_LABEL })).toBeNull()
    fireEvent.change(within(panel).getByRole('textbox'), { target: { value: 'octocat' } })
    await click(within(panel).getByRole('button', { name: msg('Admin.applications.list.approveApplication') }))

    expect(onApprove).toHaveBeenCalledExactlyOnceWith(ID, undefined)
  })

  it('a refusal for the code stays in the panel as its sentence and keeps what was typed', async () => {
    const refused = msg('Errors.admin.codes.REAUTHENTICATION_REQUIRED')
    onApprove.mockResolvedValue({ error: refused })
    renderList([application()])

    const { panel, confirm } = await prepareApproval('@octocat', 'octocat')
    await click(confirm)

    expect(within(panel).getByRole('alert')).toHaveTextContent(refused)
    expect(within(panel).getByRole('textbox', { name: STEP_UP_LABEL })).toHaveValue(STEP_UP_CODE)
  })
})

describe('AuthorApplicationList: approve (retyping the login is required to confirm)', () => {
  it('opens the panel: focus on the input, consequence attached to the button; button enabled only when the typed text matches the login; Escape closes, focus returns to "Approve"', async () => {
    renderList([application()])

    await click(screen.getByRole('button', { name: approveName('@octocat') }))
    const panel = screen.getByRole('group', { name: plain('confirmApprove', { handle: '@octocat' }) })
    const input = within(panel).getByRole('textbox', { name: plain('confirmLogin', { handle: '@octocat' }) })
    expect(input).toHaveFocus()
    const confirm = within(panel).getByRole('button', { name: msg('Admin.applications.list.approveApplication') })
    expect(confirm).toHaveAccessibleDescription(
      `${plain('effect.promote', { handle: '@octocat' })} ${msg('Admin.applications.list.effect.sessions')}`,
    )

    // A display name cannot replace the login when the person has one.
    for (const typed of ['', 'octo', 'octocat2', '@@octocat', 'Octo Cat']) {
      fireEvent.change(input, { target: { value: typed } })
      expect(confirm, typed).toHaveAttribute('aria-disabled', 'true')
    }
    // aria-disabled cannot stop a click or Enter: the form itself must block it, so the action is never reached.
    await click(confirm)
    expect(onApprove).not.toHaveBeenCalled()

    // Trim whitespace and one leading "@"; the login is case-insensitive, like GitHub. Making a reader an author also asks for the
    // administrator's own code: with the login right and the code missing the button is still off.
    fireEvent.change(input, { target: { value: '  @OctoCat ' } })
    expect(confirm).toHaveAttribute('aria-disabled', 'true')
    typeStepUpCode(panel)
    expect(confirm).not.toHaveAttribute('aria-disabled')

    await act(async () => {
      fireEvent.keyDown(input, { key: 'Escape' })
    })
    expect(screen.queryByRole('group')).toBeNull()
    expect(screen.getByRole('button', { name: approveName('@octocat') })).toHaveFocus()
    expect(onApprove).not.toHaveBeenCalled()
  })

  it('confirm: one call even when clicked twice; then the "Approved" label, no button left, focus back on the row, a notification and a reload notice', async () => {
    const answer = deferred<AdminAuthorApplication>()
    onApprove.mockReturnValue(answer.promise)
    renderList([application()])

    const { confirm } = await prepareApproval('@octocat', 'octocat')
    confirm.focus()
    await click(confirm)
    await click(confirm)
    expect(confirm).toHaveTextContent(msg('Admin.applications.list.approving'))
    expect(confirm).toHaveAttribute('aria-disabled', 'true')

    await act(async () =>
      answer.resolve(
        application({ status: 'APPROVED', decidedAt: '2026-10-10T08:00:00Z', applicant: applicant({ role: 'AUTHOR' }) }),
      ),
    )

    expect(onApprove).toHaveBeenCalledExactlyOnceWith(ID, STEP_UP_CODE)
    const row = screen.getByRole('listitem')
    expect(row).toHaveFocus()
    expect(within(row).getByText(msg('Admin.statuses.application.APPROVED'))).toBeInTheDocument()
    expect(row).toHaveTextContent(listText.markup('approvedOn', { date: () => DECIDED_DATE_TEXT }))
    expect(row).toHaveTextContent(msg('Admin.applications.list.currentRole', { role: 'AUTHOR' }))
    expect(within(row).queryAllByRole('button')).toEqual([])
    expect(screen.getByRole('status')).toHaveTextContent(plain('notice.approved', { handle: '@octocat' }))
    // The application leaves the pending tab yet stays in place: the pagination is stale, and there is nothing to undo.
    expect(
      screen.getByText(msg('Admin.common.staleList.notice', { count: 1, unit: 'application', kept: 'review' })),
    ).toBeInTheDocument()
    await click(screen.getByRole('button', { name: msg('Admin.common.staleList.reload') }))
    expect(router.refresh).toHaveBeenCalledTimes(1)
  })

  it('backend rejects (application was just rejected elsewhere): error sentence in the panel, application unchanged, focus on the confirm button', async () => {
    const refused = msg('Errors.admin.codes.AUTHOR_APPLICATION_DECIDED')
    onApprove.mockResolvedValue({ error: refused })
    renderList([application()])

    const { panel, confirm } = await prepareApproval('@octocat', 'octocat')
    confirm.focus()
    await click(confirm)

    expect(within(panel).getByRole('alert')).toHaveTextContent(refused)
    expect(confirm).toHaveFocus()
    expect(confirm).toHaveTextContent(msg('Admin.applications.list.approveApplication'))
    expect(screen.queryByText(msg('Admin.statuses.application.APPROVED'))).toBeNull()
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('no GitHub login: typing the display name with exact case works, decomposed Vietnamese diacritics still match; consequence depends on the applicant', async () => {
    renderList([application({ applicant: applicant({ githubLogin: null, displayName: APPLICANT_NAME, status: 'SUSPENDED' }) })])

    await click(screen.getByRole('button', { name: approveName(APPLICANT_NAME) }))
    const panel = screen.getByRole('group', { name: plain('confirmApprove', { handle: APPLICANT_NAME }) })
    const input = within(panel).getByRole('textbox', { name: plain('confirmName', { handle: APPLICANT_NAME }) })
    const confirm = within(panel).getByRole('button', { name: msg('Admin.applications.list.approveApplication') })
    // The backend refuses to grant a role to a suspended account: say so up front.
    expect(confirm).toHaveAccessibleDescription(endsWith(msg('Admin.applications.list.effect.suspendedNote')))

    typeStepUpCode(panel)
    fireEvent.change(input, { target: { value: APPLICANT_NAME_LOWER_CASE } })
    expect(confirm).toHaveAttribute('aria-disabled', 'true')
    fireEvent.change(input, { target: { value: APPLICANT_NAME_TYPED.normalize('NFD') } })
    expect(confirm).not.toHaveAttribute('aria-disabled')
  })

  it('applicant is already an author: approving only closes the application, the consequence says the role stays unchanged', async () => {
    renderList([application({ applicant: applicant({ role: 'AUTHOR' }) })])

    const { confirm } = await prepareApproval('@octocat', '')

    expect(confirm).toHaveAccessibleDescription(plain('effect.alreadyRole', { handle: '@octocat', role: 'AUTHOR' }))
  })
})

describe('AuthorApplicationList: reject', () => {
  it('confirms in place, focus on "Cancel"; Escape closes, focus returns to "Reject"; confirming calls the right id, label "Rejected"', async () => {
    onReject.mockResolvedValue(application({ status: 'REJECTED', decidedAt: '2026-10-10T08:00:00Z' }))
    renderList([application()])
    const trigger = () => screen.getByRole('button', { name: rejectName('@octocat') })

    await click(trigger())
    let panel = screen.getByRole('group', { name: (name) => name.startsWith(`${rejectName('@octocat')}?`) })
    expect(panel).toHaveTextContent(plain('confirmReject', { handle: '@octocat' }))
    expect(within(panel).getByRole('button', { name: msg('Site.comments.form.cancel') })).toHaveFocus()
    await act(async () => {
      fireEvent.keyDown(within(panel).getByRole('button', { name: msg('Site.comments.form.cancel') }), { key: 'Escape' })
    })
    expect(screen.queryByRole('group')).toBeNull()
    expect(trigger()).toHaveFocus()
    expect(onReject).not.toHaveBeenCalled()

    await click(trigger())
    panel = screen.getByRole('group', { name: (name) => name.startsWith(`${rejectName('@octocat')}?`) })
    const confirm = within(panel).getByRole('button', { name: msg('Admin.applications.list.reject') })
    confirm.focus()
    await click(confirm)

    expect(onReject).toHaveBeenCalledExactlyOnceWith(ID)
    expect(onApprove).not.toHaveBeenCalled()
    expect(screen.getByRole('listitem')).toHaveFocus()
    expect(screen.getByText(msg('Site.profile.author.status.rejected.title'))).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(plain('notice.rejected', { handle: '@octocat' }))
  })
})
