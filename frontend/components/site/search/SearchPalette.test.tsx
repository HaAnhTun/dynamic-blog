import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SuggestResponse } from '@/lib/search-contract'
import { RECENT_KEY } from './recent-searches'
import { SearchPalette } from './SearchPalette'
import { DEBOUNCE_MS } from './useSuggest'
import { msg } from '@/test/render-intl'
import { COMPOSED_QUERY } from '@/test/fixtures/vi/search-input'
import { defaultSiteContent } from '@/content/defaults'

const { site } = defaultSiteContent('vi')

const session = vi.hoisted(() => ({ value: { status: 'anonymous' } as { status: string } }))
vi.mock('@/lib/session-client', () => ({ useSession: () => session.value }))

const original = { showModal: HTMLDialogElement.prototype.showModal, close: HTMLDialogElement.prototype.close }
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    if (!this.open) return
    this.removeAttribute('open')
    this.dispatchEvent(new Event('close'))
  }
})
afterAll(() => {
  HTMLDialogElement.prototype.showModal = original.showModal
  HTMLDialogElement.prototype.close = original.close
})

const seg = (text: string, match = false) => ({ text, match })

function response(query: string, extra: Partial<SuggestResponse> = {}): SuggestResponse {
  return {
    query,
    groups: [
      {
        type: 'post',
        total: 2,
        items: [
          {
            id: 'post:queue',
            title: [seg('When to add a '), seg('queue', true)],
            href: '/posts/queue',
            meta: { kind: 'post', category: 'Architecture', readingMinutes: 12 },
          },
          { id: 'post:sqs', title: [seg('From API Gateway to SQS')], href: '/posts/sqs', meta: { kind: 'post' } },
        ],
      },
      {
        type: 'topic',
        total: 1,
        items: [{ id: 'tag:aws', title: [seg('AWS')], href: '/tags/aws', meta: { kind: 'tag', count: 4 } }],
      },
    ],
    ...extra,
  }
}

type Reply = { status: number; body: unknown } | Promise<{ status: number; body: unknown }>
let suggestReplies: Array<(url: URL) => Reply>
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  suggestReplies = []
  fetchMock = vi.fn(async (input: string) => {
    const url = new URL(input, 'http://localhost')
    if (url.pathname === '/api/search/popular') return new Response(JSON.stringify({ items: [] }))
    const next = suggestReplies.shift()
    const reply = await (next ? next(url) : { status: 200, body: response(url.searchParams.get('q') ?? '') })
    return new Response(JSON.stringify(reply.body), { status: reply.status })
  })
  vi.stubGlobal('fetch', fetchMock)
  window.localStorage.clear()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const suggestCalls = () => fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith('/api/search/suggest'))

function open(onClosed = vi.fn()) {
  render(<SearchPalette onClosed={onClosed} siteName={site.name} galleryLead={null} />)
  const input = screen.getByRole('combobox', { name: msg('Site.palette.inputLabel') })
  return { input, onClosed }
}

async function type(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10)
  })
}

const activeOption = (input: HTMLElement) => document.getElementById(input.getAttribute('aria-activedescendant')!)!

describe('SearchPalette', () => {
  it('opens as a modal, focus on the field; the ARIA combobox points at the listbox; before typing it is quick navigation, no search call', () => {
    const { input } = open()

    expect(screen.getByRole('dialog', { name: msg('Site.search.heading') })).toHaveAttribute('open')
    expect(input).toHaveFocus()
    expect(input).toHaveAttribute('aria-expanded', 'true')
    const listbox = screen.getByRole('listbox')
    expect(input).toHaveAttribute('aria-controls', listbox.id)
    const nav = within(listbox).getByRole('group', { name: msg('Site.palette.sections.nav') })
    const options = within(nav).getAllByRole('option')
    expect(options.map((option) => option.getAttribute('href'))).toEqual([
      '/writing',
      '/start-here',
      '/case-studies',
      '/about',
      '/topics',
      '/archive',
      '/series',
      '/gallery',
      '/newsletter',
    ])
    // Rows are real links; the first row is preselected.
    expect(activeOption(input)).toBe(options[0])
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    expect(suggestCalls()).toEqual([])
  })

  it('asks for the popular posts of the page language', async () => {
    // The once-per-load cache is module state: start from a fresh module.
    vi.resetModules()
    const { SearchPalette: Fresh } = await import('./SearchPalette')
    await act(async () => {
      render(<Fresh onClosed={vi.fn()} siteName={site.name} galleryLead={null} />)
    })

    expect(fetchMock.mock.calls.map(([url]) => url)).toContain('/api/search/popular?lang=vi')
  })

  it('one character only filters the quick navigation locally; from 2 characters it asks, once after the debounce', async () => {
    const { input } = open()
    await type(input, 'c')
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      expect.stringContaining('Case study'),
      expect.stringContaining(msg('Site.footer.links.topics')),
      msg('Site.palette.allResults', { query: 'c' }),
    ])
    expect(suggestCalls()).toEqual([])

    fireEvent.change(input, { target: { value: 'qu' } })
    fireEvent.change(input, { target: { value: 'que' } })
    await type(input, 'queue')
    expect(suggestCalls()).toEqual(['/api/search/suggest?q=queue&type=all&lang=vi'])
    const posts = screen.getByRole('group', { name: msg('Site.about.readNextLinks.writing') })
    expect(within(posts).getAllByRole('option')[0]!.querySelector('mark')).toHaveTextContent('queue')
    expect(screen.getByRole('status')).toHaveTextContent(msg('Site.palette.announce.results', { count: 3 }))
  })

  it('↑/↓ wrap around, Home/End go to the first/last, Enter opens the selected row (a real link) and saves it to recent searches', async () => {
    const { input, onClosed } = open()
    await type(input, 'queue')
    const options = screen.getAllByRole('option')

    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(activeOption(input)).toBe(options.at(-1))
    expect(options.at(-1)).toHaveAttribute('href', '/search?q=queue')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(activeOption(input)).toBe(options[0])
    fireEvent.keyDown(input, { key: 'End' })
    expect(activeOption(input)).toBe(options.at(-1))
    fireEvent.keyDown(input, { key: 'Home' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })

    const clicked: string[] = []
    document.addEventListener(
      'click',
      (event) => {
        clicked.push((event.target as HTMLAnchorElement).getAttribute('href') ?? '')
        event.preventDefault()
      },
      { once: true },
    )
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(clicked).toEqual(['/posts/sqs'])
    expect(onClosed).toHaveBeenCalledWith(true)
    expect(JSON.parse(window.localStorage.getItem(RECENT_KEY)!)).toEqual(['queue'])
  })

  it('a slow response to an old query does not overwrite the new query; Enter when the results do not yet match the query goes to /search', async () => {
    let releaseOld!: () => void
    suggestReplies.push(
      () => new Promise((resolve) => (releaseOld = () => resolve({ status: 200, body: response('queue', { groups: [] }) }))),
    )
    const { input } = open()
    await type(input, 'queue')
    await type(input, 'lambda')
    expect(screen.getByRole('group', { name: msg('Site.about.readNextLinks.writing') })).toBeInTheDocument()
    await act(async () => releaseOld())
    // The answer for "queue" (no group) arrives later, but does not replace the results of "lambda".
    expect(screen.getByRole('group', { name: msg('Site.about.readNextLinks.writing') })).toBeInTheDocument()

    // Typing more: the results shown are those of "lambda", Enter must not open its post.
    fireEvent.change(input, { target: { value: 'lambda sqs' } })
    const clicked: string[] = []
    document.addEventListener(
      'click',
      (event) => {
        clicked.push((event.target as HTMLAnchorElement).getAttribute('href') ?? '')
        event.preventDefault()
      },
      { once: true },
    )
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(clicked).toEqual(['/search?q=lambda+sqs'])
  })

  it('while composing text with an input method (Telex/VNI): no search, Enter and arrows belong to the input method', async () => {
    const { input, onClosed } = open()
    fireEvent.compositionStart(input)
    await type(input, COMPOSED_QUERY)
    expect(suggestCalls()).toEqual([])
    fireEvent.compositionEnd(input)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10)
    })
    expect(suggestCalls()).toEqual(['/api/search/suggest?q=qu%C3%AA&type=all&lang=vi'])

    await type(input, 'queue')
    const before = activeOption(input)
    fireEvent.keyDown(input, { key: 'ArrowDown', keyCode: 229 })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(activeOption(input)).toBe(before)
    expect(onClosed).not.toHaveBeenCalled()
  })

  it('"no results" and "could not search" are two different states; exceeding the quota has its own message', async () => {
    suggestReplies.push(() => ({ status: 200, body: { query: 'zzz', groups: [] } }))
    suggestReplies.push(() => ({ status: 502, body: { error: { code: 'UPSTREAM_UNAVAILABLE' } } }))
    suggestReplies.push(() => ({ status: 429, body: { error: { code: 'RATE_LIMITED' } } }))
    const { input } = open()

    await type(input, 'zzz')
    expect(screen.getByText(msg('Site.palette.noMatch.title', { query: 'zzz' }))).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('link', { name: msg('Site.palette.noMatch.openFullSearch') })).toHaveAttribute(
      'href',
      '/search?q=zzz',
    )

    await type(input, 'lambda')
    expect(screen.getByRole('alert')).toHaveTextContent(msg('Site.palette.unavailable.failed'))
    expect(screen.queryByText(msg('Site.palette.announce.none'))).toBeNull()

    await type(input, 'kafka')
    // The route's per-IP quota or the backend's shared ceiling: the same code, so the message does not blame the reader.
    expect(screen.getByRole('alert')).toHaveTextContent(msg('Site.search.busy'))
  })

  it('degraded: a basic-search notice line in the results area, not an alert; the read-out sentence has it once', async () => {
    suggestReplies.push((url) => ({ status: 200, body: response(url.searchParams.get('q') ?? '', { degraded: true }) }))
    const { input } = open()

    await type(input, 'queue')
    const notice = screen.getByText(msg('Site.search.degraded'))
    expect(notice.tagName).toBe('P')
    expect(notice.closest('[role="alert"], [role="status"], [role="listbox"]')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    // Results still show as usual, only a notice line is added.
    expect(screen.getByRole('group', { name: msg('Site.about.readNextLinks.writing') })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(
      new RegExp(`^${msg('Site.palette.announce.resultsDegraded', { count: 3 })}$`),
    )

    // The engine is back to normal: the notice line is gone.
    await type(input, 'lambda')
    expect(screen.queryByText(msg('Site.search.degraded'))).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent(new RegExp(`^${msg('Site.palette.announce.results', { count: 3 })}$`))
  })

  it('one character matching no page: Enter still goes to /search; Ctrl+←/→ is not swallowed when there are no tabs', async () => {
    const { input } = open()
    await type(input, 'z')
    expect(screen.getAllByRole('option').map((option) => option.getAttribute('href'))).toEqual(['/search?q=z'])
    expect(fireEvent.keyDown(input, { key: 'ArrowRight', ctrlKey: true })).toBe(true)
    const clicked: string[] = []
    document.addEventListener(
      'click',
      (event) => {
        clicked.push((event.target as HTMLAnchorElement).getAttribute('href') ?? '')
        event.preventDefault()
      },
      { once: true },
    )
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(clicked).toEqual(['/search?q=z'])
  })

  it('Ctrl/⌘-clicking the "full search page" link is a new tab: the panel stays open', async () => {
    suggestReplies.push(() => ({ status: 200, body: { query: 'zzz', groups: [] } }))
    const { input, onClosed } = open()
    await type(input, 'zzz')
    const link = screen.getByRole('link', { name: msg('Site.palette.noMatch.openFullSearch') })
    link.addEventListener('click', (event) => event.preventDefault(), { once: true })
    fireEvent.click(link, { ctrlKey: true })
    expect(onClosed).not.toHaveBeenCalled()
  })

  it('tabs only for kinds with results; ←/→ on a tab and Ctrl+←/→ from the field change tab, keeping the query; Tab is not taken over', async () => {
    const { input } = open()
    await type(input, 'queue')
    const tablist = screen.getByRole('tablist', { name: msg('Site.palette.tabsLabel') })
    expect(
      within(tablist)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual([
      msg('Site.notifications.center.filterAll'),
      msg('Site.about.readNextLinks.writing'),
      msg('Site.footer.links.topics'),
    ])

    const all = within(tablist).getByRole('tab', { name: msg('Site.notifications.center.filterAll') })
    expect(all).toHaveAttribute('aria-selected', 'true')
    expect(all).toHaveAttribute('tabindex', '0')
    fireEvent.keyDown(all, { key: 'ArrowRight' })
    expect(within(tablist).getByRole('tab', { name: msg('Site.about.readNextLinks.writing') })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(within(tablist).getByRole('tab', { name: msg('Site.about.readNextLinks.writing') })).toHaveFocus()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10)
    })
    expect(suggestCalls().at(-1)).toBe('/api/search/suggest?q=queue&type=post&lang=vi')
    expect(input).toHaveValue('queue')

    fireEvent.keyDown(input, { key: 'ArrowRight', ctrlKey: true })
    expect(within(tablist).getByRole('tab', { name: msg('Site.footer.links.topics') })).toHaveAttribute('aria-selected', 'true')
    expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(true)
  })

  it('Esc closes (no navigation); recent searches stay on the device only, clicking one refills it, can be deleted, a broken localStorage still works', async () => {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(['spring boot', 'queue']))
    const { input, onClosed } = open()
    const recent = screen.getByRole('group', { name: msg('Site.palette.sections.recent') })
    fireEvent.click(within(recent).getAllByRole('option')[0]!)
    expect(input).toHaveValue('spring boot')
    expect(onClosed).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: '' } })
    // The delete button at every screen size (the panel footer only hides the key hints below 640px), and focus returns to the field when the button disappears.
    const clear = screen.getByRole('button', { name: msg('Site.palette.clearRecent') })
    expect(clear.parentElement).not.toHaveClass('hidden')
    fireEvent.click(clear)
    expect(input).toHaveFocus()
    expect(screen.queryByRole('group', { name: msg('Site.palette.sections.recent') })).toBeNull()
    expect(window.localStorage.getItem(RECENT_KEY)).toBeNull()

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClosed).toHaveBeenCalledWith(false)
  })

  it('localStorage throws (private window): the panel still opens, no recent searches', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    open()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: msg('Site.palette.sections.recent') })).toBeNull()
  })
})
