/**
 * Asserts that real Tailwind utilities reached the build output.
 *
 * This plan's Review Focus names the hazard and asks for exactly this check: replacing
 * `@import "tailwindcss"` with v3's `@tailwind base/components/utilities` makes
 * `next build` print "Compiled successfully" with no warning while emitting no
 * utilities. Measured on this tree from a clean clone: lint, typecheck, the whole test
 * suite and the build all exit 0, and the site ships unstyled.
 *
 * It runs after `next build` rather than as a unit test because the artifact it checks
 * only exists then — a test that reads `.next` would have to skip when the directory is
 * absent, which is the kind of quietly-passing check this project keeps paying for.
 *
 * A size threshold is not enough, and that is measured too: with the v3 directives the
 * CSS is still 19,738 bytes against 28,033, because the typography plugin and the
 * hand-written rules survive. Only specific utilities distinguish the two.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const DIR = '.next/static/chunks'

// One per family, each generated only by Tailwind's utility engine: layout, spacing,
// colour with a CSS-variable @theme token, a hover variant, and a dark-mode variant.
const REQUIRED = ['max-w-3xl', 'antialiased', 'text-neutral-900', 'hover\\:text-brand', 'dark\\:bg-neutral-950']

if (!existsSync(DIR)) {
  console.error(`verify-css: ${DIR} does not exist — run this after \`next build\`.`)
  process.exit(1)
}

const files = readdirSync(DIR).filter((f) => f.endsWith('.css'))
if (files.length === 0) {
  console.error(`verify-css: no CSS emitted into ${DIR}. Tailwind produced nothing.`)
  process.exit(1)
}

const css = files.map((f) => readFileSync(join(DIR, f), 'utf8')).join('\n')
const missing = REQUIRED.filter((cls) => !css.includes(`.${cls}`))

if (missing.length > 0) {
  console.error(
    `verify-css: ${missing.length} of ${REQUIRED.length} utilities are absent from the ` +
      `emitted CSS (${css.length} bytes across ${files.length} file(s)): ` +
      missing.join(', ') +
      '\nThe build reported success, so suspect app/globals.css: the entry must be ' +
      '`@import "tailwindcss";` and there must be no tailwind.config.*',
  )
  process.exit(1)
}

console.log(`verify-css: ${REQUIRED.length}/${REQUIRED.length} utilities present in ` + `${css.length} bytes of CSS.`)
