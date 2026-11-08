import { describe, expect, it } from 'vitest'
import { SHARE_TARGETS } from './share-targets'

const URL = 'https://example.test/posts/a b?x=1&y=2'
const TITLE = 'A title: with & symbols'

describe('SHARE_TARGETS', () => {
  it('lists Facebook, LinkedIn and X, in that order', () => {
    expect(SHARE_TARGETS.map((target) => target.brand)).toEqual(['facebook', 'linkedin', 'x'])
    expect(SHARE_TARGETS.map((target) => target.label)).toEqual(['Facebook', 'LinkedIn', 'X'])
  })

  it('builds the public share URLs, with the post address encoded; only X receives the title', () => {
    const [facebook, linkedin, x] = SHARE_TARGETS
    const encoded = encodeURIComponent(URL)
    expect(facebook.href(URL, TITLE)).toBe(`https://www.facebook.com/sharer/sharer.php?u=${encoded}`)
    expect(linkedin.href(URL, TITLE)).toBe(`https://www.linkedin.com/sharing/share-offsite/?url=${encoded}`)
    expect(x.href(URL, TITLE)).toBe(`https://x.com/intent/post?url=${encoded}&text=${encodeURIComponent(TITLE)}`)
  })
})
