import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import vi from '@/messages/vi.json'
import { flatten, type Catalog } from './catalog-check'

/**
 * Both directions of "the catalog and the code agree", by static reading of the source:
 *
 * - missing: a literal key in `t('a.b')`, `t.rich('a.b')`... that no namespace of the file resolves to a catalog entry;
 * - unused: a catalog key that no source file can reach.
 *
 * What counts as reaching a key: its full path, or its path relative to a namespace some file opens with `useTranslations(ns)`,
 * `getTranslations(ns)` or `{ namespace }`, written as a string literal anywhere in the source, or as a template literal
 * (`status.${code}`) or a literal ending in a dot (`'codes.'`) that matches it. This is deliberately a little generous: a key
 * that is only built from free text is not detectable, and keys must be reachable through literals, which is also what keeps
 * them greppable.
 */
const ROOTS = ['app', 'components', 'lib', 'i18n']
const TRANSLATE_CALLEE = /^t([A-Z]\w*)?$/

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

type FileInfo = { file: string; namespaces: Set<string>; calls: { key: string; line: number }[] }

type Scan = { files: FileInfo[]; literals: Set<string>; patterns: RegExp[]; prefixes: Set<string>; namespaces: Set<string> }

function scan(files: string[]): Scan {
  const result: Scan = { files: [], literals: new Set(), patterns: [], prefixes: new Set(), namespaces: new Set() }
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8')
    const sf = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    const info: FileInfo = { file, namespaces: new Set(), calls: [] }
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        result.literals.add(node.text)
        if (node.text.endsWith('.')) result.prefixes.add(node.text)
      } else if (ts.isTemplateExpression(node)) {
        const parts = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)]
        const source = parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+')
        result.patterns.push(new RegExp(`^${source}$`))
        if (node.head.text.endsWith('.')) result.prefixes.add(node.head.text)
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : ''
        const first = node.arguments[0]
        if (['useTranslations', 'getTranslations', 'createTranslator'].includes(name) && first) {
          if (ts.isStringLiteralLike(first)) info.namespaces.add(first.text)
          else if (ts.isObjectLiteralExpression(first)) {
            for (const prop of first.properties) {
              if (
                ts.isPropertyAssignment(prop) &&
                prop.name.getText() === 'namespace' &&
                ts.isStringLiteralLike(prop.initializer)
              )
                info.namespaces.add(prop.initializer.text)
            }
          }
        }
        const base =
          ts.isPropertyAccessExpression(callee) && ['rich', 'raw', 'markup'].includes(callee.name.text)
            ? callee.expression
            : callee
        if (ts.isIdentifier(base) && TRANSLATE_CALLEE.test(base.text) && first && ts.isStringLiteralLike(first)) {
          info.calls.push({ key: first.text, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1 })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    for (const ns of info.namespaces) result.namespaces.add(ns)
    result.files.push(info)
  }
  return result
}

const files = ROOTS.flatMap((root) => walk(root))
const source = scan(files)
const keys = [...flatten(vi as Catalog).keys()]
const keySet = new Set(keys)

/** The unused keys of `catalogKeys` for a scan of the source. */
export function unusedKeys(catalogKeys: string[], sc: Scan): string[] {
  return catalogKeys.filter((key) => {
    if (sc.literals.has(key)) return false
    const segments = key.split('.')
    for (let cut = 1; cut < segments.length; cut += 1) {
      const namespace = segments.slice(0, cut).join('.')
      if (!sc.namespaces.has(namespace)) continue
      const relative = segments.slice(cut).join('.')
      if (sc.literals.has(relative) || sc.patterns.some((pattern) => pattern.test(relative))) return false
      for (const prefix of sc.prefixes) if (relative.startsWith(prefix)) return false
    }
    return true
  })
}

describe('catalog and source agree', () => {
  it('actually scanned the source', () => {
    expect(source.files.length).toBeGreaterThan(100)
    expect(source.files.flatMap((info) => info.calls).length).toBeGreaterThan(300)
    expect(keys.length).toBeGreaterThan(500)
  })

  it('every literal key a file translates exists in the catalog', () => {
    const missing: string[] = []
    for (const info of source.files) {
      if (info.namespaces.size === 0) continue
      for (const call of info.calls) {
        const found = [...info.namespaces].some(
          (ns) => keySet.has(`${ns}.${call.key}`) || [...keySet].some((k) => k.startsWith(`${ns}.${call.key}.`)),
        )
        if (!found && !keySet.has(call.key)) missing.push(`${info.file.split(path.sep).join('/')}:${call.line} ${call.key}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('every catalog key is reachable from the source', () => {
    expect(unusedKeys(keys, source)).toEqual([])
  })

  it('detects an unreachable key on a fixture, and accepts template and prefix forms', () => {
    const fixture: Scan = {
      files: [],
      literals: new Set(['used', 'codes.']),
      patterns: [/^status\..+$/],
      prefixes: new Set(['codes.']),
      namespaces: new Set(['Site.demo']),
    }
    const catalog = ['Site.demo.used', 'Site.demo.status.draft', 'Site.demo.codes.NOT_FOUND', 'Site.demo.dead', 'Other.never']
    expect(unusedKeys(catalog, fixture)).toEqual(['Site.demo.dead', 'Other.never'])
  })
})
