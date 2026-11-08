import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DRAFT_TTL_MS,
  bindDraftOwner,
  canWriteDrafts,
  clearLocalDrafts,
  draftKey,
  suspendDraftWrites,
  type EditorSnapshot,
} from '@/lib/draft-storage'
import { DRAFT_DEBOUNCE_MS, useDraftAutosave } from './useDraftAutosave'
import { msg } from '@/test/render-intl'

/*
 * The editor's local draft. A fake clock: writing 1 second after the last keystroke is what is
 * tested, and it can only be tested when the test controls time.
 */

const SERVER: EditorSnapshot = {
  title: 'Saved version',
  slug: 'ban-da-luu',
  excerpt: '',
  content: 'noi dung da luu',
  categoryId: 'c1',
  tagIds: ['t1'],
}
const EDITED: EditorSnapshot = { ...SERVER, content: 'noi dung da luu va them doan moi' }
const UPDATED_AT = '2026-10-09T03:00:00.000Z'
const NOW = new Date('2026-10-09T05:00:00.000Z')
const OWNER = '11111111-1111-1111-1111-111111111111'
const OTHER_OWNER = '22222222-2222-2222-2222-222222222222'
const KEY = draftKey(OWNER, 'p1')

type Props = {
  owner: string | null
  postId: string | null
  base: string | null
  current: EditorSnapshot
  saved: EditorSnapshot
  dirty: boolean
}

const clean: Props = { owner: OWNER, postId: 'p1', base: UPDATED_AT, current: SERVER, saved: SERVER, dirty: false }
const edited: Props = { ...clean, current: EDITED, dirty: true }

function stored(key = KEY): unknown {
  const raw = localStorage.getItem(key)
  return raw === null ? null : JSON.parse(raw)
}

function store(value: unknown, key = KEY): void {
  localStorage.setItem(key, JSON.stringify(value))
}

function draft(over: Record<string, unknown> = {}) {
  return { v: 2, owner: OWNER, base: UPDATED_AT, at: '2026-10-09T04:30:00.000Z', snapshot: EDITED, ...over }
}

function mount(props: Props) {
  return renderHook((p: Props) => useDraftAutosave(p), { initialProps: props })
}

let unbind: () => void

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  localStorage.clear()
  // The admin shell binds the signed-in account when it mounts; the editor writes only for that account.
  unbind = bindDraftOwner(OWNER)
})

afterEach(() => {
  unbind()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('useDraftAutosave: ghi', () => {
  it('key per account and post: bai-viet:nhap:<user>:<id>, a new post is bai-viet:nhap:<user>:moi', () => {
    expect(draftKey(OWNER, 'p1')).toBe(`bai-viet:nhap:${OWNER}:p1`)
    expect(draftKey(OWNER, null)).toBe(`bai-viet:nhap:${OWNER}:moi`)
  })

  it('only writes when there is a change, one second after the last keystroke', () => {
    const hook = mount(clean)
    act(() => {
      vi.advanceTimersByTime(5 * DRAFT_DEBOUNCE_MS)
    })
    expect(stored()).toBeNull()

    hook.rerender(edited)
    act(() => {
      vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS - 1)
    })
    expect(stored()).toBeNull()
    act(() => {
      vi.advanceTimersByTime(1)
    })

    // `at` is the write time: the fake clock has advanced 5 + 1 seconds since NOW.
    expect(stored()).toEqual({
      v: 2,
      owner: OWNER,
      base: UPDATED_AT,
      at: new Date(NOW.getTime() + 6 * DRAFT_DEBOUNCE_MS).toISOString(),
      snapshot: EDITED,
    })
  })

  it('typing again restarts the count, and the record is the newest one', () => {
    const hook = mount(clean)
    hook.rerender(edited)
    act(() => {
      vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS - 200)
    })
    const later = { ...EDITED, content: `${EDITED.content} nua` }
    hook.rerender({ ...edited, current: later })
    act(() => {
      vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS - 200)
    })
    expect(stored()).toBeNull()

    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(stored()).toMatchObject({ snapshot: later })
  })

  it('no more changes (saved, or retyped to exactly the saved version) deletes the draft at once', () => {
    const hook = mount(edited)
    act(() => {
      vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS)
    })
    expect(stored()).not.toBeNull()

    hook.rerender(clean)
    expect(stored()).toBeNull()
  })

  it('closing or reloading the tab before the second is up: pagehide writes the pending version at once', () => {
    const hook = mount(clean)
    hook.rerender(edited)

    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })

    expect(stored()).toMatchObject({ snapshot: EDITED })
  })

  it('base is the updatedAt of the server version at write time: after saving, the page rebuilds with a new updatedAt so the next record carries a new base', () => {
    const hook = mount(edited)
    act(() => {
      vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS)
    })
    expect(stored()).toMatchObject({ base: UPDATED_AT })

    const savedAgain = '2026-10-09T04:59:00.000Z'
    hook.rerender({ ...edited, base: savedAgain, current: { ...EDITED, title: msg('Admin.analytics.sources.group.other') } })
    act(() => {
      vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS)
    })

    expect(stored()).toMatchObject({ base: savedAgain })
  })

  it('forget (a new post was just created and navigated): deletes, and does not write again even with a timer still pending', () => {
    const hook = mount({ ...edited, postId: null, base: null })
    act(() => {
      vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS)
    })
    expect(stored(draftKey(OWNER, null))).not.toBeNull()

    hook.rerender({ ...edited, postId: null, base: null, current: { ...EDITED, title: 'typed more before saving' } })
    act(() => {
      hook.result.current.forget()
    })
    act(() => {
      vi.advanceTimersByTime(5 * DRAFT_DEBOUNCE_MS)
    })
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })

    expect(stored(draftKey(OWNER, null))).toBeNull()
  })
})

describe('useDraftAutosave: restore', () => {
  it('a draft of exactly this server version that differs from it: offers a restore; restore returns that draft', () => {
    store(draft())
    const hook = mount(clean)

    expect(hook.result.current.offer).toMatchObject({ at: '2026-10-09T04:30:00.000Z', snapshot: EDITED })
    let restored: EditorSnapshot | null = null
    act(() => {
      restored = hook.result.current.restore()
    })
    expect(restored).toEqual(EDITED)
    expect(hook.result.current.offer).toBeNull()
  })

  it('while offering, the old draft is not overwritten, even when the writer has typed', () => {
    store(draft())
    const hook = mount(clean)
    hook.rerender({ ...edited, current: { ...SERVER, title: 'typed something else' } })
    act(() => {
      vi.advanceTimersByTime(5 * DRAFT_DEBOUNCE_MS)
    })

    expect(stored()).toEqual(draft())
    expect(hook.result.current.offer).not.toBeNull()
  })

  it('"Discard": deletes the draft, stops offering, then writes normally again', () => {
    store(draft())
    const hook = mount(clean)

    act(() => {
      hook.result.current.discard()
    })

    expect(hook.result.current.offer).toBeNull()
    expect(stored()).toBeNull()
    hook.rerender(edited)
    act(() => {
      vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS)
    })
    expect(stored()).toMatchObject({ snapshot: EDITED })
  })

  it('server version newer than the draft (saved in another tab or machine): dropped silently', () => {
    store(draft({ base: '2026-10-09T02:00:00.000Z' }))
    const hook = mount(clean)

    expect(hook.result.current.offer).toBeNull()
    expect(stored()).toBeNull()
  })

  it('draft identical to the server version: dropped silently', () => {
    store(draft({ snapshot: SERVER }))
    const hook = mount(clean)

    expect(hook.result.current.offer).toBeNull()
    expect(stored()).toBeNull()
  })

  it('the language is part of the snapshot: a draft with another language than the server version is offered, and kept on restore', () => {
    store(draft({ snapshot: { ...SERVER, language: 'en' } }))
    const hook = mount({ ...clean, current: { ...SERVER, language: 'vi' }, saved: { ...SERVER, language: 'vi' } })

    expect(hook.result.current.offer?.snapshot.language).toBe('en')
  })

  it('a draft stored before posts had a language matches any language: identical text is dropped silently', () => {
    store(draft({ snapshot: SERVER }))
    const hook = mount({ ...clean, current: { ...SERVER, language: 'vi' }, saved: { ...SERVER, language: 'vi' } })

    expect(hook.result.current.offer).toBeNull()
  })

  it('older than 7 days: dropped', () => {
    store(draft({ at: new Date(NOW.getTime() - DRAFT_TTL_MS - 1).toISOString() }))
    const hook = mount(clean)

    expect(hook.result.current.offer).toBeNull()
    expect(stored()).toBeNull()
  })

  it.each([
    ['not JSON', '{nhap'],
    ['unknown version', JSON.stringify(draft({ v: 3 }))],
    ['version 1, written before drafts had an owner', JSON.stringify({ ...draft({ v: 1 }), owner: undefined })],
    ['missing field', JSON.stringify(draft({ snapshot: { title: 'x' } }))],
    ['tags not an array of strings', JSON.stringify(draft({ snapshot: { ...EDITED, tagIds: [1] } }))],
    ['base is not a date', JSON.stringify(draft({ base: 'yesterday' }))],
  ])('corrupt data (%s): offers nothing, and is cleaned up', (_case, raw) => {
    localStorage.setItem(KEY, raw)
    const hook = mount(clean)

    expect(hook.result.current.offer).toBeNull()
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('new post: a draft with no base is still offered (key moi)', () => {
    const empty: EditorSnapshot = { title: '', slug: '', excerpt: '', content: '', categoryId: '', tagIds: [] }
    store(draft({ base: null, snapshot: { ...EDITED, title: 'Post in progress' } }), draftKey(OWNER, null))
    const hook = mount({ owner: OWNER, postId: null, base: null, current: empty, saved: empty, dirty: false })

    expect(hook.result.current.offer?.snapshot.title).toBe('Post in progress')
  })

  it('existing post but the draft has no base: cannot be compared with the server version, so dropped', () => {
    store(draft({ base: null }))
    const hook = mount(clean)

    expect(hook.result.current.offer).toBeNull()
  })

  it('the offer is the version present when the editor OPENED: the editor own writes do not become a new offer', () => {
    const hook = mount(clean)
    hook.rerender(edited)
    act(() => {
      vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS)
    })
    hook.rerender({ ...edited, current: { ...EDITED, title: 'kept typing' } })

    expect(hook.result.current.offer).toBeNull()
  })

  it('the editor is rebuilt (key changes, as after restoring a version): the new instance reads the storage as of its own opening', () => {
    const first = mount(edited)
    act(() => {
      vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS)
    })
    expect(stored()).toMatchObject({ snapshot: EDITED })

    first.unmount()
    const next = mount(clean)

    expect(next.result.current.offer).toMatchObject({ snapshot: EDITED })
    act(() => {
      next.result.current.discard()
    })
    next.rerender({ ...edited, current: { ...EDITED, title: 'kept typing on the new version' } })
    act(() => {
      vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS)
    })
    next.rerender({ ...edited, current: { ...EDITED, title: 'kept typing again' } })
    // The new instance own write never comes back as an offer.
    expect(next.result.current.offer).toBeNull()
  })

  it('saved while an offer is showing (server version newer than the draft): the offer disappears', () => {
    store(draft())
    const hook = mount(clean)
    expect(hook.result.current.offer).not.toBeNull()

    hook.rerender({ ...clean, base: '2026-10-09T04:59:00.000Z' })

    expect(hook.result.current.offer).toBeNull()
  })
})

describe('useDraftAutosave: broken or blocked storage', () => {
  it('every access throws (private Safari, cookies blocked): nothing is thrown outward, no offer', () => {
    const boom = () => {
      throw new DOMException('denied', 'SecurityError')
    }
    vi.stubGlobal('localStorage', {
      getItem: boom,
      setItem: boom,
      removeItem: boom,
      key: boom,
      clear: boom,
      get length(): number {
        return boom()
      },
    })

    const hook = mount(clean)
    hook.rerender(edited)
    act(() => {
      vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS)
    })
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    hook.rerender(clean)
    act(() => {
      hook.result.current.forget()
    })

    expect(hook.result.current.offer).toBeNull()
  })

  it('storage full (QuotaExceededError): that write is skipped', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    const hook = mount(clean)
    hook.rerender(edited)

    expect(() =>
      act(() => {
        vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS)
      }),
    ).not.toThrow()
    expect(setItem).toHaveBeenCalled()
    setItem.mockRestore()
  })
})

describe('clearLocalDrafts (logout)', () => {
  it('deletes every editor draft, of any account, leaves other keys', () => {
    store(draft(), draftKey(OWNER, 'a'))
    store(draft({ owner: OTHER_OWNER }), draftKey(OTHER_OWNER, null))
    localStorage.setItem('theme', 'dark')
    localStorage.setItem('binh-luan:nhap:x', '{}')

    clearLocalDrafts()

    expect(localStorage.getItem(draftKey(OWNER, 'a'))).toBeNull()
    expect(localStorage.getItem(draftKey(OTHER_OWNER, null))).toBeNull()
    expect(localStorage.getItem('theme')).toBe('dark')
    expect(localStorage.getItem('binh-luan:nhap:x')).toBe('{}')
  })

  it('storage throws: nothing is thrown outward (logout must carry on)', () => {
    vi.stubGlobal('localStorage', {
      get length(): number {
        throw new DOMException('denied', 'SecurityError')
      },
    })

    expect(() => clearLocalDrafts()).not.toThrow()
  })
})

/** Every key of the editor's drafts, whoever owns it. */
function draftKeysInStorage(): string[] {
  return Object.keys(localStorage).filter((key) => key.startsWith('bai-viet:nhap:'))
}

describe('after a sign-out nothing writes a draft again (pending timer, pagehide flush, other tabs)', () => {
  it('a debounce timer that is still pending when the draft is cleared does not put the text back', () => {
    const hook = mount(clean)
    hook.rerender(edited)
    act(() => {
      vi.advanceTimersByTime(300)
    })

    clearLocalDrafts()
    act(() => {
      vi.advanceTimersByTime(2 * DRAFT_DEBOUNCE_MS)
    })
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })

    expect(draftKeysInStorage()).toEqual([])
  })

  it('the pagehide flush of the text typed a moment before does not put it back either', () => {
    const hook = mount(clean)
    hook.rerender(edited)

    clearLocalDrafts()
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })

    expect(draftKeysInStorage()).toEqual([])
  })

  it('typing after the sign-out (the editor stays mounted until the sign-in page renders) writes nothing', () => {
    const hook = mount(edited)
    act(() => {
      vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS)
    })
    expect(draftKeysInStorage()).toHaveLength(1)

    clearLocalDrafts()
    hook.rerender({ ...edited, current: { ...EDITED, content: 'typed while the sign-out page loads' } })
    act(() => {
      vi.advanceTimersByTime(3 * DRAFT_DEBOUNCE_MS)
    })

    expect(draftKeysInStorage()).toEqual([])
    expect(canWriteDrafts(OWNER)).toBe(false)
  })

  it('writes start again when the shell binds the account after the next sign-in', () => {
    const hook = mount(clean)
    clearLocalDrafts()
    unbind = bindDraftOwner(OWNER)

    hook.rerender(edited)
    act(() => {
      vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS)
    })

    expect(stored()).toMatchObject({ owner: OWNER, snapshot: EDITED })
  })

  it('suspendDraftWrites (a sign-out request in flight): no writes meanwhile, the stored drafts stay, and the undo resumes them', () => {
    store(draft(), draftKey(OWNER, 'other-post'))
    const hook = mount(clean)
    hook.rerender(edited)

    const resume = suspendDraftWrites()
    act(() => {
      vi.advanceTimersByTime(2 * DRAFT_DEBOUNCE_MS)
    })
    expect(stored()).toBeNull()
    expect(localStorage.getItem(draftKey(OWNER, 'other-post'))).not.toBeNull()

    // The request failed: the session is alive, the next change is written.
    resume()
    hook.rerender({ ...edited, current: { ...EDITED, content: 'typed after the failed sign-out' } })
    act(() => {
      vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS)
    })
    expect(stored()).toMatchObject({ snapshot: { content: 'typed after the failed sign-out' } })
  })

  describe('with a BroadcastChannel between tabs', () => {
    /** A page's own copy of the module: its own bound account, like a second tab. */
    async function otherTab() {
      vi.resetModules()
      return import('@/lib/draft-storage')
    }

    function installFakeChannel() {
      const open = new Set<FakeChannel>()
      class FakeChannel {
        onmessage: ((event: { data: unknown }) => void) | null = null
        constructor(readonly name: string) {
          open.add(this)
        }
        postMessage(data: unknown) {
          for (const other of open) if (other !== this && other.name === this.name) other.onmessage?.({ data })
        }
        close() {
          open.delete(this)
        }
      }
      vi.stubGlobal('BroadcastChannel', FakeChannel)
    }

    it('a sign-out in another tab stops the editor open in this one, pending text included', async () => {
      installFakeChannel()
      unbind()
      unbind = bindDraftOwner(OWNER)
      const hook = mount(clean)
      hook.rerender(edited)
      act(() => {
        vi.advanceTimersByTime(300)
      })
      const tab2 = await otherTab()
      const stopTab2 = tab2.bindDraftOwner(OWNER)

      tab2.clearLocalDrafts()
      act(() => {
        vi.advanceTimersByTime(2 * DRAFT_DEBOUNCE_MS)
      })
      act(() => {
        window.dispatchEvent(new Event('pagehide'))
      })

      expect(draftKeysInStorage()).toEqual([])
      expect(canWriteDrafts(OWNER)).toBe(false)
      stopTab2()
    })

    it('a tab whose shell has left (unbound) does not listen any more', async () => {
      installFakeChannel()
      unbind()
      unbind = bindDraftOwner(OWNER)
      const tab2 = await otherTab()
      unbind()

      tab2.clearLocalDrafts()

      expect(canWriteDrafts(OWNER)).toBe(false)
      unbind = bindDraftOwner(OWNER)
      expect(canWriteDrafts(OWNER)).toBe(true)
    })

    it('a browser without BroadcastChannel still clears and unbinds this tab, and throws nothing', () => {
      vi.stubGlobal('BroadcastChannel', undefined)
      unbind()

      expect(() => {
        unbind = bindDraftOwner(OWNER)
        clearLocalDrafts()
      }).not.toThrow()
      expect(canWriteDrafts(OWNER)).toBe(false)
    })

    it('a channel that throws is ignored', () => {
      vi.stubGlobal(
        'BroadcastChannel',
        class {
          constructor() {
            throw new Error('not allowed')
          }
        },
      )
      unbind()

      expect(() => {
        unbind = bindDraftOwner(OWNER)
        clearLocalDrafts()
      }).not.toThrow()
    })
  })
})

describe('drafts belong to the account that typed them', () => {
  it('a new post written by one account is not offered to the next account, and is gone after that account binds', () => {
    const first = mount({ ...clean, postId: null, base: null, current: EDITED, saved: SERVER, dirty: true })
    act(() => {
      vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS)
    })
    expect(stored(draftKey(OWNER, null))).not.toBeNull()
    first.unmount()

    // Session ended without a sign-out click; someone else signs in on the same browser.
    unbind()
    unbind = bindDraftOwner(OTHER_OWNER)
    const second = mount({
      owner: OTHER_OWNER,
      postId: null,
      base: null,
      current: SERVER,
      saved: SERVER,
      dirty: false,
    })

    expect(second.result.current.offer).toBeNull()
    expect(draftKeysInStorage()).toEqual([])
  })

  it('an existing post with the same id and base: the next account gets no offer (the administrator can open every post)', () => {
    store(draft())
    unbind()
    unbind = bindDraftOwner(OTHER_OWNER)

    const hook = mount({ ...clean, owner: OTHER_OWNER })

    expect(hook.result.current.offer).toBeNull()
    expect(draftKeysInStorage()).toEqual([])
  })

  it('the same account is offered its own draft again after signing back in', () => {
    store(draft())
    unbind()
    unbind = bindDraftOwner(OWNER)

    const hook = mount(clean)

    expect(hook.result.current.offer).toMatchObject({ owner: OWNER, snapshot: EDITED })
  })

  it('a record under this account key that names another owner is not offered and is cleaned up', () => {
    store(draft({ owner: OTHER_OWNER }))
    const hook = mount(clean)

    expect(hook.result.current.offer).toBeNull()
    expect(stored()).toBeNull()
  })

  it('a legacy draft without an owner (version 1, key without the account) is never offered and is deleted when the shell binds', () => {
    const legacy = JSON.stringify({ v: 1, base: UPDATED_AT, at: '2026-10-09T04:30:00.000Z', snapshot: EDITED })
    localStorage.setItem('bai-viet:nhap:p1', legacy)
    localStorage.setItem('bai-viet:nhap:moi', legacy)
    unbind()
    unbind = bindDraftOwner(OWNER)

    expect(draftKeysInStorage()).toEqual([])
    const hook = mount(clean)
    expect(hook.result.current.offer).toBeNull()
  })

  it('without a known account nothing is read, offered or written', () => {
    store(draft())
    const hook = mount({ ...edited, owner: null })
    act(() => {
      vi.advanceTimersByTime(5 * DRAFT_DEBOUNCE_MS)
      window.dispatchEvent(new Event('pagehide'))
    })

    expect(hook.result.current.offer).toBeNull()
    expect(stored()).toEqual(draft())
    expect(draftKeysInStorage()).toEqual([KEY])
  })

  it('writing as an account the shell is not bound to is refused', () => {
    unbind()
    unbind = bindDraftOwner(OTHER_OWNER)
    const hook = mount(edited)
    act(() => {
      vi.advanceTimersByTime(2 * DRAFT_DEBOUNCE_MS)
    })

    expect(draftKeysInStorage()).toEqual([])
    hook.unmount()
  })
})

describe('bindDraftOwner (the admin shell opens)', () => {
  it('deletes expired drafts, keeps the account unexpired ones, and leaves every key that is not an editor draft', () => {
    store(draft({ at: '2026-09-01T00:00:00.000Z' }), draftKey(OWNER, 'cu'))
    store(draft(), draftKey(OWNER, 'con-han'))
    store(draft({ owner: OTHER_OWNER }), draftKey(OTHER_OWNER, 'p1'))
    localStorage.setItem('bai-viet:nhap:khong-hop-le', '{nhap')
    localStorage.setItem('theme', 'dark')
    localStorage.setItem('search.recent.v1', '["a"]')
    unbind()

    unbind = bindDraftOwner(OWNER)

    expect(localStorage.getItem(draftKey(OWNER, 'cu'))).toBeNull()
    expect(localStorage.getItem(draftKey(OWNER, 'con-han'))).not.toBeNull()
    expect(localStorage.getItem(draftKey(OTHER_OWNER, 'p1'))).toBeNull()
    expect(localStorage.getItem('bai-viet:nhap:khong-hop-le')).toBeNull()
    expect(localStorage.getItem('theme')).toBe('dark')
    expect(localStorage.getItem('search.recent.v1')).toBe('["a"]')
  })

  it('the undo unbinds only its own account', () => {
    const stopFirst = bindDraftOwner(OWNER)
    const stopSecond = bindDraftOwner(OTHER_OWNER)

    stopFirst()
    expect(canWriteDrafts(OTHER_OWNER)).toBe(true)
    stopSecond()
    expect(canWriteDrafts(OTHER_OWNER)).toBe(false)
  })

  it('storage that throws is survived', () => {
    vi.stubGlobal('localStorage', {
      get length(): number {
        throw new DOMException('denied', 'SecurityError')
      },
    })

    expect(() => bindDraftOwner(OWNER)()).not.toThrow()
  })
})
