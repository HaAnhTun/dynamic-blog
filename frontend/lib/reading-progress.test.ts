import { describe, expect, it } from 'vitest'
import { readingProgress } from './reading-progress'

const VIEWPORT = 800

describe('readingProgress', () => {
  it('is 0 while the top of the body is at or below the top of the viewport', () => {
    expect(readingProgress({ top: 0, height: 3000 }, VIEWPORT)).toBe(0)
    expect(readingProgress({ top: 250, height: 3000 }, VIEWPORT)).toBe(0)
  })

  it('is 1 when the bottom of the body is aligned with the bottom of the viewport, and stays 1 beyond it', () => {
    expect(readingProgress({ top: -(3000 - VIEWPORT), height: 3000 }, VIEWPORT)).toBe(1)
    expect(readingProgress({ top: -5000, height: 3000 }, VIEWPORT)).toBe(1)
  })

  it('is half way when half of the scrollable distance has passed', () => {
    expect(readingProgress({ top: -1100, height: 3000 }, VIEWPORT)).toBeCloseTo(0.5, 10)
  })

  it('never decreases while the reader scrolls down', () => {
    let previous = -1
    for (let top = 200; top >= -3200; top -= 100) {
      const value = readingProgress({ top, height: 3000 }, VIEWPORT)
      expect(value).toBeGreaterThanOrEqual(previous)
      previous = value
    }
  })

  it('a body shorter than the viewport is 0 until it moves up, then reaches 1 without dividing by zero', () => {
    expect(readingProgress({ top: 0, height: 300 }, VIEWPORT)).toBe(0)
    expect(readingProgress({ top: -1, height: 300 }, VIEWPORT)).toBe(1)
    expect(readingProgress({ top: -0.5, height: 300 }, VIEWPORT)).toBe(0.5)
  })

  it('clamps NaN, Infinity and negative sizes into 0..1 without throwing', () => {
    const inputs: [{ top: number; height: number }, number][] = [
      [{ top: Number.NaN, height: 3000 }, VIEWPORT],
      [{ top: -100, height: Number.NaN }, VIEWPORT],
      [{ top: -100, height: 3000 }, Number.NaN],
      [{ top: Number.NEGATIVE_INFINITY, height: 3000 }, VIEWPORT],
      [{ top: -100, height: -50 }, -20],
      [{ top: 100, height: 3000 }, -800],
    ]
    for (const [rect, viewport] of inputs) {
      const value = readingProgress(rect, viewport)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
    }
    expect(readingProgress({ top: Number.NaN, height: 3000 }, VIEWPORT)).toBe(0)
  })
})
