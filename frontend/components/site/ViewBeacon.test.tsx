import { render } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ViewBeacon } from './ViewBeacon'

/**
 * The view-count beacon: once per session per post (`sessionStorage`), sends the slug to
 * /api/views with `sendBeacon`, falling back to `fetch keepalive`; a ref blocks StrictMode running twice.
 * jsdom has no referrer and Node has no navigation entry, so tests that say nothing about the
 * referrer send the bare slug.
 */

const sendBeacon = vi.fn<(url: string, data?: BodyInit | null) => boolean>()

beforeEach(() => {
  sessionStorage.clear()
  sendBeacon.mockReset().mockReturnValue(true)
  Object.defineProperty(navigator, 'sendBeacon', { value: sendBeacon, configurable: true, writable: true })
})

afterEach(() => {
  delete (navigator as { sendBeacon?: unknown }).sendBeacon
  vi.restoreAllMocks()
})

describe('ViewBeacon', () => {
  it('sends the slug to /api/views exactly once, even under StrictMode', () => {
    const { container } = render(
      <StrictMode>
        <ViewBeacon slug="dat-van-de" />
      </StrictMode>,
    )

    expect(sendBeacon).toHaveBeenCalledTimes(1)
    expect(sendBeacon).toHaveBeenCalledWith('/api/views', 'dat-van-de')
    // Draws nothing.
    expect(container).toBeEmptyDOMElement()
  })

  it('the ref still blocks the second StrictMode run when sessionStorage is unusable', () => {
    // A browser blocking storage (old private mode, cookies disabled) throws when it is touched. Then
    // the ref is the only guard, so this test is what tells "has a ref" apart from "thanks to storage".
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })

    render(
      <StrictMode>
        <ViewBeacon slug="dat-van-de" />
      </StrictMode>,
    )

    expect(sendBeacon).toHaveBeenCalledTimes(1)
  })

  it('does not send again when this session already counted that post, but still sends for another post', () => {
    render(<ViewBeacon slug="dat-van-de" />)
    expect(sendBeacon).toHaveBeenCalledTimes(1)

    // Reloading the page (a fresh mount) in the same session.
    render(<ViewBeacon slug="dat-van-de" />)
    expect(sendBeacon).toHaveBeenCalledTimes(1)

    render(<ViewBeacon slug="bai-khac" />)
    expect(sendBeacon).toHaveBeenCalledTimes(2)
    expect(sendBeacon).toHaveBeenLastCalledWith('/api/views', 'bai-khac')
  })

  it('without sendBeacon: POST by fetch keepalive, a network error does not escape', async () => {
    delete (navigator as { sendBeacon?: unknown }).sendBeacon
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'))

    render(<ViewBeacon slug="dat-van-de" />)
    await Promise.resolve()

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('/api/views')
    expect(init).toMatchObject({ method: 'POST', body: 'dat-van-de', keepalive: true })
  })

  it('sendBeacon refuses to queue (returns false): retries with fetch keepalive', () => {
    sendBeacon.mockReturnValue(false)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))

    render(<ViewBeacon slug="dat-van-de" />)

    expect(sendBeacon).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

/** the second line is the previous page\'s host, never the whole URL (the path and query of another site). */
describe('ViewBeacon: host of the previous page', () => {
  it.each([
    ['', 'dat-van-de'],
    ['http://localhost:3000/posts/bai-truoc', 'dat-van-de\nlocalhost'],
    ['https://www.google.com/search?q=bi-mat&hl=vi#top', 'dat-van-de\nwww.google.com'],
    ['javascript:alert(1)', 'dat-van-de'],
    ['android-app://com.google.android.gm/', 'dat-van-de'],
    ['not a URL', 'dat-van-de'],
  ])('referrer %j: sends %j', (referrer, body) => {
    vi.spyOn(document, 'referrer', 'get').mockReturnValue(referrer)

    render(<ViewBeacon slug="dat-van-de" />)

    expect(sendBeacon).toHaveBeenCalledExactlyOnceWith('/api/views', body)
  })

  it('after client-side navigation (a path different from the loaded page): the previous page is the site itself, not the old referrer', () => {
    vi.spyOn(document, 'referrer', 'get').mockReturnValue('https://www.google.com/')
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      { name: 'http://localhost:3000/posts/bai-mo-dau' } as PerformanceEntry,
    ])

    render(<ViewBeacon slug="dat-van-de" />)

    expect(sendBeacon).toHaveBeenCalledExactlyOnceWith('/api/views', 'dat-van-de\nlocalhost')
  })

  it('exactly the loaded page: uses the referrer of the load', () => {
    vi.spyOn(document, 'referrer', 'get').mockReturnValue('https://www.facebook.com/')
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{ name: `${location.origin}/` } as PerformanceEntry])

    render(<ViewBeacon slug="dat-van-de" />)

    expect(sendBeacon).toHaveBeenCalledExactlyOnceWith('/api/views', 'dat-van-de\nwww.facebook.com')
  })

  it('the fetch fallback sends exactly the same body as sendBeacon', () => {
    delete (navigator as { sendBeacon?: unknown }).sendBeacon
    vi.spyOn(document, 'referrer', 'get').mockReturnValue('https://github.com/octocat')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))

    render(<ViewBeacon slug="dat-van-de" />)

    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ body: 'dat-van-de\ngithub.com', keepalive: true })
  })
})
