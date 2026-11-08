// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  LOGIN_ERRORS,
  adminLoginPath,
  localizedPath,
  loginErrorPath,
  loginPath,
  mfaStepPath,
  safeAdminNext,
  safeReturnTo,
} from './return-to'
import { RETURN_TO_ACCENTED } from '@/test/fixtures/vi/accented-text'

/**
 * Each vector below is a real way to turn "return to the previous page after
 * signing in" into a redirect to another site. Some only show up AFTER the URL parser normalizes
 * (`/.//evil.com` becomes pathname `//evil.com`), so both the input and the output are checked.
 */
describe('safeReturnTo: blocks open redirect', () => {
  it.each([
    // Dot segment: the URL parser collapses `/..//evil.com` into `//evil.com`, a protocol-relative URL.
    '/..//evil.com',
    '/.//evil.com',
    '/a/..//evil.com',
    // Percent-encoding of `.`, `/`, `\` and of `%` itself (double encoding).
    '/%2e%2e//evil.com',
    '/%2E%2E/admin',
    '/%2F%2Fevil.com',
    '/%2f%2fevil.com',
    '/%5Cevil.com',
    '/%255Cevil.com',
    // Backslash: the browser reads `/\` as `//`.
    '/\\evil.com',
    '/a\\b',
    '//evil.com',
    '///evil.com',
    'https://evil.com',
    'http:/evil.com',
    'javascript:alert(1)',
    'evil.com',
    // Control characters: the browser drops tab and newline in a URL, `/\t/evil.com` becomes `//evil.com`.
    '/\t/evil.com',
    '/\n/evil.com',
    '/\r/evil.com',
    `/${String.fromCharCode(0)}x`,
    `/${String.fromCharCode(0x7f)}x`,
  ])('%j → "/"', (raw) => {
    expect(safeReturnTo(raw)).toBe('/')
  })

  it.each([
    '/api/x',
    '/api',
    '/api/auth/github/start?returnTo=/x',
    '/login',
    '/login?x',
    '/login/',
    '/admin/login',
    '/admin/login?reason=forbidden',
    // The sign-in page of the English site.
    '/en/login',
    '/en/login?error=state',
  ])('%j is the sign-in page or an API → "/"', (raw) => {
    // Returning to /login after signing in is a loop; returning to /api calls an endpoint again.
    expect(safeReturnTo(raw)).toBe('/')
  })

  it.each([
    // Next 308 collapses consecutive `/`, so this is still the sign-in page.
    '/admin//login',
    '/admin///login?reason=forbidden',
    '/api//x',
    // Next percent-decodes before choosing the route: an encoded letter still reaches that same route.
    '/ad%6din/login',
    '/%6Cogin',
    '/%6c%6f%67%69%6e?x',
    '/%61pi/x',
    '/%61pi/auth/github/start',
    '/admin/%6Cogin/submit',
  ])('%j is still the sign-in page or an API after Next normalizes → "/"', (raw) => {
    expect(safeReturnTo(raw)).toBe('/')
  })

  it.each(['/posts/%E0%A4%A', '/a%', '/%ZZ', '/%C3'])('%j: broken percent-encoding in the path → "/"', (raw) => {
    // No browser produces it, and if it cannot be decoded we do not know where Next would route it.
    expect(safeReturnTo(raw)).toBe('/')
  })

  it('empty, null or longer than 512 characters gives "/"', () => {
    expect(safeReturnTo(null)).toBe('/')
    expect(safeReturnTo('')).toBe('/')
    expect(safeReturnTo(`/${'a'.repeat(512)}`)).toBe('/')
    // Boundary: exactly 512 characters is still accepted.
    const max = `/${'a'.repeat(511)}`
    expect(safeReturnTo(max)).toBe(max)
  })

  it.each([
    ['/posts/a?x=1#binh-luan', '/posts/a?x=1#binh-luan'],
    ['/admin/posts', '/admin/posts'],
    ['/', '/'],
    ['/apiary', '/apiary'],
    ['/loginx', '/loginx'],
    ['/admin', '/admin'],
    // Query and fragment may contain `/..`: only the path part is normalized by the browser.
    ['/search?q=a/../b', '/search?q=a/../b'],
    // The decoded form is only for comparing: the output is still the encoded string, and `%` in the query is untouched.
    ['/posts/%C3%A0i-viet', '/posts/%C3%A0i-viet'],
    ['/posts/%61', '/posts/%61'],
    ['/posts//a', '/posts//a'],
    ['/search?q=100%', '/search?q=100%'],
  ])('%j is valid, kept as is', (raw, expected) => {
    expect(safeReturnTo(raw)).toBe(expected)
  })

  it("the output is the URL parser's encoded form, not the raw string", () => {
    // Location may only contain ASCII: Vietnamese and spaces come out as %XX.
    expect(safeReturnTo(RETURN_TO_ACCENTED)).toBe('/posts/b%C3%A0i%20vi%E1%BA%BFt?q=a%20b')
  })

  it('the output never starts with two slashes, whatever the input', () => {
    for (const raw of ['/.//x', '/./\\x', '/%2e/x', '//x', '/\\x', '/ //x']) {
      const out = safeReturnTo(raw)
      expect(out.startsWith('//') || out.startsWith('/\\'), `${JSON.stringify(raw)} → ${out}`).toBe(false)
    }
  })
})

describe('loginErrorPath', () => {
  it('carries the error code and the encoded returnTo', () => {
    expect(loginErrorPath('state', '/posts/a?x=1#binh-luan')).toBe('/login?error=state&returnTo=%2Fposts%2Fa%3Fx%3D1%23binh-luan')
  })

  it('drops returnTo when it is the home page or unknown', () => {
    expect(loginErrorPath('denied', '/')).toBe('/login?error=denied')
    expect(loginErrorPath('rate')).toBe('/login?error=rate')
  })

  it('sanitizes returnTo again: never carries a dangerous target to the sign-in page', () => {
    expect(loginErrorPath('failed', '//evil.com')).toBe('/login?error=failed')
  })

  it('keeps the locale of returnTo: a reader on an English page lands on the English sign-in page', () => {
    expect(loginErrorPath('state', '/en/posts/a')).toBe('/en/login?error=state&returnTo=%2Fen%2Fposts%2Fa')
    expect(loginErrorPath('denied', '/en')).toBe('/en/login?error=denied&returnTo=%2Fen')
    // The default locale has no prefix (`/vi/...` is only a redirect to the unprefixed URL).
    expect(loginErrorPath('rate', '/vi/posts/a')).toBe('/login?error=rate&returnTo=%2Fvi%2Fposts%2Fa')
    // A segment that only starts like a locale is not one.
    expect(loginErrorPath('failed', '/english')).toBe('/login?error=failed&returnTo=%2Fenglish')
  })

  it('all seven codes that the /login page can speak', () => {
    expect([...LOGIN_ERRORS].sort()).toEqual(['denied', 'disabled', 'failed', 'rate', 'state', 'suspended', 'unavailable'])
  })
})

describe('loginPath', () => {
  it('is the plain sign-in page, with the encoded returnTo unless it is the home page', () => {
    expect(loginPath()).toBe('/login')
    expect(loginPath('/')).toBe('/login')
    expect(loginPath('/posts/a?x=1#binh-luan')).toBe('/login?returnTo=%2Fposts%2Fa%3Fx%3D1%23binh-luan')
  })

  it('sanitizes returnTo again and keeps the locale of the page it came from', () => {
    expect(loginPath('//evil.com')).toBe('/login')
    expect(loginPath('/en/posts/a')).toBe('/en/login?returnTo=%2Fen%2Fposts%2Fa')
  })
})

describe('localizedPath', () => {
  it.each([
    ['/posts/a?x=1#y', 'en', '/en/posts/a?x=1#y'],
    ['/', 'en', '/en'],
    ['/?q=a', 'en', '/en?q=a'],
    ['/posts/a', 'vi', '/posts/a'],
    ['/admin', 'en', '/admin'],
    ['/admin/posts', 'en', '/admin/posts'],
    ['/administrator', 'en', '/en/administrator'],
    ['/posts/a', 'xx', '/posts/a'],
  ])('%j in %s is %j', (path, locale, expected) => {
    expect(localizedPath(path, locale)).toBe(expected)
  })
})

describe('safeAdminNext: the destination after the admin sign-in', () => {
  it.each([
    ['/admin', '/admin'],
    ['/admin/security', '/admin/security'],
    ['/admin/posts/new?draft=1#top', '/admin/posts/new?draft=1#top'],
    ['/admin?page=2', '/admin?page=2'],
  ])('keeps the admin path %j', (raw, expected) => {
    expect(safeAdminNext(raw)).toBe(expected)
  })

  it.each([
    [null],
    [undefined],
    [''],
    ['//evil.example'],
    ['/\evil.example'],
    ['https://evil.example/admin'],
    ['/login'],
    ['/en/posts/a'],
    ['/administrator'],
    ['/admin/login'],
    ['/admin/login/mfa'],
    ['/admin/../api/x'],
    ['/admin/%2e%2e/api'],
    ['/api/auth/github/start'],
  ])('sends %j to the admin home', (raw) => {
    expect(safeAdminNext(raw)).toBe('/admin')
  })
})

describe('adminLoginPath and mfaStepPath', () => {
  it('the sign-in page carries `next` only when it is not the admin home', () => {
    expect(adminLoginPath()).toBe('/admin/login')
    expect(adminLoginPath('/admin')).toBe('/admin/login')
    expect(adminLoginPath('/admin/security')).toBe('/admin/login?next=/admin/security')
    expect(adminLoginPath('//evil.example')).toBe('/admin/login')
  })

  it('the second-step pages keep `next`, and the enroll page keeps the enrollment-code hint', () => {
    expect(mfaStepPath('mfa')).toBe('/admin/login/mfa')
    expect(mfaStepPath('mfa', { next: '/admin/security' })).toBe('/admin/login/mfa?next=/admin/security')
    expect(mfaStepPath('enroll', { codeRequired: true })).toBe('/admin/login/enroll?code=1')
    expect(mfaStepPath('enroll', { codeRequired: false })).toBe('/admin/login/enroll')
    expect(mfaStepPath('enroll', { next: '/admin/security', codeRequired: true })).toBe(
      '/admin/login/enroll?next=/admin/security&code=1',
    )
  })

  it('keeps the slashes of `next` readable and encodes what could end the value, so the language switch can come back', () => {
    expect(adminLoginPath('/admin/posts/new?draft=1&x=2#top')).toBe(
      '/admin/login?next=/admin/posts/new%3Fdraft%3D1%26x%3D2%23top',
    )
    expect(mfaStepPath('mfa', { next: '/admin/posts/new?a=b' })).toBe('/admin/login/mfa?next=/admin/posts/new%3Fa%3Db')
  })

  it('the hint belongs to the enroll step only, and a foreign `next` is dropped', () => {
    expect(mfaStepPath('mfa', { codeRequired: true })).toBe('/admin/login/mfa')
    expect(mfaStepPath('mfa', { next: 'https://evil.example/admin' })).toBe('/admin/login/mfa')
  })
})
