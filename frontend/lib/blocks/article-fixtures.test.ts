// @vitest-environment node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { buildPackages, FIXTURES, packageNames, zipFiles } from '../../../scripts/fixtures/build-article-zips.mjs'
import { crc32, generateAssets } from '../../../scripts/fixtures/make-article-assets.mjs'
import { BLOCKS, BLOCK_TYPES, getBlockSpec } from './registry'
import type { PropSpec } from './types'
import { validateBlocks } from './validate'

/**
 * The example articles of `fixtures/article-packages/`: what the browser verification and the import tests upload. They have to be
 * valid under the registry, reference only assets they ship, and be different enough from one another to show that the same page
 * shell holds very different compositions.
 */

const REQUIRED = ['a-architecture', 'b-tutorial', 'c-concept', 'd-case-study']
/** The reference article: every variant and attribute value the four of the brief leave out. */
const VARIANTS = 'f-variants'
/** The incident review: the blocks of round two (figures, timeline, file tree, tabs, an accordion) and two kinds of highlighted code. */
const POSTMORTEM = 'g-postmortem'

interface Fixture {
  readonly name: string
  readonly frontMatter: ReadonlyMap<string, string>
  readonly body: string
  readonly assets: readonly string[]
}

function listAssets(folder: string, prefix = ''): string[] {
  const directory = join(folder, 'assets', prefix)
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .sort()
    .flatMap((entry) =>
      statSync(join(directory, entry)).isDirectory() ? listAssets(folder, `${prefix}${entry}/`) : [`assets/${prefix}${entry}`],
    )
}

function load(name: string): Fixture {
  const folder = join(FIXTURES, name)
  const text = readFileSync(join(folder, 'article.md'), 'utf8').replace(/\r\n/g, '\n')
  const match = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/.exec(text)
  if (!match) throw new Error(`${name}: the article needs front matter and a body`)
  const frontMatter = new Map<string, string>()
  for (const line of match[1]!.split('\n')) {
    const colon = line.indexOf(':')
    frontMatter.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim())
  }
  return { name, frontMatter, body: match[2]!, assets: listAssets(folder) }
}

const FIXTURE_NAMES: string[] = packageNames()
const FIXTURE_LIST: Fixture[] = FIXTURE_NAMES.map(load)

interface Directive {
  readonly type: string
  /** The attributes the author wrote: the value, or `true` for a bare flag such as `open`. */
  readonly attributes: ReadonlyMap<string, string | true>
}

/** `type="info" title='A title' columns=3 open` as a map. A quoted value is read whole, so words inside it are not attributes. */
function parseAttributes(text: string): Map<string, string | true> {
  const attributes = new Map<string, string | true>()
  for (const match of text.matchAll(/([a-z][a-z-]*)(?:=(?:"([^"]*)"|'([^']*)'|([^\s"'}]+)))?/g)) {
    attributes.set(match[1]!, match[2] ?? match[3] ?? match[4] ?? true)
  }
  return attributes
}

/** The directive blocks of a body in document order, skipping fenced code (and so the raw body of a diagram is not scanned). */
function directives(body: string): Directive[] {
  const found: Directive[] = []
  let fence = ''
  let raw: string | undefined
  for (const line of body.split('\n')) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (fenceMatch && fenceMatch[1]!.startsWith(fence[0]!) && fenceMatch[1]!.length >= fence.length) fence = ''
      continue
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!
      continue
    }
    const open = /^(:{2,})([a-z][a-z-]*)(?:\{(.*)\})?/.exec(line)
    if (raw !== undefined) {
      if (/^:{3,}\s*$/.test(line) && line.trim().length === raw.length) raw = undefined
      continue
    }
    if (open) {
      found.push({ type: open[2]!, attributes: parseAttributes(open[3] ?? '') })
      if (open[2] === 'diagram') raw = open[1]!
    }
  }
  return found
}

/** The block types of a body in document order. */
function blockSequence(body: string): string[] {
  return directives(body).map((directive) => directive.type)
}

function multiset(types: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const type of types) counts.set(type, (counts.get(type) ?? 0) + 1)
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, n]) => `${type}:${n}`)
    .join(',')
}

/** The package-relative paths a body names: Markdown images and the `src` of figure blocks. */
function referencedAssets(body: string): string[] {
  const paths = new Set<string>()
  for (const match of body.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) paths.add(match[1]!)
  for (const match of body.matchAll(/^::+figure\{[^}]*\bsrc="([^"]+)"/gm)) paths.add(match[1]!)
  return [...paths].filter((path) => !/^(https?:)?\/\//.test(path) && !path.startsWith('/'))
}

describe('the example article fixtures', () => {
  it('has the four articles of the brief, the one that shows every variant and the postmortem', () => {
    expect(FIXTURE_NAMES).toEqual(expect.arrayContaining([...REQUIRED, VARIANTS, POSTMORTEM]))
  })

  it.each(FIXTURE_LIST)('$name has the front matter of a post and a demo slug', ({ frontMatter }) => {
    for (const key of ['title', 'slug', 'excerpt', 'category', 'tags']) {
      expect(frontMatter.get(key), key).toBeTruthy()
    }
    expect(frontMatter.get('slug')).toMatch(/^blocks-demo-[a-z0-9-]+$/)
  })

  it('gives every article its own slug and title', () => {
    expect(new Set(FIXTURE_LIST.map((f) => f.frontMatter.get('slug'))).size).toBe(FIXTURE_LIST.length)
    expect(new Set(FIXTURE_LIST.map((f) => f.frontMatter.get('title'))).size).toBe(FIXTURE_LIST.length)
  })

  it.each(FIXTURE_LIST)('$name passes validateBlocks with no problems', ({ body }) => {
    expect(validateBlocks(body)).toEqual([])
  })

  it.each(FIXTURE_LIST)('$name uses only registered blocks', ({ body }) => {
    for (const type of blockSequence(body)) expect(BLOCK_TYPES, type).toContain(type)
  })

  it.each(FIXTURE_LIST)('$name references only assets it ships, and ships only assets it uses', ({ body, assets }) => {
    const referenced = referencedAssets(body)
    for (const path of referenced) expect(assets, `missing ${path}`).toContain(path)
    expect([...assets].sort()).toEqual([...new Set(referenced)].sort())
  })

  it.each(FIXTURE_LIST)('$name is English, ASCII and free of addresses and scripts', ({ name }) => {
    const text = readFileSync(join(FIXTURES, name, 'article.md'), 'utf8')
    expect(text).toMatch(/^[\x09\x0a\x0d\x20-\x7e]*$/)
    expect(text).not.toMatch(/@|<script|<iframe|javascript:/i)
  })

  it('differs from article to article in the blocks it uses and in their order', () => {
    const sequences = FIXTURE_LIST.map((f) => blockSequence(f.body))
    expect(new Set(sequences.map(multiset)).size).toBe(FIXTURE_LIST.length)
    expect(new Set(sequences.map((s) => s.join('>'))).size).toBe(FIXTURE_LIST.length)
    expect(new Set(sequences.map((s) => s.length)).size).toBe(FIXTURE_LIST.length)
    // The registry has more blocks than any one article needs: no article is a catalogue of all of them.
    for (const sequence of sequences) expect(new Set(sequence).size).toBeLessThan(BLOCK_TYPES.length)
  })

  it('keeps the four main articles different from one another, with or without the other examples', () => {
    const sequences = REQUIRED.map((name) => blockSequence(FIXTURE_LIST.find((f) => f.name === name)!.body))
    expect(new Set(sequences.map(multiset)).size).toBe(REQUIRED.length)
    expect(new Set(sequences.map((s) => s.join('>'))).size).toBe(REQUIRED.length)
    expect(new Set(sequences.map((s) => s.length)).size).toBe(REQUIRED.length)
  })

  it('shows every value of every enum, integer and flag attribute of the registry in at least one article', () => {
    // An attribute an author leaves out is drawn with its default, so the default counts as shown wherever the block is used.
    const shown = new Map<string, Set<string>>()
    for (const { body } of FIXTURE_LIST) {
      for (const { type, attributes } of directives(body)) {
        const props: readonly PropSpec[] = getBlockSpec(type)?.props ?? []
        for (const prop of props) {
          const written = attributes.get(prop.name)
          const value = written === undefined ? prop.default : written === true ? 'true' : written
          if (value === undefined) continue
          const key = `${type}.${prop.name}`
          shown.set(key, (shown.get(key) ?? new Set<string>()).add(String(value)))
        }
      }
    }

    const missing: string[] = []
    for (const spec of BLOCKS) {
      const props: readonly PropSpec[] = spec.props
      for (const prop of props) {
        const wanted: readonly (string | number)[] =
          prop.type === 'enum'
            ? (prop.values ?? [])
            : prop.type === 'integer'
              ? Array.from({ length: (prop.max ?? 0) - (prop.min ?? 0) + 1 }, (_, i) => (prop.min ?? 0) + i)
              : prop.type === 'boolean'
                ? ['true']
                : []
        for (const value of wanted) {
          if (!shown.get(`${spec.type}.${prop.name}`)?.has(String(value))) missing.push(`${spec.type}.${prop.name}=${value}`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  it('uses every block of the registry, and every attribute of every block, in at least one article', () => {
    const used = new Map<string, Set<string>>()
    for (const { body } of FIXTURE_LIST) {
      for (const { type, attributes } of directives(body)) {
        const names = used.get(type) ?? new Set<string>()
        for (const name of attributes.keys()) names.add(name)
        used.set(type, names)
      }
    }

    const missing: string[] = []
    for (const spec of BLOCKS) {
      const names = used.get(spec.type)
      if (!names) missing.push(spec.type)
      else for (const prop of spec.props) if (!names.has(prop.name)) missing.push(`${spec.type}.${prop.name}`)
    }
    expect(missing).toEqual([])
  })

  it('tells an incident in the postmortem with the blocks of round two and two kinds of highlighted code', () => {
    const { body, frontMatter, assets } = FIXTURE_LIST.find((f) => f.name === POSTMORTEM)!
    const found = directives(body)
    const of = (type: string) => found.filter((directive) => directive.type === type)
    const attribute = (type: string, name: string) => of(type).map((directive) => directive.attributes.get(name))

    expect(frontMatter.get('language')).toBe('en')
    expect(frontMatter.get('slug')).toBe('blocks-demo-postmortem')
    expect(assets).toEqual([])
    // Key figures: the three trends, one each.
    expect(of('metrics')).toHaveLength(1)
    expect(attribute('metric', 'trend')).toEqual(['down', 'up', 'flat'])
    // A timeline of four events, one of them holding a callout.
    expect(of('timeline')).toHaveLength(1)
    expect(of('event')).toHaveLength(4)
    expect(of('callout')).toHaveLength(1)
    expect(blockSequence(body).join('>')).toContain('event>callout>event')
    expect(of('file-tree')).toHaveLength(1)
    // Tabs for three systems, the last one holding steps.
    expect(attribute('tab', 'title')).toEqual(['macOS', 'Linux', 'Windows'])
    expect(blockSequence(body).join('>')).toContain('tabs>tab>tab>tab>steps>step>step')
    // An accordion: two details blocks that share one group.
    const groups = attribute('details', 'group')
    expect(groups).toHaveLength(2)
    expect(typeof groups[0]).toBe('string')
    expect(groups[1]).toBe(groups[0])
    // A diff with a title, and code with lines highlighted.
    expect(body).toMatch(/^```diff title="[^"]+"$/m)
    expect(body).toMatch(/^```yaml .*\bhighlight="[0-9,-]+"/m)
  })

  it('composes the articles as the brief asks', () => {
    const [a, b, c, d] = REQUIRED.map((name) => FIXTURE_LIST.find((f) => f.name === name)!)
    const types = (f: Fixture) => new Set(blockSequence(f.body))
    const uses = (f: Fixture, ...wanted: string[]) => wanted.every((type) => types(f).has(type))
    const hasFence = (f: Fixture) => /^\s*(```|~~~)/m.test(f.body)
    // A: diagram, code, trade-off comparison and an operational warning.
    expect(uses(a, 'diagram', 'code-tabs', 'comparison', 'callout')).toBe(true)
    // B: prerequisites, numbered steps, commands, screenshots and troubleshooting details, and no diagram.
    expect(uses(b, 'checklist', 'steps', 'step', 'figure', 'details')).toBe(true)
    expect(types(b).has('diagram')).toBe(false)
    expect(hasFence(b)).toBe(true)
    // C: diagrams and callouts, and no code at all.
    expect(uses(c, 'diagram', 'callout')).toBe(true)
    expect(hasFence(c)).toBe(false)
    expect(types(c).has('code-tabs')).toBe(false)
    // D: a comparison matrix and before and after examples, and no diagram.
    expect(uses(d, 'comparison', 'compare')).toBe(true)
    expect(d.body).toContain('variant="before-after"')
    expect(types(d).has('diagram')).toBe(false)
  })

  it('keeps one article to headings, prose and a table', () => {
    const plain = FIXTURE_LIST.filter((f) => blockSequence(f.body).length === 0)
    expect(plain.length).toBeGreaterThanOrEqual(1)
    for (const { body } of plain) {
      expect(body).toMatch(/^## /m)
      expect(body).toMatch(/^\|.*\|\s*\n\|[-| :]+\|/m)
      expect(body).not.toMatch(/^\s*(```|~~~)/m)
    }
  })
})

describe('the fixture images', () => {
  const generated = generateAssets()

  it('are the output of the generator, byte for byte', () => {
    for (const [path, bytes] of generated) {
      expect(readFileSync(join(FIXTURES, path)).equals(bytes), path).toBe(true)
    }
    expect(generated.size).toBeGreaterThan(0)
  })

  it.each([...generated])('%s is a small PNG with no metadata chunks', (_path, bytes) => {
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    const chunks: string[] = []
    for (let at = 8; at < bytes.length;) {
      chunks.push(bytes.toString('latin1', at + 4, at + 8))
      at += 12 + bytes.readUInt32BE(at)
    }
    expect(chunks).toEqual(['IHDR', 'IDAT', 'IEND'])
    expect(bytes.length).toBeLessThan(100_000)
  })
})

interface ZipEntry {
  readonly name: string
  readonly data: Buffer
}

/** A minimal reader of the archives the builder writes: the central directory, then each entry checked against its CRC. */
function readZip(zip: Buffer): ZipEntry[] {
  const end = zip.length - 22
  expect(zip.readUInt32LE(end)).toBe(0x06054b50)
  const count = zip.readUInt16LE(end + 10)
  let at = zip.readUInt32LE(end + 16)
  const entries: ZipEntry[] = []
  for (let i = 0; i < count; i += 1) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50)
    const method = zip.readUInt16LE(at + 10)
    const crc = zip.readUInt32LE(at + 16)
    const packed = zip.readUInt32LE(at + 20)
    const size = zip.readUInt32LE(at + 24)
    const nameLength = zip.readUInt16LE(at + 28)
    const local = zip.readUInt32LE(at + 42)
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength)
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    const stored = zip.subarray(start, start + packed)
    const data = method === 8 ? inflateRawSync(stored) : Buffer.from(stored)
    expect(data.length, name).toBe(size)
    expect(crc32(data), name).toBe(crc)
    entries.push({ name, data })
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32)
  }
  return entries
}

describe('the package builder', () => {
  const packages = buildPackages()

  it('builds one archive per article folder', () => {
    expect([...packages.keys()]).toEqual(FIXTURE_NAMES)
  })

  it.each(FIXTURE_NAMES)('%s is under 1 MB, holds its article and its assets, and reads back exactly', (name) => {
    const zip = packages.get(name)!
    expect(zip.length).toBeLessThan(1_000_000)
    const entries = readZip(zip)
    const folder = join(FIXTURES, name)
    expect(entries.map((e) => e.name)).toEqual(['article.md', ...listAssets(folder)])
    for (const entry of entries) {
      expect(entry.name).toMatch(/^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/)
      expect(entry.data.equals(readFileSync(join(folder, entry.name))), entry.name).toBe(true)
    }
  })

  it('writes the same bytes on every run', () => {
    const again = buildPackages()
    for (const [name, zip] of packages) expect(again.get(name)!.equals(zip), name).toBe(true)
    const file = [{ name: 'x.txt', data: Buffer.from('same') }]
    expect(zipFiles(file).equals(zipFiles(file))).toBe(true)
  })
})
