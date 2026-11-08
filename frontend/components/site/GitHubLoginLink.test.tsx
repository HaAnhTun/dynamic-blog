import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it } from 'vitest'
import { GitHubLoginLink, githubStartHref } from './GitHubLoginLink'
import { msg, renderWithIntl } from '@/test/render-intl'

describe('githubStartHref', () => {
  it('points to the start route, with returnTo fully encoded including the query and #', () => {
    expect(githubStartHref('/posts/bai-viet?x=1#binh-luan')).toBe(
      `/api/auth/github/start?returnTo=${encodeURIComponent('/posts/bai-viet?x=1#binh-luan')}`,
    )
  })

  it('with a non-default locale, returns to the page in that locale; the default locale and /admin carry no prefix', () => {
    expect(githubStartHref('/posts/a#binh-luan', 'en')).toBe(
      `/api/auth/github/start?returnTo=${encodeURIComponent('/en/posts/a#binh-luan')}`,
    )
    expect(githubStartHref('/', 'en')).toBe('/api/auth/github/start?returnTo=%2Fen')
    expect(githubStartHref('/posts/a', 'vi')).toBe('/api/auth/github/start?returnTo=%2Fposts%2Fa')
    expect(githubStartHref('/admin', 'en')).toBe('/api/auth/github/start?returnTo=%2Fadmin')
    // Still sanitized after the prefix: the English sign-in page is not a return target either.
    expect(githubStartHref('/login', 'en')).toBe('/api/auth/github/start?returnTo=%2F')
  })

  it.each(['//evil.com', '/..//evil.com', 'https://evil.com', '/login', '/api/x', '', null, undefined])(
    'returnTo %j is sanitized to "/" before entering the URL',
    (returnTo) => {
      expect(githubStartHref(returnTo)).toBe('/api/auth/github/start?returnTo=%2F')
    },
  )
})

describe('GitHubLoginLink', () => {
  it('on an English page the link returns to the English page', () => {
    renderWithIntl(<GitHubLoginLink returnTo="/posts/a">{msg('Site.account.signInWithGithub', {}, 'en')}</GitHubLoginLink>, {
      locale: 'en',
    })
    expect(screen.getByRole('link')).toHaveAttribute('href', '/api/auth/github/start?returnTo=%2Fen%2Fposts%2Fa')
  })

  it('is a plain <a rel="nofollow">, the name comes from the text, the GitHub mark is only for the eye', () => {
    render(<GitHubLoginLink returnTo="/posts/a">{msg('Site.account.signInWithGithub')}</GitHubLoginLink>)

    const link = screen.getByRole('link', { name: msg('Site.account.signInWithGithub') })
    expect(link.tagName).toBe('A')
    expect(link).toHaveAttribute('href', '/api/auth/github/start?returnTo=%2Fposts%2Fa')
    expect(link).toHaveAttribute('rel', 'nofollow')
    const svg = link.querySelector('svg')!
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg).toHaveAttribute('focusable', 'false')
  })

  it('accepts an aria-label for the icon-only form, and forwards the ref to the <a> tag', () => {
    const ref = createRef<HTMLAnchorElement>()
    render(
      <GitHubLoginLink returnTo="/" aria-label={msg('Site.account.signInWithGithub')} className="h-9" ref={ref}>
        <span className="hidden sm:inline">{msg('Site.account.signIn')}</span>
      </GitHubLoginLink>,
    )

    const link = screen.getByRole('link', { name: msg('Site.account.signInWithGithub') })
    expect(ref.current).toBe(link)
    expect(link).toHaveClass('h-9')
  })

  it('does not go through next/link: prefetching a link to the start route would begin an OAuth round on its own', () => {
    // Next's router prefetches every <Link> it sees on screen (app/random/route.ts has the same reason).
    const source = readFileSync(join(process.cwd(), 'components/site/GitHubLoginLink.tsx'), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

    expect(code).not.toMatch(/from\s+['"]next\/link['"]/)
  })
})
