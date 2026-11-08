import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RESERVED_PAGE_IDS } from './page-ids'

const ROOT = resolve(__dirname, '..')
const SOURCE = /\.(ts|tsx)$/
const TEST = /\.test\.(ts|tsx)$/

function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && SOURCE.test(entry.name) && !TEST.test(entry.name))
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'))
}

describe('RESERVED_PAGE_IDS', () => {
  const code = [...sources('components'), ...sources('app')].join('\n')

  it('lists only ids that are still in the pages, so a rename cannot leave the list behind', () => {
    expect(RESERVED_PAGE_IDS.length).toBeGreaterThan(0)
    for (const id of RESERVED_PAGE_IDS) {
      expect(code.includes(`"${id}"`) || code.includes(`'${id}'`), id).toBe(true)
    }
  })

  it('has each id once, as a lowercase slug (the only form a heading slug can take)', () => {
    expect(new Set(RESERVED_PAGE_IDS).size).toBe(RESERVED_PAGE_IDS.length)
    for (const id of RESERVED_PAGE_IDS) expect(id).toMatch(/^[a-z][a-z0-9-]*$/)
  })
})
