import { POST_IMPORT_MAX_PACKAGE_BYTES, isPackageName } from './post-import'

/*
 * The profile import as the page and the server actions share it: the file kinds and their limits. A profile file is a
 * Markdown file (.md) or a ZIP package (the same file plus its images under assets/), read by the backend with the same archive
 * limits as a post package. No 'server-only' here: the page component imports it too. The backend decides everything again.
 */

/** Bytes of a Markdown profile file (the backend's SiteImportFileLimits). */
export const SITE_IMPORT_MAX_FILE_BYTES = 262_144
/** Bytes of a ZIP package: the post package limit (the Server Action body limit of next.config.ts is 5 MiB). */
export const SITE_IMPORT_MAX_PACKAGE_BYTES = POST_IMPORT_MAX_PACKAGE_BYTES

export type ProfileFileRefusal = 'noFile' | 'fileTooLarge' | 'packageTooLarge' | 'notMarkdown'

/** The first reason a profile file cannot be uploaded, or null. The page and the server action both use it. */
export function checkProfileFile(file: { name: string; size: number }): ProfileFileRefusal | null {
  const pack = isPackageName(file.name)
  if (!pack && !file.name.toLowerCase().endsWith('.md')) return 'notMarkdown'
  if (file.size === 0) return 'noFile'
  if (pack ? file.size > SITE_IMPORT_MAX_PACKAGE_BYTES : file.size > SITE_IMPORT_MAX_FILE_BYTES) {
    return pack ? 'packageTooLarge' : 'fileTooLarge'
  }
  return null
}
