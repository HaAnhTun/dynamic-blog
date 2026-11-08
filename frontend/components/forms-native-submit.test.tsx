import fs from 'node:fs'
import path from 'node:path'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { IntlWrapper } from '@/test/intl'
import LoginForm, { LOGIN_ENDPOINT } from '@/app/admin/login/LoginForm'
import MfaForm, { MFA_ENDPOINT } from '@/app/admin/login/mfa/MfaForm'
import { SignupForm } from '@/app/[locale]/(site)/newsletter/SignupForm'
import PasswordForm from '@/components/admin/security/PasswordForm'
import StepUpForm from '@/components/admin/security/StepUpForm'
import { CommentForm } from '@/components/site/comments/CommentForm'
import { ContactForm } from '@/components/site/ContactForm'

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ replace: vi.fn() }),
}))

/**
 * A form that is submitted before its JavaScript has loaded (a slow connection, a blocked script) is submitted by the browser itself.
 * Without a method that is a GET to the current address, and the typed fields end up in the query string, in the browser history and in
 * the access log of every proxy on the way: the admin password, the address of a subscriber, the text of a message. These forms
 * hold such data, so each one must say `method="post"`. Its `action` is the route its script posts to, which only takes JSON from the
 * same origin and answers a form body with 415, so the native post changes nothing and exposes nothing.
 *
 * The first block looks at the markup the server sends (the only markup that exists before hydration). The second reads the source of
 * the public area and fails for a new `<form>` that forgets its method.
 */

/** The `<form>` elements of the markup the server would send for this element, as a DOM. */
function serverForms(element: ReactElement): HTMLFormElement[] {
  const html = renderToStaticMarkup(<IntlWrapper>{element}</IntlWrapper>)
  const dom = document.createElement('div')
  dom.innerHTML = html
  return [...dom.querySelectorAll('form')]
}

const sendsNothing = async () => ({ ok: true }) as const

const FORMS: Array<[string, ReactElement, string | null]> = [
  ['the admin login form', <LoginForm key="login" />, LOGIN_ENDPOINT],
  ['the contact form', <ContactForm key="contact" />, '/api/contact'],
  ['the newsletter form', <SignupForm key="newsletter" />, '/api/newsletter/subscribe'],
  ['the comment form', <CommentForm key="comment" label="x" submitLabel="y" onSubmit={sendsNothing} />, null],
  // The second step of the sign-in and the Security page: a code, a recovery code, the enrollment code or a password.
  ['the second-step form', <MfaForm key="mfa" next="/admin" />, MFA_ENDPOINT],
  [
    'the form that turns two-step verification off',
    <StepUpForm
      key="step-up"
      url="/admin/security/disable"
      withPassword
      submitLabel="x"
      workingLabel="y"
      onSuccess={() => {}}
      onCancel={() => {}}
    />,
    '/admin/security/disable',
  ],
  [
    'the form that changes the password',
    <PasswordForm
      key="password"
      status={{
        enrolled: true,
        required: true,
        recoveryCodesRemaining: 10,
        hasPassword: true,
        passwordManagedByEnvironment: false,
      }}
      onRefused={() => {}}
    />,
    '/admin/security/password',
  ],
]

describe('forms that hold personal data never fall back to a GET before hydration', () => {
  it.each(FORMS)('%s is a POST in the server markup', (_name, element, action) => {
    const forms = serverForms(element)

    expect(forms.length).toBeGreaterThan(0)
    for (const form of forms) {
      expect(form.getAttribute('method')?.toLowerCase()).toBe('post')
      // The target, when there is one, is a path of this site and never another origin.
      const target = form.getAttribute('action')
      if (action !== null) expect(target).toBe(action)
      if (target !== null) expect(target).toMatch(/^\/(?!\/)/)
    }
  })

  it.each(FORMS.filter(([, , action]) => action !== null))(
    '%s carries a route to post to, because it asks for a password or an address',
    (_name, element) => {
      for (const form of serverForms(element)) {
        const personal = form.querySelector('input[type="password"], input[type="email"]')
        if (personal !== null) expect(form.getAttribute('action')).not.toBeNull()
      }
    },
  )
})

/**
 * The public pages, the login and the first-run setup: where someone without a session or a loaded script can submit a form. The forms of
 * the Security page are here too: they take a password and one-time codes, and an administrator who presses Enter before the script has
 * loaded would otherwise send them in the address.
 */
const ROOTS = ['app/[locale]', 'app/admin/login', 'app/setup', 'components/site', 'components/setup', 'components/admin/security']

function sources(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) sources(full, out)
    else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) out.push(full)
  }
  return out
}

/** Every `<form>` of a file that has no `method` attribute, as `file:line`. */
function formsWithoutMethod(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const missing: string[] = []
  const visit = (node: ts.Node) => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText() === 'form') {
      const hasMethod = node.attributes.properties.some(
        (attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText() === 'method',
      )
      if (!hasMethod) {
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1
        missing.push(`${path.relative('.', file).split(path.sep).join('/')}:${line}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return missing
}

describe('every <form> of the public area states its method', () => {
  it('finds none without one', () => {
    expect(ROOTS.flatMap((root) => sources(root)).flatMap(formsWithoutMethod)).toEqual([])
  })

  it('detects a form without a method in a fixture', () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-forms-'))
    try {
      const file = path.join(dir, 'Bad.tsx')
      fs.writeFileSync(
        file,
        [
          'export const A = () => <form onSubmit={() => {}}><input name="password" /></form>',
          'export const B = () => <form method="post" action="/x" />',
          'export const C = () => <form method="get" action="/search" />',
        ].join('\n'),
      )
      expect(formsWithoutMethod(file).map((found) => found.replace(/^.*Bad\.tsx/, 'Bad.tsx'))).toEqual(['Bad.tsx:1'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
