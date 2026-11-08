/**
 * Reads the reports the browser sends when the Content-Security-Policy of a page is violated (app/api/csp-report/route.ts).
 *
 * Two formats arrive. The older `report-uri` directive posts `application/csp-report`, one object `{"csp-report": {...}}` with
 * dashed names. The Reporting API (`report-to`, the `Reporting-Endpoints` header) posts `application/reports+json`, an array of
 * `{type: "csp-violation", body: {...}}` with camel-case names. Each browser uses one of them; the policy names both.
 *
 * A report is data from the outside: anyone can post one. What this module hands back is a directive name that matched a strict
 * shape and the origin (scheme and host) or keyword of the blocked resource, nothing else. The document address is never read: it
 * can carry a search query or a token, and neither belongs in a log. The blocked address is cut down to scheme and host for the same
 * reason, and anything that does not parse becomes a fixed word, so a forged report cannot write a line of its own into the log.
 */

/** One violation, as far as the log may know it. */
export type CspViolation = { directive: string; blocked: string }

/** At most this many reports of one `application/reports+json` batch are read; the rest are dropped. */
export const CSP_REPORT_MAX_ENTRIES = 10

const LEGACY_TYPE = 'application/csp-report'
const REPORTING_API_TYPE = 'application/reports+json'

/** A CSP directive name: lower-case letters and hyphens (`script-src-elem`), well under 40 characters. */
const DIRECTIVE = /^[a-z][a-z-]{0,39}$/

/** The values `blocked-uri` takes when the resource has no address (CSP3, "obtain the blocked URI"). */
const KEYWORDS: ReadonlySet<string> = new Set([
  'inline',
  'eval',
  'self',
  'wasm-eval',
  'data',
  'blob',
  'trusted-types-policy',
  'trusted-types-sink',
])

/** Schemes whose address is the resource itself (a payload or a document): only the scheme is kept. */
const SCHEME_ONLY: ReadonlySet<string> = new Set(['data:', 'blob:', 'filesystem:', 'about:', 'javascript:'])

/** Schemes with a host worth naming. */
const HOST_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'ws:', 'wss:'])

/** A real host is far shorter; a longer one is a forged report. */
const MAX_HOST_LENGTH = 100

function mediaType(contentType: string | null): string {
  return (contentType ?? '').split(';', 1)[0]!.trim().toLowerCase()
}

/** Whether the Content-Type is one of the two report formats. */
export function isReportContentType(contentType: string | null): boolean {
  const type = mediaType(contentType)
  return type === LEGACY_TYPE || type === REPORTING_API_TYPE
}

/**
 * The blocked resource as the log may show it: a keyword, a scheme alone (`data`, `blob`), or `scheme://host[:port]` of an
 * http(s) or ws(s) address. No path, query, fragment or credential; `other` for everything else.
 */
export function blockedOrigin(value: unknown): string {
  if (typeof value !== 'string') return 'other'
  const text = value.trim()
  if (KEYWORDS.has(text)) return text
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return 'other'
  }
  if (SCHEME_ONLY.has(url.protocol)) return url.protocol.slice(0, -1)
  if (!HOST_SCHEMES.has(url.protocol) || url.host === '' || url.host.length > MAX_HOST_LENGTH) return 'other'
  return `${url.protocol}//${url.host}`
}

/** The directive name: the first word, if it has the shape of one; `unknown` otherwise. */
function directiveName(value: unknown): string {
  if (typeof value !== 'string') return 'unknown'
  const word = value.trim().split(/\s+/, 1)[0]!.toLowerCase()
  return DIRECTIVE.test(word) ? word : 'unknown'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fromLegacy(report: Record<string, unknown>): CspViolation {
  return {
    directive: directiveName(report['effective-directive'] ?? report['violated-directive']),
    blocked: blockedOrigin(report['blocked-uri']),
  }
}

function fromReportingApi(entry: Record<string, unknown>): CspViolation | null {
  const body = entry.body
  if (entry.type !== 'csp-violation' || !isRecord(body)) return null
  return {
    directive: directiveName(body.effectiveDirective ?? body.violatedDirective),
    blocked: blockedOrigin(body.blockedURL),
  }
}

/**
 * The violations in a report body, or null when the body is not a report of the format its media type names (not accepted, not
 * JSON, or not an object/array). An empty list is a readable body that holds no violation (another report type).
 */
export function readViolations(contentType: string | null, raw: string): CspViolation[] | null {
  const type = mediaType(contentType)
  if (type !== LEGACY_TYPE && type !== REPORTING_API_TYPE) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (type === LEGACY_TYPE) {
    if (!isRecord(parsed)) return null
    const report = parsed['csp-report']
    return isRecord(report) ? [fromLegacy(report)] : []
  }
  const entries = Array.isArray(parsed) ? parsed : isRecord(parsed) ? [parsed] : null
  if (entries === null) return null
  const found: CspViolation[] = []
  for (const entry of entries.slice(0, CSP_REPORT_MAX_ENTRIES)) {
    const violation = isRecord(entry) ? fromReportingApi(entry) : null
    if (violation !== null) found.push(violation)
  }
  return found
}
