import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearClientSessionData } from './client-session-data'
import { COMMENT_DRAFT_PREFIX, COMMENT_SLOT_DRAFT_PREFIX } from './comment-draft-keys'
import { bindDraftOwner, canWriteDrafts, draftKey } from './draft-storage'
import { RECENT_KEY } from '@/components/site/search/recent-searches'

const OWNER = '11111111-1111-1111-1111-111111111111'

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
  sessionStorage.clear()
})

describe('clearClientSessionData', () => {
  it('removes the editor drafts of every account, the recent searches and both kinds of comment draft', () => {
    localStorage.setItem(draftKey(OWNER, '42'), '{}')
    localStorage.setItem(draftKey('22222222-2222-2222-2222-222222222222', null), '{}')
    localStorage.setItem('bai-viet:nhap:42', '{}')
    localStorage.setItem(RECENT_KEY, '["a"]')
    sessionStorage.setItem(`${COMMENT_DRAFT_PREFIX}a-post`, '{}')
    sessionStorage.setItem(`${COMMENT_SLOT_DRAFT_PREFIX}another-post`, '{}')

    clearClientSessionData()

    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('leaves what is not about the person: the theme choice and the per-tab view marks', () => {
    localStorage.setItem('theme', 'dark')
    sessionStorage.setItem('view:a-post', '1')
    sessionStorage.setItem('something-else', 'x')

    clearClientSessionData()

    expect(localStorage.getItem('theme')).toBe('dark')
    expect(sessionStorage.getItem('view:a-post')).toBe('1')
    expect(sessionStorage.getItem('something-else')).toBe('x')
  })

  it('also stops the editor from writing: the account is no longer the bound one', () => {
    const unbind = bindDraftOwner(OWNER)
    expect(canWriteDrafts(OWNER)).toBe(true)

    clearClientSessionData()

    expect(canWriteDrafts(OWNER)).toBe(false)
    unbind()
  })

  it('never throws when the storage is blocked (private Safari, cookies blocked): a sign-out must carry on', () => {
    const boom = () => {
      throw new DOMException('denied', 'SecurityError')
    }
    const blocked = {
      getItem: boom,
      setItem: boom,
      removeItem: boom,
      key: boom,
      clear: boom,
      get length(): number {
        return boom()
      },
    }
    vi.stubGlobal('localStorage', blocked)
    vi.stubGlobal('sessionStorage', blocked)

    expect(() => clearClientSessionData()).not.toThrow()
  })
})
