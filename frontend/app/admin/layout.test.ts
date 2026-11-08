// @vitest-environment node
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import type { Metadata } from 'next'
import { describe, expect, it } from 'vitest'
import { generateMetadata as loginMetadata } from '@/app/admin/login/page'
import { routeMap } from '@/test/routes'
import { metadata, viewport } from './layout'

const appDir = join(process.cwd(), 'app')

/** Every non-test source file under `app/`, with comments stripped — the same idiom
 *  app/opengraph-image.test.ts uses, so a `noindex` inside a comment is not a hit. */
function sources(): { file: string; code: string }[] {
  const out: { file: string; code: string }[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue
      const source = readFileSync(full, 'utf8')
      out.push({
        file: full
          .slice(full.indexOf(`app${sep}`))
          .split(sep)
          .join('/'),
        code: source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''),
      })
    }
  }
  walk(appDir)
  return out
}

describe('admin theme-color', () => {
  it('is always the light colour: admin has no dark theme, whatever the OS prefers', () => {
    // app/layout.tsx gives the public site an OS-following pair (light/dark media queries).
    // Admin is always light, so it overrides the key with a single colour for the branch.
    expect(viewport.themeColor).toBe('#ffffff')
  })
})

describe('admin pages are not indexable', () => {
  it('declares noindex once, for the whole admin branch', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false })
  })

  it('puts that declaration above every admin route, including the login page', () => {
    // The mechanism, as an executable assertion rather than a comment: this layout sits at
    // `app/admin/`, which is a filesystem level on the path to both `app/admin/(shell)/**`
    // and `app/admin/login`, so next-app-loader has it in both chains. If a future admin
    // page is served from a file outside `app/admin/`, the single declaration stops
    // covering it and this fails.
    const admin = [...routeMap(appDir).entries()].filter(([url]) => url === '/admin' || url.startsWith('/admin/'))

    expect(admin.map(([url]) => url)).toEqual(expect.arrayContaining(['/admin', '/admin/login']))
    for (const [url, file] of admin) {
      expect(file, `${url} is served from outside app/admin/, so the layout does not wrap it`).toMatch(/^app\/admin\//)
    }
  })

  it('is not overridden by anything underneath it', async () => {
    // Next REPLACES `robots` wholesale rather than merging, so an admin page that grew its
    // own `robots` key for an unrelated reason would silently drop the noindex. The login
    // page is the one admin page with its own `metadata` export today.
    // Widened to `Metadata`: the login page writes a bare object literal, so TypeScript
    // infers `{ title: string }` and `.robots` would not even compile — which is the
    // property being asserted, so it has to be expressed as a runtime check on the wider
    // type rather than skipped.
    expect(((await loginMetadata()) as Metadata).robots).toBeUndefined()

    // And the precondition on the other side: the public root metadata (lib/root-metadata.ts, spread by the `[locale]` layout)
    // must declare no `robots` at all, which is what lets the bare /search stay indexable by simply not mentioning it.
    // The comment there says so; this is the assertion.
    //
    // Read as source rather than imported: RootShell calls `Inter()` from next/font/google at module scope, a build-time
    // transform. The leak-guard below reads files the same way, so one mechanism covers both.
    const stripped = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    const rootMetadata = stripped(readFileSync(join(process.cwd(), 'lib/root-metadata.ts'), 'utf8'))
    expect(rootMetadata).toContain('rootMetadata')
    expect(rootMetadata).not.toMatch(/robots:/)
    const localeLayout = sources().find(({ file }) => file === 'app/[locale]/layout.tsx')
    expect(localeLayout, 'app/[locale]/layout.tsx not found by the scan').toBeDefined()
    expect(localeLayout!.code).not.toMatch(/robots:/)
  })

  it('leaks onto no public page', () => {
    // The test that did not exist before, and the reason this task is worth more than one
    // line of metadata: nothing in the suite could previously tell you that a public route
    // had become noindex. That failure has no symptom — the page renders, the tests pass,
    // and it simply stops appearing in results.
    const scanned = sources()
    expect(scanned.length, 'the app directory scan looks empty').toBeGreaterThan(10)

    const declares = scanned
      .filter(({ code }) => /robots:\s*\{[^}]*index:\s*false/.test(code) || /content=["']noindex/.test(code))
      // The locale segment is not part of what is being pinned: `app/[locale]/(site)/search` is still the search page.
      .map(({ file }) => file.replace('app/[locale]/', 'app/'))
      .sort()

    // An exact set, not a "none outside admin" check: the search page's noindex is a real
    // product decision that should also fail loudly if it is ever deleted.
    //
    // /login: the GitHub sign-in page has nothing to find, and `?error=` is a URL strangers can build.
    // /profile: a static shell that, to a crawler, is just "You are not signed in." (not signed in).
    // /notifications: the same kind of static shell, to a crawler only an invitation to sign in;
    // notifications belong to each person.
    // /bookmarks: the same mould; saved posts belong to each person.
    // /newsletter/confirm, /newsletter/unsubscribe: URLs differ only by the token in the email link,
    // nothing to find. /newsletter itself (the signup form) is still indexed.
    // /u/[slug]: only reader profiles without posts (noindex, still follow); author profiles are indexed.
    expect(
      declares,
      'noindex is declared somewhere new. If a public page is meant to be hidden from ' +
        'search, that is a product decision — add it here with the reason.',
    ).toEqual([
      'app/(site)/bookmarks/page.tsx',
      'app/(site)/login/page.tsx',
      'app/(site)/newsletter/confirm/page.tsx',
      'app/(site)/newsletter/unsubscribe/page.tsx',
      'app/(site)/notifications/page.tsx',
      'app/(site)/profile/page.tsx',
      'app/(site)/search/page.tsx',
      'app/(site)/u/[slug]/page.tsx',
      'app/admin/layout.tsx',
      // The first-run setup page: it has nothing to find, and it 404s once setup is done.
      'app/setup/layout.tsx',
    ])
  })
})
