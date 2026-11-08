// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

/**
 * components/RootShell.tsx calls next/font `Inter()`, which only runs through the Next compiler, so
 * most tests read the source instead of importing the module. They read the code part, without comments: the comments there talk about
 * very long subsets.
 *
 * `viewport` is read straight from the module: next/font/google is replaced by a function returning exactly the shape
 * the layout uses (`variable`), and vi.mock only changes the import, not the tests that read the source.
 */
vi.mock('next/font/google', () => ({ Inter: () => ({ variable: 'font-inter-test' }) }))

const strip = (file: string) =>
  readFileSync(join(process.cwd(), file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

const code = strip('components/RootShell.tsx')
const metadataCode = strip('lib/root-metadata.ts')

describe('components/RootShell.tsx and lib/root-metadata.ts', () => {
  it("Inter loads 'latin-ext' as well: the Vietnamese letters live in that subset, so it must be preloaded", () => {
    // Without being in `subsets`, the latin-ext file (83.6 KiB, the largest) is not preloaded but is only
    // discovered after the CSS has been read — measured on the QA stack, it pushes the text LCP up to 3.0 s.
    const subsets = /subsets:\s*\[([^\]]*)\]/.exec(code)
    expect(subsets, 'Inter subsets not found').not.toBeNull()
    const names = subsets![1]!
      .split(',')
      .map((s) => s.trim().replace(/['"]/g, ''))
      .filter(Boolean)
    expect(names).toEqual(expect.arrayContaining(['latin', 'latin-ext', 'vietnamese']))
  })

  it('the root layout share tags carry size and alt (siteOgImage), not just the URL', () => {
    expect(metadataCode).toMatch(/images:\s*\[await siteOgImage\(locale\)\]/)
    expect(metadataCode).not.toMatch(/images:\s*\[OG_IMAGE\]/)
  })
})

describe('lib/root-metadata.ts: viewport (V6 P1-10)', () => {
  it('theme-color follows the OS: exactly the <body> background of the light and dark themes; no colorScheme', async () => {
    const { rootViewport: viewport } = await import('@/lib/root-metadata')

    // Exactly two entries, in order, no other key. A `colorScheme` here produces
    // <meta name="color-scheme">, which the browser reads before CSS and before the boot script: it would paint the
    // canvas by OS for a reader who chose the opposite theme. `color-scheme` lives in globals.css.
    expect(viewport).toEqual({
      themeColor: [
        { media: '(prefers-color-scheme: light)', color: '#ffffff' },
        { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
      ],
    })
  })

  it('those two colors are the <body> background: bg-white and dark:bg-neutral-950 (#0a0a0a)', () => {
    // The browser bar has the same color as the page: change the <body> background and theme-color follows.
    const body = /<body className="([^"]*)"/.exec(code)
    expect(body, 'className of <body> not found').not.toBeNull()
    expect(body![1]!.split(/\s+/)).toEqual(expect.arrayContaining(['bg-white', 'dark:bg-neutral-950']))
  })
})
