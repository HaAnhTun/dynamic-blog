import { describe, expect, it } from 'vitest'
import { SITE_CONTENT_KEYS } from '@/lib/site-content-types'
import { defaultPayload, defaultPayloads, defaultSiteContent } from './index'

const LOCALES = ['en', 'vi'] as const
const IDENTIFIER_KEYS = ['id', 'slug', 'kind', 'level', 'defaultLevel', 'lastUpdated', 'lastVerified', 'href', 'source']

function walk(value: unknown, path: string, visit: (leaf: unknown, path: string) => void): void {
  if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}/${i}`, visit))
  else if (value !== null && typeof value === 'object') Object.entries(value).forEach(([k, v]) => walk(v, `${path}/${k}`, visit))
  else visit(value, path)
}

/** The structure without the translated text: keys, array lengths, nulls and the identifiers are kept. */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? 'text' : shape(v)))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, typeof v === 'string' && !IDENTIFIER_KEYS.includes(k) ? 'text' : shape(v)]),
    )
  }
  return value
}

describe('packaged site content defaults', () => {
  it.each(LOCALES)('%s has all nine keys', (locale) => {
    expect(Object.keys(defaultPayloads(locale)).sort()).toEqual([...SITE_CONTENT_KEYS].sort())
  })

  it.each(SITE_CONTENT_KEYS)('%s has the same structure and ids in both locales', (key) => {
    expect(shape(defaultPayload('vi', key))).toEqual(shape(defaultPayload('en', key)))
  })

  it.each(LOCALES)('%s has no padded text and no control characters', (locale) => {
    walk(defaultPayloads(locale), '', (leaf, path) => {
      if (typeof leaf !== 'string') return
      expect(leaf, path).toBe(leaf.trim())
      expect(
        Array.from(leaf).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
        path,
      ).toBe(false)
    })
  })

  it.each(LOCALES)('%s uses only https or mailto URLs', (locale) => {
    const p = defaultPayloads(locale)
    const urls = [p.contact.github, ...p.contact.social.map((s) => s.url), ...p.blogroll.entries.map((e) => e.url)]
    for (const url of urls) {
      if (url !== null) expect(url).toMatch(/^(https:\/\/|mailto:)/)
    }
    for (const item of p.now.items) {
      if (item.evidence) expect(item.evidence.href).toMatch(/^(https:\/\/|\/(?!\/))/)
    }
  })

  it.each(LOCALES)('%s case studies carry sources and a non-empty ifRedone', (locale) => {
    const { items } = defaultPayloads(locale).case_studies
    expect(items.length).toBeGreaterThan(0)
    for (const study of items) {
      expect(study.ifRedone.length).toBeGreaterThan(0)
      expect(study.results.length).toBeGreaterThan(0)
      for (const r of study.results) expect(r.source.trim()).not.toBe('')
    }
  })

  it.each(LOCALES)('%s loads through defaultSiteContent', (locale) => {
    const content = defaultSiteContent(locale)
    expect(content.site.name).not.toBe('')
    expect(content.caseStudies.map((c) => c.slug)).toEqual(['example-case-study'])
  })
})
