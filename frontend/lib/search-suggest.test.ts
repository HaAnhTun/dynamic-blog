// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { allowSearch, SEARCH_RATE } from './search-suggest'

/** One address per test: the counters of lib/rate-limit.ts live for the whole file. */
describe('allowSearch: the search allowance per address, shared by the quick search routes and the /search page', () => {
  it('allows SEARCH_RATE.limit searches from one address, then refuses; another address is not affected', () => {
    for (let i = 0; i < SEARCH_RATE.limit; i += 1) expect(allowSearch('203.0.113.201')).toBe(true)

    expect(allowSearch('203.0.113.201')).toBe(false)
    expect(allowSearch('203.0.113.202')).toBe(true)
  })

  it('an address of the same IPv6 /64 shares the allowance', () => {
    for (let i = 0; i < SEARCH_RATE.limit; i += 1) expect(allowSearch(`2001:db8:5:6::${i + 1}`)).toBe(true)

    expect(allowSearch('2001:db8:5:6:ffff::1')).toBe(false)
  })

  it('an unknown address (null) is not exempt: it counts in the shared "unknown" bucket and is refused once that is used up', () => {
    let allowed = 0
    for (let i = 0; i < 1000; i += 1) allowed += allowSearch(null) ? 1 : 0

    // The shared unknown bucket has its own, wider limit (lib/rate-limit.ts): not unlimited, not zero.
    expect(allowed).toBeGreaterThan(0)
    expect(allowed).toBeLessThan(1000)
    expect(allowSearch(null)).toBe(false)
  })
})
