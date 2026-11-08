import { describe, expect, it } from 'vitest'
import {
  POST_IMPORT_MAX_FILE_BYTES,
  POST_IMPORT_MAX_FILES,
  POST_IMPORT_MAX_PACKAGE_ASSET_BYTES,
  POST_IMPORT_MAX_PACKAGE_BYTES,
  POST_IMPORT_MAX_PACKAGE_ENTRIES,
  POST_IMPORT_MAX_TOTAL_BYTES,
  checkPostFiles,
  isPackageName,
} from './post-import'

const file = (name: string, size: number) => ({ name, size })

describe('checkPostFiles', () => {
  it('accepts up to 20 .md files within the per-file and the total cap', () => {
    expect(checkPostFiles([file('a.md', 10), file('B.MD', 20)])).toBeNull()
    expect(checkPostFiles(Array.from({ length: POST_IMPORT_MAX_FILES }, (_, i) => file(`p${i}.md`, 1)))).toBeNull()
  })

  it.each([
    ['no file', [], { key: 'noFile' }],
    ['21 files', Array.from({ length: POST_IMPORT_MAX_FILES + 1 }, (_, i) => file(`p${i}.md`, 1)), { key: 'tooMany' }],
    ['a wrong extension, by position', [file('a.md', 1), file('b.txt', 1)], { key: 'notMarkdown', position: 2 }],
    ['an empty file, by position', [file('a.md', 0)], { key: 'emptyFile', position: 1 }],
    ['a file over the cap', [file('a.md', POST_IMPORT_MAX_FILE_BYTES + 1)], { key: 'fileTooLarge', position: 1 }],
    [
      'a total over the cap before twenty files of the cap',
      Array.from({ length: 17 }, (_, i) => file(`p${i}.md`, POST_IMPORT_MAX_FILE_BYTES)),
      { key: 'totalTooLarge' },
    ],
  ])('refuses %s', (_name, files, expected) => {
    expect(checkPostFiles(files)).toEqual(expected)
  })

  it('keeps the numbers of the backend', () => {
    expect([
      POST_IMPORT_MAX_FILES,
      POST_IMPORT_MAX_FILE_BYTES,
      POST_IMPORT_MAX_TOTAL_BYTES,
      POST_IMPORT_MAX_PACKAGE_BYTES,
      POST_IMPORT_MAX_PACKAGE_ENTRIES,
      POST_IMPORT_MAX_PACKAGE_ASSET_BYTES,
    ]).toEqual([20, 262_144, 4_194_304, 4_194_304, 40, 4_194_304])
  })

  it('accepts a .zip package next to a .md file, whatever the case of the extension', () => {
    expect(checkPostFiles([file('post.md', 10), file('article.zip', 3_000_000), file('OTHER.ZIP', 5)])).toBeNull()
  })

  it('lets a package use the whole total, where a Markdown file may not', () => {
    expect(checkPostFiles([file('a.zip', POST_IMPORT_MAX_PACKAGE_BYTES)])).toBeNull()
    expect(checkPostFiles([file('a.md', POST_IMPORT_MAX_FILE_BYTES + 1)])).toEqual({ key: 'fileTooLarge', position: 1 })
  })

  it.each([
    ['an empty package, by position', [file('a.md', 1), file('b.zip', 0)], { key: 'emptyFile', position: 2 }],
    [
      'a package over its cap, by position',
      [file('a.zip', POST_IMPORT_MAX_PACKAGE_BYTES + 1)],
      { key: 'packageTooLarge', position: 1 },
    ],
    ['packages over the total together', [file('a.zip', 3_000_000), file('b.zip', 2_000_000)], { key: 'totalTooLarge' }],
    ['a name that only contains the extension in the middle', [file('a.zip.txt', 1)], { key: 'notMarkdown', position: 1 }],
  ])('refuses %s', (_name, files, expected) => {
    expect(checkPostFiles(files)).toEqual(expected)
  })
})

describe('isPackageName', () => {
  it('recognises a package by its extension only', () => {
    expect(isPackageName('article.zip')).toBe(true)
    expect(isPackageName('ARTICLE.ZIP')).toBe(true)
    expect(isPackageName('article.md')).toBe(false)
    expect(isPackageName('zip')).toBe(false)
  })
})
