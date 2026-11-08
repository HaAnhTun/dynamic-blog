import { describe, expect, it } from 'vitest'
import { SITE_IMPORT_MAX_FILE_BYTES, SITE_IMPORT_MAX_PACKAGE_BYTES, checkProfileFile } from './site-import'

describe('checkProfileFile', () => {
  it('accepts a Markdown file and a ZIP package within their limits, whatever the case of the extension', () => {
    expect(checkProfileFile({ name: 'profile.md', size: 10 })).toBeNull()
    expect(checkProfileFile({ name: 'PROFILE.MD', size: SITE_IMPORT_MAX_FILE_BYTES })).toBeNull()
    expect(checkProfileFile({ name: 'about.zip', size: 10 })).toBeNull()
    expect(checkProfileFile({ name: 'About.ZIP', size: SITE_IMPORT_MAX_PACKAGE_BYTES })).toBeNull()
  })

  it('refuses any other name before looking at the size', () => {
    expect(checkProfileFile({ name: 'profile.txt', size: 10 })).toBe('notMarkdown')
    expect(checkProfileFile({ name: 'profile.zip.exe', size: 0 })).toBe('notMarkdown')
  })

  it('refuses an empty file of either kind', () => {
    expect(checkProfileFile({ name: 'profile.md', size: 0 })).toBe('noFile')
    expect(checkProfileFile({ name: 'about.zip', size: 0 })).toBe('noFile')
  })

  it('applies the Markdown limit to .md and the package limit to .zip', () => {
    expect(checkProfileFile({ name: 'profile.md', size: SITE_IMPORT_MAX_FILE_BYTES + 1 })).toBe('fileTooLarge')
    expect(checkProfileFile({ name: 'about.zip', size: SITE_IMPORT_MAX_FILE_BYTES + 1 })).toBeNull()
    expect(checkProfileFile({ name: 'about.zip', size: SITE_IMPORT_MAX_PACKAGE_BYTES + 1 })).toBe('packageTooLarge')
  })
})
