import { describe, expect, it } from 'vitest'
import { COVER_MIN_WIDTH, COVER_RECOMMENDED_WIDTH, IMAGE_QUALITY, isLowResolutionCover } from './image-quality'

describe('isLowResolutionCover', () => {
  it('is true below the minimum width and false from it up', () => {
    expect(isLowResolutionCover({ width: 275 })).toBe(true)
    expect(isLowResolutionCover({ width: COVER_MIN_WIDTH - 1 })).toBe(true)
    expect(isLowResolutionCover({ width: COVER_MIN_WIDTH })).toBe(false)
    expect(isLowResolutionCover({ width: 2400 })).toBe(false)
  })

  it('does not judge an unknown width', () => {
    expect(isLowResolutionCover({ width: 0 })).toBe(false)
  })
})

describe('image constants', () => {
  it('recommend more than the minimum, and the sharp quality is above the standard one', () => {
    expect(COVER_RECOMMENDED_WIDTH).toBeGreaterThan(COVER_MIN_WIDTH)
    expect(IMAGE_QUALITY.sharp).toBeGreaterThan(IMAGE_QUALITY.standard)
  })
})
