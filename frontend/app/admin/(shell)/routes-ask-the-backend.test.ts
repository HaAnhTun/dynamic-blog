// @vitest-environment node
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * The shell and `proxy.ts` decide from the role claim of the access cookie, which is an UNSIGNED payload there (lib/jwt.ts): a hand-made
 * token with a role of ADMIN and any refresh cookie opens the empty shell. That is deliberate (no backend call in the layout, so an outage
 * cannot escape error.tsx) and harmless because every screen and every route handler gets its data from the backend, which checks the
 * signature. A route handler that serves something WITHOUT a backend call would have nothing behind that gate, so every route handler
 * under (shell) must go through a module that asks the backend: the admin client, the download frame, the Security frame, or
 * `verifiedAdminRole`. A new handler that does none of these fails here until it does (docs/CONVENTIONS.md, section 10).
 */
const shellDir = join(process.cwd(), 'app', 'admin', '(shell)')

/** An import path that leads to a backend call made with the caller's token. */
const ASKS_THE_BACKEND = [
  /from '@\/lib\/admin-api'/,
  /from '@\/lib\/admin-download'/,
  /from '@\/lib\/admin-security-bff'/,
  /\bverifiedAdminRole\b[\s\S]*from '@\/lib\/admin-role'|from '@\/lib\/admin-role'[\s\S]*\bverifiedAdminRole\b/,
]

function routeFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) found.push(...routeFiles(full))
    else if (entry === 'route.ts') found.push(full)
  }
  return found
}

describe('route handlers of the admin shell', () => {
  const files = routeFiles(shellDir)

  it('finds the route handlers it is meant to guard', () => {
    const names = files.map((file) => relative(shellDir, file).split(sep).join('/'))
    expect(names).toContain('posts/import/authoring-prompt/route.ts')
    expect(names).toContain('security/password/route.ts')
    expect(names.length).toBeGreaterThanOrEqual(10)
  })

  it.each(files.map((file) => [relative(shellDir, file).split(sep).join('/'), file]))(
    '%s asks the backend, so a forged role claim opens nothing',
    (_name, file) => {
      const code = readFileSync(file, 'utf8')
      expect(ASKS_THE_BACKEND.some((pattern) => pattern.test(code))).toBe(true)
    },
  )

  it('does not accept the unverified role helper alone', () => {
    const code =
      "import { adminRole } from '@/lib/admin-role'\nexport async function GET() { return new Response(String(await adminRole())) }"
    expect(ASKS_THE_BACKEND.some((pattern) => pattern.test(code))).toBe(false)
  })
})
