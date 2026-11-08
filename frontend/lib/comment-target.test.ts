import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COMMENT_TARGET_EVENT,
  COMMENT_TARGET_PREFIX,
  onCommentTarget,
  parseCommentTarget,
  requestCommentTarget,
} from './comment-target'

/*
 * The "one comment" target of a notification link: the `#binh-luan-<uuid>` anchor and the window event
 * for the case where the reader is already on that very post.
 */

const ID = '0b9a5a4e-7c1d-4f7e-8f52-3c1e2d9a6b10'

let stops: (() => void)[] = []

afterEach(() => {
  for (const stop of stops) stop()
  stops = []
})

function listen(): ReturnType<typeof vi.fn<(id: string) => void>> {
  const listener = vi.fn<(id: string) => void>()
  stops.push(onCommentTarget(listener))
  return listener
}

describe('parseCommentTarget', () => {
  it('only accepts exactly `#binh-luan-<uuid>`', () => {
    expect(COMMENT_TARGET_PREFIX).toBe('binh-luan-')
    expect(parseCommentTarget(`#binh-luan-${ID}`)).toBe(ID)
  })

  it('an uppercase UUID (hand-copied link) is lowercased, to match the server data-comment-id', () => {
    expect(parseCommentTarget(`#binh-luan-${ID.toUpperCase()}`)).toBe(ID)
  })

  it.each([
    ['empty', ''],
    ['the returnTo target of the login invitation', '#binh-luan'],
    ['the id of the section heading', '#binh-luan-heading'],
    ['missing the # sign', `binh-luan-${ID}`],
    ['not a UUID', '#binh-luan-123'],
    ['UUID without hyphens', `#binh-luan-${ID.replace(/-/g, '')}`],
    ['extra characters after the UUID', `#binh-luan-${ID}x`],
    ['two UUIDs', `#binh-luan-${ID}-${ID}`],
    ['a different prefix', `#luot-thich-${ID}`],
    ['a heading anchor inside a post', '#gioi-thieu'],
  ])('%s: null', (_label, hash) => {
    expect(parseCommentTarget(hash)).toBeNull()
  })
})

describe('requestCommentTarget and onCommentTarget', () => {
  it('goes full circle: the listener receives the right id', () => {
    const listener = listen()

    requestCommentTarget(ID)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(ID)
  })

  it('the event is a CustomEvent named blog:comment-target carrying { id }', () => {
    const seen: Event[] = []
    const record = (event: Event) => seen.push(event)
    window.addEventListener(COMMENT_TARGET_EVENT, record)
    stops.push(() => window.removeEventListener(COMMENT_TARGET_EVENT, record))

    requestCommentTarget(ID)

    expect(seen).toHaveLength(1)
    expect(seen[0]).toBeInstanceOf(CustomEvent)
    expect((seen[0] as CustomEvent).detail).toEqual({ id: ID })
  })

  it('an id that is not a UUID, or an event with the same name but the wrong shape, does not reach the listener', () => {
    const listener = listen()

    requestCommentTarget('../admin')
    requestCommentTarget('')
    window.dispatchEvent(new Event(COMMENT_TARGET_EVENT))
    window.dispatchEvent(new CustomEvent(COMMENT_TARGET_EVENT, { detail: ID }))
    window.dispatchEvent(new CustomEvent(COMMENT_TARGET_EVENT, { detail: { id: 42 } }))

    expect(listener).not.toHaveBeenCalled()
  })

  it('after unsubscribing nothing is received any more', () => {
    const listener = vi.fn<(id: string) => void>()
    const stop = onCommentTarget(listener)

    stop()
    requestCommentTarget(ID)

    expect(listener).not.toHaveBeenCalled()
  })
})
