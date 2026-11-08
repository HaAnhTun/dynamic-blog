import { describe, expect, it } from 'vitest'
import { pseudoMessage, pseudoMessages } from './pseudo'

describe('pseudoMessage', () => {
  it('accents letters, keeps ICU arguments and rich-text tags, and lengthens the text by about 30 percent', () => {
    const out = pseudoMessage('Read <b>{count} posts</b> now')
    expect(out).toContain('{count}')
    expect(out).toContain('<b>')
    expect(out).toContain('</b>')
    expect(out).not.toContain('Read')
    expect(out.length).toBeGreaterThan('Read <b>{count} posts</b> now'.length)
  })

  it('leaves a message without letters short and walks nested objects', () => {
    expect(pseudoMessage('42')).toBe('42')
    expect(pseudoMessages({ a: { b: 'Hi there, friend' } }).a.b).not.toBe('Hi there, friend')
  })
})
