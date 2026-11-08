/**
 * The site's UI glyph set: SVGs drawn on the server, no icon library at runtime.
 *
 * Why not `lucide-react`: its `Icon` is a `"use client"` module that calls
 * `useContext`, so every icon used from a Server Component becomes a client reference — its JS
 * ships to the browser, and each icon's path data is serialized into the RSC payload. The repo
 * convention is the opposite: inline SVG rendered on the server (ThemeToggle, the Header search box, CopyLink).
 * This file copies exactly the paths of the glyphs actually used, adding no dependency.
 *
 * Usage rules (design spec):
 * - Always `aria-hidden="true"` + `focusable="false"`: an icon never carries an accessible name.
 *   The name comes from the text next to it, or from an `sr-only` span.
 * - Not inside `<time>`, not on nav labels, titles, section headings or pagination
 *   arrows. One deliberate exception: the admin sidebar (app/admin/(shell)/AdminNav.tsx) puts an
 *   icon before each item label, following the Ghost style of the admin spec; the icon is still aria-hidden.
 * - The three existing hand-drawn glyphs (search, theme, copy) stay as they are, not replaced by this set.
 * - Do not set `display`: Tailwind's preflight makes `svg` `block`. Put the icon in an
 *   `inline-flex items-center gap-…` row like everywhere else on the site. `shrink-0` is always present, because
 *   next to a truncated title the icon is the first thing flex would squash.
 *
 * Stroke width is kept constant on screen, not on the grid. Lucide draws on a 24 grid with
 * stroke 2; the site's hand-drawn glyphs use a 16 grid, stroke 1.5 at 16px, i.e. 1.5px. To match:
 *   16px → 2.25 (2.25 × 16/24 = 1.5px, as the design spec requires)
 *   20px → 1.8  (1.5px: a bigger icon in the lightbox must not be bolder than the adjacent text)
 *   14px → 2.14 (≈1.25px: at the 12–14px meta text size, a 1.5px stroke crowds the text)
 *
 * ---------------------------------------------------------------------------------------
 * Path source: lucide-static 1.52.0 (https://lucide.dev), file `icons/<name>.svg` in the package,
 * body copied verbatim; only the attributes of the original <svg> tag are replaced by `Glyph`. Each
 * function names its original file. License, verbatim from the package's LICENSE:
 *
 *   ISC License
 *
 *   Copyright (c) 2026 Lucide Icons and Contributors
 *
 *   Permission to use, copy, modify, and/or distribute this software for any
 *   purpose with or without fee is hereby granted, provided that the above
 *   copyright notice and this permission notice appear in all copies.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 *   WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 *   MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 *   ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 *   WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 *   ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 *   OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 *
 * Per the same LICENSE file, the following icons originate from the Feather project and are also under the
 * MIT license below: arrow-down, arrow-up, arrow-up-right, bell, check, chevron-left, chevron-right,
 * circle-alert (formerly alert-circle), clock, link, log-out, plus, rss, search, trash-2,
 * upload, x.
 *
 *   The MIT License (MIT)
 *
 *   Copyright (c) 2013-present Cole Bemis
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *   SOFTWARE.
 * ---------------------------------------------------------------------------------------
 */
import type { ReactNode } from 'react'

export type IconSize = 14 | 16 | 20

export type IconProps = {
  /** Icon edge length, px. Default 16. */
  size?: IconSize
  /** Extra classes, usually the color (`text-neutral-400 dark:text-neutral-500`). */
  className?: string
}

/** Written out verbatim so Tailwind's scanner sees it: a class assembled from strings would not get CSS generated. */
const SIZE_CLASS: Record<IconSize, string> = {
  14: 'h-3.5 w-3.5',
  16: 'h-4 w-4',
  20: 'h-5 w-5',
}

/** Stroke on the 24 grid for each size; see the "Stroke width" section at the top of the file. */
const STROKE_WIDTH: Record<IconSize, number> = {
  14: 2.14,
  16: 2.25,
  20: 1.8,
}

/**
 * Classes of an icon of size `size`: dimensions, `shrink-0`, then the caller's classes. Exported for
 * BrandIcon, so the two icon sets share one size scale instead of two copies.
 */
export function iconClassName(size: IconSize, className?: string): string {
  return className ? `${SIZE_CLASS[size]} shrink-0 ${className}` : `${SIZE_CLASS[size]} shrink-0`
}

/**
 * The shared <svg> tag. `width`/`height` repeat the size of the CSS classes: if the stylesheet fails to
 * load, an SVG without these two attributes would stretch to 300×150 or the full width.
 */
function Glyph({ size = 16, className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE_WIDTH[size]}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={iconClassName(size, className)}
    >
      {children}
    </svg>
  )
}

/** lucide `calendar-days` */
export function CalendarDaysIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M8 2v3" />
      <path d="M16 2v3" />
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18" />
      <path d="M8 13h.01" />
      <path d="M12 13h.01" />
      <path d="M16 13h.01" />
      <path d="M8 17h.01" />
      <path d="M12 17h.01" />
      <path d="M16 17h.01" />
    </Glyph>
  )
}

/** lucide `clock` */
export function ClockIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </Glyph>
  )
}

/** lucide `folder` */
export function FolderIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </Glyph>
  )
}

/** lucide `tag` */
export function TagIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />
      <circle cx="7.5" cy="7.5" r=".5" fill="currentColor" />
    </Glyph>
  )
}

/** lucide `tags` */
export function TagsIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M13.172 2a2 2 0 0 1 1.414.586l6.71 6.71a2.4 2.4 0 0 1 0 3.408l-4.592 4.592a2.4 2.4 0 0 1-3.408 0l-6.71-6.71A2 2 0 0 1 6 9.172V3a1 1 0 0 1 1-1z" />
      <path d="M2 7v6.172a2 2 0 0 0 .586 1.414l6.71 6.71a2.4 2.4 0 0 0 3.191.193" />
      <circle cx="10.5" cy="6.5" r=".5" fill="currentColor" />
    </Glyph>
  )
}

/** lucide `layers` */
export function LayersIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z" />
      <path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12" />
      <path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17" />
    </Glyph>
  )
}

/** lucide `eye` */
export function EyeIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <circle cx="12" cy="12" r="3" />
    </Glyph>
  )
}

/** lucide `trending-up` */
export function TrendingUpIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M16 7h6v6" />
      <path d="m22 7-8.5 8.5-5-5L2 17" />
    </Glyph>
  )
}

/** lucide `star` */
export function StarIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z" />
    </Glyph>
  )
}

/** lucide `archive` */
export function ArchiveIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect width="20" height="5" x="2" y="3" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
    </Glyph>
  )
}

/** lucide `shuffle` */
export function ShuffleIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="m18 14 4 4-4 4" />
      <path d="m18 2 4 4-4 4" />
      <path d="M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22" />
      <path d="M2 6h1.972a4 4 0 0 1 3.6 2.2" />
      <path d="M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45" />
    </Glyph>
  )
}

/** lucide `rss` */
export function RssIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M4 11a9 9 0 0 1 9 9" />
      <path d="M4 4a16 16 0 0 1 16 16" />
      <circle cx="5" cy="19" r="1" />
    </Glyph>
  )
}

/** lucide `mail` */
export function MailIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7" />
      <rect x="2" y="4" width="20" height="16" rx="2" />
    </Glyph>
  )
}

/** lucide `link` */
export function LinkIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </Glyph>
  )
}

/** lucide `arrow-up-right` */
export function ArrowUpRightIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M7 7h10v10" />
      <path d="M7 17 17 7" />
    </Glyph>
  )
}

/** lucide `list` */
export function ListIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M3 5h.01" />
      <path d="M3 12h.01" />
      <path d="M3 19h.01" />
      <path d="M8 5h13" />
      <path d="M8 12h13" />
      <path d="M8 19h13" />
    </Glyph>
  )
}

/** lucide `share-2` */
export function Share2Icon(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" x2="15.42" y1="13.51" y2="17.49" />
      <line x1="15.41" x2="8.59" y1="6.51" y2="10.49" />
    </Glyph>
  )
}

/** lucide `x` */
export function XIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Glyph>
  )
}

/** lucide `chevron-left` */
export function ChevronLeftIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="m15 18-6-6 6-6" />
    </Glyph>
  )
}

/** lucide `chevron-right` */
export function ChevronRightIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="m9 18 6-6-6-6" />
    </Glyph>
  )
}

/** lucide `graduation-cap` */
export function GraduationCapIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z" />
      <path d="M22 10v6" />
      <path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5" />
    </Glyph>
  )
}

/** lucide `briefcase` */
export function BriefcaseIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
      <rect width="20" height="14" x="2" y="6" rx="2" />
    </Glyph>
  )
}

/** lucide `user` */
export function UserIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </Glyph>
  )
}

/** lucide `images` */
export function ImagesIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="m22 11-1.296-1.296a2.4 2.4 0 0 0-3.408 0L11 16" />
      <path d="M4 8a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2" />
      <circle cx="13" cy="7" r="1" fill="currentColor" />
      <rect x="8" y="2" width="14" height="14" rx="2" />
    </Glyph>
  )
}

/** lucide `pen-line` */
export function PenLineIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M13 21h8" />
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
    </Glyph>
  )
}

/** lucide `upload` */
export function UploadIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M12 3v12" />
      <path d="m17 8-5-5-5 5" />
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    </Glyph>
  )
}

/** lucide `image-plus` */
export function ImagePlusIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M16 5h6" />
      <path d="M19 2v6" />
      <path d="M21 11.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7.5" />
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
      <circle cx="9" cy="9" r="2" />
    </Glyph>
  )
}

/** lucide `trash-2` */
export function Trash2Icon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </Glyph>
  )
}

/** lucide `arrow-up` */
export function ArrowUpIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="m5 12 7-7 7 7" />
      <path d="M12 19V5" />
    </Glyph>
  )
}

/** lucide `arrow-down` */
export function ArrowDownIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M12 5v14" />
      <path d="m19 12-7 7-7-7" />
    </Glyph>
  )
}

/** lucide `newspaper` */
export function NewspaperIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M15 18h-5" />
      <path d="M18 14h-8" />
      <path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-4 0v-9a2 2 0 0 1 2-2h2" />
      <rect width="8" height="4" x="10" y="6" rx="1" />
    </Glyph>
  )
}

/* The six glyphs below are for admin: saved feedback,
   mobile menu button, post search box, create button, sign-out, error frame. Same source, same copy method. */

/** lucide `check` */
export function CheckIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M20 6 9 17l-5-5" />
    </Glyph>
  )
}

/** lucide `menu` */
export function MenuIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M4 5h16" />
      <path d="M4 12h16" />
      <path d="M4 19h16" />
    </Glyph>
  )
}

/** lucide `search` */
export function SearchIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="m21 21-4.34-4.34" />
      <circle cx="11" cy="11" r="8" />
    </Glyph>
  )
}

/** lucide `plus` */
export function PlusIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </Glyph>
  )
}

/** lucide `log-out` */
export function LogOutIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    </Glyph>
  )
}

/** lucide `shield`: the Security item of the admin sidebar. */
export function ShieldIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    </Glyph>
  )
}

/** lucide `circle-alert` */
export function CircleAlertIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" x2="12" y1="8" y2="12" />
      <line x1="12" x2="12.01" y1="16" y2="16" />
    </Glyph>
  )
}

/* The three glyphs below: the post like button, the comments item and the users
   item of admin. Same lucide-static 1.52.0 source, same copy method; none of the three has a Feather origin. */

/**
 * lucide `heart`. `filled`: solid fill with `currentColor` (liked), exactly the same path. Only the path's
 * `fill` attribute changes; the <svg> tag stays `fill="none"` like every other glyph in the file.
 */
export function HeartIcon({ filled = false, ...props }: IconProps & { filled?: boolean }) {
  return (
    <Glyph {...props}>
      <path
        d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"
        fill={filled ? 'currentColor' : undefined}
      />
    </Glyph>
  )
}

/** lucide `message-square` */
export function MessageSquareIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" />
    </Glyph>
  )
}

/** lucide `users` */
export function UsersIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <path d="M16 3.128a4 4 0 0 1 0 7.744" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <circle cx="9" cy="7" r="4" />
    </Glyph>
  )
}

/** lucide `sliders-horizontal` */
export function SlidersIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M10 5H3" />
      <path d="M12 19H3" />
      <path d="M14 3v4" />
      <path d="M16 17v4" />
      <path d="M21 12h-9" />
      <path d="M21 19h-5" />
      <path d="M21 5h-7" />
      <path d="M8 10v4" />
      <path d="M8 12H3" />
    </Glyph>
  )
}

/* Glyph for notifications: the notification bell in the header. Same source
   lucide-static 1.52.0, same copy method; `bell` has a Feather origin (MIT notice at the top of the file). */

/** lucide `bell` */
export function BellIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M10.268 21a2 2 0 0 0 3.464 0" />
      <path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />
    </Glyph>
  )
}

/* Glyph: the copy-code button on each code block (components/site/CopyCodeButton.tsx), switches
   to CheckIcon once copied. Same source lucide-static 1.52.0, same copy method; `copy` has no
   Feather origin (not in the LICENSE list), so only the ISC license at the top of the file applies. It does not replace the
   hand-drawn link glyph of CopyLink: that one is "copy link", this glyph is "copy content". */

/** lucide `copy` */
export function CopyIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </Glyph>
  )
}

/* Glyph: the post save button next to the like button, and the /bookmarks page. Same source lucide-static 1.52.0, same
   copy method; `bookmark` is not in the Feather list of the LICENSE, so only the ISC license applies. */

/** lucide `bookmark`. `filled`: solid fill with `currentColor` (saved), like HeartIcon. */
export function BookmarkIcon({ filled = false, ...props }: IconProps & { filled?: boolean }) {
  return (
    <Glyph {...props}>
      <path
        d="M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z"
        fill={filled ? 'currentColor' : undefined}
      />
    </Glyph>
  )
}
