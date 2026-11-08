import { describe, expect, it } from 'vitest'
import en from '@/messages/en.json'
import vi from '@/messages/vi.json'
import { argsOf, checkCatalogs, flatten, hasVietnameseLetters, type Catalog } from './catalog-check'

const A_BREVE = String.fromCodePoint(0x103)

describe('message catalogs', () => {
  it('vi.json and en.json have the same keys and ICU arguments, no empty value, no Vietnamese in en.json', () => {
    expect(checkCatalogs(vi as Catalog, en as Catalog)).toEqual([])
  })
})

describe('argsOf', () => {
  it('finds simple, plural, select and rich-text arguments, branches included', () => {
    expect(argsOf('Hello {name}')).toEqual(['name'])
    expect(argsOf('{count, plural, one {# post by {author}} other {# posts}}')).toEqual(['author', 'count'])
    expect(argsOf('{kind, select, a {{x}} other {none}}')).toEqual(['kind', 'x'])
    expect(argsOf('Read <b>this</b> now')).toEqual(['<b>'])
    expect(argsOf('No arguments')).toEqual([])
  })

  it('ignores braces inside ICU quotes and reports unbalanced ones', () => {
    expect(argsOf("Use '{' and '}' literally, {name}")).toEqual(['name'])
    expect(argsOf('Broken {name')).toEqual(['<unbalanced>'])
  })
})

describe('flatten', () => {
  it('joins nested keys with dots', () => {
    expect([...flatten({ A: { b: { c: 'x' } }, d: 'y' }).keys()]).toEqual(['A.b.c', 'd'])
  })
})

describe('checkCatalogs on fixtures', () => {
  const base = { Site: { nav: 'Writing', count: '{count, plural, one {# post} other {# posts}}' } }
  const other = { Site: { nav: 'Bai viet', count: '{count, plural, one {# bai} other {# bai}}' } }

  it('accepts matching catalogs', () => {
    expect(checkCatalogs(other, base)).toEqual([])
  })

  it('reports a key missing on either side', () => {
    expect(checkCatalogs({ Site: { nav: 'x' } }, base)).toContain('vi: missing Site.count')
    expect(checkCatalogs(other, { Site: { nav: 'x' } })).toContain('en: missing Site.count')
  })

  it('reports different ICU arguments, an empty value and a non-string leaf', () => {
    expect(checkCatalogs({ Site: { ...other.Site, count: '{total, plural, other {#}}' } }, base)).toEqual([
      'Site.count: ICU arguments differ (en: count, vi: total)',
    ])
    expect(checkCatalogs({ Site: { ...other.Site, nav: ' ' } }, base)).toContain('vi: Site.nav is empty')
    expect(checkCatalogs({ Site: { ...other.Site, nav: 3 as unknown as string } }, base)).toContain(
      'vi: Site.nav is not a string',
    )
  })

  it('reports Vietnamese letters in the English catalog', () => {
    expect(hasVietnameseLetters(`Wr${A_BREVE}ting`)).toBe(true)
    expect(hasVietnameseLetters('A cafe, a resume')).toBe(false)
    expect(checkCatalogs(other, { Site: { ...base.Site, nav: `Wr${A_BREVE}ting` } })).toContain(
      'en: Site.nav contains Vietnamese letters',
    )
  })
})
