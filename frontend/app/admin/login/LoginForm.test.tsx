// frontend/app/admin/login/LoginForm.test.tsx
import { describe, expect, it, vi, afterEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { msg, renderWithIntl } from '@/test/render-intl'
import LoginForm, { LOGIN_ENDPOINT } from './LoginForm'

/**
 * DEVIATION from the plan's test code, forced and disclosed in the report:
 * the plan drives this form with `@testing-library/user-event`, which is not
 * installed in this project and is in neither package.json nor package-lock.json.
 * Measured: `require.resolve('@testing-library/user-event')` ->
 *   MODULE_NOT_FOUND Cannot find module '@testing-library/user-event'
 * and the first run of the plan's file verbatim died in Vite's import analysis.
 * Installing it would edit package.json/package-lock.json and mutate node_modules
 * while other agents are running tests, so this file uses `fireEvent`, which is
 * already how app/error.test.tsx drives a click. The assertions are the plan's.
 */

const replace = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }))

/** A fresh Response per call: a single instance's body can only be read once. */
function respond(body: unknown, status: number) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(body), { status }))
}

function fill(email: string, password: string) {
  fireEvent.change(screen.getByLabelText(msg('Admin.login.email')), { target: { value: email } })
  fireEvent.change(screen.getByLabelText(msg('Admin.login.password')), { target: { value: password } })
}

function submit() {
  fireEvent.click(screen.getByRole('button', { name: msg('Admin.login.submit') }))
}

describe('LoginForm', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    replace.mockReset()
  })

  it('posts the credentials to the route handler and goes to /admin', async () => {
    const fetchSpy = respond({ ok: true }, 200)

    renderWithIntl(<LoginForm />)
    fill('admin@blog.local', 'secret')
    submit()

    expect(fetchSpy).toHaveBeenCalledWith(LOGIN_ENDPOINT, expect.objectContaining({ method: 'POST' }))
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/admin'))
  })

  it('never submits the password as a GET query before the script has loaded', () => {
    // The server HTML is all there is until hydration. A <form> without a method is a GET to this very address: the password would
    // sit in the URL, the browser history and the proxy's access log. A POST to the handler is refused (it takes JSON only) and leaks nothing.
    const { container } = renderWithIntl(<LoginForm />)

    const form = container.querySelector('form')
    expect(form).toHaveAttribute('method', 'post')
    expect(form).toHaveAttribute('action', LOGIN_ENDPOINT)
  })

  it('sends the credentials as JSON in the body, not in the URL', async () => {
    // Beyond the plan's assertions. `toHaveBeenCalledWith(url, objectContaining({method}))`
    // passes against a form that posts an empty body, or one that appends the password
    // to the query string where it lands in every access log on the way.
    const fetchSpy = respond({ ok: true }, 200)

    renderWithIntl(<LoginForm />)
    fill('admin@blog.local', 's3cret')
    submit()

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).not.toContain('s3cret')
    expect(JSON.parse(String(init.body))).toEqual({ email: 'admin@blog.local', password: 's3cret' })
  })

  it('shows the error from the handler and stays put', async () => {
    respond({ error: 'Invalid email or password' }, 401)

    renderWithIntl(<LoginForm />)
    fill('admin@blog.local', 'wrong')
    submit()

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password')
    expect(replace).not.toHaveBeenCalled()
  })

  it('too many attempts (route 429): shows the message from the route, stays on the page, button is usable again', async () => {
    const message = msg('Admin.login.tooManyAttempts', { minutes: '10' })
    respond({ error: message }, 429)

    renderWithIntl(<LoginForm />)
    fill('admin@blog.local', 'wrong')
    submit()

    expect(await screen.findByRole('alert')).toHaveTextContent(message)
    expect(replace).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: msg('Admin.login.submit') })).not.toBeDisabled()
  })

  it('treats a 200 that is not {ok:true} as a failure rather than navigating', async () => {
    // Beyond the plan. The measured failure mode this catches: if the login endpoint
    // is ever gated by middleware, the POST is answered with a 307 to /admin/login,
    // fetch follows it, and the login PAGE comes back as a 200 full of HTML. On
    // `if (!res.ok)` alone that reads as success, the form navigates to /admin,
    // middleware bounces it straight back, and the author sees a login page again
    // with no error — a silent loop. The body check turns it into a visible failure.
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('<!doctype html><title>login</title>', { status: 200 }),
    )

    renderWithIntl(<LoginForm />)
    fill('admin@blog.local', 'secret')
    submit()

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(replace).not.toHaveBeenCalled()
  })

  it('reports a network failure instead of hanging on the spinner', async () => {
    // Beyond the plan. Without the try/catch the rejected promise is unhandled, the
    // button stays disabled, and the author has no way to retry but a reload.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))

    renderWithIntl(<LoginForm />)
    fill('admin@blog.local', 'secret')
    submit()

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: msg('Admin.login.submit') })).not.toBeDisabled()
  })

  it('does not post to its own page URL, which one segment cannot also serve', () => {
    // Beyond the plan, and the only offline way to pin a routing fact. Measured in
    // node_modules/next 16.3.7: an `app/admin/login/page.tsx` shadows the sibling
    // `route.ts` (AppPage matcher provider is registered first, base-server.js:462-463),
    // Next raises no error and not even the dev duplicate warning, and a POST to a page
    // route is a 405. Pointing this constant back at '/admin/login' is therefore a
    // silent login outage; this assertion makes it a loud test failure instead.
    expect(LOGIN_ENDPOINT).not.toBe('/admin/login')
    expect(LOGIN_ENDPOINT.startsWith('/admin/')).toBe(true)
  })

  it('never renders the password back into the DOM as text', async () => {
    renderWithIntl(<LoginForm />)
    const password = screen.getByLabelText(msg('Admin.login.password'))
    fireEvent.change(password, { target: { value: 'secret' } })

    // The channel this inspects is the input's type attribute, which is what actually
    // masks the value — not the document's text, where a password input's value never
    // appears regardless.
    expect(password).toHaveAttribute('type', 'password')
  })
})

describe('LoginForm in English', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses the English labels, button and fallback errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))

    renderWithIntl(<LoginForm />, { locale: 'en' })
    fireEvent.change(screen.getByLabelText(msg('Admin.login.email', undefined, 'en')), { target: { value: 'a@b.test' } })
    fireEvent.change(screen.getByLabelText(msg('Admin.login.password', undefined, 'en')), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: msg('Admin.login.submit', undefined, 'en') }))

    expect(await screen.findByRole('alert')).toHaveTextContent(msg('Admin.login.network', undefined, 'en'))
  })

  it('shows the English fallback when the handler sends no error text', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({}), { status: 401 }))

    renderWithIntl(<LoginForm />, { locale: 'en' })
    fireEvent.change(screen.getByLabelText(msg('Admin.login.email', undefined, 'en')), { target: { value: 'a@b.test' } })
    fireEvent.change(screen.getByLabelText(msg('Admin.login.password', undefined, 'en')), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: msg('Admin.login.submit', undefined, 'en') }))

    expect(await screen.findByRole('alert')).toHaveTextContent(msg('Admin.login.failed', undefined, 'en'))
  })
})

describe('LoginForm: the second step and the destination', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    replace.mockReset()
  })

  it('goes to the destination given by the page (for example "sign in again" from Security)', async () => {
    respond({ ok: true }, 200)

    renderWithIntl(<LoginForm next="/admin/security" />)
    fill('admin@blog.local', 'secret')
    submit()

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/admin/security'))
  })

  it('an administrator is sent to the code page: no session exists yet, so it does not go to /admin', async () => {
    respond({ ok: true, next: 'mfa', enrollmentCodeRequired: false }, 200)

    renderWithIntl(<LoginForm />)
    fill('admin@blog.local', 'secret')
    submit()

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/admin/login/mfa'))
    expect(replace).toHaveBeenCalledTimes(1)
  })

  it('the first sign-in of an administrator goes to the enrollment, and carries the hint that the enrollment code is asked', async () => {
    respond({ ok: true, next: 'enroll', enrollmentCodeRequired: true }, 200)

    renderWithIntl(<LoginForm />)
    fill('admin@blog.local', 'secret')
    submit()

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/admin/login/enroll?code=1'))
  })

  it('keeps the destination through the second step in the URL', async () => {
    respond({ ok: true, next: 'mfa' }, 200)

    renderWithIntl(<LoginForm next="/admin/security" />)
    fill('admin@blog.local', 'secret')
    submit()

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/admin/login/mfa?next=/admin/security'))
  })

  it('ignores a step name it does not know and treats the answer like a finished sign-in', async () => {
    respond({ ok: true, next: 'somewhere-else' }, 200)

    renderWithIntl(<LoginForm />)
    fill('admin@blog.local', 'secret')
    submit()

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/admin'))
  })
})
