// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLIENT_IP_HEADER, CLIENT_IP_TOKEN_HEADER, clientIp, clientIpHeaders } from './client-ip'

function withXff(value: string | null): Request {
  const headers = new Headers()
  if (value !== null) headers.set('x-forwarded-for', value)
  return new Request('http://localhost:3000/api/auth/github/start', { headers })
}

afterEach(() => vi.unstubAllEnvs())

describe('clientIp: the X-Forwarded-For entry written by a trusted proxy, counted from the right', () => {
  it('defaults to one hop: the last entry, not the first one the client sent itself', () => {
    // nginx `$proxy_add_x_forwarded_for` APPENDS `$remote_addr` to the end of the chain the client sent.
    expect(clientIp(withXff('1.2.3.4, 9.9.9.9'))).toBe('9.9.9.9')
  })

  it('a single entry (Next fills it from the socket when there is no proxy)', () => {
    expect(clientIp(withXff('203.0.113.7'))).toBe('203.0.113.7')
  })

  it('TRUSTED_PROXY_HOPS=2 (Cloudflare in front of nginx): the second entry from the right', () => {
    vi.stubEnv('TRUSTED_PROXY_HOPS', '2')
    expect(clientIp(withXff('6.6.6.6, 198.51.100.4, 172.16.0.9'))).toBe('198.51.100.4')
  })

  it('a list shorter than the hop count gives null', () => {
    vi.stubEnv('TRUSTED_PROXY_HOPS', '3')
    expect(clientIp(withXff('198.51.100.4, 172.16.0.9'))).toBeNull()
  })

  // Recorded deliberately: the old version used `a.a.a.a, b.b.b.b, c.c.c.c`, which is now three junk entries and
  // all become null (see the "accepts only an IP address" block below). What this test pins stays exactly the same.
  it('reads the environment variable at call time, not at module load', () => {
    const request = withXff('192.0.2.1, 192.0.2.2, 192.0.2.3')
    expect(clientIp(request)).toBe('192.0.2.3')
    vi.stubEnv('TRUSTED_PROXY_HOPS', '3')
    expect(clientIp(request)).toBe('192.0.2.1')
  })

  it.each(['0', '6', '-1', 'abc', '1.5', ''])('TRUSTED_PROXY_HOPS=%j outside 1–5 falls back to the default 1', (value) => {
    vi.stubEnv('TRUSTED_PROXY_HOPS', value)
    expect(clientIp(withXff('1.1.1.1, 2.2.2.2'))).toBe('2.2.2.2')
  })

  it('no header, or the entry to take is empty, gives null', () => {
    expect(clientIp(withXff(null))).toBeNull()
    expect(clientIp(withXff('1.2.3.4, '))).toBeNull()
    expect(clientIp(withXff('   '))).toBeNull()
  })

  it('trims whitespace around each entry', () => {
    expect(clientIp(withXff(' 1.2.3.4 ,   9.9.9.9   '))).toBe('9.9.9.9')
  })
})

describe('clientIp: accepts only an IP address', () => {
  it.each([
    '203.0.113.7',
    '0.0.0.0',
    '255.255.255.255',
    '::1',
    // Next fills XFF from the socket when there is no proxy: an IPv4 on a dual-stack socket comes out in this form.
    '::ffff:127.0.0.1',
    '2001:db8::1',
    // The address form the E2E suite sends (e2e/support/network.ts, randomClientAddress).
    '2001:db8:aaaa:bbbb:cccc:dddd:eeee:ffff',
  ])('%s is an IP, kept as is', (ip) => {
    expect(clientIp(withXff(`198.51.100.9, ${ip}`))).toBe(ip)
  })

  it.each([
    'garbage',
    'unknown',
    'a.a.a.a',
    '1.2.3.256',
    '1.2.3',
    '1.2.3.4.5',
    '01.2.3.4',
    '1.2.3.4:5678',
    '[2001:db8::1]',
    '2001:db8::g',
    '1::2::3',
  ])('%j is not an IP, gives null: "IP unknown", not a key of its own', (entry) => {
    expect(clientIp(withXff(entry))).toBeNull()
  })

  it('a broken selected entry gives null, no falling back to an entry on the left: every entry on the left is something the client sent', () => {
    expect(clientIp(withXff('198.51.100.4, garbage'))).toBeNull()

    vi.stubEnv('TRUSTED_PROXY_HOPS', '2')
    expect(clientIp(withXff('198.51.100.4, unknown, 172.16.0.9'))).toBeNull()
  })

  it.each(['', ' , ', ',', '198.51.100.4,'])('broken header %j gives null, does not throw', (value) => {
    expect(clientIp(withXff(value))).toBeNull()
  })
})

describe('clientIp: with more hops than real proxies the entry is one the visitor wrote', () => {
  // Recorded on purpose, not a wish: with TRUSTED_PROXY_HOPS=2 and only one proxy the entry that is taken is a client-written one.
  // The safeguard is the proxy configuration (docs/SECURITY.md), not this function.
  it('TRUSTED_PROXY_HOPS=2 behind a single proxy returns the visitor-written entry', () => {
    vi.stubEnv('TRUSTED_PROXY_HOPS', '2')
    expect(clientIp(withXff('9.9.9.9, 203.0.113.7'))).toBe('9.9.9.9')
  })
})

/**
 * Issue 017, a warning once per process: in production an X-Forwarded-For with fewer entries than TRUSTED_PROXY_HOPS, or none, means
 * the request did not come through the proxy chain that is configured (Next reached directly, or the number of hops is too high).
 * The module keeps the "already said" state, so each case loads a fresh copy.
 */
describe('clientIp: warns once in production when the proxy chain is not what TRUSTED_PROXY_HOPS says', () => {
  async function freshClientIp() {
    vi.resetModules()
    return (await import('./client-ip')).clientIp
  }

  afterEach(() => vi.restoreAllMocks())

  it('a header shorter than the hop count warns once, without the address', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('TRUSTED_PROXY_HOPS', '2')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const clientIpOnce = await freshClientIp()

    expect(clientIpOnce(withXff('203.0.113.77'))).toBeNull()
    expect(clientIpOnce(withXff('203.0.113.78'))).toBeNull()

    expect(warn).toHaveBeenCalledTimes(1)
    const line = String(warn.mock.calls[0]?.[0])
    expect(line).toContain('TRUSTED_PROXY_HOPS')
    expect(line).not.toContain('203.0.113')
  })

  it('a request with no header at all warns once too, apart from the short-header warning', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const clientIpOnce = await freshClientIp()

    expect(clientIpOnce(withXff(null))).toBeNull()
    expect(clientIpOnce(withXff(null))).toBeNull()
    vi.stubEnv('TRUSTED_PROXY_HOPS', '3')
    expect(clientIpOnce(withXff('203.0.113.77'))).toBeNull()

    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('a well-formed chain, or a development run, says nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.stubEnv('NODE_ENV', 'production')
    const clientIpOnce = await freshClientIp()
    expect(clientIpOnce(withXff('1.2.3.4, 203.0.113.9'))).toBe('203.0.113.9')

    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('TRUSTED_PROXY_HOPS', '3')
    expect(clientIpOnce(withXff('203.0.113.9'))).toBeNull()
    expect(clientIpOnce(withXff(null))).toBeNull()

    expect(warn).not.toHaveBeenCalled()
  })
})

describe('clientIpHeaders: what the backend is told about the visitor', () => {
  it('sends the address and the shared token, trimmed like the backend trims it', () => {
    vi.stubEnv('CLIENT_IP_TOKEN', '  shared-token-for-tests  ')
    expect(clientIpHeaders('203.0.113.7')).toEqual({
      [CLIENT_IP_HEADER]: '203.0.113.7',
      [CLIENT_IP_TOKEN_HEADER]: 'shared-token-for-tests',
    })
    expect([CLIENT_IP_HEADER, CLIENT_IP_TOKEN_HEADER]).toEqual(['x-client-ip', 'x-client-ip-token'])
  })

  it('an unknown visitor (null) sends only the token: the backend then counts one shared unknown key', () => {
    vi.stubEnv('CLIENT_IP_TOKEN', 'shared-token-for-tests')
    expect(clientIpHeaders(null)).toEqual({ [CLIENT_IP_TOKEN_HEADER]: 'shared-token-for-tests' })
  })

  it.each([undefined, '', '   '])(
    'without a token (%j: a dev stack) nothing is sent, the address never travels without its secret',
    (token) => {
      vi.stubEnv('CLIENT_IP_TOKEN', token)
      expect(clientIpHeaders('203.0.113.7')).toEqual({})
      expect(clientIpHeaders(null)).toEqual({})
    },
  )

  it('reads the environment variable at call time, not at module load', () => {
    expect(clientIpHeaders('203.0.113.7')).toEqual({})
    vi.stubEnv('CLIENT_IP_TOKEN', 'later')
    expect(clientIpHeaders('203.0.113.7')[CLIENT_IP_TOKEN_HEADER]).toBe('later')
  })

  it('forwards what clientIp derived (counted from the right), never the first entry the visitor wrote', () => {
    vi.stubEnv('CLIENT_IP_TOKEN', 'shared-token-for-tests')
    const headers = clientIpHeaders(clientIp(withXff('6.6.6.6, 198.51.100.4')))
    expect(headers[CLIENT_IP_HEADER]).toBe('198.51.100.4')
    expect(Object.values(headers)).not.toContain('6.6.6.6')
    expect(clientIpHeaders(clientIp(withXff('6.6.6.6, junk')))).toEqual({ [CLIENT_IP_TOKEN_HEADER]: 'shared-token-for-tests' })
  })
})
