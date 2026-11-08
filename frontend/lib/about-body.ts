/** The longest description taken from a body. */
const LEAD_MAX = 200

/**
 * The first plain sentence of a Markdown body, for the page description when `about.intro` is empty. Skips what is not prose: code
 * fences, whole blocks (`:::name` to `:::`, nested too; their text is not the page lead), headings, tables, HTML lines and blank lines; strips the inline marks of the first prose
 * line (links, images, emphasis, code, list and quote markers). Returns an empty string when the body has no prose line.
 */
export function plainLead(markdown: string): string {
  let inFence = false
  let blockDepth = 0
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim()
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    // `:::name{...}` opens a block, a bare `:::` closes one; `::name{...}` is a one-line block and opens nothing.
    if (/^:{3,}\s*[A-Za-z]/.test(line)) blockDepth += 1
    else if (/^:{3,}\s*$/.test(line)) blockDepth = Math.max(0, blockDepth - 1)
    if (blockDepth > 0 || line === '' || /^[:#|<]/.test(line)) continue
    const text = line
      .replace(/^(?:>\s*)+/, '')
      .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`~]/g, '')
      .trim()
    if (text === '') continue
    const sentence = /^(.+?[.!?])(?:\s|$)/.exec(text)?.[1] ?? text
    return sentence.length > LEAD_MAX ? `${sentence.slice(0, LEAD_MAX - 1).trimEnd()}…` : sentence
  }
  return ''
}
