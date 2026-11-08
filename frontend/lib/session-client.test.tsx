import { act, render, screen, waitFor } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from './types'

/**
 * The session store is module state that lives for a whole page load: exactly what it promises ("call
 * /api/session once per page load"), and also the reason each test reloads the module from scratch
 * (`vi.resetModules` + dynamic import) instead of exporting a reset function just for tests.
 */
type Store = typeof import('./session-client')

const USER: SessionUser = {
  displayName: 'Alice Reader',
  githubLogin: 'doc-gia',
  avatarUrl: 'https://avatars.githubusercontent.com/u/42?v=4',
  role: 'USER',
  joinedAt: '2026-10-01T08:00:00Z',
  canAccessAdmin: false,
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** Loads a brand new module and a component reading it, printing the state as text for the test to compare. */
async function freshStore() {
  vi.resetModules()
  const store: Store = await import('./session-client')
  function Probe({ id = 'probe' }: { id?: string }) {
    const session = store.useSession()
    const text =
      session.status === 'authenticated'
        ? `authenticated:${session.user.displayName}`
        : session.status === 'anonymous'
          ? `anonymous:${session.loggedOut ? 'logged-out' : 'guest'}`
          : 'loading'
    return <p data-testid={id}>{text}</p>
  }
  return { store, Probe }
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useSession: one /api/session call per page load', () => {
  it('server render is loading and calls nothing: cacheable HTML carries no user data', async () => {
    const { Probe } = await freshStore()

    expect(renderToString(<Probe />)).toContain('loading')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('calls /api/session exactly once even with several islands reading, including on remount', async () => {
    fetchMock.mockResolvedValue(json(200, { data: USER }))
    const { Probe } = await freshStore()

    const first = render(
      <>
        <Probe id="a" />
        <Probe id="b" />
      </>,
    )
    expect(screen.getByTestId('a')).toHaveTextContent('loading')
    await waitFor(() => expect(screen.getByTestId('a')).toHaveTextContent('authenticated:Alice Reader'))
    expect(screen.getByTestId('b')).toHaveTextContent('authenticated:Alice Reader')

    first.unmount()
    render(<Probe id="c" />)
    expect(screen.getByTestId('c')).toHaveTextContent('authenticated:Alice Reader')

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/session')
    // no-store: the session belongs to this person, right now; no cache may keep it.
    expect(init).toMatchObject({ cache: 'no-store', credentials: 'same-origin' })
  })

  it('null data is anonymous', async () => {
    fetchMock.mockResolvedValue(json(200, { data: null }))
    const { Probe } = await freshStore()

    render(<Probe />)

    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('anonymous:guest'))
  })

  it.each([
    ['502 when the backend does not answer', () => Promise.resolve(json(502, { error: { code: 'UPSTREAM_UNAVAILABLE' } }))],
    ['network error', () => Promise.reject(new TypeError('fetch failed'))],
    ['response is not JSON', () => Promise.resolve(new Response('<html>', { status: 200 }))],
    ['payload off the contract', () => Promise.resolve(json(200, { data: { displayName: 'X', role: 'ROOT' } }))],
  ])('%s: becomes anonymous, not stuck on loading', async (_label, answer) => {
    fetchMock.mockImplementation(answer)
    const { Probe } = await freshStore()

    render(<Probe />)

    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('anonymous:guest'))
  })
})

describe('getSessionSnapshot: the session right now for code outside React', () => {
  it("read only: does not call /api/session itself, then follows the store's changes exactly", async () => {
    fetchMock.mockResolvedValue(json(200, { data: USER }))
    const { store, Probe } = await freshStore()

    // The notification store reading it before anyone subscribes must not open a session request either.
    expect(store.getSessionSnapshot()).toEqual({ status: 'loading' })
    expect(fetchMock).not.toHaveBeenCalled()

    render(<Probe />)
    await waitFor(() => expect(store.getSessionSnapshot()).toEqual({ status: 'authenticated', user: USER }))

    act(() => store.setAnonymous())
    expect(store.getSessionSnapshot()).toEqual({ status: 'anonymous', loggedOut: false })
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})

describe('setAnonymous', () => {
  it('puts the current session back to anonymous, without calling /api/session again', async () => {
    fetchMock.mockResolvedValue(json(200, { data: USER }))
    const { store, Probe } = await freshStore()
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('authenticated'))

    act(() => store.setAnonymous())

    // Not "logged out": an expired session (a 401) is not the user clicking sign out.
    expect(screen.getByTestId('probe')).toHaveTextContent('anonymous:guest')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('wins over a late /api/session answer', async () => {
    let answer: (response: Response) => void = () => {}
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => (answer = resolve)))
    const { store, Probe } = await freshStore()
    render(<Probe />)
    expect(screen.getByTestId('probe')).toHaveTextContent('loading')

    act(() => store.setAnonymous())
    await act(async () => answer(json(200, { data: USER })))

    expect(screen.getByTestId('probe')).toHaveTextContent('anonymous:guest')
  })
})

describe('logout', () => {
  it('POST /api/auth/logout, then the session becomes "logged out"', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { data: USER })).mockResolvedValueOnce(new Response(null, { status: 204 }))
    const { store, Probe } = await freshStore()
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('authenticated'))

    let ok = false
    await act(async () => {
      ok = await store.logout()
    })

    expect(ok).toBe(true)
    expect(screen.getByTestId('probe')).toHaveTextContent('anonymous:logged-out')
    const [url, init] = fetchMock.mock.calls[1]!
    expect(url).toBe('/api/auth/logout')
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin' })
    // The reader sign-out route returns 415 for every POST that is not JSON.
    expect(new Headers(init!.headers).get('content-type')).toBe('application/json')
  })

  describe('what the browser keeps for the person who signs out', () => {
    const seed = () => {
      localStorage.setItem('bai-viet:nhap:11111111-1111-1111-1111-111111111111:42', '{"v":2}')
      localStorage.setItem('bai-viet:nhap:11111111-1111-1111-1111-111111111111:moi', '{"v":2}')
      localStorage.setItem('search.recent.v1', '["a private topic"]')
      sessionStorage.setItem('binh-luan:nhap:bai-mot', '{"owner":"gh:x","text":"half a comment"}')
      sessionStorage.setItem('binh-luan:nhap-cho:bai-mot', '{"owner":"gh:x","kind":"reply","id":"c","text":"half"}')
      localStorage.setItem('theme', 'dark')
      sessionStorage.setItem('view:bai-mot', '1')
    }
    const keysOf = (storage: Storage) => Object.keys(storage).sort()

    afterEach(() => {
      localStorage.clear()
      sessionStorage.clear()
    })

    it('a sign-out that went through clears the editor drafts, the recent searches and the comment drafts, and only those', async () => {
      seed()
      fetchMock.mockResolvedValueOnce(json(200, { data: USER })).mockResolvedValueOnce(new Response(null, { status: 204 }))
      const { store, Probe } = await freshStore()
      render(<Probe />)
      await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('authenticated'))

      await act(async () => {
        await store.logout()
      })

      expect(keysOf(localStorage)).toEqual(['theme'])
      expect(keysOf(sessionStorage)).toEqual(['view:bai-mot'])
    })

    it('a sign-out that failed keeps everything: the person is still signed in', async () => {
      seed()
      const before = [keysOf(localStorage), keysOf(sessionStorage)]
      fetchMock.mockResolvedValueOnce(json(200, { data: USER })).mockRejectedValueOnce(new TypeError('fetch failed'))
      const { store, Probe } = await freshStore()
      render(<Probe />)
      await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('authenticated'))

      await act(async () => {
        await store.logout()
      })

      expect([keysOf(localStorage), keysOf(sessionStorage)]).toEqual(before)
    })
  })

  it.each([
    ['network error', () => Promise.reject(new TypeError('fetch failed'))],
    ['403 from another origin', () => Promise.resolve(json(403, { error: { code: 'FORBIDDEN' } }))],
  ])('%s: returns false and the session is kept, because the cookie is still in the browser', async (_label, answer) => {
    fetchMock.mockResolvedValueOnce(json(200, { data: USER })).mockImplementationOnce(answer)
    const { store, Probe } = await freshStore()
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('authenticated'))

    let ok = true
    await act(async () => {
      ok = await store.logout()
    })

    expect(ok).toBe(false)
    expect(screen.getByTestId('probe')).toHaveTextContent('authenticated:Alice Reader')
  })
})
