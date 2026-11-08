import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { IntlWrapper } from '@/test/intl'
import { SearchForm } from './SearchForm'
import { msg, renderWithIntl } from '@/test/render-intl'
import { RETIRED_DIACRITIC_HINT } from '@/test/fixtures/vi/search-form-hint'

/**
 * `process.cwd()`, not `fileURLToPath(import.meta.url)`: under Vite's transform
 * `import.meta.url` is not a file: URL and `fileURLToPath` throws "The URL must be of
 * scheme file" — measured, that was this file's first failure, and the /writing test
 * carries the same note. `import.meta.dirname` is undefined before Node 20.11.
 *
 * `readFileSync` rather than a maybe-empty read: a source-text guard that silently read
 * '' would make every `not.toContain` below pass while checking nothing, so a wrong
 * path must throw rather than produce an empty string. The sanity assertion in the last
 * test proves the file actually arrived.
 */
const SOURCE_PATH = resolve(process.cwd(), 'components/site/SearchForm.tsx')
const SOURCE = readFileSync(SOURCE_PATH, 'utf8')

/**
 * Comments stripped — block, JSX (`{/* … *\/}` is a block comment inside braces, so the
 * same rule removes it) and line — before the "no client code" assertions below.
 *
 * Not fastidiousness: without this the guards fail on the component's own prose, which
 * is where the words `useState`, `onChange` and `'use client'` legitimately appear
 * explaining why none of them is used. Measured, in this order: `toContain('use
 * client')` failed first, then `/\buseState\b/`, then `/\bonChange\b/`. Loosening each
 * pattern until the prose slipped past would have left three patterns that no longer
 * match the real thing either. app/globals.css's own test strips comments the same way
 * and for the same reason.
 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

describe('SearchForm', () => {
  it('is a GET form aimed at /search, so the query ends up in the URL', () => {
    const { container } = render(<SearchForm q="" />)

    const form = container.querySelector('form')
    expect(form).not.toBeNull()

    // Both halves matter and both are reader-visible consequences rather than style.
    //
    // method="get": a POST form would navigate to /search and arrive with the query in
    // a body no server component can read from `searchParams` — the page would render
    // its "nothing searched yet" state for every search ever performed, with no error
    // anywhere. jsdom reports the DEFAULT as "get" too, so `toBe('get')` alone would
    // pass on a form with no method attribute at all; the attribute is asserted
    // directly as well.
    expect(form?.method).toBe('get')
    expect(form?.getAttribute('method')).toBe('get')

    // action="/search": a form with no action submits to the CURRENT url, which is
    // right only while this component lives on /search alone.
    expect(form?.getAttribute('action')).toBe('/search')
  })

  it('on the English site it submits to the English results page', () => {
    renderWithIntl(<SearchForm q="" />, { locale: 'en' })
    expect(screen.getByRole('search').getAttribute('action')).toBe('/en/search')
  })

  it('names the field "q", which is the only reason the browser produces ?q=', () => {
    render(<SearchForm q="" />)

    // Found by its visible label, so this also pins the label/input association —
    // getByLabelText fails if the `htmlFor`/`id` pair is broken, which is the usual way
    // a visible label stops being an accessible name.
    const input = screen.getByLabelText(msg('Site.search.form.keywordLabel'))

    expect(input).toHaveAttribute('name', 'q')
    // `search`, not `text`: mobile keyboards offer a Go key for it. It submits the same
    // either way, so this is the one assertion here that is purely about the reader's
    // keyboard.
    expect(input).toHaveAttribute('type', 'search')
  })

  it('shows the current query back in the box, so refining means editing not retyping', () => {
    render(<SearchForm q="queue" />)

    expect(screen.getByLabelText(msg('Site.search.form.keywordLabel'))).toHaveValue('queue')
  })

  it('is empty when there is no query, rather than printing undefined', () => {
    render(<SearchForm q="" />)

    expect(screen.getByLabelText(msg('Site.search.form.keywordLabel'))).toHaveValue('')
  })

  it('offers a real submit button', () => {
    render(<SearchForm q="" />)

    // Enter in a single-field form submits it, but touch keyboards vary on offering a
    // Go key, and the button is also the only affordance saying this box searches
    // rather than filtering as you type.
    expect(screen.getByRole('button', { name: msg('Site.search.form.submit') })).toHaveAttribute('type', 'submit')
  })

  it('is a search landmark', () => {
    render(<SearchForm q="" />)

    expect(screen.getByRole('search')).toBeInTheDocument()
  })

  it('no longer warns about diacritics: the search ignores them now', () => {
    const { container } = render(<SearchForm q="" />)

    // PINNED AGAIN ON PURPOSE. The old test pinned the sentence saying search is diacritic-sensitive: the plain form does not match the accented form.
    // — true when the backend used the `simple` config (q=hoc returned 0, q with diacritics returned 5). Now the backend searches with an
    // accent-stripping config (`vi_unaccent`): the unaccented form finds the accented word. Keeping that sentence would tell
    // the reader something false about the search field itself, so it goes, along with its id/aria-describedby pair.
    expect(screen.queryByText(RETIRED_DIACRITIC_HINT)).not.toBeInTheDocument()
    expect(container.querySelector('#search-hint')).toBeNull()
    // Do not leave an aria-describedby pointing at a nonexistent id: a screen reader would read nothing,
    // and accessibility checkers report a reference error.
    expect(screen.getByLabelText(msg('Site.search.form.keywordLabel'))).not.toHaveAttribute('aria-describedby')
    // The "present" pair: the form loses nothing else — still the label, the field, the button.
    expect(screen.getByRole('button', { name: msg('Site.search.form.submit') })).toBeInTheDocument()
  })

  it('focuses the field on an empty /search, so the reader can type straight away', () => {
    render(<SearchForm q="" />)

    // A person arriving at an empty /search (the header's search slot, the "/" key) arrives to type. React calls focus() when the field is
    // mounted, even when the page arrives through client-side navigation.
    expect(screen.getByLabelText(msg('Site.search.form.keywordLabel'))).toHaveFocus()
    // And the server HTML carries the attribute, so the first page load also focuses before hydration.
    expect(
      renderToStaticMarkup(
        <IntlWrapper>
          <SearchForm q="" />
        </IntlWrapper>,
      ),
    ).toMatch(/<input[^>]*\sautofocus(=""|\s|>)/i)
  })

  it('leaves focus alone when there is a query: the reader is reading results, not typing', () => {
    render(<SearchForm q="queue" />)

    // Focusing the field on a results page scrolls up to the top and, on a phone, raises the keyboard covering half the list
    // just found.
    expect(screen.getByLabelText(msg('Site.search.form.keywordLabel'))).not.toHaveFocus()
    expect(
      renderToStaticMarkup(
        <IntlWrapper>
          <SearchForm q="queue" />
        </IntlWrapper>,
      ),
    ).not.toMatch(/autofocus/i)
  })

  it('no children adds nothing (the label and one row of field + button); children sit in the same form, after "Search"', () => {
    const { container, unmount } = render(<SearchForm q="queue" />)
    // Header.test.tsx uses the form without children: still exactly two children as before the filters existed.
    expect([...container.querySelector('form')!.children].map((el) => el.tagName)).toEqual(['LABEL', 'DIV'])
    unmount()

    render(
      <SearchForm q="queue">
        <select name="category" aria-label={msg('Site.writing.categories')} />
      </SearchForm>,
    )
    const select = screen.getByRole('combobox', { name: msg('Site.writing.categories') })
    expect(screen.getByRole('search')).toContainElement(select)
    // After the button: the search button is still the first submit button, so Enter in the keyword field submits the filters too.
    const button = screen.getByRole('button', { name: msg('Site.search.form.submit') })
    expect(button.compareDocumentPosition(select) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('autoFocus can be turned off — /search with only filters is a results page, not an empty field waiting for typing', () => {
    render(<SearchForm q="" autoFocus={false} />)

    expect(screen.getByLabelText(msg('Site.search.form.keywordLabel'))).not.toHaveFocus()
    expect(
      renderToStaticMarkup(
        <IntlWrapper>
          <SearchForm q="" autoFocus={false} />
        </IntlWrapper>,
      ),
    ).not.toMatch(/autofocus/i)
  })

  it('has a visible focus ring on both controls', () => {
    render(<SearchForm q="" />)

    // Asserted on the class string, which is the honest limit of what jsdom can say:
    // it applies no Tailwind CSS at all, so nothing in this file can prove the ring is
    // actually painted. What it does catch is the ring being deleted in a restyle.
    for (const el of [
      screen.getByLabelText(msg('Site.search.form.keywordLabel')),
      screen.getByRole('button', { name: msg('Site.search.form.submit') }),
    ]) {
      expect(el.className).toContain('focus-visible:outline-brand')
    }
  })

  /**
   * A source-text guard, not a DOM one, because what it forbids cannot be observed in
   * the DOM: a `'use client'` component that fetches on change renders the same markup
   * on first paint and only then diverges.
   *
   * The whole design of this page rests on the query living in the URL — linkable,
   * shareable, reloadable, and readable by a server component. The tempting refactor
   * ("make it feel instant") replaces the form with onChange + debounce + fetch, which
   * silently costs every one of those, forces /search to become a client component,
   * and requires the API base URL to be public with CORS open. This test is the only
   * thing in the suite that would notice.
   */
  it('is a server component with no client-side fetching', () => {
    // A negative-only test is vacuous if the read failed or the stripping ate
    // everything, so prove CODE first: these two strings are the component's identity
    // and neither lives in a comment.
    expect(CODE, `read nothing useful from ${SOURCE_PATH}`).toContain('export function SearchForm')
    expect(CODE).toContain('method="get"')

    expect(CODE).not.toMatch(/['"]use client['"]/)
    expect(CODE).not.toMatch(/\buseState\b/)
    expect(CODE).not.toMatch(/\buseEffect\b/)
    expect(CODE).not.toMatch(/\bdebounce\b/i)
    expect(CODE).not.toMatch(/\bonChange\b/)
    expect(CODE).not.toMatch(/\bfetch\b/)
  })
})
