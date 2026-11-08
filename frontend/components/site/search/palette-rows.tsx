import type { ReactNode } from 'react'
import {
  ArchiveIcon,
  BookmarkIcon,
  BriefcaseIcon,
  ClockIcon,
  FolderIcon,
  ImagesIcon,
  LayersIcon,
  MailIcon,
  NewspaperIcon,
  PenLineIcon,
  SearchIcon,
  StarIcon,
  TagIcon,
  TagsIcon,
  TrendingUpIcon,
  UserIcon,
} from '@/components/icons'
import { highlightSegments, matchesQuery } from '@/lib/highlight'
import type { Locale } from '@/i18n/config'
import type { Translator } from '@/i18n/translator'
import type { ItemMeta, PopularItem, SearchGroup, SearchType, Segment } from '@/lib/search-contract'
import { GROUP_LABEL_KEYS } from '@/lib/search-contract'
import type { SitePage } from '@/lib/site-pages'

/** One selectable row of the panel: always a real link (Ctrl/⌘-click opens a new tab, no router needed). */
export type PaletteRow = {
  key: string
  href: string
  /** The post's own language, when the row is a post: the link goes under that prefix. */
  locale?: Locale
  kind: 'nav' | 'popular' | 'recent' | 'result' | 'all'
  icon: ReactNode
  title: Segment[]
  description?: Segment[]
  meta?: ItemMeta
  /** A recent-search row: a plain click refills the query, no navigation. */
  recentQuery?: string
  avatarUrl?: string | null
}

export type PaletteSection = { id: string; label: string | null; rows: PaletteRow[] }

const plain = (text: string): Segment[] => [{ text, match: false }]

/** The icon by page, chosen the same way WritingSectionNav chooses for the indexes of the writing section. */
const PAGE_ICONS: Record<string, ReactNode> = {
  '/writing': <NewspaperIcon />,
  '/start-here': <StarIcon />,
  '/case-studies': <BriefcaseIcon />,
  '/about': <UserIcon />,
  '/topics': <TagsIcon />,
  '/archive': <ArchiveIcon />,
  '/series': <LayersIcon />,
  '/gallery': <ImagesIcon />,
  '/newsletter': <MailIcon />,
}

const TYPE_ICONS: Record<SearchType, ReactNode> = {
  post: <PenLineIcon />,
  topic: <FolderIcon />,
  series: <LayersIcon />,
  'case-study': <BriefcaseIcon />,
  author: <UserIcon />,
  page: <NewspaperIcon />,
}

/**
 * The state before typing (or after just one character): quick navigation from `sitePages` (the single source,
 * including `navItems`), one character filters locally by prefix, no network call; then saved posts once
 * signed in, most-read (only when real view counts pass a threshold) and recent searches (on the device only).
 * `pages` is the translated `sitePages(...)`; `t` is the translator of `Site.palette`.
 */
export function initialSections(
  query: string,
  options: { signedIn: boolean; popular: PopularItem[]; recent: string[]; pages: readonly SitePage[] },
  t: Translator,
): PaletteSection[] {
  const typed = query.trim()
  const nav: PaletteRow[] = options.pages
    .filter((page) => typed === '' || matchesQuery(page.title, typed, { prefix: true }))
    .map((page) => ({
      key: `nav:${page.href}`,
      href: page.href,
      kind: 'nav',
      icon: PAGE_ICONS[page.href] ?? <NewspaperIcon />,
      title: typed === '' ? plain(page.title) : highlightSegments(page.title, typed, { prefix: true }),
      description: plain(page.description),
    }))
  if (typed === '' && options.signedIn) {
    nav.push({
      key: 'nav:/bookmarks',
      href: '/bookmarks',
      kind: 'nav',
      icon: <BookmarkIcon />,
      title: plain(t('bookmarks.title')),
      description: plain(t('bookmarks.description')),
    })
  }

  const sections: PaletteSection[] = [{ id: 'nav', label: t('sections.nav'), rows: nav }]
  if (typed === '' && options.popular.length > 0) {
    sections.push({
      id: 'popular',
      label: t('sections.popular'),
      rows: options.popular.map((item) => ({
        key: item.id,
        href: item.href,
        locale: item.locale,
        kind: 'popular',
        icon: <TrendingUpIcon />,
        title: plain(item.title),
      })),
    })
  }
  if (typed === '' && options.recent.length > 0) {
    sections.push({
      id: 'recent',
      label: t('sections.recent'),
      rows: options.recent.map((recent) => ({
        key: `recent:${recent}`,
        href: `/search?${new URLSearchParams({ q: recent })}`,
        kind: 'recent',
        icon: <ClockIcon />,
        title: plain(recent),
        recentQuery: recent,
      })),
    })
  }
  return sections.filter((section) => section.rows.length > 0)
}

export function resultSections(groups: SearchGroup[], t: Translator): PaletteSection[] {
  return groups.map((group) => ({
    id: group.type,
    label: t(GROUP_LABEL_KEYS[group.type]),
    rows: group.items.map((item) => ({
      key: item.id,
      href: item.href,
      locale: item.locale,
      kind: 'result',
      icon:
        item.meta?.kind === 'tag' ? (
          <TagIcon />
        ) : group.type === 'page' ? (
          (PAGE_ICONS[item.href] ?? TYPE_ICONS.page)
        ) : (
          TYPE_ICONS[group.type]
        ),
      title: item.title,
      description: item.description,
      meta: item.meta,
      avatarUrl: item.meta?.kind === 'author' ? item.meta.avatarUrl : undefined,
    })),
  }))
}

export function allResultsRow(query: string, href: string, t: Translator): PaletteRow {
  return { key: 'all', href, kind: 'all', icon: <SearchIcon />, title: plain(t('allResults', { query })) }
}
