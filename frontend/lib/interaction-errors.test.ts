// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { translatorFor } from '@/test/intl'
import { interactionMessage, needsLogin } from './interaction-errors'
import { msg } from '@/test/render-intl'

const t = translatorFor('vi', 'Errors.interaction')
const SESSION = msg('Errors.interaction.sessionExpired')
const NETWORK = msg('Site.profile.author.errors.network')

describe('interactionMessage: error code → Vietnamese sentence', () => {
  it.each([
    ['USER_SUSPENDED', 403, msg('Errors.interaction.userSuspended.comment')],
    ['FORBIDDEN', 403, msg('Errors.interaction.byCode.FORBIDDEN')],
    ['COMMENT_NOT_FOUND', 404, msg('Errors.interaction.byCode.COMMENT_NOT_FOUND')],
    ['COMMENT_NOT_REPLYABLE', 422, msg('Errors.interaction.byCode.COMMENT_NOT_REPLYABLE')],
    ['COMMENT_DUPLICATE', 409, msg('Errors.interaction.byCode.COMMENT_DUPLICATE')],
    ['RATE_LIMITED', 429, msg('Errors.interaction.byCode.RATE_LIMITED')],
  ])('%s', (code, status, message) => {
    expect(interactionMessage(t, code, status, 'comment')).toBe(message)
    expect(interactionMessage(t, code, status, 'like')).toBe(message)
  })

  it('session ended: by code UNAUTHENTICATED or by status 401', () => {
    expect(interactionMessage(t, 'UNAUTHENTICATED', 401, 'comment')).toBe(SESSION)
    expect(interactionMessage(t, 'UNKNOWN', 401, 'like')).toBe(SESSION)
  })

  it('POST_NOT_FOUND speaks by context', () => {
    expect(interactionMessage(t, 'POST_NOT_FOUND', 404, 'comment')).toBe(msg('Errors.interaction.postNotFound.comment'))
    expect(interactionMessage(t, 'POST_NOT_FOUND', 404, 'like')).toBe(msg('Errors.interaction.postNotFound.like'))
  })

  it('saving a post: its own sentences for suspended and post no longer there; other codes are shared', () => {
    expect(interactionMessage(t, 'USER_SUSPENDED', 403, 'bookmark')).toBe(msg('Errors.interaction.userSuspended.bookmark'))
    expect(interactionMessage(t, 'POST_NOT_FOUND', 404, 'bookmark')).toBe(msg('Errors.interaction.postNotFound.bookmark'))
    expect(interactionMessage(t, 'RATE_LIMITED', 429, 'bookmark')).toBe(msg('Errors.interaction.byCode.RATE_LIMITED'))
    expect(interactionMessage(t, 'VALIDATION_ERROR', 400, 'bookmark')).toBe(msg('Errors.interaction.invalid.like'))
    expect(interactionMessage(t, 'UNAUTHENTICATED', 401, 'bookmark')).toBe(SESSION)
    expect(interactionMessage(t, 'NETWORK', 0, 'bookmark')).toBe(NETWORK)
  })

  it.each([
    ['VALIDATION_ERROR', 400],
    ['PAYLOAD_TOO_LARGE', 413],
    // The 413 is returned by the proxy in front, with no envelope.
    ['UNKNOWN', 413],
  ])('%s / %i speaks by context', (code, status) => {
    expect(interactionMessage(t, code, status, 'comment')).toBe(msg('Errors.interaction.invalid.comment'))
    expect(interactionMessage(t, code, status, 'like')).toBe(msg('Errors.interaction.invalid.like'))
  })

  it.each([
    ['NETWORK', 0],
    ['INTERNAL_ERROR', 500],
    ['UPSTREAM_UNAVAILABLE', 502],
    ['UNKNOWN', 503],
  ])('%s / %i is a connection error', (code, status) => {
    expect(interactionMessage(t, code, status, 'comment')).toBe(NETWORK)
    expect(interactionMessage(t, code, status, 'like')).toBe(NETWORK)
  })

  it('an unknown 4xx code gets a generic sentence, never an empty string or the backend English', () => {
    const message = interactionMessage(t, 'RESOURCE_CONFLICT', 409, 'comment')
    expect(message).toBe(msg('Site.notifications.errors.generic'))
  })
})

describe('needsLogin', () => {
  it('only when the session has ended: by code or by status 401', () => {
    expect(needsLogin('UNAUTHENTICATED', 401)).toBe(true)
    expect(needsLogin('UNKNOWN', 401)).toBe(true)
    expect(needsLogin('USER_SUSPENDED', 403)).toBe(false)
    expect(needsLogin('NETWORK', 0)).toBe(false)
  })
})
