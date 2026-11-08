import { act, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from './session-client'

/**
 * The store of the unread-notification count. Like the session store, it is module state that lives for a whole
 * page load, so each test reloads the module (`vi.resetModules` + dynamic import). The session store is replaced by a
 * fixed value: all that matters here is how the notification store reads it, and whether it calls `setAnonymous`.
 * The clock is fake: a 60 second beat, a 15 second brake.
 */

const sessionState = vi.hoisted(() => ({
  value: { status: 'authenticated', user: {} } as unknown as Session,
  setAnonymous: vi.fn(),
}))
vi.mock('./session-client', () => ({
  getSessionSnapshot: () => sessionState.value,
  setAnonymous: sessionState.setAnonymous,
}))

type Store = typeof import('./notifications-client')

const SIGNED_IN = { status: 'authenticated', user: {} } as unknown as Session

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function countOf(count: number): Response {
  return json(200, { data: { count } })
}

let fetchMock: ReturnType<typeof vi.fn>
let visibility: DocumentVisibilityState = 'visible'

function unreadCalls(): number {
  return fetchMock.mock.calls.filter(([url]) => url === '/api/notifications/unread-count').length
}

async function freshStore() {
  vi.resetModules()
  const store: Store = await import('./notifications-client')
  function Probe({ id = 'probe' }: { id?: string }) {
    const count = store.useUnreadCount()
    return <p data-testid={id}>{count === null ? 'null' : String(count)}</p>
  }
  return { store, Probe }
}

/** Lets pending promises (fake fetch, `res.json()`) finish, inside act. */
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

function setVisibility(next: DocumentVisibilityState) {
  visibility = next
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

function shown(id = 'probe'): string {
  return screen.getByTestId(id).textContent ?? ''
}

beforeEach(() => {
  vi.useFakeTimers()
  sessionState.value = SIGNED_IN
  sessionState.setAnonymous.mockReset()
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  fetchMock = vi.fn(async () => countOf(3))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  // Back to the Document.prototype getter.
  Reflect.deleteProperty(document, 'visibilityState')
})

describe('useUnreadCount: who may start asking', () => {
  it("server render is null and calls nothing: cacheable HTML carries nobody's number", async () => {
    const { Probe } = await freshStore()

    expect(renderToString(<Probe />)).toContain('null')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['asking for the session', { status: 'loading' }],
    ['anonymous', { status: 'anonymous', loggedOut: false }],
  ])('%s: never asks, even when the tab is focused or many minutes pass', async (_label, value) => {
    sessionState.value = value as Session
    const { Probe } = await freshStore()

    render(<Probe />)
    await flush()
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    setVisibility('visible')
    await advance(5 * 60_000)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(shown()).toBe('null')
  })

  it('signed in: asks once at the start, with a same-origin no-store GET', async () => {
    const { Probe } = await freshStore()

    render(<Probe />)
    expect(shown()).toBe('null')
    await flush()

    expect(shown()).toBe('3')
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/notifications/unread-count')
    expect(init).toMatchObject({ cache: 'no-store', credentials: 'same-origin' })
    expect(init?.method ?? 'GET').toBe('GET')
  })

  it('StrictMode (subscribe, unsubscribe, subscribe) and two islands reading together: still one request', async () => {
    const { Probe } = await freshStore()

    render(
      <StrictMode>
        <Probe id="a" />
        <Probe id="b" />
      </StrictMode>,
    )
    await flush()

    expect(unreadCalls()).toBe(1)
    expect(shown('a')).toBe('3')
    expect(shown('b')).toBe('3')
  })
})

describe('polling beat', () => {
  it('once every 60 seconds while the tab is visible', async () => {
    const { Probe } = await freshStore()
    render(<Probe />)
    await flush()
    expect(unreadCalls()).toBe(1)

    fetchMock.mockImplementation(async () => countOf(5))
    await advance(59_000)
    expect(unreadCalls()).toBe(1)
    await advance(1_000)
    expect(unreadCalls()).toBe(2)
    expect(shown()).toBe('5')
    await advance(60_000)
    expect(unreadCalls()).toBe(3)
  })

  it('a hidden tab stops asking; becoming visible asks at once, then the beat restarts from there', async () => {
    const { Probe } = await freshStore()
    render(<Probe />)
    await flush()

    setVisibility('hidden')
    await advance(10 * 60_000)
    expect(unreadCalls()).toBe(1)

    setVisibility('visible')
    await flush()
    expect(unreadCalls()).toBe(2)
    await advance(59_000)
    expect(unreadCalls()).toBe(2)
    await advance(1_000)
    expect(unreadCalls()).toBe(3)
  })

  it('returning to the tab: the visibilitychange + focus pair gives only one request (15 second brake and sharing the in-flight one)', async () => {
    const { Probe } = await freshStore()
    render(<Probe />)
    await flush()
    setVisibility('hidden')
    await advance(2 * 60_000)

    setVisibility('visible')
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await flush()
    expect(unreadCalls()).toBe(2)

    // Within 15 seconds after that ask, an extra focus does not ask either.
    await advance(10_000)
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await flush()
    expect(unreadCalls()).toBe(2)
  })

  it('while a request is in flight: refreshUnread() shares it, does not send another', async () => {
    let answer: (response: Response) => void = () => {}
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (answer = resolve)))
    const { store, Probe } = await freshStore()
    render(<Probe />)

    const first = store.refreshUnread()
    const second = store.refreshUnread()
    expect(unreadCalls()).toBe(1)

    await act(async () => {
      answer(countOf(4))
      await Promise.all([first, second])
    })
    expect(shown()).toBe('4')
  })

  it('refreshUnread() skips the 15 second brake: the reader just opened the panel or the notifications page', async () => {
    const { store, Probe } = await freshStore()
    render(<Probe />)
    await flush()
    fetchMock.mockImplementation(async () => countOf(7))

    await act(async () => {
      await store.refreshUnread()
    })

    expect(unreadCalls()).toBe(2)
    expect(shown()).toBe('7')
  })

  it('the last unsubscribe stops every timer and every listener', async () => {
    const { Probe } = await freshStore()
    const view = render(<Probe />)
    await flush()

    view.unmount()
    await advance(10 * 60_000)
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    setVisibility('hidden')
    setVisibility('visible')
    await flush()

    expect(unreadCalls()).toBe(1)
  })
})

describe('ordering: an old answer does not bring the badge back', () => {
  it('a request started before applyUnread() and returning after it is dropped', async () => {
    let answer: (response: Response) => void = () => {}
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (answer = resolve)))
    const { store, Probe } = await freshStore()
    render(<Probe />)
    expect(unreadCalls()).toBe(1)

    // The reader just did "mark all as read": the server says 0.
    act(() => store.applyUnread(0))
    expect(shown()).toBe('0')
    // The old request (started before the write) returns late with the number from before the write.
    await act(async () => {
      answer(countOf(5))
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(shown()).toBe('0')
  })

  it('a request started AFTER the write is accepted', async () => {
    const { store, Probe } = await freshStore()
    render(<Probe />)
    await flush()
    act(() => store.applyUnread(0))

    fetchMock.mockImplementation(async () => countOf(2))
    await advance(60_000)

    expect(shown()).toBe('2')
  })

  it('applyUnread() ignores an invalid number', async () => {
    const { store, Probe } = await freshStore()
    render(<Probe />)
    await flush()

    act(() => {
      store.applyUnread(-1)
      store.applyUnread(1.5)
      store.applyUnread(Number.NaN)
    })

    expect(shown()).toBe('3')
  })
})

describe('errors while asking in the background', () => {
  it.each([
    [401, 'UNAUTHENTICATED'],
    [403, 'USER_SUSPENDED'],
    // The backend has not restarted yet: its `denyAll`.
    [403, 'FORBIDDEN'],
  ])('%i %s: stops asking for this page load, hides the number, does NOT call setAnonymous', async (status, code) => {
    const { Probe } = await freshStore()
    render(<Probe />)
    await flush()
    expect(shown()).toBe('3')

    fetchMock.mockImplementation(async () => json(status, { error: { code } }))
    await advance(60_000)
    expect(shown()).toBe('null')
    expect(unreadCalls()).toBe(2)

    await advance(10 * 60_000)
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    setVisibility('hidden')
    setVisibility('visible')
    await flush()

    expect(unreadCalls()).toBe(2)
    expect(sessionState.setAnonymous).not.toHaveBeenCalled()
  })

  it('after stopping, a correct number from a reader action lets automatic asking run again', async () => {
    fetchMock.mockImplementation(async () => json(403, { error: { code: 'FORBIDDEN' } }))
    const { store, Probe } = await freshStore()
    render(<Probe />)
    await flush()
    await advance(5 * 60_000)
    expect(unreadCalls()).toBe(1)

    // The reader opens the panel: refreshUnread() still asks (skipping the brake), and this time the server answers.
    fetchMock.mockImplementation(async () => countOf(1))
    await act(async () => {
      await store.refreshUnread()
    })
    expect(shown()).toBe('1')

    await advance(60_000)
    expect(unreadCalls()).toBe(3)
  })

  it.each([
    ['500', async () => json(500, { error: { code: 'INTERNAL_ERROR' } })],
    ['network error', async () => Promise.reject(new TypeError('fetch failed'))],
    ['payload off the contract (negative number)', async () => countOf(-1)],
    ['payload off the contract (string)', async () => json(200, { data: { count: '3' } })],
  ])('%s: keeps the old number, the next beat retries', async (_label, answer) => {
    const { Probe } = await freshStore()
    render(<Probe />)
    await flush()

    fetchMock.mockImplementation(answer)
    await advance(60_000)
    expect(shown()).toBe('3')

    fetchMock.mockImplementation(async () => countOf(6))
    await advance(60_000)
    expect(shown()).toBe('6')
    expect(unreadCalls()).toBe(3)
  })
})

describe('markNotificationRead', () => {
  const ID = '0b9a5a4e-7c1d-4f7e-8f52-3c1e2d9a6b10'

  it('POST /api/notifications/<id>/read with keepalive and JSON, then applies the number the server returns', async () => {
    const { store, Probe } = await freshStore()
    render(<Probe />)
    await flush()
    fetchMock.mockImplementation(async () => countOf(2))

    await act(async () => {
      await store.markNotificationRead(ID)
    })

    const call = fetchMock.mock.calls.find(([url]) => url === `/api/notifications/${ID}/read`)!
    expect(call[1]).toMatchObject({ method: 'POST', keepalive: true, credentials: 'same-origin' })
    expect(new Headers(call[1]!.headers).get('content-type')).toBe('application/json')
    expect(shown()).toBe('2')
  })

  it("401 after the reader's click: session becomes anonymous, like every 401 after an action", async () => {
    const { store } = await freshStore()
    fetchMock.mockImplementation(async () => json(401, { error: { code: 'UNAUTHENTICATED' } }))

    await store.markNotificationRead(ID)

    expect(sessionState.setAnonymous).toHaveBeenCalledOnce()
  })

  it('404 or a network error: does not throw, does not change the session', async () => {
    const { store } = await freshStore()
    fetchMock.mockImplementationOnce(async () => json(404, { error: { code: 'NOTIFICATION_NOT_FOUND' } }))
    fetchMock.mockImplementationOnce(async () => Promise.reject(new TypeError('fetch failed')))

    await expect(store.markNotificationRead(ID)).resolves.toBeUndefined()
    await expect(store.markNotificationRead(ID)).resolves.toBeUndefined()
    expect(sessionState.setAnonymous).not.toHaveBeenCalled()
  })
})

describe('parseUnreadCount', () => {
  it.each([
    [{ count: 0 }, 0],
    [{ count: 100 }, 100],
    [{ count: -1 }, null],
    [{ count: 1.5 }, null],
    [{ count: '3' }, null],
    [{}, null],
    [null, null],
    ['3', null],
  ])('%j → %j', async (value, expected) => {
    const { store } = await freshStore()

    expect(store.parseUnreadCount(value)).toBe(expected)
  })
})
