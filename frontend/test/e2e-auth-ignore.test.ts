// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `frontend/e2e/.auth/` holds what the E2E suite knows about the administrator of its throw-away stack: the key of the authenticator,
 * its recovery codes and the sessions of the global setup. They are throw-away values, but they are still credentials, so they must
 * never be committed (the repository `.gitignore`) and never be copied into the image: the Dockerfile does `COPY . .` from this folder,
 * and only `**\/*.test.ts` is otherwise left out of the build context (test/docker-context.test.ts).
 */
const root = process.cwd()
const lines = (file: string) =>
  readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())

describe('the E2E credentials of the stack stay out of git and out of the image', () => {
  it('is ignored by the repository .gitignore', () => {
    expect(lines(join(root, '..', '.gitignore'))).toContain('frontend/e2e/.auth/')
  })

  it('git really ignores the files the suite writes there', () => {
    const ignored = (file: string) => {
      try {
        execFileSync('git', ['check-ignore', '--quiet', file], { cwd: root })
        return true
      } catch {
        return false
      }
    }
    for (const file of ['e2e/.auth/admin-mfa.json', 'e2e/.auth/admin-session.json', 'e2e/.auth/admin-api-session.json']) {
      expect(ignored(file), file).toBe(true)
    }
  })

  it('is left out of the Docker build context of the frontend image', () => {
    expect(lines(join(root, '.dockerignore'))).toContain('e2e/.auth/')
  })
})
