/*
 * The post import as the page, the server actions and the backend client share it: the limits, the answers of the backend
 * (/api/v1/admin/post-import/**) and the checks that save a round trip. No 'server-only' here: the page component imports it
 * too. The backend decides everything again.
 */

/**
 * The same numbers as the backend (PostFileLimits, PostFile, PostPackage): files in one import, bytes per Markdown file, bytes in
 * all the files, bytes per ZIP package (the Server Action body limit of next.config.ts is 5 MiB, so a package fits with its form).
 */
export const POST_IMPORT_MAX_FILES = 20
export const POST_IMPORT_MAX_FILE_BYTES = 262_144
export const POST_IMPORT_MAX_TOTAL_BYTES = 4 * 1024 * 1024
export const POST_IMPORT_MAX_PACKAGE_BYTES = 4 * 1024 * 1024
/** The backend's other limits of a package (PostFileLimits), which the authoring prompt tells the AI: files in one package, bytes of one image. */
export const POST_IMPORT_MAX_PACKAGE_ENTRIES = 40
export const POST_IMPORT_MAX_PACKAGE_ASSET_BYTES = 4 * 1024 * 1024
/** The block syntax problems of one file that the page lists; `PostArticleCheck.problemsTotal` counts them all. */
export const POST_IMPORT_MAX_BLOCK_PROBLEMS = 50

/** The limits as the refusal sentences of the catalog name them (`Admin.posts.import.errors`, `Admin.posts.import.files`). */
export const POST_IMPORT_LIMIT_VALUES = {
  maxFiles: POST_IMPORT_MAX_FILES,
  maxKib: POST_IMPORT_MAX_FILE_BYTES / 1024,
  maxMib: POST_IMPORT_MAX_TOTAL_BYTES / (1024 * 1024),
  maxPackageMib: POST_IMPORT_MAX_PACKAGE_BYTES / (1024 * 1024),
}

export const POST_IMPORT_SHA256 = /^[0-9a-f]{64}$/
/** The preview state is URL-safe Base64 without padding; the page never reads it as text. */
export const POST_IMPORT_STATE = /^[A-Za-z0-9_-]{1,512}$/

/** Backend codes that mean "preview the files again": the files or the posts are not what the preview showed. */
export const POST_IMPORT_STALE_CODES: readonly string[] = ['POST_IMPORT_HASH_MISMATCH', 'POST_IMPORT_PREVIEW_OUT_OF_DATE']

export type PostFileRefusal =
  'noFile' | 'emptyFile' | 'notMarkdown' | 'fileTooLarge' | 'packageTooLarge' | 'tooMany' | 'totalTooLarge'

/** A ZIP package (an article and its images) by its extension; the backend also reads the magic bytes, so the name decides nothing there. */
export const isPackageName = (name: string): boolean => name.toLowerCase().endsWith('.zip')

/**
 * The first reason the files cannot be uploaded, or null. `position` (1-based) names the file when the reason is about one
 * file. The page and the server action both use it, so the two never disagree. A file is a Markdown file (.md) or a ZIP package
 * (.zip); `notMarkdown` is the refusal for any other name and its sentence names both.
 */
export function checkPostFiles(files: readonly { name: string; size: number }[]): {
  key: PostFileRefusal
  position?: number
} | null {
  if (files.length === 0) return { key: 'noFile' }
  if (files.length > POST_IMPORT_MAX_FILES) return { key: 'tooMany' }
  let total = 0
  for (const [index, file] of files.entries()) {
    const position = index + 1
    const pack = isPackageName(file.name)
    if (!pack && !file.name.toLowerCase().endsWith('.md')) return { key: 'notMarkdown', position }
    if (file.size === 0) return { key: 'emptyFile', position }
    if (pack ? file.size > POST_IMPORT_MAX_PACKAGE_BYTES : file.size > POST_IMPORT_MAX_FILE_BYTES) {
      return { key: pack ? 'packageTooLarge' : 'fileTooLarge', position }
    }
    total += file.size
  }
  if (total > POST_IMPORT_MAX_TOTAL_BYTES) return { key: 'totalTooLarge' }
  return null
}

export type PostFileState = 'new' | 'will_change' | 'unchanged' | 'error'

/** A noteworthy, non-blocking fact about a file. `code` is one of the backend constants; the page turns it into a sentence. */
export type PostImportNote = { code: string; key: string | null; line: number | null }
/** A blocking problem. Nothing in it comes from the file: the position is the file's place in the upload. */
export type PostImportProblem = { position: number; key: string | null; line: number | null; message: string }
export type PostIgnoredKey = { name: string | null; line: number }

export type PostChange = { before: string | null; after: string | null }
export type PostPreviewChanges = {
  title: PostChange
  description: PostChange
  category: PostChange
  tagsAdded: number
  tagsRemoved: number
  tagsKept: number
  contentDiffers: boolean
  linkWillBeAdded: boolean
  /** The series the post is in now and the one it joins; null when the file changes nothing about the series (always for an author). */
  series: PostChange | null
  /** The declared part before and after; null exactly when `series` is. */
  seriesPart: { before: number | null; after: number | null } | null
}

/** What a preview says about the ZIP package of a file (`PostPackageFacts`): counts and bytes, never text. */
export type PostPackageFacts = {
  entries: number
  assets: number
  assetBytes: number
  usedAssets: number
  unusedAssets: number
  unsupportedItems: number
}

export type PostPreviewFile = {
  position: number
  fileName: string
  bytes: number
  sha256: string
  slug: string | null
  slugSource: 'file_name' | 'title' | null
  language: string | null
  state: PostFileState
  changes: PostPreviewChanges | null
  notes: PostImportNote[]
  newCategories: string[]
  newTags: string[]
  /** The name of the series the file makes the import create: none or one, administrators only. */
  newSeries: string[]
  problems: PostImportProblem[]
  problemsTotal: number
  ignored: PostIgnoredKey[]
  ignoredTotal: number
  previewState: string | null
  /**
   * The facts of the file's ZIP package; null for a Markdown file and for a package that could not be read. Optional like the
   * optional fields of `PostSummary`: older fixtures and an older backend do not have it, and a missing value means "no package".
   */
  pkg?: PostPackageFacts | null
}

export type PostPreview = {
  files: PostPreviewFile[]
  filesWithProblems: number[]
  problemsOmitted: number
  newCategoryCount: number
  newTagCount: number
  newSeriesCount: number
  totalBytes: number
}

/** One item of the manifest an apply sends, in upload order: the hash the preview reported, the tick, the opaque state. */
export type PostManifestItem = { sha256: string; selected: boolean; state: string | null }

export type PostAppliedResult = 'created' | 'updated' | 'unchanged' | 'skipped'
/** What the apply did with each file, in upload order. `postId` and `slug` are set for a written file, null for a skipped one. */
export type PostApplyResult = {
  importId: number | null
  files: { position: number; fileName: string; result: PostAppliedResult; postId: string | null; slug: string | null }[]
  created: number
  skipped: number
}

/** One mistake in the block syntax of a body (`validateBlocks`), placed on the line of the FILE, not of the body. */
export type PostBlockProblem = { line: number; code: string; block: string | null; message: string }

/**
 * What the article check of one file says: the block syntax problems (capped like the preview's problems, `problemsTotal` counts
 * them all) and how many blocks of each type the body uses, most used first. Plain data: the page keeps it next to the preview file.
 */
export type PostArticleCheck = {
  problems: PostBlockProblem[]
  problemsTotal: number
  blocks: { type: string; count: number }[]
}

/**
 * The article of one file as the backend's article-preview endpoint returns it (`PostArticlePreviewResponse`): the front matter
 * values the article header needs, the body as written, and the images of a package that the body uses, inlined. It carries the
 * text of the file, so only the person who uploaded it receives it and nothing here is stored or logged.
 */
export type PostArticlePreview = {
  fileName: string
  title: string | null
  excerpt: string | null
  category: string | null
  tags: string[]
  language: string | null
  slug: string | null
  body: string | null
  /** The 1-based line of the file where the body starts, 0 when there is none. */
  bodyLine: number
  assets: { path: string; contentType: string; base64: string; width: number; height: number }[]
  pkg: PostPackageFacts | null
  problems: PostImportProblem[]
  problemsTotal: number
}
