import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { apiBaseUrlProblem, siteUrlProblem } from './start-check.mjs'

type Result = { level: 'ok' | 'warn' | 'fatal'; message: string }
const check = (input: Record<string, unknown>) => siteUrlProblem({ nodeEnv: 'production', ...input }) as Result

describe('siteUrlProblem', () => {
  it('is quiet when the address the image was built for is the address of the run', () => {
    expect(check({ baked: 'https://example.org', runtime: 'https://example.org' }).level).toBe('ok')
    expect(check({ baked: 'https://example.org/', runtime: 'https://EXAMPLE.org' }).level).toBe('ok')
  })

  it('refuses an image built for localhost on a public address, and says what is lost', () => {
    const result = check({ baked: 'http://localhost:3000', runtime: 'https://example.org' })
    expect(result.level).toBe('fatal')
    expect(result.message).toMatch(/Strict-Transport-Security/)
    expect(result.message).toMatch(/canonical/i)
    expect(result.message).toMatch(/--build/)
    expect(result.message).toContain('http://localhost:3000')
    expect(result.message).toContain('https://example.org')
  })

  it('refuses any other mismatch too (SITE_URL changed without a rebuild)', () => {
    expect(check({ baked: 'https://old.example.org', runtime: 'https://new.example.org' }).level).toBe('fatal')
    expect(check({ baked: 'https://example.org', runtime: 'http://example.org' }).level).toBe('fatal')
  })

  it('has nothing to compare when the run does not say its address (a localhost trial, a plain docker run)', () => {
    expect(check({ baked: 'http://localhost:3000' }).level).toBe('ok')
    expect(check({ baked: 'http://localhost:3000', runtime: '' }).level).toBe('ok')
    expect(check({ baked: 'http://localhost:3000', runtime: '   ' }).level).toBe('ok')
  })

  it('only warns when the operator accepts the mismatch', () => {
    const result = check({ baked: 'http://localhost:3000', runtime: 'https://example.org', allow: 'true' })
    expect(result.level).toBe('warn')
    expect(check({ baked: 'http://localhost:3000', runtime: 'https://example.org', allow: 'yes' }).level).toBe('fatal')
  })

  it('checks nothing outside production', () => {
    expect(check({ nodeEnv: 'development', baked: 'http://localhost:3000', runtime: 'https://example.org' }).level).toBe('ok')
  })

  it('does not choke on values that are not URLs', () => {
    expect(check({ baked: 'nonsense', runtime: 'https://example.org' }).level).toBe('fatal')
    expect(check({ baked: 'https://example.org', runtime: 'nonsense' }).level).toBe('fatal')
  })
})

describe('apiBaseUrlProblem', () => {
  const problem = (apiBaseUrl: string | undefined, extra: Record<string, string> = {}) =>
    apiBaseUrlProblem({ NODE_ENV: 'production', API_BASE_URL: apiBaseUrl, ...extra })

  it('accepts what the compose file and a TLS split deployment use', () => {
    expect(problem('http://backend:8080')).toBe('')
    expect(problem('https://api.example.com')).toBe('')
    expect(problem(undefined)).toBe('')
  })

  it('names the host and the way out for plain http to a host other machines can sit between', () => {
    const message = problem('http://user:s3cret-pass@10.0.0.5:8080/internal?token=abc')
    expect(message).toContain('10.0.0.5')
    expect(message).toContain('API_ALLOW_PLAINTEXT')
    expect(message).not.toContain('s3cret-pass')
    expect(message).not.toContain('token=abc')
  })

  it('is the same rule as lib/api-base-url.ts: the operator can accept the link on purpose', () => {
    expect(problem('http://10.0.0.5:8080', { API_ALLOW_PLAINTEXT: 'true' })).toBe('')
    expect(problem('not a url')).toMatch(/API_BASE_URL/)
  })
})

describe('the wrapper that starts the server', () => {
  const made: string[] = []
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  /** A folder as the image has it: start-check.mjs next to a server.js (here one that only says it started). */
  function image() {
    const dir = mkdtempSync(join(tmpdir(), 'start-check-'))
    made.push(dir)
    // The two files the Dockerfile copies next to server.js.
    copyFileSync(join(process.cwd(), 'scripts', 'start-check.mjs'), join(dir, 'start-check.mjs'))
    copyFileSync(join(process.cwd(), 'scripts', 'api-base-url-rule.mjs'), join(dir, 'api-base-url-rule.mjs'))
    writeFileSync(join(dir, 'server.js'), "console.log('server.js started')\n")
    return dir
  }
  const run = (dir: string, env: Record<string, string>) =>
    spawnSync(process.execPath, [join(dir, 'start-check.mjs')], {
      encoding: 'utf8',
      // Next's typings make NODE_ENV mandatory in a ProcessEnv; every case here passes it.
      env: { PATH: process.env.PATH ?? '', ...env } as unknown as NodeJS.ProcessEnv,
    })

  it('starts the server when the addresses agree', () => {
    const result = run(image(), {
      NODE_ENV: 'production',
      BAKED_SITE_URL: 'https://example.org',
      SITE_URL: 'https://example.org',
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('server.js started')
  })

  it('does not start the server when the image was built for another address', () => {
    const result = run(image(), {
      NODE_ENV: 'production',
      BAKED_SITE_URL: 'http://localhost:3000',
      SITE_URL: 'https://example.org',
    })
    expect(result.status).toBe(1)
    expect(result.stdout).not.toContain('server.js started')
    expect(result.stderr).toMatch(/Strict-Transport-Security/)
  })

  it('starts with a warning when the operator accepts the mismatch', () => {
    const result = run(image(), {
      NODE_ENV: 'production',
      BAKED_SITE_URL: 'http://localhost:3000',
      SITE_URL: 'https://example.org',
      ALLOW_SITE_URL_MISMATCH: 'true',
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('server.js started')
    expect(result.stderr).toMatch(/built for/)
  })

  it('does not start the server when API_BASE_URL is plain http to a host other machines can sit between', () => {
    // Without this the container would start, answer /robots.txt for its healthcheck and return a 500 from every page that reads the API.
    const result = run(image(), { NODE_ENV: 'production', API_BASE_URL: 'http://10.0.0.5:8080' })
    expect(result.status).toBe(1)
    expect(result.stdout).not.toContain('server.js started')
    expect(result.stderr).toContain('10.0.0.5')
    expect(result.stderr).toMatch(/API_ALLOW_PLAINTEXT/)
  })

  it('starts when the operator accepts the plain http link, or when the backend is a service name', () => {
    expect(
      run(image(), { NODE_ENV: 'production', API_BASE_URL: 'http://10.0.0.5:8080', API_ALLOW_PLAINTEXT: 'true' }).status,
    ).toBe(0)
    expect(run(image(), { NODE_ENV: 'production', API_BASE_URL: 'http://backend:8080' }).status).toBe(0)
  })

  it('starts when the run says nothing about its address', () => {
    const result = run(image(), { NODE_ENV: 'production', BAKED_SITE_URL: 'http://localhost:3000' })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('server.js started')
  })
})
