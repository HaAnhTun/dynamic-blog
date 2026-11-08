'use client'

import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ComponentType } from 'react'
import AdminLanguageSwitcher from '@/components/admin/AdminLanguageSwitcher'
import { button } from '@/components/admin/ui'
import {
  ArrowUpRightIcon,
  ImagesIcon,
  type IconProps,
  LayersIcon,
  MailIcon,
  MessageSquareIcon,
  NewspaperIcon,
  PenLineIcon,
  ShieldIcon,
  SlidersIcon,
  StarIcon,
  TagsIcon,
  TrendingUpIcon,
  UsersIcon,
} from '@/components/icons'
import LogoutButton from './LogoutButton'

export type AdminSection = {
  href: string
  /** Key of the label in `Admin.shell.nav`. */
  labelKey: string
  /** Path segment this item owns, if different from `href`. "Posts" lives at /admin but
   *  the post edit pages live under /admin/posts. */
  prefix?: string
  icon: ComponentType<IconProps>
  /** Only ADMIN sees this item; the backend still rejects AUTHOR on every such page. */
  adminOnly?: boolean
}

/**
 * The management items: the four base items, plus "Topics" (categories & tags) right after
 * "Posts" — they are properties of the post, like Tags after Posts in Ghost. Last come the two
 * reader items: "Comments" (moderation) and "Users" (suspension); content work first, reader
 * work after. Each item has an icon before the label, like Ghost's sidebar: a deliberate exception
 * to the "no icon on nav labels" rule (noted in components/icons.tsx), for the admin sidebar only.
 * The icon stays aria-hidden, the name is text. "Analytics" right after "Posts" (AUTHOR sees it
 * too, only their own posts), "Newsletter" (readers, ADMIN only), then "Contact" (the contact-form inbox, ADMIN only).
 * Newsletter and Contact share the mail glyph: the icon set is a closed inventory (icons.test.tsx). "Security" is for AUTHOR too, between
 * Contact and Settings: it is the one place a signed-in account manages its own sign-in.
 */
export const adminSections: readonly AdminSection[] = [
  { href: '/admin', labelKey: 'posts', prefix: '/admin/posts', icon: NewspaperIcon },
  { href: '/admin/analytics', labelKey: 'analytics', icon: TrendingUpIcon },
  { href: '/admin/topics', labelKey: 'topics', icon: TagsIcon, adminOnly: true },
  { href: '/admin/series', labelKey: 'series', icon: LayersIcon, adminOnly: true },
  { href: '/admin/curated', labelKey: 'curated', icon: StarIcon, adminOnly: true },
  { href: '/admin/gallery', labelKey: 'gallery', icon: ImagesIcon, adminOnly: true },
  { href: '/admin/comments', labelKey: 'comments', icon: MessageSquareIcon, adminOnly: true },
  { href: '/admin/users', labelKey: 'users', icon: UsersIcon, adminOnly: true },
  { href: '/admin/applications', labelKey: 'applications', icon: PenLineIcon, adminOnly: true },
  { href: '/admin/newsletter', labelKey: 'newsletter', icon: MailIcon, adminOnly: true },
  { href: '/admin/contact', labelKey: 'contact', icon: MailIcon, adminOnly: true },
  // Security (two-step verification, password, sign out everywhere) is for every account that can open the admin area.
  { href: '/admin/security', labelKey: 'security', icon: ShieldIcon },
  { href: '/admin/settings', labelKey: 'settings', icon: SlidersIcon, adminOnly: true },
]

/** The items a role sees: ADMIN sees all; AUTHOR (or an unknown role) sees only their own posts. */
export function sectionsFor(role: string | null): AdminSection[] {
  if (role === 'ADMIN') return [...adminSections]
  return adminSections
    .filter((item) => !item.adminOnly)
    .map((item) => (item.href === '/admin' ? { ...item, labelKey: 'myPosts' } : item))
}

const NEW_POST = '/admin/posts/new'

/**
 * `/admin` matches exactly, not by prefix: every admin URL starts with /admin, so prefix matching
 * would light up "Posts" on every page. The other prefixes match by segment
 * (`=== p || startsWith(p + '/')`), so /admin/series-cu does not light up "Series".
 *
 * The new-post page lives under /admin/posts but already has its own link, "Write a post"; it gets
 * aria-current, and no other item does, so two links never both say "this is the current page".
 * (The editor page currently has no sidebar, see AdminSidebar; the rule is kept so it is right everywhere.)
 */
export function isCurrentAdminSection(pathname: string, item: AdminSection): boolean {
  if (pathname === item.href) return true
  if (pathname === NEW_POST) return false
  const prefix = item.prefix ?? item.href
  if (prefix === '/admin') return false
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

/** One sidebar item. Taller on phones (36px) because it is a touch target in the dropdown menu. */
const ITEM =
  'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors duration-150 motion-reduce:transition-none lg:py-1.5 focus-visible:outline-2 focus-visible:outline-offset-2 outline-brand'
const ITEM_IDLE = 'text-slate-600 hover:bg-slate-200/60 hover:text-slate-900'
const ITEM_CURRENT = 'bg-slate-200/70 text-slate-900'

export default function AdminNav({
  role,
  id,
  open = true,
  onNavigate,
}: {
  role: string | null
  id?: string
  /**
   * Only meaningful below `lg`: whether the phone dropdown menu is open or closed (AdminSidebar holds
   * the state). From `lg` the sidebar is always visible. Open by default, so the nav stands on its own.
   */
  open?: boolean
  /** Called when a link is pressed: the phone menu closes once a choice is made. */
  onNavigate?: () => void
}) {
  const t = useTranslations('Admin.shell')
  // '' on the first render in some environments; same as the public Header.
  const pathname = usePathname() ?? '/admin'

  return (
    // One <nav> for both layouts: sidebar from lg, dropdown menu below lg. There is no second copy
    // for phones, so there is exactly one "Admin" region in the accessibility tree at every width.
    <nav id={id} aria-label={t('navLabel')} className={`${open ? 'flex' : 'hidden'} mt-4 flex-1 flex-col gap-6 lg:mt-8 lg:flex`}>
      <ul aria-label={t('sectionsLabel')} className="flex flex-col gap-0.5">
        {sectionsFor(role).map((item) => {
          const current = isCurrentAdminSection(pathname, item)
          const Icon = item.icon
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                // undefined removes the attribute entirely; aria-current="false" is a present string.
                aria-current={current ? 'page' : undefined}
                onClick={onNavigate}
                className={`${ITEM} ${current ? ITEM_CURRENT : ITEM_IDLE}`}
              >
                <Icon className={current ? 'text-slate-900' : 'text-slate-500'} />
                {t(`nav.${item.labelKey}`)}
              </Link>
            </li>
          )
        })}
      </ul>

      <div className="flex flex-col gap-1">
        {/* The main job of the whole admin, so the only solid button in the sidebar. */}
        <Link
          href={NEW_POST}
          aria-current={pathname === NEW_POST ? 'page' : undefined}
          onClick={onNavigate}
          className={button('primary', 'md', 'w-full justify-start px-2.5')}
        >
          <PenLineIcon />
          {t('newPost')}
        </Link>
        <Link href="/" onClick={onNavigate} className={`${ITEM} ${ITEM_IDLE}`}>
          <ArrowUpRightIcon className="text-slate-500" />
          {t('viewBlog')}
        </Link>
      </div>

      <AdminLanguageSwitcher className="mt-auto lg:px-1" />

      <div className="flex items-center justify-between gap-3 border-t border-slate-200 pt-4 lg:px-1">
        {role !== null ? (
          <p className="min-w-0 text-[13px] text-slate-500">
            {t.rich('role', { role, strong: (chunks) => <span className="font-medium text-slate-700">{chunks}</span> })}
          </p>
        ) : (
          <span />
        )}
        <LogoutButton />
      </div>
    </nav>
  )
}
