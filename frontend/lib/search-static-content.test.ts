// @vitest-environment node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultSiteContent } from '@/content/defaults'
import { navItems } from '@/components/site/nav-items'
import { buildStaticSearchContent, serializeStaticSearchContent, STATIC_CONTENT_PATH } from './search-static-content'

const target = resolve(__dirname, '..', STATIC_CONTENT_PATH)

describe('static content for the backend search', () => {
  // `npm run search:export` runs this file with `--mode export`: it rewrites the JSON from the packaged defaults.
  it.runIf(import.meta.env.MODE === 'export')('ghi JSON cho backend', () => {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, serializeStaticSearchContent())
  })

  it('the JSON committed in the backend matches the TS source (after changing content, run npm run search:export)', () => {
    expect(existsSync(target), target).toBe(true)
    expect(readFileSync(target, 'utf-8').replace(/\r\n/g, '\n')).toBe(serializeStaticSearchContent())
  })

  it('all nav pages, all case studies, the site owner pointing to /about; no empty field', () => {
    const content = buildStaticSearchContent()
    expect(content.owner.href).toBe('/about')
    for (const item of navItems) expect(content.pages.map((page) => page.href)).toContain(item.href)
    expect(content.caseStudies.map((study) => study.slug)).toEqual(
      defaultSiteContent('vi').caseStudies.map((study) => study.slug),
    )
    for (const page of content.pages) {
      expect(page.slug).toMatch(/^[a-z0-9-]+$/)
      expect(page.title && page.description).toBeTruthy()
    }
    for (const study of content.caseStudies) expect(study.title && study.summary && study.body).toBeTruthy()
  })
})
