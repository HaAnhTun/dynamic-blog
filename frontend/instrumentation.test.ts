// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

const startRuntimeCacheGuard = vi.hoisted(() => vi.fn())
vi.mock('@/lib/runtime-cache', () => ({ startRuntimeCacheGuard }))

afterEach(() => {
  vi.unstubAllEnvs()
  startRuntimeCacheGuard.mockReset()
})

async function register() {
  const { register: run } = await import('./instrumentation')
  await run()
}

describe('instrumentation: the cache guard runs in a production server and nowhere else', () => {
  it('starts it once for the Node.js runtime in production, on the .next folder of the working directory', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs')
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PHASE', 'phase-production-server')

    await register()

    expect(startRuntimeCacheGuard).toHaveBeenCalledTimes(1)
    expect(String(startRuntimeCacheGuard.mock.calls[0]?.[0])).toMatch(/\.next$/)
  })

  it.each([
    ['the edge runtime', { NEXT_RUNTIME: 'edge', NODE_ENV: 'production', NEXT_PHASE: 'phase-production-server' }],
    ['next build', { NEXT_RUNTIME: 'nodejs', NODE_ENV: 'production', NEXT_PHASE: 'phase-production-build' }],
    ['development', { NEXT_RUNTIME: 'nodejs', NODE_ENV: 'development', NEXT_PHASE: 'phase-development-server' }],
    ['a test', { NEXT_RUNTIME: 'nodejs', NODE_ENV: 'test', NEXT_PHASE: '' }],
  ])('does nothing in %s', async (_name, env) => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)

    await register()

    expect(startRuntimeCacheGuard).not.toHaveBeenCalled()
  })
})
