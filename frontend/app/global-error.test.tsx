import { act, fireEvent, screen } from '@testing-library/react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import GlobalError from './global-error'
import { msg } from '@/test/render-intl'

/**
 * app/global-error.tsx: when app/layout.tsx itself breaks, Next replaces the WHOLE document with this file.
 * No globals.css, no Tailwind, no theme boot script (Next docs, error.md "Global
 * Error"), so it carries its own `<html lang="vi">`, title, and inline styles readable on both light and dark backgrounds.
 */

let log: MockInstance

beforeEach(() => {
  log = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  log.mockRestore()
})

function markup(error: Error & { digest?: string } = new Error('boom')): string {
  return renderToStaticMarkup(<GlobalError error={error} retry={() => {}} />)
}

describe('app/global-error.tsx: its own document', () => {
  it('is a full document: <html lang="vi">, a <head> with <title>, <body>', () => {
    const html = markup()

    expect(html).toMatch(/^<html lang="vi"[^>]*>/)
    expect(html).toMatch(/<head>.*<\/head>/)
    expect(html).toContain(`<title>${msg('Site.errorPage.title')}</title>`)
    expect(html).toMatch(/<body[^>]*>.*<\/body><\/html>$/)
  })

  it('color-scheme: light dark on <html>, colors only via light-dark(): light or dark by OS, no glaring white on a dark machine', () => {
    // There is no boot script here to read the reader choice (Next docs: global-error does not
    // receive the app theme), so the document follows the OS. A single hard color would be wrong on one of the two sides.
    const html = markup()
    const root = /^<html[^>]*style="([^"]*)"/.exec(html)

    expect(root?.[1]).toContain('color-scheme:light dark')
    const colours = [...html.matchAll(/(?:^|;|")((?:background-)?color):([^;"]+)/g)].map((m) => m[2]!.trim())
    expect(colours.length).toBeGreaterThan(0)
    for (const value of colours) expect(value).toMatch(/^(light-dark\(|inherit$|currentColor$|transparent$)/)
  })

  it('same wording and three exits as the in-site error page, using plain <a> (a full page reload)', () => {
    document.body.innerHTML = markup().replace(/^<html[^>]*>|<\/html>$/g, '')

    expect(screen.getByRole('heading', { level: 1, name: msg('Site.errorPage.title') })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: msg('Site.profile.author.retry') })).toHaveAttribute('type', 'button')
    expect(screen.getByRole('link', { name: msg('Site.login.backHome') })).toHaveAttribute('href', '/')
    expect(screen.getByRole('link', { name: msg('Site.errorPage.exits.allPosts') })).toHaveAttribute('href', '/writing')
    expect(screen.getByRole('link', { name: msg('Site.search.heading') })).toHaveAttribute('href', '/search')
    expect(screen.getByRole('main')).toBeInTheDocument()
    document.body.innerHTML = ''
  })

  it('the digest code when present; never error.message', () => {
    const withDigest = markup(Object.assign(new Error('jdbc:postgresql://db:5432/blog refused'), { digest: '1618' }))

    expect(withDigest).toContain(msg('Site.errorPage.digest', { digest: '1618' }))
    expect(withDigest).not.toContain('jdbc:postgresql')
    expect(markup()).not.toContain(msg('Site.errorPage.digest', { digest: '' }).replace(/[:\s]+$/, ''))
  })
})

describe('app/global-error.tsx: runs for real in the browser', () => {
  it('"Retry" calls retry exactly once; the error is written to the console', async () => {
    // A full document can only render into `document` itself: <html>, <head>, <body> are singletons in
    // React 19. Kept at the end of the file, because it takes over the jsdom document.
    const retry = vi.fn()
    const error = new Error('boom')
    const root = createRoot(document)

    await act(async () => {
      root.render(<GlobalError error={error} retry={retry} />)
    })

    expect(document.documentElement).toHaveAttribute('lang', 'vi')
    expect(document.title).toBe(msg('Site.errorPage.title'))
    fireEvent.click(screen.getByRole('button', { name: msg('Site.profile.author.retry') }))
    expect(retry).toHaveBeenCalledTimes(1)
    expect(retry).toHaveBeenCalledWith()
    expect(log.mock.calls.some((call) => call.includes(error))).toBe(true)

    await act(async () => root.unmount())
  })
})
