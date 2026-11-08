import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { headers } from 'next/headers'
import { Link } from '@/i18n/navigation'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Pagination } from '@/components/Pagination'
import { BrowseFrame } from '@/components/site/BrowseFrame'
import { DiscoveryGrid } from '@/components/site/DiscoveryGrid'
import { PostList, type RowHighlight } from '@/components/site/PostList'
import {
  ActiveFilters,
  hasFilters,
  SearchFilters,
  searchHref,
  type FilterOptions,
  type SearchFilterState,
} from '@/components/site/SearchFilters'
import { SearchForm } from '@/components/site/SearchForm'
import { DegradedNotice } from '@/components/site/search/DegradedNotice'
import { ApiError, searchContent } from '@/lib/api'
import { clientIpFromHeaders } from '@/lib/client-ip'
import { getDiscovery } from '@/lib/discovery'
import { metadataLocale } from '@/lib/locale-path'
import { pageMetadata } from '@/lib/metadata'
import { cleanQuery, type BackendSearchResponse } from '@/lib/search-contract'
import { allowSearch } from '@/lib/search-suggest'
import { getSeriesList } from '@/lib/series'
import { getCategories, getTags } from '@/lib/taxonomy'
import type { PageMeta, PostSummary } from '@/lib/types'
import { setPageLocale } from '@/i18n/page-locale'

/**
 * Inert here, like the identical declaration on /writing: reading `searchParams` makes the
 * route fully dynamic. There is no fetch cache left to set a number on: `searchContent` is `no-store`
 * (rule 6 of the API client). Kept at 60 because a test pins it, so that nobody copies the 300 of /writing here.
 */
export const revalidate = 60

const PAGE_SIZE = 10

/**
 * Same ceiling and same reason as /writing: the backend binds `page` to a 32-bit
 * `int`, so 2147483647 is a 500 and 2147483648 a 400 — reader-typable URLs answered
 * with a server error. Refusing above a page count no blog reaches means the absurd
 * values never reach the API at all.
 */
const MAX_PAGE = 10_000

/** Backend limit: a `q` longer than 200 (cut in `cleanQuery`) or more than 5 distinct tags is a 400. */
const MAX_TAGS = 5

/**
 * Makes THIS FILE reject a hand-written `{ searchParams: … }`.
 *
 * `PageProps<'/[locale]/search'>` on the signature is a tripwire, not a guard. Next's generated
 * validator types a page's default export as `{ params: Promise<…> } & any`, and
 * `X & any` collapses to `any`, so the framework itself accepts any signature at all.
 * On /writing, swapping the annotation for a synchronous `{ searchParams }` shape put
 * every resulting error in the test fixture and none in the page — lint, typecheck,
 * tests and build all green while `?page=2` served page one.
 *
 * This route is the one where that failure would be worst: `q` is the whole content of
 * the page, and a synchronous destructure of a Promise yields `undefined`, which this
 * page renders as the perfectly plausible "nobody has searched yet" state. Not an
 * error — the empty prompt, on every query, forever.
 *
 * Both exports are checked, not only the default one. The route literal is
 * double-quoted so a search-and-replace over the single-quoted annotations below
 * cannot rewrite it, which is how a first attempt at this guard on another route
 * silently disarmed itself.
 */
type AcceptsGeneratedProps<T extends (props: PageProps<'/[locale]/search'>) => unknown> = T
export type _SearchAcceptsGeneratedProps = AcceptsGeneratedProps<typeof SearchPage>
export type _SearchMetadataAcceptsGeneratedProps = AcceptsGeneratedProps<typeof generateMetadata>

/**
 * Shape-checked before parsing, not after — the note on /writing's copy has the full
 * reasoning. In short: `Number.parseInt` reads '1.5' as 1, '0x2' as 2, '2abc' as 2,
 * and on a 22-digit string returns a float, so '9999999999999999999999' became
 * `page=1e+22` on the wire and the API answered 500. Only a run of digits counts;
 * everything else is page 0.
 *
 * `Array.isArray` first, because `?page=2&page=5` arrives as `['2','5']`.
 *
 * Duplicated from /writing, /categories/[slug] and /tags/[slug] rather than shared:
 * the only module all four could share is lib/*, which belongs to another agent this
 * run. Each copy is covered by its own test.
 */
function parsePage(page: string | string[] | undefined): number {
  const raw = Array.isArray(page) ? (page[0] ?? '') : (page ?? '')
  return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : 0
}

/**
 * The same `Array.isArray` guard as `parsePage`, for the same reason — `?q=a&q=b` is a
 * legal URL and arrives as an array, and `q.trim()` on an array is a runtime
 * TypeError, not a type error, because `searchParams` is typed
 * `Record<string, string | string[] | undefined>`. The first value wins.
 *
 * Trimmed, and the trimmed value is what the whole page uses: it is the string sent to
 * the API (a blank one, '   ' included, is not sent at all: the page skips the network
 * call), the string echoed back in the no-match message, and the string carried
 * through the pager. Echoing the untrimmed original while searching the trimmed one
 * would show the reader quotes with phantom whitespace inside them.
 */
function parseQuery(q: string | string[] | undefined): string {
  // The same function as the quick search panel: the same typed string, the same query in both places.
  return cleanQuery(Array.isArray(q) ? (q[0] ?? '') : (q ?? ''))
}

/** Like `parseQuery`: first value, trimmed; empty means no filter. An unknown slug is still sent, the backend returns an empty page. */
function parseSlug(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
  return raw.trim() || undefined
}

/** `tag` may repeat: all values, trimmed, empties and duplicates dropped; the sixth tag onward is dropped instead of becoming a 400. */
function parseFilters(params: Record<string, string | string[] | undefined>): SearchFilterState {
  const tags = ([] as string[]).concat(params.tag ?? []).map((tag) => tag.trim())
  return {
    category: parseSlug(params.category),
    tags: [...new Set(tags.filter((tag) => tag !== ''))].slice(0, MAX_TAGS),
    series: parseSlug(params.series),
  }
}

type SearchResult = { items: PostSummary[]; highlights: Map<string, RowHighlight>; meta: PageMeta; degraded: boolean }

/**
 * The `post` group of the shared client turned into a PostList page. The backend drops the group when no post matches,
 * but keeps it (with the total, `totalPages`, no rows) when the page is past the last page: the 404 rule below needs exactly that number.
 */
function postResults(response: BackendSearchResponse<PostSummary>, page: number): SearchResult {
  const group = response.groups.find((candidate) => candidate.type === 'post')
  const rows = (group?.items ?? []).flatMap(({ post, title, description }) =>
    post ? [{ post, title, excerpt: description }] : [],
  )
  const total = group?.total ?? 0
  return {
    items: rows.map((row) => row.post),
    highlights: new Map(rows.map(({ post, title, excerpt }) => [post.id, { title, excerpt }])),
    meta: {
      page: group?.page ?? page,
      size: PAGE_SIZE,
      totalElements: total,
      totalPages: group?.totalPages ?? Math.ceil(total / PAGE_SIZE),
    },
    degraded: response.degraded === true,
  }
}

/**
 * `alternates.canonical` is mandatory, not cosmetic: app/layout.tsx sets
 * `canonical: '/'` and Next INHERITS it into every page that does not override it, so
 * without this block /search declares itself a duplicate of the homepage.
 *
 * It is the bare '/search' for every query and every page, deliberately — the opposite
 * of /writing, which carries `?page=` into its canonical. The two differ because the
 * pages differ: /writing?page=3 is the only URL where certain posts appear, so
 * collapsing it would drop them from the index. A search result page contains nothing
 * that is not already on /writing or /posts/[slug]; there is no content to lose.
 *
 * `robots` is the half that matters. A search endpoint left indexable is the classic
 * way a site fills an index with thousands of near-duplicate thin pages — and, when
 * the query is echoed back on the page as it is below, the way a site ends up hosting
 * search-result pages for whatever strangers decide to submit. So any non-empty query
 * is noindex, and so is any filter. `follow: true` with it: the links on the
 * page point at real articles and there is no reason to refuse a crawler the path to them.
 *
 * The bare /search carries NO robots key at all, rather than an explicit
 * `index: true`. Omitting it inherits the site default (app/layout.tsx sets no robots
 * key, so there is no "noindex" to override) and leaves one fewer directive to
 * contradict a future site-wide one.
 */
export async function generateMetadata(props: PageProps<'/[locale]/search'>): Promise<Metadata> {
  const locale = await metadataLocale(props.params)
  const t = await getTranslations({ locale, namespace: 'Site.search.meta' })
  const params = await props.searchParams
  const query = parseQuery(params.q)
  const filtered = hasFilters(parseFilters(params))

  // The bare page carries NO `robots` key, which is why it is expressed as the helper's
  // result unchanged: lib/metadata.ts deliberately has no `robots` parameter, so it cannot
  // make this route noindex by accident. The query branch spreads one in alongside.
  if (query === '' && !filtered) {
    return pageMetadata({
      locale,
      title: t('title'),
      description: t('description'),
      canonical: '/search',
    })
  }

  return {
    ...(await pageMetadata({
      locale,
      title: query === '' ? t('title') : t('titleWithQuery', { query }),
      description: query === '' ? t('descriptionFiltered') : t('descriptionWithQuery', { query }),
      // '/search', not '/search?q=…' — and therefore `og:url` is '/search' too, while the
      // TITLE stays query-specific. That asymmetry is the reason lib/metadata.ts takes a
      // canonical rather than deriving one from the request: there is no rule it could
      // apply that would be right here and right on /writing at the same time.
      canonical: '/search',
    })),
    robots: { index: false, follow: true },
  }
}

export default async function SearchPage(props: PageProps<'/[locale]/search'>) {
  const locale = await setPageLocale(props.params)
  const t = await getTranslations('Site.search')
  // searchParams is a Promise in Next 16. Destructuring it synchronously compiles,
  // builds and renders empty values — the type annotation is what makes it an error.
  const params = await props.searchParams
  const query = parseQuery(params.q)
  const filters = parseFilters(params)
  const current = parsePage(params.page)

  // Before any API call: the point of MAX_PAGE is that such a page does not exist,
  // which is knowable without asking anyone.
  if (current > MAX_PAGE) notFound()

  const hasQuery = query !== ''
  const filtered = hasFilters(filters)
  const searched = hasQuery || filtered
  // The same per-IP allowance as the quick search panel (allowSearch): every search here also uses up a unit of the backend
  // shared ceiling, so without it one IP loading this page continuously is enough to make the whole site "busy". An unknown IP (misconfigured
  // proxy, a junk X-Forwarded-For entry) is not exempt: it counts in the shared "unknown" bucket like in every other limiter, so a request
  // that hides its address does not get the unlimited path. The address also goes to the backend, which limits per address too.
  const ip = searched ? clientIpFromHeaders(await headers()) : null
  const allowed = searched && allowSearch(ip)

  // The lists of categories, tags, series only feed the filter field and the chip names: if they fail the filter field gets emptier
  // (the filters in use still show by slug), search still runs.
  const [response, categories, tags, series] = await Promise.all([
    // Nothing searched yet (q empty or whitespace only, no filter): the answer is known to be empty, no network call.
    // `null` here is never drawn: the "nothing searched" branch comes before the 400 branch below.
    !searched
      ? null
      : !allowed
        ? ('busy' as const)
        : searchContent(
            {
              q: query,
              type: 'post',
              page: current,
              size: PAGE_SIZE,
              category: filters.category,
              tags: filters.tags.length > 0 ? filters.tags : undefined,
              series: filters.series,
              language: locale,
            },
            { clientIp: ip },
          ).catch((error: unknown) => {
            // 400 is a bad request coming from the very URL the reader typed: an in-place sentence, not a 500 page.
            if (error instanceof ApiError && error.status === 400) return null
            // 429 is the backend's own limit (this address, or the shared ceiling): busy for a moment, not an error of the page.
            if (error instanceof ApiError && error.status === 429) return 'busy' as const
            throw error
          }),
    getCategories(locale).catch(() => []),
    getTags(locale).catch(() => []),
    getSeriesList(locale).catch(() => []),
  ])
  const busy = response === 'busy'
  const result = response && response !== 'busy' ? postResults(response, current) : null
  const options: FilterOptions = {
    categories,
    tags,
    series: series.map((item) => ({ slug: item.slug, name: item.title })),
  }

  // Out of range is a 404 only when there is a query or a filter. The backend echoes the
  // requested page straight back — ?page=99 over six pages answers the post group with its
  // total and `totalPages` but no items, and Pagination clamps its own
  // label; without this the reader gets a blank list under a pager reading
  // "Trang 6 / 6", a URL that does not exist answered 200 with a lie on it.
  //
  // With NO query and no filter there is deliberately no 404: totalPages is 0, so the /writing rule
  // (`current > 0 && current >= meta.totalPages`) would turn /search?page=2 into a
  // not-found even though the page it would render — the prompt — plainly exists and is
  // the primary content of this route. A stray ?page on an unsearched /search is a
  // harmless no-op, and the canonical above already stops it being an indexable
  // duplicate.
  if (searched && result !== null && current > 0 && current >= result.meta.totalPages) notFound()

  // Reading suggestions for the "no results" state, and ONLY that state: a page with results
  // or one where nobody has searched anything does not need it, so it is not asked. The post page block: "most read" (or "should read
  // first") and "newest", because those are the two ready-made answers to "not found, so what to read": no
  // new data source, only reusing the getDiscovery cache. It does not throw (each source catches its
  // errors); `.catch` is for itself, like on /writing: a failing secondary block only loses the block, it does not become a 500.
  //
  // Kept only when one of the two blocks that the `article` variant of DiscoveryGrid draws exists (getDiscovery
  // returns null for every empty block): `suggestions` being non-null means the suggestion block really shows, so the bottom
  // of the results section shrinks to match exactly that.
  const discovery =
    searched && result?.items.length === 0 ? await getDiscovery({ context: 'article', language: locale }).catch(() => null) : null
  const suggestions = discovery && (discovery.popular || discovery.recent) ? discovery : null

  /*
    The pager's base path, and the one thing on this page most likely to break silently.

    A pager built as basePath="/search" works perfectly on page one — the links read
    /search?page=1 and nothing looks wrong — and then every one of them lands on an
    unsearched /search showing the prompt. The query and every filter MUST be carried.

    Built with URLSearchParams (in `searchHref`) rather than string concatenation so the
    encoding is done once and correctly: a query of "a & b" or "c=d" or "100%" would each break a
    hand-built `?q=${query}&page=`. Pagination re-parses this string with
    URLSearchParams and sets `page` on it, which round-trips cleanly precisely because
    the value is properly encoded here (and because URLSearchParams never emits a bare
    '?' or '&' inside a value, so Pagination's own `basePath.split('?')` is safe).

    search/page.test.tsx asserts the actual hrefs, not just that a pager rendered.
  */
  const basePath = searchHref(query, filters)

  const noMatch = hasQuery
    ? t(filtered ? 'noMatch.withQueryAndFilters' : 'noMatch.withQuery', { query })
    : t('noMatch.filtersOnly')
  const retryKey = !filtered ? 'noMatch.retryKeyword' : hasQuery ? 'noMatch.retryKeywordOrFilters' : 'noMatch.retryFilters'
  const allPostsLink = (chunks: ReactNode) => (
    <Link
      href="/writing"
      className="text-brand underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
    >
      {chunks}
    </Link>
  )

  return (
    <>
      {/* No <main> here. app/layout.tsx owns the document's single
          `<main id="main-content">`; a second one makes the skip link ambiguous. */}
      <BrowseFrame>
        <header className="pb-2">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{t('heading')}</h1>
          {/* The form and its filters stay at a form's width: an input stretched over the whole column is wrong. The results below use the column. */}
          <div className="max-w-3xl">
            {/* `key` follows the URL (not `page`): Next keeps the React tree when only searchParams change, so after clicking a
            chip, the select that is already drawn still holds the filter just removed and the next click on "Search" applies it again. Changing the key redraws the form. */}
            <SearchForm key={basePath} q={query} autoFocus={!searched}>
              <SearchFilters filters={filters} options={options} open={!searched} />
            </SearchForm>
            <ActiveFilters query={query} filters={filters} options={options} />
          </div>
        </header>

        <section>
          {!searched ? (
            /*
            STATE 1 — nothing searched yet.

            Not an empty result list, and emphatically not "0 results": nobody has
            searched for anything, so a count of zero would be a false statement about
            a search that never happened. This is the state a reader sees after
            clicking the header's search icon, so it is the most-rendered of the four
            and the one that most needs to look intended rather than empty.
          */
            <p className="pt-4 text-neutral-700 dark:text-neutral-300">{t.rich('prompt', { link: allPostsLink })}</p>
          ) : busy ? (
            <p role="alert" className="pt-4 text-red-700 dark:text-red-300">
              {t('busy')}
            </p>
          ) : result === null ? (
            <p role="alert" className="pt-4 text-red-700 dark:text-red-300">
              {t('badRequest')}
            </p>
          ) : result.items.length === 0 ? (
            /*
            STATE 2 — a query (or filter) that matched nothing.

            The query is echoed back, because "no results" alone leaves the reader
            unsure whether the box even received what they typed.

            No more "check the diacritics again" advice: the backend searches with the diacritic-stripping configuration
            `vi_unaccent`, so a query without diacritics finds the accented word and typing without diacritics is not why the page is empty.

            STATE 4 OF THE ORIGINAL DESIGN COLLAPSES INTO THIS ONE, and that was verified
            against the running backend rather than assumed (first on the old `/posts/search`; since
            then the page calls `GET /api/v1/search`, where a query with no letter or digit
            is still an empty group on both engines: Postgres gets an empty tsquery, and the
            Meilisearch provider answers empty without calling the engine):

              curl "…/posts/search?q=%21%40%23%24%25%5E%26*%28%29"  (i.e. !@#$%^&*() )
                -> HTTP 200, {"data":[],"pagination":{…,"totalElements":0,…}}

            So a query the tsquery parser cannot use is a normal empty page, not an
            error envelope and not a 500. There is no fourth branch to write. Two more
            measurements from the same probe, for the record: "queue | kafka" answers 0
            while "queue" answers 6, so the terms are ANDed and `|` is matched as a
            literal rather than as an operator; and q=, q=%20%20 and a missing q all
            answer 200 with an empty page, which is why the page may skip the call for
            them without lying.

            The suggestion points at /writing rather than at a list of category links:
            one link reaches every category, and the filter panel above lists
            them too. The specific suggested posts are in the block
            "Suggested reading" right below this section (getDiscovery, already cached for the whole site).
          */
            <div className="pt-4">
              <p className="text-neutral-700 dark:text-neutral-300">{noMatch}</p>
              {result.degraded ? <DegradedNotice className="mt-1" /> : null}
              <p className="mt-3 text-neutral-600 dark:text-neutral-400">{t.rich(retryKey, { link: allPostsLink })}</p>
            </div>
          ) : (
            /*
            STATE 3 — matches.

            No heading above the list, deliberately, and for the same reason /writing
            has none: PostList's rows are <h2>, so a label here would be their SIBLING
            rather than their parent, and a screen-reader user navigating by heading
            would hear "Results" owning nothing. The count lives in a paragraph; the
            section's name is carried by the h1.

            `meta.totalElements`, not `items.length` — the former is the number of
            matches, the latter is how many fit on this page. On page 1 of 6 results
            they differ, and "10 results" on a six-page search is a lie that only shows
            up on the last page.

            The highlighted spots belong to the engine: the `Segment[]` of the title and description (which may be a body
            excerpt) through `highlights`; `query` is only the fallback when a row has no segment.
          */
            <>
              <p className="pt-4 text-sm text-neutral-600 dark:text-neutral-400">
                {hasQuery
                  ? t('count.withQuery', { count: result.meta.totalElements, query })
                  : t('count.filtersOnly', { count: result.meta.totalElements })}
              </p>
              {result.degraded ? <DegradedNotice className="mt-1" /> : null}
              <PostList posts={result.items} query={query} highlights={result.highlights} />
              <Pagination meta={result.meta} basePath={basePath} />
            </>
          )}
        </section>
      </BrowseFrame>

      {/* Outside the frame grid, after it, at frame width, like "What to read next" on the post page: DiscoveryGrid builds its own
          Container and is a named region of its own. null when every block is empty, so no heading stands alone (and the wrapper,
          which then has no child, is hidden by `empty:hidden`, so no lone rule is drawn). */}
      {suggestions ? (
        <div className="border-t border-neutral-200 empty:hidden dark:border-neutral-800 print:hidden">
          <DiscoveryGrid id="goi-y-doc" title={t('suggestionsTitle')} data={suggestions} variant="article" width="reader" />
        </div>
      ) : null}
    </>
  )
}
