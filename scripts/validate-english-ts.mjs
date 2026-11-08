// TypeScript side of scripts/validate-english.py: reads JSON on stdin, writes JSON on stdout.
//   mode "compare": items {path, base, head}; equal when both print identically with comments removed
//                   (maskTitles also blanks the first string argument of it/test/describe calls)
//   mode "scan":    items {path, head}, viChars; lines of test title strings and lines of identifiers that hold a viChars letter
import { createRequire } from 'node:module'
import path from 'node:path'

const ts = createRequire(path.join(import.meta.dirname, '..', 'frontend', 'package.json'))('typescript')

const TITLE_FNS = new Set(['it', 'test', 'describe', 'step', 'fit', 'fdescribe', 'xit', 'xdescribe'])

function kindOf(file) {
  if (file.endsWith('.tsx') || file.endsWith('.jsx')) return ts.ScriptKind.TSX
  if (/\.(js|mjs|cjs)$/.test(file)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function parse(file, text) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kindOf(file))
}

function isTitleCall(node) {
  if (!ts.isCallExpression(node) || node.arguments.length === 0) return false
  let callee = node.expression
  // it.each(table)('title %s', fn): the title call wraps the table call
  while (ts.isPropertyAccessExpression(callee) || ts.isCallExpression(callee)) {
    if (ts.isPropertyAccessExpression(callee) && TITLE_FNS.has(callee.name.text)) return true
    callee = callee.expression
  }
  return ts.isIdentifier(callee) && TITLE_FNS.has(callee.text)
}

function titleNodes(sf) {
  const found = []
  const visit = (node) => {
    if (isTitleCall(node)) {
      const arg = node.arguments[0]
      if (ts.isStringLiteralLike(arg) || ts.isTemplateExpression(arg)) found.push(arg)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

function masked(file, text) {
  const sf = parse(file, text)
  const nodes = titleNodes(sf).sort((a, b) => b.getStart() - a.getStart())
  let out = text
  for (const n of nodes) out = out.slice(0, n.getStart()) + '""' + out.slice(n.getEnd())
  return out
}

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed })

function canonical(file, text, maskTitles) {
  const sf = parse(file, maskTitles ? masked(file, text) : text)
  if (sf.parseDiagnostics.length) {
    const d = sf.parseDiagnostics[0]
    throw new Error(`parse error: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`)
  }
  return printer.printFile(sf)
}


// Layout-insensitive structure: node kinds plus leaf values; parentheses, trailing commas, semicolons, quote style and
// whitespace-only JSX text do not appear, everything a formatter may legally change.
function astSignature(file, text) {
  const sf = parse(file, text)
  if (sf.parseDiagnostics.length) {
    const d = sf.parseDiagnostics[0]
    throw new Error(`parse error: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`)
  }
  const out = []
  const words = (t) => {
    for (const w of t.split(/\s+/)) if (w) out.push('T:' + w)
  }
  const visit = (node) => {
    if (ts.isParenthesizedExpression(node) || ts.isParenthesizedTypeNode(node)) return visit(node.expression ?? node.type)
    if (node.kind === ts.SyntaxKind.EmptyStatement) return
    if (node.kind === ts.SyntaxKind.JsxText) return words(node.text)
    if ((ts.isJsxElement(node) || ts.isJsxFragment(node)) && !ts.isJsxSelfClosingElement(node)) {
      out.push(ts.SyntaxKind[node.kind] + '(')
      if (ts.isJsxElement(node)) visit(node.openingElement)
      // Children: text and string-only expressions compare as words, since a formatter may move a space
      // between {' '}, a line break and plain text (a known limitation: significant-space moves are not told apart).
      for (const c of node.children) {
        if (ts.isJsxExpression(c) && c.expression && ts.isStringLiteralLike(c.expression)) words(c.expression.text)
        else visit(c)
      }
      if (ts.isJsxElement(node)) visit(node.closingElement)
      out.push(')')
      return
    }
    const p = node.parent
    if (p && node === p.name && (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) &&
        (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p))) {
      out.push('K:' + node.text)
      return
    }
    let leaf = ''
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) leaf = node.text
    else if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)) leaf = node.text
    else if (ts.isTemplateLiteralToken(node)) leaf = node.rawText ?? node.text
    else if (ts.isRegularExpressionLiteral(node)) leaf = node.text
    out.push(ts.SyntaxKind[node.kind] + (leaf ? ':' + leaf : '') + '(')
    ts.forEachChild(node, visit)
    out.push(')')
  }
  visit(sf)
  // Comment text as words, found through the compiler (a regex literal such as /\//g is not a comment).
  const seen = new Set()
  const note = (pos, end) => {
    if (seen.has(pos)) return
    seen.add(pos)
    for (const w of sf.text.slice(pos, end).replace(/(^|\s)(\/\*+|\*+\/|\*+|\/\/+)(?=\s|$)/g, ' ').split(/\s+/)) if (w) out.push('C:' + w)
  }
  const walk = (node) => {
    ts.forEachLeadingCommentRange(sf.text, node.pos, (pos, end) => note(pos, end))
    ts.forEachTrailingCommentRange(sf.text, node.end, (pos, end) => note(pos, end))
    for (const c of node.getChildren(sf)) walk(c)
  }
  walk(sf)
  return out
}

const input = JSON.parse(await new Promise((resolve) => {
  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (d) => (buf += d))
  process.stdin.on('end', () => resolve(buf))
}))

const out = []
for (const item of input.items) {
  if (input.mode === 'scan') {
    const sf = parse(item.path, item.head)
    const vi = new RegExp('[' + input.viChars + ']')
    const lines = new Set()
    for (const n of titleNodes(sf)) {
      const s = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1
      const e = sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1
      for (let l = s; l <= e; l++) lines.add(l)
    }
    const idents = new Set()
    const visit = (node) => {
      if ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && vi.test(node.text)) {
        idents.add(sf.getLineAndCharacterOfPosition(node.getStart()).line + 1)
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    const comments = new Set()
    const textLines = sf.text.split(String.fromCharCode(10))
    const seen = new Set()
    const note = (r) => {
      if (seen.has(r.pos)) return
      seen.add(r.pos)
      if (!vi.test(sf.text.slice(r.pos, r.end))) return
      const a = sf.getLineAndCharacterOfPosition(r.pos).line + 1
      const b = sf.getLineAndCharacterOfPosition(r.end).line + 1
      for (let l = a; l <= b; l++) if (vi.test(textLines[l - 1])) comments.add(l)
    }
    const walk = (node) => {
      ts.forEachLeadingCommentRange(sf.text, node.pos, (pos, end) => note({ pos, end }))
      ts.forEachTrailingCommentRange(sf.text, node.end, (pos, end) => note({ pos, end }))
      for (const c of node.getChildren(sf)) walk(c)
    }
    walk(sf)
    out.push({ path: item.path, lines: [...lines], idents: [...idents], comments: [...comments] })
    continue
  }
  if (input.mode === 'ast') {
    try {
      const a = astSignature(item.path, item.base)
      const b = astSignature(item.path, item.head)
      let i = 0
      while (i < a.length && a[i] === b[i]) i++
      out.push(i === a.length && a.length === b.length ? { path: item.path, equal: true } : { path: item.path, equal: false, diff: `syntax node ${i}: ${a[i]} vs ${b[i]}` })
    } catch (err) {
      out.push({ path: item.path, equal: false, diff: String(err.message) })
    }
    continue
  }
  try {
    const a = canonical(item.path, item.base, input.maskTitles)
    const b = canonical(item.path, item.head, input.maskTitles)
    if (a === b) {
      out.push({ path: item.path, equal: true })
    } else {
      const la = a.split('\n')
      const lb = b.split('\n')
      let i = 0
      while (i < la.length && la[i] === lb[i]) i++
      out.push({ path: item.path, equal: false, diff: `printed line ${i + 1}: ${JSON.stringify((la[i] ?? '').trim().slice(0, 70))} vs ${JSON.stringify((lb[i] ?? '').trim().slice(0, 70))}` })
    }
  } catch (err) {
    out.push({ path: item.path, equal: false, diff: String(err.message) })
  }
}
process.stdout.write(JSON.stringify(out))
