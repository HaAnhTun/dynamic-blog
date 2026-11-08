import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * User-facing text lives in the message catalogs. This test fails when a component outside the allowlist has a literal with
 * letters in JSX text or in the attributes `aria-label`, `alt`, `title`, `placeholder`, `label`, `aria-description`.
 *
 * Limits: it does not see text built in plain strings handed to a component prop with another name, nor strings in helper
 * modules (the strict English guard covers Vietnamese there, not English). Exceptions: a literal with no letters (symbols, numbers),
 * a path (starts with `/`), the proper nouns GitHub and RSS, the key cap `esc`, and a line, or the line before it, carrying `i18n-ok: <reason>` (brand names, code samples, language names).
 */
const ROOTS = ['app', 'components']
const ATTRIBUTES = new Set(['aria-label', 'alt', 'title', 'placeholder', 'label', 'aria-description'])
const LETTERS = /\p{L}/u
/** Proper nouns and key caps that are the same in every language. */
const UNIVERSAL = new Set(['GitHub', 'RSS', 'esc'])
const isUniversal = (text: string) => UNIVERSAL.has(text.trim().replace(/\s*→$/, '')) || text.trim().startsWith('/')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) out.push(full)
  }
  return out
}

function findings(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  const report = (node: ts.Node, what: string) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart()).line
    if (/i18n-ok:/.test(lines[line] ?? '') || /i18n-ok:/.test(lines[line - 1] ?? '')) return
    out.push(`${path.relative('.', file).split(path.sep).join('/')}:${line + 1} ${what}`)
  }
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node) && LETTERS.test(node.text) && !isUniversal(node.text))
      report(node, `JSX text "${node.text.trim().slice(0, 40)}"`)
    if (
      ts.isJsxAttribute(node) &&
      ATTRIBUTES.has(node.name.getText()) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer)
    ) {
      if (LETTERS.test(node.initializer.text)) report(node, `${node.name.getText()}="${node.initializer.text.slice(0, 40)}"`)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

describe('no literal user-facing text in components', () => {
  it('finds none in app/ and components/ outside the allowlist', () => {
    const all = ROOTS.flatMap((root) => walk(root)).flatMap(findings)
    expect(all).toEqual([])
  })

  it('detects JSX text and attributes in a fixture, and honours i18n-ok', () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-literal-'))
    try {
      const file = path.join(dir, 'Bad.tsx')
      fs.writeFileSync(
        file,
        [
          'export const A = () => <p title="Hello">Welcome</p>',
          'export const B = () => <p>{1}</p>',
          '// i18n-ok: brand name',
          'export const C = () => <b>GitHub</b>',
        ].join('\n'),
      )
      expect(findings(file).map((f) => f.replace(/^.*Bad\.tsx/, 'Bad.tsx'))).toEqual([
        'Bad.tsx:1 title="Hello"',
        'Bad.tsx:1 JSX text "Welcome"',
      ])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
