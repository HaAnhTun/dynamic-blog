/**
 * Asserts that the mermaid library stays a lazy chunk: only a page that draws a diagram downloads it.
 *
 * Run it after `next build --webpack` (the build of the E2E stack): `node scripts/verify-lazy-mermaid.mjs [buildDir]`. It reads
 * `.next/react-loadable-manifest.json`, which lists, for every dynamic `import()` of the code base, the chunks that import needs.
 * The entry of `components/site/blocks/DiagramView.tsx` -> `mermaid` names the chunks of the library; they must appear in no
 * prerendered page (`.next/server/app/**\/*.html`), in no client reference manifest (the list of chunks each route loads up
 * front) and in no list of the build manifest. A page without a diagram then never fetches them: they are loaded by the
 * `import('mermaid')` that runs after a diagram block mounts, and by nothing else.
 *
 * It is not part of `npm run build`: the manifest it reads is the webpack one, and a Turbopack build lays out its manifests
 * differently, so a missing manifest is reported (exit 1) instead of being taken for a pass. The same reasoning as
 * scripts/verify-css.mjs for being a script rather than a unit test: the artifact only exists after a build.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const dir = process.argv[2] ?? '.next'
const manifestPath = join(dir, 'react-loadable-manifest.json')

function fail(message) {
  console.error(`verify-lazy-mermaid: ${message}`)
  process.exit(1)
}

if (!existsSync(manifestPath)) {
  fail(`${manifestPath} does not exist; run it after \`next build --webpack\`.`)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const entry = Object.entries(manifest).find(([key]) => /DiagramView\.tsx -> mermaid$/.test(key.replaceAll('\\', '/')))
if (!entry) {
  fail('no dynamic import of mermaid in components/site/blocks/DiagramView.tsx: it was imported statically or moved.')
}
const lazy = entry[1].files.map((file) => basename(file))
if (lazy.length === 0) fail('the import of mermaid lists no chunk.')

/** Every file under `root` whose name satisfies `keep`. */
function walk(root, keep, out = []) {
  if (!existsSync(root)) return out
  for (const item of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, item.name)
    if (item.isDirectory()) walk(full, keep, out)
    else if (keep(item.name)) out.push(full)
  }
  return out
}

const pages = walk(join(dir, 'server', 'app'), (name) => name.endsWith('.html') || name.endsWith('_client-reference-manifest.js'))
const manifests = ['build-manifest.json', 'app-build-manifest.json'].map((name) => join(dir, name)).filter(existsSync)
const checked = [...pages, ...manifests]
if (pages.length === 0) fail(`no prerendered page or route manifest under ${join(dir, 'server', 'app')}: nothing to check.`)

const offenders = []
for (const file of checked) {
  const text = readFileSync(file, 'utf8')
  for (const chunk of lazy) if (text.includes(chunk)) offenders.push(`${file}: ${chunk}`)
}

if (offenders.length > 0) {
  fail(`the mermaid chunks are loaded up front by:\n  ${offenders.join('\n  ')}`)
}
console.log(
  `verify-lazy-mermaid: ok. ${lazy.length} chunks of the mermaid import (${lazy.join(', ')}) are in none of the ${pages.length} pages and route manifests, nor the build manifest.`,
)
