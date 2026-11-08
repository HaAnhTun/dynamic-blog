// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ACCENT_FIXTURES,
  buildAllPackages,
  buildPackages,
  FIXTURES,
  packageNames,
} from '../../../scripts/fixtures/build-article-zips.mjs'
import { validateBlocks } from './validate'

/**
 * The demo series of `fixtures/article-packages/`: three small parts of one series (and a fourth whose series name has accents,
 * kept under `fixtures/vi/` where the English guard allows such letters). They exist to import the parts in any order and to see the
 * series come out right, so what matters here is that the series keys agree between the files and that each file is a valid package.
 */

const PARTS = ['series-queues-part-1', 'series-queues-part-2', 'series-queues-part-3']
const ACCENTS = 'series-queues-accents'

interface Part {
  readonly name: string
  readonly keys: ReadonlyMap<string, string>
  readonly body: string
  readonly hasAssets: boolean
}

function load(name: string, root = FIXTURES): Part {
  const folder = join(root, name)
  const text = readFileSync(join(folder, 'article.md'), 'utf8').replace(/\r\n/g, '\n')
  const match = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/.exec(text)
  if (!match) throw new Error(`${name}: the article needs front matter and a body`)
  const keys = new Map<string, string>()
  for (const line of match[1]!.split('\n')) {
    const colon = line.indexOf(':')
    keys.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim())
  }
  return {
    name,
    keys,
    body: match[2]!,
    hasAssets: existsSync(join(folder, 'assets')) && readdirSync(join(folder, 'assets')).length > 0,
  }
}

/** The address of a series: its name as a slug, so accents, capitals and punctuation drop out (the backend's `slugifyOrEmpty`). */
const seriesSlug = (name: string) =>
  name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/** The block types of a body in document order (a directive line opens a block). */
const blocksOf = (body: string) => [...body.matchAll(/^:{2,}([a-z][a-z-]*)/gm)].map((match) => match[1]!)

const parts = PARTS.map((name) => load(name))

describe('the demo series', () => {
  it('has three parts that are package folders of the example articles', () => {
    expect(packageNames()).toEqual(expect.arrayContaining(PARTS))
  })

  it('names one series in all three parts, with the parts 1, 2 and 3 in language en', () => {
    expect(parts.map((part) => part.keys.get('series'))).toEqual(Array(3).fill('Queues in practice'))
    expect(parts.map((part) => part.keys.get('series_part'))).toEqual(['1', '2', '3'])
    expect(parts.map((part) => part.keys.get('language'))).toEqual(['en', 'en', 'en'])
  })

  it('gives each part a demo slug of its own', () => {
    expect(parts.map((part) => part.keys.get('slug'))).toEqual([
      'blocks-demo-series-queues-1',
      'blocks-demo-series-queues-2',
      'blocks-demo-series-queues-3',
    ])
  })

  it('gives the same description of the series in every part, within the limit of 2000 characters', () => {
    const [first, second, third] = parts.map((part) => part.keys.get('series_description'))
    expect(first).toBeTruthy()
    expect(first!.length).toBeLessThanOrEqual(2000)
    expect(second).toBe(first)
    expect(third).toBe(first)
  })

  it('differs from part to part in title, excerpt, text and blocks', () => {
    for (const key of ['title', 'excerpt']) {
      expect(new Set(parts.map((part) => part.keys.get(key))).size, key).toBe(3)
    }
    expect(new Set(parts.map((part) => part.body)).size).toBe(3)
    expect(new Set(parts.map((part) => blocksOf(part.body).join('>'))).size).toBe(3)
  })

  it('keeps the limits of the format: short keys, a category and tags, no images, valid blocks', () => {
    for (const part of parts) {
      expect(part.keys.get('title')!.length).toBeLessThanOrEqual(255)
      expect(part.keys.get('category'), part.name).toBeTruthy()
      expect(part.keys.get('tags'), part.name).toBeTruthy()
      expect(part.hasAssets, part.name).toBe(false)
      expect(validateBlocks(part.body), part.name).toEqual([])
    }
  })

  it('has a part 4 that spells the series with accents and still has the web address of the others', () => {
    const fourth = load(ACCENTS, ACCENT_FIXTURES)
    const name = fourth.keys.get('series')!

    expect(name).not.toBe('Queues in practice')
    expect(name).toMatch(/[^\u0000-\u007f]/)
    expect(seriesSlug(name)).toBe(seriesSlug('Queues in practice'))
    expect(fourth.keys.get('series_part')).toBe('4')
    expect(fourth.keys.get('series_description')).toBeUndefined()
    expect(fourth.keys.get('language')).toBe('en')
    expect(fourth.keys.get('slug')).toBe('blocks-demo-series-queues-accents')
    expect(validateBlocks(fourth.body)).toEqual([])
  })

  it('is written by the build script as four archives, the accented one included', () => {
    const all = buildAllPackages()

    expect([...all.keys()]).toEqual(expect.arrayContaining([...PARTS, ACCENTS]))
    expect(all.get(ACCENTS)!.equals(buildPackages(ACCENT_FIXTURES).get(ACCENTS)!)).toBe(true)
    for (const name of [...PARTS, ACCENTS]) expect(all.get(name)!.length, name).toBeLessThan(10_000)
  })
})
