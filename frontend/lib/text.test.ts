import { describe, expect, it } from 'vitest'
import { isPlausibleSlug, normalizeSlug } from './text'
import { SLUG_DAT_VAN_DE, SLUG_TIENG_VIET } from '@/test/fixtures/vi/accented-text'

describe('normalizeSlug', () => {
  it('decodes a percent-encoded slug', () => {
    expect(normalizeSlug('ti%E1%BA%BFng-vi%E1%BB%87t')).toBe(SLUG_TIENG_VIET)
  })

  it('leaves an already-decoded slug alone', () => {
    expect(normalizeSlug(SLUG_TIENG_VIET)).toBe(SLUG_TIENG_VIET)
  })

  it('normalizes decomposed Vietnamese to NFC so it compares equal to composed', () => {
    const composed = SLUG_DAT_VAN_DE
    const decomposed = composed.normalize('NFD')

    expect(decomposed).not.toBe(composed)
    expect(normalizeSlug(decomposed)).toBe(composed)
  })

  it('survives a slug containing a stray percent sign', () => {
    expect(normalizeSlug('100%-uptime')).toBe('100%-uptime')
  })
})

describe('isPlausibleSlug', () => {
  const withChar = (code: number) => `a${String.fromCharCode(code)}b`

  it('accepts the slugs posts really have, accented Vietnamese included', () => {
    expect(isPlausibleSlug('dat-van-de')).toBe(true)
    expect(isPlausibleSlug(SLUG_TIENG_VIET)).toBe(true)
    expect(isPlausibleSlug(SLUG_DAT_VAN_DE)).toBe(true)
    expect(isPlausibleSlug('x'.repeat(255))).toBe(true)
  })

  it('rejects what the backend would refuse: empty, a slash, a control character, or an over-long value', () => {
    expect(isPlausibleSlug('')).toBe(false)
    expect(isPlausibleSlug('../../x')).toBe(false)
    expect(isPlausibleSlug(withChar(0x5c))).toBe(false) // backslash
    expect(isPlausibleSlug(withChar(0x00))).toBe(false) // NUL
    expect(isPlausibleSlug(withChar(0x0a))).toBe(false) // line feed
    expect(isPlausibleSlug(withChar(0x7f))).toBe(false) // DEL
    expect(isPlausibleSlug(withChar(0x85))).toBe(false) // a C1 control
    expect(isPlausibleSlug('x'.repeat(256))).toBe(false)
  })
})
