import { act, render, screen } from '@testing-library/react'
import { hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import type { ReactNode } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderMarkdown, type TocEntry } from '@/lib/markdown'
import { SITE_HEADER_VAR } from '@/lib/scroll-ui'
import { activeLinePx, tocHref, tocRootMargin } from '@/lib/toc'
import type { Post } from '@/lib/types'
import { ArticleView } from './ArticleView'
import { TocNav } from './TocNav'
import { TocSpy } from './TocSpy'
import { IntlWrapper, translatorFor } from '@/test/intl'
import { msg } from '@/test/render-intl'
import { TOC_FIRST, TOC_MARKDOWN, TOC_POST_TITLE, TOC_SECOND, TOC_THIRD } from '@/test/fixtures/vi/toc-spy'

/*
 * TocSpy runs on exactly the markup ArticleView draws from the real renderMarkdown: the island's selector and the table of contents nav
 * must match each other, which a hand-written fixture cannot see when the two drift apart.
 */

const POST: Post = {
  id: 'p1',
  title: TOC_POST_TITLE,
  slug: 'mot-bai-dai',
  excerpt: null,
  status: 'PUBLISHED',
  category: null,
  tags: [],
  featured: false,
  readingMinutes: 5,
  publishedAt: '2026-10-01T00:00:00Z',
  content: '',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
}

// The first id starts with a digit and carries diacritics: querySelector('#1-…') throws SyntaxError. An h5 has an id but is not
// in the table of contents, so it must not be observed.
const MARKDOWN = TOC_MARKDOWN

let content: ReactNode
let toc: TocEntry[]
let ids: string[]

beforeAll(async () => {
  ;({ content, toc } = await renderMarkdown(MARKDOWN))
  ids = toc.map((entry) => entry.id)
})

const observers: FakeObserver[] = []

class FakeObserver {
  readonly observed: Element[] = []
  disconnected = false
  constructor(
    readonly callback: () => void,
    readonly options?: IntersectionObserverInit,
  ) {
    observers.push(this)
  }
  observe(element: Element) {
    this.observed.push(element)
  }
  disconnect() {
    this.disconnected = true
  }
  unobserve() {}
  takeRecords() {
    return []
  }
}

/** The top edge (px, relative to the viewport) of a heading by id; defaults far below the screen. */
const tops = new Map<string, number>()

beforeEach(() => {
  observers.length = 0
  tops.clear()
  vi.stubGlobal('IntersectionObserver', FakeObserver)
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return { top: tops.get(this.id) ?? 10_000 } as DOMRect
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
  document.documentElement.style.removeProperty(SITE_HEADER_VAR)
})

/** The reading line when no header has been measured (a page without a public header, or before the header finishes measuring). */
const LINE = activeLinePx(0)

const article = () => (
  <ArticleView post={POST} content={content} toc={toc} series={null} t={translatorFor('vi', 'Site.article')} />
)

function renderArticle() {
  const view = render(article())
  const nav = screen.getByRole('navigation', { name: msg('Site.article.toc') })
  /** The link carrying aria-current, with its value: the attribute is removed entirely rather than becoming "false". */
  const marked = () =>
    [...nav.querySelectorAll('a[aria-current]')].map((a) => `${a.textContent}=${a.getAttribute('aria-current')}`)
  return { ...view, marked }
}

/** Sets the top edge of the three headings in the table of contents, then notifies the observer, as after a scroll. */
function scroll(positions: [number, number, number]) {
  ids.forEach((id, index) => tops.set(id, positions[index]!))
  act(() => observers.at(-1)!.callback())
}

/** Changes the hash without scrolling, then fires the events the browser fires after a jump or the Back button. */
function navigate(hash: string, type: 'hashchange' | 'popstate') {
  window.history.replaceState(null, '', hash)
  act(() => {
    window.dispatchEvent(type === 'hashchange' ? new HashChangeEvent('hashchange') : new PopStateEvent('popstate'))
  })
}

describe('TocSpy', () => {
  it('observes exactly the headings in the table of contents, the root starting at the reading line', () => {
    renderArticle()

    expect(ids[0]).toMatch(/^\d/)
    expect(observers).toHaveLength(1)
    const [observer] = observers
    expect(observer!.observed).toHaveLength(3)
    ids.forEach((id, index) => expect(observer!.observed[index]).toBe(document.getElementById(id)))
    expect(observer!.observed).not.toContain(screen.getByRole('heading', { level: 5 }))
    expect(observer!.options).toEqual({ rootMargin: `-${LINE}px 0px 10000% 0px`, threshold: 1 })
  })

  it('sticky header : the reading line sits below the header height, and follows when the header changes height', async () => {
    document.documentElement.style.setProperty(SITE_HEADER_VAR, '64px')
    const { marked, unmount } = renderArticle()

    expect(observers).toHaveLength(1)
    expect(observers[0]!.options?.rootMargin).toBe(tocRootMargin(64 + 40))
    // A heading just jumped to stops at header + scroll-margin (96px): already past the 104px line.
    scroll([-400, 96, 700])
    expect(marked()).toEqual([`${TOC_SECOND}=location`])
    scroll([-400, 104, 700])
    expect(marked()).toEqual([`${TOC_FIRST}=location`])

    // The header drops to two rows (device rotated, window narrowed): the old observer disconnects, a new observer with the new line.
    document.documentElement.style.setProperty(SITE_HEADER_VAR, '97px')
    await act(async () => {})
    expect(observers).toHaveLength(2)
    expect(observers[0]!.disconnected).toBe(true)
    expect(observers[1]!.options?.rootMargin).toBe(tocRootMargin(137))
    expect(observers[1]!.observed).toHaveLength(3)
    scroll([-400, 120, 700])
    expect(marked()).toEqual([`${TOC_SECOND}=location`])

    // Another style of <html> changes while the height stays the same: not recreated.
    document.documentElement.style.setProperty('--khac', '1')
    await act(async () => {})
    expect(observers).toHaveLength(2)
    document.documentElement.style.removeProperty('--khac')
    // Unmount before afterEach: afterEach clears the height variable after the fake IntersectionObserver has been removed.
    unmount()
  })

  it('each callback recomputes from the real positions: exactly one link carries aria-current="location", none before the first heading is reached', () => {
    const { marked } = renderArticle()

    scroll([300, 900, 1500])
    expect(marked()).toEqual([])

    scroll([-200, 20, 700])
    expect(marked()).toEqual([`${TOC_SECOND}=location`])

    scroll([-900, -500, LINE - 1])
    expect(marked()).toEqual([`${TOC_THIRD}=location`])

    // Back to the top of the post (Home): no item, and the attribute is removed entirely.
    scroll([300, 900, 1500])
    expect(marked()).toEqual([])
  })

  it("hash at load, hashchange, popstate: the hash's item is marked at once; a hash outside the table of contents or broken encoding is ignored", () => {
    window.history.replaceState(null, '', tocHref(ids[2]!))
    const { marked } = renderArticle()
    // Before any observer callback.
    expect(marked()).toEqual([`${TOC_THIRD}=location`])

    // An unencoded id, like the href of the # mark beside a heading: the URL encodes itself, the island decodes it back.
    navigate(`#${ids[1]}`, 'hashchange')
    expect(marked()).toEqual([`${TOC_SECOND}=location`])

    // A comment link (pushState, then Back): not an item, the item being read stays as it was.
    navigate('#binh-luan', 'popstate')
    expect(marked()).toEqual([`${TOC_SECOND}=location`])
    navigate('#%E0%A4%A', 'hashchange')
    expect(marked()).toEqual([`${TOC_SECOND}=location`])

    navigate(tocHref(ids[0]!), 'popstate')
    expect(marked()).toEqual([`${TOC_FIRST}=location`])
  })

  it('unmount: disconnects the observer and the header height watcher, removes both attached listeners', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const stopWatching = vi.spyOn(MutationObserver.prototype, 'disconnect')
    const { unmount } = renderArticle()
    const added = add.mock.calls.filter(([type]) => type === 'hashchange' || type === 'popstate')
    expect(added.map(([type]) => type).sort()).toEqual(['hashchange', 'popstate'])

    unmount()

    expect(observers[0]!.disconnected).toBe(true)
    expect(stopWatching).toHaveBeenCalled()
    for (const [type, listener] of added) expect(remove).toHaveBeenCalledWith(type, listener)
  })

  it('a browser without IntersectionObserver: does nothing, no error', () => {
    vi.unstubAllGlobals()
    window.history.replaceState(null, '', tocHref(ids[1]!))
    const { marked } = renderArticle()

    expect(typeof IntersectionObserver).toBe('undefined')
    expect(marked()).toEqual([])
  })

  it('hydrating the server HTML has no error; the server HTML carries no aria-current, the island sets it after hydration', async () => {
    window.history.replaceState(null, '', tocHref(ids[1]!))
    const host = document.createElement('div')
    host.innerHTML = renderToString(<IntlWrapper>{article()}</IntlWrapper>)
    document.body.append(host)
    expect(host.querySelector('[aria-current]')).toBeNull()

    const errors: unknown[] = []
    const root = hydrateRoot(host, <IntlWrapper>{article()}</IntlWrapper>, { onRecoverableError: (error) => errors.push(error) })
    await act(async () => {})

    expect(errors).toEqual([])
    expect(host.querySelector('a[aria-current="location"]')?.textContent).toBe(TOC_SECOND)
    root.unmount()
    host.remove()
  })
})

describe('TocSpy with both navs (inline and rail)', () => {
  const t = translatorFor('vi', 'Site.article')
  const ROW_HEIGHT = 20
  const LIST_HEIGHT = 40
  const LIST_TOP = 100
  /** Offset of each rail link inside the list content: the first fits the 40px window, the other two are below it. */
  const OFFSETS = [0, 30, 60]

  function setup(options: { reducedMotion?: boolean; scrollTop?: number } = {}) {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({ matches: options.reducedMotion === true && query.includes('prefers-reduced-motion') })),
    )
    const view = render(
      <>
        <TocNav variant="inline" toc={toc} t={t} />
        <TocNav variant="rail" toc={toc} t={t} />
        <TocSpy />
        {content}
      </>,
    )
    const list = view.container.querySelector<HTMLElement>('ul[data-toc-list]')!
    const scrollTo = vi.fn()
    list.scrollTo = scrollTo as unknown as typeof list.scrollTo
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: LIST_HEIGHT })
    Object.defineProperty(list, 'scrollTop', { configurable: true, value: options.scrollTop ?? 0 })
    const railLinks = [...list.querySelectorAll('a')]
    // The geometry of the list and its links (the existing mock only knows headings by id).
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this === list) return { top: LIST_TOP, height: LIST_HEIGHT } as DOMRect
      const index = railLinks.indexOf(this as HTMLAnchorElement)
      if (index >= 0) return { top: LIST_TOP + OFFSETS[index]! - list.scrollTop, height: ROW_HEIGHT } as DOMRect
      return { top: tops.get(this.id) ?? 10_000, height: 0 } as DOMRect
    })
    const windowScroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    const marked = (nav: Element) =>
      [...nav.querySelectorAll('a[aria-current]')].map((a) => `${a.textContent}=${a.getAttribute('aria-current')}`)
    const navs = [...view.container.querySelectorAll('nav[data-toc]')]
    return { ...view, list, scrollTo, windowScroll, scrollIntoView, marked, navs }
  }

  afterEach(() => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  })

  it('one observer marks the matching link in both navs (selector nav[data-toc])', () => {
    const { marked, navs } = setup()

    expect(navs).toHaveLength(2)
    expect(observers).toHaveLength(1)
    expect(observers[0]!.observed).toHaveLength(3)
    scroll([-200, 20, 700])
    for (const nav of navs) expect(marked(nav)).toEqual([`${TOC_SECOND}=location`])
    scroll([-900, -500, 10])
    for (const nav of navs) expect(marked(nav)).toEqual([`${TOC_THIRD}=location`])
  })

  it('a link outside the visible range of the rail list: scrolls only that list, centring the link, smoothly', () => {
    const { scrollTo, windowScroll, scrollIntoView } = setup()

    scroll([-200, 20, 700])

    // Link at offset 30 (height 20) in a 40px window: centred at 30 - 40/2 + 20/2.
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 20, behavior: 'smooth' })
    expect(windowScroll).not.toHaveBeenCalled()
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('a link already inside the visible range: no scroll', () => {
    const { scrollTo } = setup()

    scroll([20, 900, 1500])

    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('a link above the visible range scrolls the list back up', () => {
    const { scrollTo } = setup({ scrollTop: 60 })

    scroll([20, 900, 1500])

    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: -10, behavior: 'smooth' })
  })

  it('prefers-reduced-motion: the list jumps instead of animating', () => {
    const { scrollTo } = setup({ reducedMotion: true })

    scroll([-900, -500, 10])

    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 50, behavior: 'auto' })
  })

  it('the same active item confirmed again does not scroll the list a second time', () => {
    const { scrollTo } = setup()

    scroll([-200, 20, 700])
    scroll([-210, 10, 690])

    expect(scrollTo).toHaveBeenCalledTimes(1)
  })

  it('only the inline nav on the page (the preview): marks it, never touches any scroll', () => {
    const view = render(
      <>
        <TocNav variant="inline" toc={toc} t={t} spy />
        {content}
      </>,
    )
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView

    scroll([-200, 20, 700])

    expect(view.container.querySelector('a[aria-current="location"]')?.textContent).toBe(TOC_SECOND)
    expect(scrollIntoView).not.toHaveBeenCalled()
  })
})
