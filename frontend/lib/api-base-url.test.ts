import { describe, expect, it } from 'vitest'
import { apiBaseUrl } from '@/lib/api-base-url'

type Env = Record<string, string | undefined>

/** A production run: the bearer tokens, the views token and the client address travel to this URL. */
const production = (apiBaseUrlValue: string | undefined, extra: Env = {}) =>
  apiBaseUrl({ NODE_ENV: 'production', API_BASE_URL: apiBaseUrlValue, ...extra })

describe('apiBaseUrl', () => {
  it('falls back to the local backend when the variable is not set', () => {
    expect(apiBaseUrl({ NODE_ENV: 'production' })).toBe('http://localhost:8080')
    expect(apiBaseUrl({ NODE_ENV: 'development', API_BASE_URL: '' })).toBe('http://localhost:8080')
    expect(apiBaseUrl({ NODE_ENV: 'development', API_BASE_URL: '   ' })).toBe('http://localhost:8080')
  })

  it.each([
    'https://api.example.com',
    'https://api.example.com:8443/base',
    'http://backend:8080',
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'http://[::1]:8080',
  ])('accepts %s in production', (url) => {
    expect(production(url)).toBe(url)
  })

  it.each([
    'http://api.example.com',
    'http://api.example.com:8080',
    'http://blog-backend.internal:8080',
    'http://10.0.0.5:8080',
    'http://203.0.113.9',
  ])('refuses plain http to %s in production', (url) => {
    expect(() => production(url)).toThrow(/plain http/)
  })

  it('names the host and the way out, never the path, the credentials or the query', () => {
    let message = ''
    try {
      production('http://user:s3cret-pass@api.example.com/internal/route?token=abc')
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('api.example.com')
    expect(message).toContain('API_ALLOW_PLAINTEXT')
    expect(message).not.toContain('s3cret-pass')
    expect(message).not.toContain('/internal/route')
    expect(message).not.toContain('token=abc')
  })

  it('refuses a value that is not a URL, or not http(s), in production', () => {
    expect(() => production('not a url')).toThrow(/API_BASE_URL/)
    expect(() => production('ftp://backend:21')).toThrow(/API_BASE_URL/)
  })

  it('lets the operator accept plain http on a private network on purpose', () => {
    expect(production('http://10.0.0.5:8080', { API_ALLOW_PLAINTEXT: 'true' })).toBe('http://10.0.0.5:8080')
    expect(() => production('http://10.0.0.5:8080', { API_ALLOW_PLAINTEXT: 'yes' })).toThrow(/plain http/)
  })

  it('checks nothing outside production (development, tests and the E2E stack use http://localhost)', () => {
    expect(apiBaseUrl({ NODE_ENV: 'development', API_BASE_URL: 'http://api.example.com' })).toBe('http://api.example.com')
    expect(apiBaseUrl({ NODE_ENV: 'test', API_BASE_URL: 'http://api.test' })).toBe('http://api.test')
  })
})
