// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { CSP_REPORT_GROUP, CSP_REPORT_PATH, buildContentSecurityPolicy } from './csp-policy.mjs'

/** The directives of a policy as a name -> sources map. */
function parse(policy: string): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/)
    if (name) map.set(name, sources)
  }
  return map
}

describe('buildContentSecurityPolicy', () => {
  const prod = parse(buildContentSecurityPolicy({ dev: false, siteUrl: 'http://localhost:3000' }))

  it('locks down the directives that need no exception', () => {
    expect(prod.get('default-src')).toEqual(["'self'"])
    expect(prod.get('object-src')).toEqual(["'none'"])
    expect(prod.get('base-uri')).toEqual(["'none'"])
    expect(prod.get('form-action')).toEqual(["'self'"])
    expect(prod.get('frame-ancestors')).toEqual(["'none'"])
    expect(prod.get('frame-src')).toEqual(["'none'"])
    expect(prod.get('connect-src')).toEqual(["'self'"])
    expect(prod.get('font-src')).toEqual(["'self'", 'data:'])
  })

  it('uses no nonce and no wildcard, so static and ISR pages stay cacheable', () => {
    const text = buildContentSecurityPolicy({ dev: false, siteUrl: 'https://example.org' })
    expect(text).not.toContain('nonce-')
    expect(text).not.toMatch(/\s\*(\s|;|$)/)
  })

  it('opens a whole scheme to nothing but images: no other directive has https: or http:', () => {
    const policy = parse(buildContentSecurityPolicy({ dev: false, siteUrl: 'https://example.org' }))
    for (const [name, sources] of policy) {
      if (name === 'img-src') continue
      expect(
        sources.filter((source) => /^https?:$/.test(source)),
        name,
      ).toEqual([])
    }
  })

  it('allows inline scripts (theme boot script, RSC payload) but never eval in production', () => {
    expect(prod.get('script-src')).toEqual(["'self'", "'unsafe-inline'"])
  })

  it('allows eval only in next dev', () => {
    const dev = parse(buildContentSecurityPolicy({ dev: true, siteUrl: 'http://localhost:3000' }))
    expect(dev.get('script-src')).toEqual(["'self'", "'unsafe-inline'", "'unsafe-eval'"])
  })

  it('allows images from the site, data and blob URLs and any https host (an author may embed one), never plain http', () => {
    expect(prod.get('img-src')).toEqual(["'self'", 'data:', 'blob:', 'https:'])
  })

  it('allows inline styles (Tailwind, next/font, React style attributes)', () => {
    expect(prod.get('style-src')).toEqual(["'self'", "'unsafe-inline'"])
  })

  it('adds upgrade-insecure-requests only for an https site URL', () => {
    expect(prod.has('upgrade-insecure-requests')).toBe(false)
    const secure = parse(buildContentSecurityPolicy({ dev: false, siteUrl: 'https://example.org' }))
    expect(secure.has('upgrade-insecure-requests')).toBe(true)
    const insecureDev = parse(buildContentSecurityPolicy({ dev: true, siteUrl: 'https://example.org' }))
    expect(insecureDev.has('upgrade-insecure-requests')).toBe(true)
  })

  it('treats an empty or missing site URL as not https', () => {
    for (const siteUrl of ['', undefined, '  ', 'http://example.org']) {
      expect(parse(buildContentSecurityPolicy({ dev: false, siteUrl })).has('upgrade-insecure-requests')).toBe(false)
    }
  })

  it('names the report endpoint twice: report-uri for Firefox and Safari, report-to for Chrome and Edge', () => {
    expect(CSP_REPORT_PATH).toBe('/api/csp-report')
    expect(prod.get('report-uri')).toEqual([CSP_REPORT_PATH])
    expect(prod.get('report-to')).toEqual([CSP_REPORT_GROUP])
    // A relative path: the report goes to the origin that sent the page, never to another host.
    expect(CSP_REPORT_PATH).toMatch(/^\/[a-z/-]+$/)
  })

  it('reports in a Report-Only policy too', () => {
    const report = parse(buildContentSecurityPolicy({ dev: false, siteUrl: 'https://example.org', reportOnly: true }))
    expect(report.get('report-uri')).toEqual([CSP_REPORT_PATH])
    expect(report.get('report-to')).toEqual([CSP_REPORT_GROUP])
  })

  it('leaves out the directives a Report-Only policy ignores, and keeps the rest', () => {
    const report = parse(buildContentSecurityPolicy({ dev: false, siteUrl: 'https://example.org', reportOnly: true }))
    expect(report.has('frame-ancestors')).toBe(false)
    expect(report.has('upgrade-insecure-requests')).toBe(false)
    expect(report.get('form-action')).toEqual(["'self'"])
    expect(report.get('base-uri')).toEqual(["'none'"])
  })
})
