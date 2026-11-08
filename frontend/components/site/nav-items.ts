export type NavItem = {
  href: string
  /** Key in the `Site.nav` message namespace. */
  labelKey: string
  /**
   * Extra path prefixes that belong to this section. `/posts/<slug>` is a reader
   * arriving at an article, which is the writing section even though the URL does not
   * start with /writing.
   */
  readonly owns?: readonly string[]
}

/**
 * Four, which is the cap the brief sets — and the cap is the point: a fifth link is a
 * decision about information architecture, not a one-line addition.
 *
 * The fourth slot was the projects item and was emptied together with the portfolio section it
 * pointed at (commit f26ef8f, a privacy decision about work that was not the author's
 * own). 'Case study' is not that section coming back: it points at /case-studies, which
 * carries only projects the author owns outright, and the old /projects path stays gone.
 *
 * Nav rather than footer-only, because a portfolio whose single piece of project
 * evidence is reachable only from the page bottom is a portfolio that hid it.
 *
 * The featured-posts item took the slot the home item held. It is the second item on
 * the reference site's menu, and adding it as a fifth would have broken both the cap and
 * the single row on a 320px phone. Home did not need the slot: the site name beside the
 * nav already links to '/', and it carries `aria-current` there instead.
 *
 * What each section owns is every route a reader reaches from inside it: the writing section is all
 * the ways of browsing the writing (one post, a series, the topic and archive indexes, a
 * tag or category listing); the gallery is part of the author's profile, so it sits under
 * the About section. /search belongs to no section, and marks none.
 */
export const navItems: readonly NavItem[] = [
  {
    href: '/writing',
    labelKey: 'writing',
    owns: ['/posts', '/series', '/topics', '/archive', '/tags', '/categories'],
  },
  { href: '/start-here', labelKey: 'startHere' },
  { href: '/case-studies', labelKey: 'caseStudies' },
  { href: '/about', labelKey: 'about', owns: ['/gallery'] },
]
