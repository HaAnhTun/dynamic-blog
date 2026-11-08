/**
 * The images of a ZIP package as the import page's article preview shows them. The author names an image by a path relative to the
 * article (`assets/a.png`); the preview has the bytes, not a URL, so each path maps to a `data:` URL. Pure and without React or
 * `server-only`: the Markdown pipeline and the block dispatcher both look paths up here.
 *
 * `resolvePackagePath` reads a destination the way the backend's `PostPackageRefs.resolve` does (cut at `#` or `?`, percent-decoded,
 * NFC, `.` and `..` resolved), so a path that names an asset for the backend names the same asset here.
 */

/** The three image types a package may hold (the backend's `ImageFormat`); anything else never becomes a data URL. */
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/** Path to `data:` URL. */
export type PreviewImages = ReadonlyMap<string, string>

/** An image of a package as the article-preview endpoint returns it; the size it declares is not needed to show the image. */
export type PreviewAsset = { path: string; contentType: string; base64: string; width?: number; height?: number }

/** The package path a destination names, or null when it names no file of the package (a URL, a site path, a fragment, a path that leaves it). */
export function resolvePackagePath(raw: string): string | null {
  const text = raw.trim()
  if (text === '' || text.startsWith('/') || text.startsWith('#') || text.startsWith('?')) return null
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(text)) return null
  const cut = text.search(/[#?]/)
  let path: string
  try {
    path = decodeURIComponent(cut < 0 ? text : text.slice(0, cut)).normalize('NFC')
  } catch {
    return null
  }
  const parts: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else {
      parts.push(segment)
    }
  }
  return parts.length === 0 ? null : parts.join('/')
}

/** One `data:` URL per usable asset. An asset with another type or a body that is not plain Base64 is left out. */
export function dataUrlsOf(assets: readonly PreviewAsset[]): Map<string, string> {
  const urls = new Map<string, string>()
  for (const asset of assets) {
    if (!IMAGE_TYPES.has(asset.contentType) || !BASE64.test(asset.base64)) continue
    urls.set(asset.path, `data:${asset.contentType};base64,${asset.base64}`)
  }
  return urls
}

/** The `data:` URL of the image that `raw` names, or undefined when it names none of the package's images. */
export function imageFor(images: PreviewImages, raw: string): string | undefined {
  const path = resolvePackagePath(raw)
  return path === null ? undefined : images.get(path)
}
