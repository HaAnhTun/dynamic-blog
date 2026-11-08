// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { CSP_REPORT_MAX_ENTRIES, blockedOrigin, isReportContentType, readViolations } from './csp-report'

const LEGACY = 'application/csp-report'
const REPORTING_API = 'application/reports+json'

function legacy(report: Record<string, unknown>): string {
  return JSON.stringify({ 'csp-report': report })
}

function reportingApi(...bodies: Record<string, unknown>[]): string {
  return JSON.stringify(bodies.map((body) => ({ type: 'csp-violation', age: 3, url: 'https://blog.example/a?q=secret', body })))
}

describe('blockedOrigin: what is left of a blocked address', () => {
  it.each([
    ['https://cdn.example.org/a/b.js?token=abc#frag', 'https://cdn.example.org'],
    ['http://cdn.example.org:8080/x?y=1', 'http://cdn.example.org:8080'],
    ['wss://sock.example.org/path', 'wss://sock.example.org'],
    ['https://user:password@cdn.example.org/x', 'https://cdn.example.org'],
    ['HTTPS://CDN.Example.org/x', 'https://cdn.example.org'],
  ])('%s keeps only scheme and host', (value, expected) => {
    expect(blockedOrigin(value)).toBe(expected)
  })

  it.each(['inline', 'eval', 'self', 'wasm-eval', 'data', 'blob', 'trusted-types-policy', 'trusted-types-sink'])(
    'keeps the keyword %s',
    (keyword) => {
      expect(blockedOrigin(keyword)).toBe(keyword)
    },
  )

  it.each([
    ['data:text/html;base64,PHNjcmlwdD4=', 'data'],
    ['blob:https://blog.example/6f0c', 'blob'],
    ['javascript:alert(1)', 'javascript'],
    ['filesystem:https://blog.example/temporary/x', 'filesystem'],
    ['about:blank', 'about'],
  ])('%s keeps only its scheme', (value, expected) => {
    expect(blockedOrigin(value)).toBe(expected)
  })

  it.each([undefined, null, 5, {}, [], '', '   ', 'not a url', 'ftp://files.example.org/x', 'https://', 'https://a b.example/'])(
    '%j becomes "other"',
    (value) => {
      expect(blockedOrigin(value)).toBe('other')
    },
  )

  it('never returns a path, a query, a fragment, a credential or a line break', () => {
    const hostile = 'https://cdn.example.org/path?email=reader@example.test&q=secret\r\n[csp] forged'
    const result = blockedOrigin(hostile)
    expect(result).toBe('https://cdn.example.org')
  })

  it('does not echo an over-long host', () => {
    expect(blockedOrigin(`https://${'a'.repeat(300)}.example.org/x`)).toBe('other')
  })
})

describe('readViolations: the legacy application/csp-report body', () => {
  it('reads the effective directive and the blocked address', () => {
    const body = legacy({
      'document-uri': 'https://blog.example/search?q=my+private+search',
      'effective-directive': 'script-src-elem',
      'violated-directive': "script-src-elem 'self' 'unsafe-inline'",
      'blocked-uri': 'https://evil.example/x.js?c=cookie',
      'original-policy': "default-src 'self'",
    })

    expect(readViolations(LEGACY, body)).toEqual([{ directive: 'script-src-elem', blocked: 'https://evil.example' }])
  })

  it('falls back to the first word of the violated directive', () => {
    const body = legacy({ 'violated-directive': "img-src 'self' data:", 'blocked-uri': 'https://tracker.example/p.gif' })

    expect(readViolations(LEGACY, body)).toEqual([{ directive: 'img-src', blocked: 'https://tracker.example' }])
  })

  it('accepts a media type with a charset and a different case', () => {
    const body = legacy({ 'effective-directive': 'object-src', 'blocked-uri': 'inline' })

    expect(readViolations('Application/CSP-Report; charset=utf-8', body)).toEqual([
      { directive: 'object-src', blocked: 'inline' },
    ])
  })

  it('turns an unreadable directive into "unknown" instead of echoing it', () => {
    const body = legacy({ 'effective-directive': 'x'.repeat(200), 'blocked-uri': 'inline' })

    expect(readViolations(LEGACY, body)).toEqual([{ directive: 'unknown', blocked: 'inline' }])
  })

  it('returns nothing for a body without a report', () => {
    expect(readViolations(LEGACY, JSON.stringify({ 'csp-report': 5 }))).toEqual([])
    expect(readViolations(LEGACY, JSON.stringify({ other: {} }))).toEqual([])
  })
})

describe('readViolations: the Reporting API application/reports+json body', () => {
  it('reads every csp-violation of the batch', () => {
    const body = reportingApi(
      { effectiveDirective: 'img-src', blockedURL: 'https://tracker.example/p.gif?id=1', documentURL: 'https://blog.example/' },
      { effectiveDirective: 'script-src-elem', blockedURL: 'inline' },
    )

    expect(readViolations(REPORTING_API, body)).toEqual([
      { directive: 'img-src', blocked: 'https://tracker.example' },
      { directive: 'script-src-elem', blocked: 'inline' },
    ])
  })

  it('skips reports of another type', () => {
    const body = JSON.stringify([
      { type: 'deprecation', body: { id: 'x' } },
      { type: 'csp-violation', body: { effectiveDirective: 'object-src', blockedURL: 'inline' } },
    ])

    expect(readViolations(REPORTING_API, body)).toEqual([{ directive: 'object-src', blocked: 'inline' }])
  })

  it('reads at most CSP_REPORT_MAX_ENTRIES reports of one batch', () => {
    const many = Array.from({ length: CSP_REPORT_MAX_ENTRIES + 20 }, () => ({
      effectiveDirective: 'img-src',
      blockedURL: 'inline',
    }))

    expect(readViolations(REPORTING_API, reportingApi(...many))).toHaveLength(CSP_REPORT_MAX_ENTRIES)
  })

  it('ignores entries that are not objects', () => {
    expect(readViolations(REPORTING_API, JSON.stringify([5, null, 'x', [], { type: 'csp-violation', body: 'x' }]))).toEqual([])
  })

  it('reads a single report object too', () => {
    const body = JSON.stringify({
      type: 'csp-violation',
      body: { effectiveDirective: 'form-action', blockedURL: 'https://evil.example/post' },
    })

    expect(readViolations(REPORTING_API, body)).toEqual([{ directive: 'form-action', blocked: 'https://evil.example' }])
  })
})

describe('readViolations: bodies it refuses', () => {
  it.each(['', 'not json', '{', 'null', '5', '"text"'])('%j is not a report', (body) => {
    expect(readViolations(LEGACY, body)).toBeNull()
    expect(readViolations(REPORTING_API, body)).toBeNull()
  })

  it.each([null, '', 'application/json', 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x'])(
    'media type %j is refused',
    (type) => {
      expect(readViolations(type, legacy({ 'effective-directive': 'img-src', 'blocked-uri': 'inline' }))).toBeNull()
    },
  )
})

describe('isReportContentType', () => {
  it.each([
    'application/csp-report',
    'application/reports+json',
    'Application/Reports+JSON; charset=utf-8',
    ' application/csp-report ',
  ])('%s is accepted', (type) => {
    expect(isReportContentType(type)).toBe(true)
  })

  it.each([null, '', 'application/json', 'text/plain', 'application/csp-report+json', 'application/reports+jsonx'])(
    '%j is not',
    (type) => {
      expect(isReportContentType(type)).toBe(false)
    },
  )
})
