import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AdminUser, UserRole, UserStatus } from '@/lib/types'
import UserTable from './UserTable'
import { msg } from '@/test/render-intl'
import { currentTestLocale, translatorFor } from '@/test/intl'
import { DIACRITIC_NAME, DIACRITIC_NAME_LOWER, DIACRITIC_NAME_PADDED, JOINED_DATE_MEDIUM } from '@/test/fixtures/vi/user-table'

// The reload-list button (StaleListNotice) is router.refresh(): here we only need to know it was called.
const router = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => router,
}))

const onSuspend = vi.fn()
const onUnsuspend = vi.fn()
const onChangeRole = vi.fn()
const onResetMfa = vi.fn()

afterEach(() => vi.clearAllMocks())

const SELF = '99999999-9999-9999-9999-999999999999'
const CAPTION = 'Users (every role, every status), page 1/1'
const SUSPENDED_CAPTION = 'Users (every role, suspended), page 1/1'

const T = (key: string, args?: Record<string, string | number>) => msg(`Admin.users.table.${key}`, args)
const role = (code: 'USER' | 'AUTHOR' | 'ADMIN') => msg(`Admin.statuses.role.${code}`)
const suspendName = (handle: string) => `${T('suspend')} ${handle}`
const unsuspendName = (handle: string) => `${T('unsuspend')} ${handle}`
const roleButtonName = (handle: string) => `${T('changeRole')} ${handle}`
const resetMfaName = (handle: string) => `${T('resetMfa')} ${handle}`
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const startsWith = (text: string) => new RegExp(`^${escapeRegExp(text)}`)
const STALE_NOTICE = msg('Admin.common.staleList.notice', { count: 1, unit: 'user', kept: 'undo' })

/** A catalog message with rich tags (<bdi>, <strong>, <b>) as the plain text a screen reader gets. */
function plain(key: string, args: Record<string, string | number> = {}): string {
  const tr = translatorFor(currentTestLocale()) as unknown as { rich: (key: string, values: Record<string, unknown>) => unknown }
  const keep = (chunks: unknown) => chunks
  const flatten = (node: unknown): string => (Array.isArray(node) ? node.map(flatten).join('') : String(node))
  return flatten(tr.rich(key, { ...args, bdi: keep, strong: keep, b: keep }))
}

const user = (over: Partial<AdminUser> = {}): AdminUser => ({
  id: '22222222-2222-2222-2222-222222222222',
  displayName: 'Octo Cat',
  githubLogin: 'octocat',
  avatarUrl: null,
  role: 'USER',
  status: 'ACTIVE',
  createdAt: '2026-10-02T19:00:00Z',
  lastLoginAt: '2026-10-05T19:00:00Z',
  ...over,
})

function renderTable(
  users: AdminUser[],
  selfId: string | null = SELF,
  statusFilter: UserStatus | null = null,
  roleFilter: UserRole | null = null,
) {
  return render(
    <UserTable
      users={users}
      caption={CAPTION}
      selfId={selfId}
      statusFilter={statusFilter}
      roleFilter={roleFilter}
      onSuspend={onSuspend}
      onUnsuspend={onUnsuspend}
      onChangeRole={onChangeRole}
      onResetMfa={onResetMfa}
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

/** The row (tr) of an account, by display name (the always-visible user cell). */
function rowOf(name: string): HTMLElement {
  return screen.getAllByText(name)[0].closest('tr')!
}

/** The role-change panel, by how the table refers to that person ("@login", or the display name when there is none). */
function rolePanel(handle: string): HTMLElement {
  return screen.getByRole('group', { name: plain('Admin.users.roleChange.title', { handle }) })
}

/** The administrator's own code, typed for the changes that ask for one (lib/role-step-up.ts, audit 111). */
const STEP_UP_CODE = '482913'
const STEP_UP_LABEL = msg('Admin.stepUp.codeLabel')

function typeStepUpCode(panel: HTMLElement, code = STEP_UP_CODE) {
  fireEvent.change(within(panel).getByRole('textbox', { name: STEP_UP_LABEL }), { target: { value: code } })
}

/**
 * Opens the role-change panel, chooses the new role, types the confirmation text (and the administrator's code when the change asks
 * for one); returns the confirm button.
 */
async function prepareRoleChange(handle: string, role: string, typed: string): Promise<HTMLElement> {
  await click(screen.getByRole('button', { name: roleButtonName(handle) }))
  const panel = rolePanel(handle)
  await click(within(panel).getByRole('radio', { name: role }))
  // The retyped login is the first text box; the administrator's code, when there is one, comes after it.
  fireEvent.change(within(panel).getAllByRole('textbox')[0]!, { target: { value: typed } })
  if (within(panel).queryByRole('textbox', { name: STEP_UP_LABEL }) !== null) typeStepUpCode(panel)
  return within(panel).getByRole('button', { name: msg('Admin.users.roleChange.changeTo', { role }) })
}

describe('UserTable: rendering', () => {
  it('the table has a caption and six columns; the notification region exists', () => {
    renderTable([user()])

    const table = screen.getByRole('table', { name: CAPTION })
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual([
      msg('Admin.shell.nav.users'),
      msg('Admin.users.roleLabel'),
      msg('Admin.dashboard.table.status'),
      msg('Admin.users.table.joined'),
      msg('Admin.users.table.lastLogin'),
      msg('Admin.comments.table.actions'),
    ])
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('name in <bdi>, @login only when present; role and status as text; dates in UTC', () => {
    const { container } = renderTable([
      user(),
      user({ id: SELF, displayName: msg('Site.comments.item.ownerBadge'), githubLogin: null, role: 'ADMIN', lastLoginAt: null }),
    ])

    expect(Array.from(container.querySelectorAll('bdi')).map((bdi) => bdi.textContent)).toContain('Octo Cat')
    expect(container.textContent).not.toContain('@null')
    const reader = rowOf('Octo Cat')
    expect(within(reader).getAllByText('@octocat').length).toBeGreaterThan(0)
    expect(within(reader).getAllByText(msg('Admin.statuses.role.USER')).length).toBeGreaterThan(0)
    expect(within(reader).getAllByText(msg('Admin.statuses.user.ACTIVE')).length).toBeGreaterThan(0)
    // 19:00Z is 02:00 the next day in the time zone the test suite pins: the date must follow UTC.
    const joined = reader.querySelector('time[dateTime="2026-10-02T19:00:00Z"]')
    expect(joined?.textContent).toContain(JOINED_DATE_MEDIUM)
    expect(within(rowOf(msg('Site.comments.item.ownerBadge'))).getAllByText(msg('Site.account.admin')).length).toBeGreaterThan(0)
    expect(
      within(rowOf(msg('Site.comments.item.ownerBadge'))).getAllByText(msg('Admin.users.table.neverLoggedIn')).length,
    ).toBeGreaterThan(0)
  })

  it('"Change role" on every row, suspend / unsuspend only on readers, the two-step reset only on authors; the row of the logged-in person has no button', () => {
    renderTable(
      [
        user(),
        user({ id: 'u2', displayName: 'Locked Out', githubLogin: 'spammer', status: 'SUSPENDED' }),
        user({ id: 'u3', displayName: msg('Site.authorBox.eyebrow'), githubLogin: 'writer', role: 'AUTHOR' }),
        user({ id: SELF, displayName: msg('Site.comments.item.ownerBadge'), githubLogin: 'owner', role: 'ADMIN' }),
        // The role in the DB was just lowered to USER while the token is still this person: still cannot suspend or change their own role.
        user({ id: 'self-demoted', displayName: 'Myself', githubLogin: 'me' }),
      ],
      'self-demoted',
    )

    const buttons = (name: string) =>
      within(rowOf(name))
        .queryAllByRole('button')
        .map((b) => b.textContent)
    expect(buttons('Octo Cat')).toEqual([suspendName('@octocat'), roleButtonName('@octocat')])
    expect(buttons('Locked Out')).toEqual([unsuspendName('@spammer'), roleButtonName('@spammer')])
    // An author can have lost the device of their two-step verification: only that row has the reset.
    expect(buttons(msg('Site.authorBox.eyebrow'))).toEqual([roleButtonName('@writer'), resetMfaName('@writer')])
    // Another admin (selfId here is "self-demoted"): can have the role changed, the backend keeps the last admin.
    expect(buttons(msg('Site.comments.item.ownerBadge'))).toEqual([roleButtonName('@owner')])
    expect(buttons('Myself')).toEqual([])
    expect(within(rowOf('Myself')).getByText(msg('Admin.users.table.you'))).toBeInTheDocument()
  })
})

describe('UserTable: fresh data from the server', () => {
  it('re-entering this very URL (same key): the new list replaces the old; with the same list the in-place changes are kept', async () => {
    onUnsuspend.mockResolvedValue(user())
    const users = [user({ status: 'SUSPENDED' })]
    const props = {
      caption: 'c',
      selfId: null,
      statusFilter: null,
      roleFilter: null,
      onSuspend,
      onUnsuspend,
      onChangeRole,
      onResetMfa,
    }
    const { rerender } = render(<UserTable users={users} {...props} />)

    await click(screen.getByRole('button', { name: unsuspendName('@octocat') }))
    rerender(<UserTable users={users} {...props} />)
    expect(screen.getByRole('button', { name: suspendName('@octocat') })).toBeInTheDocument()

    rerender(<UserTable users={[user({ id: 'u9', displayName: 'Newcomer', githubLogin: 'newbie' })]} {...props} />)
    expect(screen.getByRole('button', { name: suspendName('@newbie') })).toBeInTheDocument()
    expect(screen.queryByText('Octo Cat')).toBeNull()
  })
})

describe('UserTable: suspend and unsuspend', () => {
  it('suspend: in-place confirmation with the exact sentence from the design, focus on "Cancel"; Escape cancels, focus returns to the button', async () => {
    renderTable([user()])

    await click(screen.getByRole('button', { name: suspendName('@octocat') }))

    const group = screen.getByRole('group', {
      name: plain('Admin.users.table.confirmSuspend', { handle: '@octocat' }),
    })
    expect(within(group).getByRole('button', { name: msg('Site.comments.form.cancel') })).toHaveFocus()

    await act(async () => {
      fireEvent.keyDown(within(group).getByRole('button', { name: msg('Site.comments.form.cancel') }), { key: 'Escape' })
    })

    expect(screen.queryByRole('group')).toBeNull()
    expect(screen.getByRole('button', { name: suspendName('@octocat') })).toHaveFocus()
    expect(onSuspend).not.toHaveBeenCalled()
  })

  it('confirm: one call even when clicked twice; when done the label "Suspended", focus moves to "Unsuspend", a notification appears', async () => {
    const answer = deferred<AdminUser>()
    onSuspend.mockReturnValue(answer.promise)
    renderTable([user()])

    await click(screen.getByRole('button', { name: suspendName('@octocat') }))
    const confirm = within(screen.getByRole('group')).getByRole('button', { name: msg('Admin.users.table.suspend') })
    confirm.focus()
    await click(confirm)
    await click(confirm)

    expect(onSuspend).toHaveBeenCalledTimes(1)
    expect(onSuspend).toHaveBeenCalledWith('22222222-2222-2222-2222-222222222222')
    expect(within(screen.getByRole('group')).getByRole('button', { name: msg('Admin.users.table.suspending') })).toHaveAttribute(
      'aria-disabled',
      'true',
    )

    await act(async () => answer.resolve(user({ status: 'SUSPENDED' })))

    expect(screen.queryByRole('group')).toBeNull()
    expect(screen.getByRole('button', { name: unsuspendName('@octocat') })).toHaveFocus()
    // The status label does not repeat the button text: the suspended label is a state, while the suspend button is only an action.
    expect(within(rowOf('Octo Cat')).getAllByText(msg('Admin.statuses.user.SUSPENDED')).length).toBeGreaterThan(0)
    expect(within(rowOf('Octo Cat')).queryByText(msg('Admin.users.table.suspend'))).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent(plain('Admin.users.table.notice.suspended', { handle: '@octocat' }))
  })

  it('unsuspend: no confirmation needed; when done focus returns to "Suspend", a notification appears', async () => {
    onUnsuspend.mockResolvedValue(user())
    renderTable([user({ status: 'SUSPENDED' })])
    const unlock = screen.getByRole('button', { name: unsuspendName('@octocat') })
    unlock.focus()

    await click(unlock)

    expect(onUnsuspend).toHaveBeenCalledWith('22222222-2222-2222-2222-222222222222')
    expect(screen.getByRole('button', { name: suspendName('@octocat') })).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent(plain('Admin.users.table.notice.unsuspended', { handle: '@octocat' }))
  })

  it('no GitHub login: the display name takes the place of @login in the button and the question', async () => {
    renderTable([user({ githubLogin: null })])

    await click(screen.getByRole('button', { name: suspendName('Octo Cat') }))

    expect(screen.getByRole('group', { name: startsWith(`${T('suspend')} Octo Cat?`) })).toBeInTheDocument()
  })

  it('failure: error sentence in the confirmation panel, status unchanged; a failed unsuspend shows the error right under the row', async () => {
    onSuspend.mockResolvedValue({ error: msg('Errors.admin.codes.USER_NOT_SUSPENDABLE') })
    onUnsuspend.mockResolvedValue({ error: msg('Errors.admin.codes.USER_NOT_FOUND') })
    renderTable([user(), user({ id: 'u2', displayName: 'Locked Out', githubLogin: 'spammer', status: 'SUSPENDED' })])

    await click(screen.getByRole('button', { name: suspendName('@octocat') }))
    await click(within(screen.getByRole('group')).getByRole('button', { name: msg('Admin.users.table.suspend') }))

    expect(within(screen.getByRole('group')).getByRole('alert')).toHaveTextContent(msg('Errors.admin.codes.USER_NOT_SUSPENDABLE'))
    expect(within(rowOf('Octo Cat')).getAllByText(msg('Admin.statuses.user.ACTIVE')).length).toBeGreaterThan(0)

    const unlock = screen.getByRole('button', { name: unsuspendName('@spammer') })
    unlock.focus()
    await click(unlock)
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toContain(msg('Errors.admin.codes.USER_NOT_FOUND'))
    expect(unlock).toHaveFocus()
  })
})

describe('UserTable: change role (retyping the login is required to confirm)', () => {
  const ID = '22222222-2222-2222-2222-222222222222'

  it('opens the panel: focus on the current role; choosing another role states the consequence; the button is enabled only once a role is chosen and the typed text matches the login', async () => {
    renderTable([user()])

    await click(screen.getByRole('button', { name: roleButtonName('@octocat') }))

    const panel = rolePanel('@octocat')
    const current = within(panel).getByRole('radio', { name: `${role('USER')} ${msg('Admin.users.roleChange.current')}` })
    expect(current).toBeChecked()
    expect(current).toHaveFocus()
    // Typing the right login without choosing another role: there is nothing to confirm yet.
    const input = within(panel).getByRole('textbox', {
      name: plain('Admin.users.roleChange.confirmLogin', { handle: '@octocat' }),
    })
    fireEvent.change(input, { target: { value: 'octocat' } })
    expect(within(panel).getByRole('button', { name: msg('Admin.users.table.changeRole') })).toHaveAttribute(
      'aria-disabled',
      'true',
    )

    await click(within(panel).getByRole('radio', { name: msg('Site.authorBox.eyebrow') }))
    const confirm = within(panel).getByRole('button', { name: msg('Admin.users.roleChange.changeTo', { role: role('AUTHOR') }) })
    expect(confirm).toHaveAccessibleDescription(
      new RegExp(
        `^${escapeRegExp(plain('Admin.users.roleChange.effect.promote', { handle: '@octocat', to: 'AUTHOR' }))} .*${escapeRegExp(msg('Admin.users.roleChange.effect.promoteSessions'))}$`,
      ),
    )
    // A reader becoming an author asks for the administrator's own code too: the login matches, the code is missing.
    expect(confirm).toHaveAttribute('aria-disabled', 'true')
    typeStepUpCode(panel)
    expect(confirm).not.toHaveAttribute('aria-disabled')

    // A display name cannot replace the login when the person has one.
    for (const typed of ['', 'octo', 'octocat2', '@@octocat', 'Octo Cat']) {
      fireEvent.change(input, { target: { value: typed } })
      expect(confirm, typed).toHaveAttribute('aria-disabled', 'true')
    }
    // aria-disabled cannot stop a click or Enter: the form itself must block it, so the action is never reached.
    await click(confirm)
    expect(onChangeRole).not.toHaveBeenCalled()

    // Trim whitespace and one leading "@"; the login is case-insensitive, like GitHub.
    fireEvent.change(input, { target: { value: '  @OctoCat ' } })
    expect(confirm).not.toHaveAttribute('aria-disabled')
  })

  it('confirm: calls the right id and role; the row follows the backend version (suspend button gone), focus returns to "Change role", a notification appears', async () => {
    onChangeRole.mockResolvedValue(user({ role: 'AUTHOR' }))
    renderTable([user()])

    const confirm = await prepareRoleChange('@octocat', msg('Site.authorBox.eyebrow'), 'octocat')
    confirm.focus()
    await click(confirm)

    expect(onChangeRole).toHaveBeenCalledExactlyOnceWith(ID, 'AUTHOR', STEP_UP_CODE)
    expect(screen.queryByRole('group')).toBeNull()
    const row = rowOf('Octo Cat')
    expect(within(row).getAllByText(msg('Site.authorBox.eyebrow')).length).toBeGreaterThan(0)
    expect(within(row).queryByText(msg('Admin.statuses.role.USER'))).toBeNull()
    expect(
      within(row)
        .getAllByRole('button')
        .map((b) => b.textContent),
      // The reader became an author: the suspend button is gone and the two-step reset appears.
    ).toEqual([roleButtonName('@octocat'), resetMfaName('@octocat')])
    expect(screen.getByRole('button', { name: roleButtonName('@octocat') })).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent(
      plain('Admin.users.table.notice.roleChanged', { handle: '@octocat', role: role('AUTHOR') }),
    )
  })

  it('backend refuses (LAST_ADMIN): error sentence in the panel, role unchanged; focus stays on the confirm button while pending', async () => {
    const answer = deferred<{ error: string }>()
    onChangeRole.mockReturnValue(answer.promise)
    renderTable([user({ displayName: 'Admin Hai', githubLogin: 'admin2', role: 'ADMIN' })])

    const confirm = await prepareRoleChange('@admin2', msg('Admin.statuses.role.USER'), 'admin2')
    expect(confirm).toHaveAccessibleDescription(
      startsWith(plain('Admin.users.roleChange.effect.demote', { handle: '@admin2', from: 'ADMIN', to: 'USER' })),
    )
    confirm.focus()
    await click(confirm)
    expect(confirm).toHaveTextContent(msg('Admin.users.roleChange.submitting'))
    expect(confirm).toHaveAttribute('aria-disabled', 'true')

    const refused = msg('Errors.admin.codes.LAST_ADMIN')
    await act(async () => answer.resolve({ error: refused }))

    expect(within(rolePanel('@admin2')).getByRole('alert')).toHaveTextContent(refused)
    expect(confirm).toHaveFocus()
    expect(confirm).toHaveTextContent(msg('Admin.users.roleChange.changeTo', { role: role('USER') }))
    expect(within(rowOf('Admin Hai')).getAllByText(msg('Site.account.admin')).length).toBeGreaterThan(0)
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('Escape or "Cancel": closes the panel, focus returns to "Change role", nothing is called', async () => {
    renderTable([user()])
    const trigger = () => screen.getByRole('button', { name: roleButtonName('@octocat') })

    await click(trigger())
    await act(async () => {
      fireEvent.keyDown(within(rolePanel('@octocat')).getByRole('textbox'), { key: 'Escape' })
    })
    expect(screen.queryByRole('group')).toBeNull()
    expect(trigger()).toHaveFocus()

    await click(trigger())
    await click(within(rolePanel('@octocat')).getByRole('button', { name: msg('Site.comments.form.cancel') }))
    expect(screen.queryByRole('group')).toBeNull()
    expect(trigger()).toHaveFocus()
    expect(onChangeRole).not.toHaveBeenCalled()
  })

  it('no GitHub login: typing the display name with exact case; Vietnamese diacritics typed in decomposed form still match', async () => {
    renderTable([user({ githubLogin: null, displayName: DIACRITIC_NAME })])

    await click(screen.getByRole('button', { name: roleButtonName(DIACRITIC_NAME) }))
    const panel = rolePanel(DIACRITIC_NAME)
    await click(within(panel).getByRole('radio', { name: msg('Site.authorBox.eyebrow') }))
    const input = within(panel).getByRole('textbox', {
      name: plain('Admin.users.roleChange.confirmName', { handle: DIACRITIC_NAME }),
    })
    const confirm = within(panel).getByRole('button', { name: msg('Admin.users.roleChange.changeTo', { role: role('AUTHOR') }) })

    fireEvent.change(input, { target: { value: DIACRITIC_NAME_LOWER } })
    expect(confirm).toHaveAttribute('aria-disabled', 'true')
    fireEvent.change(input, { target: { value: DIACRITIC_NAME_PADDED.normalize('NFD') } })
    typeStepUpCode(panel)
    expect(confirm).not.toHaveAttribute('aria-disabled')
  })
})

/**
 * Audit 111: a change to or from ADMIN, and a reader becoming an author, asks for the administrator's own code. The field is only
 * shown for those, and the code travels with the role; the backend decides, so a hidden field never turns a refusal into a change.
 */
describe('UserTable: the administrator code of a role change', () => {
  const ID = '22222222-2222-2222-2222-222222222222'

  async function open(u: ReturnType<typeof user>, newRole: string, handle: string) {
    renderTable([u])
    await click(screen.getByRole('button', { name: roleButtonName(handle) }))
    const panel = rolePanel(handle)
    await click(within(panel).getByRole('radio', { name: newRole }))
    return panel
  }

  it.each([
    ['USER', 'AUTHOR'],
    ['USER', 'ADMIN'],
    ['AUTHOR', 'ADMIN'],
    ['ADMIN', 'AUTHOR'],
    ['ADMIN', 'USER'],
  ] as const)('%s to %s shows the code field and does not confirm without it', async (from, to) => {
    const panel = await open(user({ role: from }), role(to), '@octocat')

    expect(within(panel).getByRole('textbox', { name: STEP_UP_LABEL })).toBeInTheDocument()
    expect(within(panel).getByText(msg('Admin.stepUp.codeHint'))).toBeInTheDocument()
    fireEvent.change(within(panel).getAllByRole('textbox')[0]!, { target: { value: 'octocat' } })
    const confirm = within(panel).getByRole('button', { name: msg('Admin.users.roleChange.changeTo', { role: role(to) }) })
    expect(confirm).toHaveAttribute('aria-disabled', 'true')
    await click(confirm)
    expect(onChangeRole).not.toHaveBeenCalled()
  })

  it('an author becoming a reader needs no code: no field, and the call carries none', async () => {
    onChangeRole.mockResolvedValue(user({ role: 'USER' }))
    const panel = await open(user({ role: 'AUTHOR' }), role('USER'), '@octocat')

    expect(within(panel).queryByRole('textbox', { name: STEP_UP_LABEL })).toBeNull()
    fireEvent.change(within(panel).getByRole('textbox'), { target: { value: 'octocat' } })
    await click(within(panel).getByRole('button', { name: msg('Admin.users.roleChange.changeTo', { role: role('USER') }) }))

    expect(onChangeRole).toHaveBeenCalledExactlyOnceWith(ID, 'USER', undefined)
  })

  it('the code is trimmed, and a promotion to ADMIN says that the authenticator is set up again', async () => {
    onChangeRole.mockResolvedValue(user({ role: 'ADMIN' }))
    const panel = await open(user({ role: 'AUTHOR' }), role('ADMIN'), '@octocat')
    const confirm = within(panel).getByRole('button', { name: msg('Admin.users.roleChange.changeTo', { role: role('ADMIN') }) })

    expect(confirm).toHaveAccessibleDescription(
      new RegExp(escapeRegExp(msg('Admin.users.roleChange.effect.promoteEnrollsAgain'))),
    )
    fireEvent.change(within(panel).getAllByRole('textbox')[0]!, { target: { value: 'octocat' } })
    typeStepUpCode(panel, '  123 456  ')
    await click(confirm)

    expect(onChangeRole).toHaveBeenCalledExactlyOnceWith(ID, 'ADMIN', '123 456')
  })

  it('a refusal for the code (wrong code, old sign-in) stays in the panel as its sentence and keeps what was typed', async () => {
    const refused = msg('Errors.admin.codes.MFA_CODE_INVALID')
    onChangeRole.mockResolvedValue({ error: refused })
    const panel = await open(user(), role('AUTHOR'), '@octocat')
    fireEvent.change(within(panel).getAllByRole('textbox')[0]!, { target: { value: 'octocat' } })
    typeStepUpCode(panel)

    await click(within(panel).getByRole('button', { name: msg('Admin.users.roleChange.changeTo', { role: role('AUTHOR') }) }))

    expect(within(panel).getByRole('alert')).toHaveTextContent(refused)
    expect(within(panel).getByRole('textbox', { name: STEP_UP_LABEL })).toHaveValue(STEP_UP_CODE)
  })
})

describe('UserTable: row leaves the current filter', () => {
  const RELOAD = msg('Admin.common.staleList.reload')

  it('filter "Reader", change a reader into an author: also leaves the filter', async () => {
    onChangeRole.mockResolvedValue(user({ role: 'AUTHOR' }))
    renderTable([user()], SELF, null, 'USER')
    expect(screen.queryByRole('button', { name: RELOAD })).toBeNull()

    await click(await prepareRoleChange('@octocat', msg('Site.authorBox.eyebrow'), 'octocat'))

    expect(screen.getByText(STALE_NOTICE)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: RELOAD })).toBeInTheDocument()
  })

  it('filter "Active", suspend a reader: warns the pagination is stale, "Reload the list" redraws the page', async () => {
    onSuspend.mockResolvedValue(user({ status: 'SUSPENDED' }))
    renderTable([user(), user({ id: 'u2', displayName: 'Someone Else', githubLogin: 'other' })], SELF, 'ACTIVE')
    expect(screen.queryByRole('button', { name: RELOAD })).toBeNull()

    await click(screen.getByRole('button', { name: suspendName('@octocat') }))
    await click(within(screen.getByRole('group')).getByRole('button', { name: msg('Admin.users.table.suspend') }))

    expect(screen.getByText(STALE_NOTICE)).toHaveTextContent(STALE_NOTICE)
    await click(screen.getByRole('button', { name: RELOAD }))
    expect(router.refresh).toHaveBeenCalledTimes(1)
  })

  it('filter "Suspended", unsuspend: also leaves the filter; suspending again removes the notice', async () => {
    onUnsuspend.mockResolvedValue(user())
    onSuspend.mockResolvedValue(user({ status: 'SUSPENDED' }))
    renderTable([user({ status: 'SUSPENDED' })], SELF, 'SUSPENDED')

    await click(screen.getByRole('button', { name: unsuspendName('@octocat') }))
    expect(screen.getByRole('button', { name: RELOAD })).toBeInTheDocument()

    await click(screen.getByRole('button', { name: suspendName('@octocat') }))
    await click(within(screen.getByRole('group')).getByRole('button', { name: msg('Admin.users.table.suspend') }))
    expect(screen.queryByRole('button', { name: RELOAD })).toBeNull()
  })

  it('"Any status": no row can leave, no notice', async () => {
    onUnsuspend.mockResolvedValue(user())
    renderTable([user({ status: 'SUSPENDED' })], SELF, null)

    await click(screen.getByRole('button', { name: unsuspendName('@octocat') }))

    expect(screen.queryByRole('button', { name: RELOAD })).toBeNull()
  })

  it('fresh list arrives after reloading: the notice disappears, focus moves from the button to the table', async () => {
    onUnsuspend.mockResolvedValue(user())
    const props = {
      caption: SUSPENDED_CAPTION,
      selfId: SELF,
      statusFilter: 'SUSPENDED' as const,
      roleFilter: null,
      onSuspend,
      onUnsuspend,
      onChangeRole,
      onResetMfa,
    }
    const other = user({ id: 'u2', displayName: 'Someone Else', githubLogin: 'other', status: 'SUSPENDED' })
    const { rerender } = render(<UserTable users={[user({ status: 'SUSPENDED' }), other]} {...props} />)
    await click(screen.getByRole('button', { name: unsuspendName('@octocat') }))
    const reload = screen.getByRole('button', { name: RELOAD })
    reload.focus()
    await click(reload)

    rerender(<UserTable users={[other]} {...props} />)

    expect(screen.queryByText('Octo Cat')).toBeNull()
    expect(screen.queryByRole('button', { name: RELOAD })).toBeNull()
    expect(screen.getByRole('table', { name: SUSPENDED_CAPTION })).toHaveFocus()
  })

  it('user moved elsewhere while reloading: focus is not pulled back to the table', async () => {
    onUnsuspend.mockResolvedValue(user())
    const props = {
      caption: 'c',
      selfId: SELF,
      statusFilter: 'SUSPENDED' as const,
      roleFilter: null,
      onSuspend,
      onUnsuspend,
      onChangeRole,
      onResetMfa,
    }
    const other = user({ id: 'u2', displayName: 'Someone Else', githubLogin: 'other', status: 'SUSPENDED' })
    const { rerender } = render(<UserTable users={[user({ status: 'SUSPENDED' }), other]} {...props} />)
    await click(screen.getByRole('button', { name: unsuspendName('@octocat') }))
    await click(screen.getByRole('button', { name: RELOAD }))
    screen.getByRole('button', { name: unsuspendName('@other') }).focus()

    rerender(<UserTable users={[other]} {...props} />)

    expect(screen.getByRole('button', { name: unsuspendName('@other') })).toHaveFocus()
  })
})

describe("UserTable: reset an author's two-step verification", () => {
  const AUTHOR = () => user({ id: 'author-1', displayName: 'Writer Person', githubLogin: 'writer', role: 'AUTHOR' })
  const panel = (handle: string) => screen.getByRole('group', { name: plain('Admin.users.table.resetMfaConfirm', { handle }) })

  it('only an author row has it: a reader, another administrator and the person themselves do not', () => {
    renderTable([user(), AUTHOR(), user({ id: 'admin-2', displayName: 'Other Admin', githubLogin: 'boss', role: 'ADMIN' })], SELF)

    expect(screen.getAllByRole('button', { name: new RegExp(escapeRegExp(T('resetMfa'))) })).toHaveLength(1)
    expect(within(rowOf('Writer Person')).getByRole('button', { name: resetMfaName('@writer') })).toBeInTheDocument()
  })

  it("opens an in-place panel that says what is removed and asks for the administrator's own code; focus goes to the code", async () => {
    renderTable([AUTHOR()])

    await click(screen.getByRole('button', { name: resetMfaName('@writer') }))

    const group = panel('@writer')
    expect(within(group).getByLabelText(T('resetMfaCode'))).toHaveFocus()
    expect(onResetMfa).not.toHaveBeenCalled()
  })

  it('does not call the backend without a code; with one it sends the author id and the trimmed code, once, and announces it', async () => {
    onResetMfa.mockResolvedValue({ done: true })
    renderTable([AUTHOR()])
    await click(screen.getByRole('button', { name: resetMfaName('@writer') }))
    const group = panel('@writer')

    await click(within(group).getByRole('button', { name: T('resetMfaSubmit') }))
    expect(onResetMfa).not.toHaveBeenCalled()

    fireEvent.change(within(group).getByLabelText(T('resetMfaCode')), { target: { value: ' 123456 ' } })
    await click(within(group).getByRole('button', { name: T('resetMfaSubmit') }))

    expect(onResetMfa).toHaveBeenCalledTimes(1)
    expect(onResetMfa).toHaveBeenCalledWith('author-1', '123456')
    expect(screen.queryByRole('group', { name: plain('Admin.users.table.resetMfaConfirm', { handle: '@writer' }) })).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent(plain('Admin.users.table.notice.mfaReset', { handle: '@writer' }))
    // Focus returns to the button that opened the panel.
    expect(screen.getByRole('button', { name: resetMfaName('@writer') })).toHaveFocus()
  })

  it('a refusal (wrong code, sign-in too old, delay) shows the sentence in the panel and keeps it open', async () => {
    onResetMfa.mockResolvedValue({ error: msg('Errors.admin.codes.MFA_CODE_INVALID') })
    renderTable([AUTHOR()])
    await click(screen.getByRole('button', { name: resetMfaName('@writer') }))
    const group = panel('@writer')
    fireEvent.change(within(group).getByLabelText(T('resetMfaCode')), { target: { value: '000000' } })

    await click(within(group).getByRole('button', { name: T('resetMfaSubmit') }))

    expect(within(panel('@writer')).getByRole('alert')).toHaveTextContent(msg('Errors.admin.codes.MFA_CODE_INVALID'))
    expect(screen.getByRole('status')).toHaveTextContent('')
  })

  it('Escape and Cancel close it without calling anything, focus back on the button', async () => {
    renderTable([AUTHOR()])
    await click(screen.getByRole('button', { name: resetMfaName('@writer') }))

    fireEvent.keyDown(within(panel('@writer')).getByLabelText(T('resetMfaCode')), { key: 'Escape' })

    expect(screen.queryByRole('group', { name: plain('Admin.users.table.resetMfaConfirm', { handle: '@writer' }) })).toBeNull()
    expect(onResetMfa).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: resetMfaName('@writer') })).toHaveFocus()
  })
})
