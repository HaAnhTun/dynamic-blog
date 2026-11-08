import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { defaultSiteContent } from '@/content/defaults'
import type { Locale } from '@/i18n/config'
import type { Contact } from '@/lib/site-content-types'
import { setTestLocale } from '@/test/intl'
import { msg, renderWithIntl } from '@/test/render-intl'
import { Footer } from './Footer'

const NO_CONTACT: Contact = { ...defaultSiteContent('en').contact, email: null, github: null }

/** Footer is an async server component: it reads the request locale and the site content before it renders. */
async function renderFooter(locale: Locale, data = NO_CONTACT) {
  setTestLocale(locale)
  return renderWithIntl(await Footer({ data }), { locale })
}

describe('Footer in English', () => {
  it('shows the English labels and links the pages under /en', async () => {
    await renderFooter('en')

    const nav = screen.getByRole('navigation', { name: msg('Site.footer.navLabel', undefined, 'en') })
    const read = within(nav).getByRole('list', { name: msg('Site.footer.readTitle', undefined, 'en') })
    expect(
      within(read)
        .getAllByRole('link')
        .map((a) => [a.textContent, a.getAttribute('href')]),
    ).toEqual([
      [msg('Site.footer.links.writing', undefined, 'en'), '/en/writing'],
      [msg('Site.footer.links.startHere', undefined, 'en'), '/en/start-here'],
      [msg('Site.footer.links.series', undefined, 'en'), '/en/series'],
      [msg('Site.footer.links.topics', undefined, 'en'), '/en/topics'],
      [msg('Site.footer.links.archive', undefined, 'en'), '/en/archive'],
      // A route handler: a plain link without a locale prefix.
      [msg('Site.footer.links.random', undefined, 'en'), '/random'],
    ])
    expect(
      within(nav).getByRole('heading', { level: 2, name: msg('Site.footer.aboutTitle', undefined, 'en') }),
    ).toBeInTheDocument()
    expect(within(nav).getByRole('link', { name: msg('Site.footer.links.newsletter', undefined, 'en') })).toHaveAttribute(
      'href',
      '/en/newsletter',
    )
  })

  it('writes the copyright line with the year and the site name, and keeps no Vietnamese label', async () => {
    await renderFooter('en')

    const { site } = defaultSiteContent('en')
    const footer = screen.getByRole('contentinfo')
    expect(footer).toHaveTextContent(site.positioning)
    expect(footer).toHaveTextContent(`© ${new Date().getFullYear()} ${site.name}`)
    expect(within(footer).queryByRole('link', { name: msg('Site.footer.links.writing', undefined, 'vi') })).toBeNull()
  })
})

describe('Footer in the site frame', () => {
  it('has no margin or padding of its own: the padding is on its Container, so the frame hairlines touch both edges', async () => {
    await renderFooter('en')

    const footer = screen.getByRole('contentinfo')
    const classes = Array.from(footer.classList)
    expect(classes.filter((name) => /^(-?m[tblrxy]?|p[tblrxy]?)-/.test(name))).toEqual([])
    expect(footer).toHaveClass('border-t', 'bg-neutral-50', 'print:hidden')
    // The e2e frameGeometry hook is `contentinfo > :scope > div`: exactly one direct div child, and it is the Container.
    const divs = Array.from(footer.children).filter((child) => child.tagName === 'DIV')
    expect(divs).toHaveLength(1)
    expect(divs[0]).toHaveClass('max-w-[87.5rem]', 'py-8', 'sm:py-10', 'frame:border-x', 'print:border-0')
    expect(divs[0]).not.toHaveClass('max-w-5xl')
  })

  it('renders no frame marker attribute', async () => {
    await renderFooter('en')

    expect(document.querySelectorAll('[data-site-footer], [data-site-frame]')).toHaveLength(0)
  })
})

describe('Footer in Vietnamese', () => {
  it('links the pages without a prefix', async () => {
    await renderFooter('vi')

    expect(screen.getByRole('link', { name: msg('Site.footer.links.writing', undefined, 'vi') })).toHaveAttribute(
      'href',
      '/writing',
    )
  })
})

describe('Footer contact links', () => {
  it('lists the email and GitHub when the content has them, GitHub with rel me', async () => {
    await renderFooter('en', { ...NO_CONTACT, email: 'reader@example.test', github: 'https://github.com/example-user' })

    const footer = screen.getByRole('contentinfo')
    expect(within(footer).getByRole('link', { name: 'reader@example.test' })).toHaveAttribute(
      'href',
      'mailto:reader@example.test',
    )
    const github = within(footer).getByRole('link', { name: 'example-user' })
    expect(github).toHaveAttribute('href', 'https://github.com/example-user')
    expect(github.getAttribute('rel')?.split(' ')).toContain('me')
  })

  it('renders no contact list at all when both channels are empty', async () => {
    await renderFooter('en')

    expect(screen.getByRole('contentinfo').querySelectorAll('ul')).toHaveLength(2)
  })
})
