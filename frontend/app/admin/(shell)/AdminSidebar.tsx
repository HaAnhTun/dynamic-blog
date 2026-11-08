'use client'

import { useTranslations } from 'next-intl'
import { usePathname } from 'next/navigation'
import { useId, useRef, useState } from 'react'
import { MenuIcon, XIcon } from '@/components/icons'
import AdminNav from './AdminNav'

/**
 * Pages without a sidebar, taking the full width:
 * - the post editor (new and edit), like Ghost's editor: it needs room for the writing area and the settings column;
 * - the full-page preview of a post: the post must be at the blog's reading width, not squeezed by
 *   the sidebar's 15rem column.
 * Both have their own top bar with a "Posts" link to go back.
 *
 * Matched by path segment, not by prefix: /admin/posts/x/edit/thua is not an editor page.
 */
export function isFullWidthRoute(pathname: string): boolean {
  return pathname === '/admin/posts/new' || /^\/admin\/posts\/[^/]+\/(edit|preview)$/.test(pathname)
}

/**
 * Admin navigation frame: site name, then nav. From `lg` it is a fixed left sidebar of full screen height;
 * below `lg` it is a sticky top bar with a "Menu" button that opens/closes the nav right below it.
 *
 * A disclosure rather than a modal drawer: the nav stays a block in the page, no focus trap, no
 * scroll lock; opening pushes the content down. Fewer states than a dialog for a screen only the
 * site owner uses, and Escape still closes it. Pressing a link closes the menu.
 */
export default function AdminSidebar({ siteName, role }: { siteName: string; role: string | null }) {
  const t = useTranslations('Admin.shell')
  const pathname = usePathname() ?? '/admin'
  const navId = useId()
  const [open, setOpen] = useState(false)
  const toggle = useRef<HTMLButtonElement>(null)

  if (isFullWidthRoute(pathname)) return null

  return (
    <header
      className="sticky top-0 z-30 border-b border-slate-200 bg-slate-50/95 backdrop-blur-sm lg:h-dvh lg:w-60 lg:shrink-0 lg:self-start lg:border-r lg:border-b-0 lg:bg-slate-50 lg:backdrop-blur-none"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          setOpen(false)
          toggle.current?.focus()
        }
      }}
    >
      <div className="flex h-full flex-col px-4 py-2.5 lg:overflow-y-auto lg:px-3 lg:py-5">
        <div className="flex items-center justify-between gap-3 lg:px-2.5">
          {/* Not a link: "Posts" in the nav already is the way back to the admin home. */}
          <p className="min-w-0 leading-tight">
            <span className="block truncate text-sm font-semibold text-slate-900">{siteName}</span>
            <span className="block text-[13px] text-slate-500">{t('subtitle')}</span>
          </p>
          <button
            ref={toggle}
            type="button"
            aria-expanded={open}
            aria-controls={navId}
            onClick={() => setOpen((current) => !current)}
            className="-mr-1.5 inline-flex h-9 items-center gap-2 rounded-md px-2.5 text-sm font-medium text-slate-700 transition-colors duration-150 motion-reduce:transition-none hover:bg-slate-200/60 focus-visible:outline-2 focus-visible:outline-offset-2 outline-brand lg:hidden"
          >
            {open ? <XIcon /> : <MenuIcon />}
            {t('menu')}
          </button>
        </div>
        <AdminNav id={navId} role={role} open={open} onNavigate={() => setOpen(false)} />
      </div>
    </header>
  )
}
