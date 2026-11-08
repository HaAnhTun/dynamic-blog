import { describe, expect, it } from 'vitest'
import { dataUrlsOf, imageFor, resolvePackagePath } from './preview-images'

describe('resolvePackagePath', () => {
  it.each([
    ['assets/a.png', 'assets/a.png'],
    ['./assets/a.png', 'assets/a.png'],
    ['assets/./sub/../a.png', 'assets/a.png'],
    ['assets/a.png#400x300', 'assets/a.png'],
    ['assets/a.png?raw=1', 'assets/a.png'],
    ['assets/my%20image.png', 'assets/my image.png'],
    ['  assets/a.png  ', 'assets/a.png'],
  ])('reads %s as the package path %s', (raw, expected) => {
    expect(resolvePackagePath(raw)).toBe(expected)
  })

  it.each([
    'https://example.com/a.png',
    '/media/abc.png',
    '//example.com/a.png',
    'data:image/png;base64,AAAA',
    'javascript:alert(1)',
    '#top',
    '',
    '../outside.png',
    'assets/../../outside.png',
    'assets/%ZZ.png',
  ])('does not name a file of the package: %s', (raw) => {
    expect(resolvePackagePath(raw)).toBeNull()
  })

  it('normalizes the Unicode form like the backend does', () => {
    expect(resolvePackagePath('assets/cafe\u0301.png')).toBe('assets/caf\u00e9.png')
  })
})

describe('imageFor', () => {
  const images = dataUrlsOf([
    { path: 'assets/a.png', contentType: 'image/png', base64: 'AAAA', width: 1, height: 1 },
    { path: 'assets/b.webp', contentType: 'image/webp', base64: 'BBBB', width: 2, height: 2 },
  ])

  it('builds one data URL per image with its own content type', () => {
    expect(images.get('assets/a.png')).toBe('data:image/png;base64,AAAA')
    expect(images.get('assets/b.webp')).toBe('data:image/webp;base64,BBBB')
  })

  it('finds an image by the path as the author wrote it', () => {
    expect(imageFor(images, './assets/a.png#10x10')).toBe('data:image/png;base64,AAAA')
    expect(imageFor(images, 'assets/missing.png')).toBeUndefined()
    expect(imageFor(images, 'https://example.com/a.png')).toBeUndefined()
  })

  it('keeps only the three image types of a package, so no other kind of content becomes a data URL', () => {
    const odd = dataUrlsOf([
      { path: 'assets/x.svg', contentType: 'image/svg+xml', base64: 'CCCC', width: 0, height: 0 },
      { path: 'assets/y.png', contentType: 'image/png;x=y', base64: 'DDDD', width: 0, height: 0 },
      { path: 'assets/z.png', contentType: 'image/png', base64: 'not base64!', width: 0, height: 0 },
    ])
    expect(odd.size).toBe(0)
  })
})
