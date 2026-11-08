import { describe, expect, it } from 'vitest'
import { roleChangeNeedsCode } from './role-step-up'
import type { UserRole } from './types'

describe('roleChangeNeedsCode', () => {
  it.each<[UserRole, UserRole, boolean]>([
    ['USER', 'AUTHOR', true],
    ['USER', 'ADMIN', true],
    ['AUTHOR', 'ADMIN', true],
    ['ADMIN', 'AUTHOR', true],
    ['ADMIN', 'USER', true],
    // Taking privilege away from a non-admin needs no code; nothing changes when the role stays.
    ['AUTHOR', 'USER', false],
    ['USER', 'USER', false],
    ['AUTHOR', 'AUTHOR', false],
    ['ADMIN', 'ADMIN', false],
  ])('%s to %s: %s', (from, to, needed) => {
    expect(roleChangeNeedsCode(from, to)).toBe(needed)
  })
})
