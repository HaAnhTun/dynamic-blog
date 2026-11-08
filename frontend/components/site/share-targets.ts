import type { BrandName } from '@/components/BrandIcon'

export type ShareTarget = { brand: BrandName; label: string; href: (url: string, title: string) => string }

/**
 * The three fixed share destinations, shared by the share icon row of the right column (ShareBar) and the Share menu of the
 * hero (ShareMenu), so both produce identical URLs. Each URL is the platform's public share page, receiving
 * the post address through the query string; no SDK, no third-party script, nothing runs before
 * the reader clicks. X additionally receives the title as the text of the post; Facebook and LinkedIn read og:* themselves.
 *
 * A plain module (no 'use client', no JSX) so a server component and a client island can both import it.
 */
export const SHARE_TARGETS: readonly ShareTarget[] = [
  {
    brand: 'facebook',
    label: 'Facebook',
    href: (url) => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`,
  },
  {
    brand: 'linkedin',
    label: 'LinkedIn',
    href: (url) => `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`,
  },
  {
    brand: 'x',
    label: 'X',
    href: (url, title) => `https://x.com/intent/post?url=${encodeURIComponent(url)}&text=${encodeURIComponent(title)}`,
  },
]
