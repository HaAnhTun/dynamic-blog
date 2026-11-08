// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CODE_LANGUAGES } from './code-languages'

/**
 * `CODE_LANGUAGES` is the one list of the fence languages that are highlighted. The loader of `lib/markdown.tsx` has to import each
 * grammar by a literal specifier (a built name would hide it from the bundler), so the list and the imports are two texts: this reads
 * the second one and compares it with the first.
 */

const MARKDOWN_SOURCE = readFileSync(join(process.cwd(), 'lib', 'markdown.tsx'), 'utf8')

describe('the code languages', () => {
  it('are unique, lower case and in step with the literal grammar imports of the loader', () => {
    expect(new Set(CODE_LANGUAGES).size).toBe(CODE_LANGUAGES.length)
    for (const language of CODE_LANGUAGES) expect(language).toMatch(/^[a-z]+$/)

    const entries = [...MARKDOWN_SOURCE.matchAll(/^\s+([a-z]+): \(\) => import\('@shikijs\/langs\/([a-z]+)'\),$/gm)].map(
      (match) => [match[1], match[2]],
    )
    // Each language is loaded from the grammar of its own name, once, and nothing else is loaded.
    expect(entries.map(([language]) => language)).toEqual([...CODE_LANGUAGES])
    expect(entries.every(([language, grammar]) => language === grammar)).toBe(true)
    expect([...MARKDOWN_SOURCE.matchAll(/import\('@shikijs\/langs\/([a-z]+)'\)/g)].map((match) => match[1])).toEqual([
      ...CODE_LANGUAGES,
    ])
  })

  it('all ship as grammars of the installed package, so adding one needs no dependency', () => {
    for (const language of CODE_LANGUAGES) {
      expect(existsSync(join(process.cwd(), 'node_modules', '@shikijs', 'langs', 'dist', `${language}.mjs`)), language).toBe(true)
    }
  })

  it('include the ten languages of round two', () => {
    expect(CODE_LANGUAGES).toEqual(
      expect.arrayContaining(['diff', 'shellsession', 'go', 'rust', 'html', 'css', 'dockerfile', 'toml', 'markdown', 'ini']),
    )
    expect(CODE_LANGUAGES).toHaveLength(20)
  })
})
