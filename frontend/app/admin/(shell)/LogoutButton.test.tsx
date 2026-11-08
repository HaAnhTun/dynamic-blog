import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { replace } = vi.hoisted(() => ({ replace: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }))

import { bindDraftOwner, canWriteDrafts, draftKey } from '@/lib/draft-storage'
import { RECENT_KEY } from '@/components/site/search/recent-searches'
import LogoutButton from './LogoutButton'
import { msg } from '@/test/render-intl'

const OWNER = '11111111-1111-1111-1111-111111111111'

let unbind: (() => void) | undefined

afterEach(() => {
  unbind?.()
  unbind = undefined
  vi.restoreAllMocks()
  vi.clearAllMocks()
  localStorage.clear()
  sessionStorage.clear()
})

const signOut = () => screen.getByRole('button', { name: msg('Site.account.signOut') })

describe('LogoutButton', () => {
  it('logs out (POST), returns to the login page, and clears what the browser keeps for the writer', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true })))
    localStorage.setItem(draftKey(OWNER, 'p1'), '{"v":2}')
    localStorage.setItem(draftKey(OWNER, null), '{"v":2}')
    localStorage.setItem(RECENT_KEY, '["secret topic"]')
    sessionStorage.setItem('binh-luan:nhap:bai-mot', '{"owner":"x","text":"half"}')
    localStorage.setItem('theme', 'dark')
    render(<LogoutButton />)

    await act(async () => {
      fireEvent.click(signOut())
    })

    expect(fetchSpy).toHaveBeenCalledWith('/admin/logout', { method: 'POST' })
    expect(replace).toHaveBeenCalledWith('/admin/login')
    // Shared machine: the unpublished text of the person who just left does not stay in the browser.
    expect(localStorage.getItem(draftKey(OWNER, 'p1'))).toBeNull()
    expect(localStorage.getItem(draftKey(OWNER, null))).toBeNull()
    expect(localStorage.getItem(RECENT_KEY)).toBeNull()
    expect(sessionStorage.getItem('binh-luan:nhap:bai-mot')).toBeNull()
    expect(localStorage.getItem('theme')).toBe('dark')
  })

  it('tells the login page when the server could not end the session, and still goes there and clears the drafts', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true, revoked: false })))
    localStorage.setItem(draftKey(OWNER, 'p1'), '{"v":2}')
    render(<LogoutButton />)

    await act(async () => {
      fireEvent.click(signOut())
    })

    expect(replace).toHaveBeenCalledWith('/admin/login?reason=session-not-ended')
    expect(localStorage.getItem(draftKey(OWNER, 'p1'))).toBeNull()
  })

  it('goes to the plain login page when the answer cannot be read', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not json'))
    render(<LogoutButton />)

    await act(async () => {
      fireEvent.click(signOut())
    })

    expect(replace).toHaveBeenCalledWith('/admin/login')
  })

  it('stops the open editor from writing while the request is in flight, not only after it', async () => {
    unbind = bindDraftOwner(OWNER)
    let finish: (response: Response) => void = () => {}
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise<Response>((resolve) => (finish = resolve)))
    render(<LogoutButton />)

    await act(async () => {
      fireEvent.click(signOut())
    })
    expect(canWriteDrafts(OWNER)).toBe(false)

    await act(async () => {
      finish(new Response(JSON.stringify({ ok: true })))
    })
    expect(canWriteDrafts(OWNER)).toBe(false)
    expect(replace).toHaveBeenCalledWith('/admin/login')
  })

  it('when the request fails the session is still alive: the drafts stay and the editor goes on saving them', async () => {
    unbind = bindDraftOwner(OWNER)
    localStorage.setItem(draftKey(OWNER, 'p1'), '{"v":2}')
    localStorage.setItem(RECENT_KEY, '["topic"]')
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'))
    render(<LogoutButton />)

    await act(async () => {
      fireEvent.click(signOut())
    })

    expect(canWriteDrafts(OWNER)).toBe(true)
    expect(localStorage.getItem(draftKey(OWNER, 'p1'))).not.toBeNull()
    expect(localStorage.getItem(RECENT_KEY)).not.toBeNull()
    expect(replace).not.toHaveBeenCalled()
    expect(signOut()).toBeEnabled()
  })

  it.each([502, 403, 429])(
    'an answer of status %i is not a sign-out: nothing is cleared, the editor goes on saving, and the person is told',
    async (status) => {
      // A proxy error, a refused Origin or a limiter answers before the sign-out route has cleared the cookies: the session is alive.
      unbind = bindDraftOwner(OWNER)
      localStorage.setItem(draftKey(OWNER, 'p1'), '{"v":2}')
      localStorage.setItem(RECENT_KEY, '["topic"]')
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status }))
      render(<LogoutButton />)

      await act(async () => {
        fireEvent.click(signOut())
      })

      expect(replace).not.toHaveBeenCalled()
      expect(canWriteDrafts(OWNER)).toBe(true)
      expect(localStorage.getItem(draftKey(OWNER, 'p1'))).not.toBeNull()
      expect(localStorage.getItem(RECENT_KEY)).not.toBeNull()
      expect(signOut()).toBeEnabled()
      expect(screen.getByRole('alert').textContent).toBe(msg('Admin.shell.logoutFailed'))
    },
  )

  it('tells the person when the server could not be reached, and removes the notice on the next attempt', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('network down'))
    render(<LogoutButton />)

    await act(async () => {
      fireEvent.click(signOut())
    })
    expect(screen.getByRole('alert').textContent).toBe(msg('Admin.shell.logoutFailed'))

    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true })))
    await act(async () => {
      fireEvent.click(signOut())
    })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(replace).toHaveBeenCalledWith('/admin/login')
  })
})
