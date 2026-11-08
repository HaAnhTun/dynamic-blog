'use client'

import Image from 'next/image'
import { useLocale } from 'next-intl'
import { useState } from 'react'
import { DEFAULT_LOCALE, type Locale } from '@/i18n/config'
import { asLocale, graphemeSegmenter, upperCase } from '@/lib/format'

/**
 * Avatar of a reader account: in the account button on the header,
 * the /profile page, and later in comments.
 *
 * - `<Image unoptimized>`: the image goes straight from GitHub to the browser, not through `/_next/image`, so
 *   `images` in next.config.ts needs no `remotePatterns`.
 * - Only the host `avatars.githubusercontent.com` over https is loaded. The backend already filters exactly so
 *   when storing (`GithubProfile.avatarUrl`); it is checked again here so a foreign URL that slips through does not become a
 *   tracking image on every page that person appears on.
 * - No image, a foreign URL, or an image that fails to load: the initial letter of the name in a circle.
 * - Always decorative (`alt=""`, initial letter `aria-hidden`): the person's name always sits next to it or
 *   is inside the accessible name of the button containing it, reading it once more is redundant.
 */

const AVATAR_ORIGIN = 'https://avatars.githubusercontent.com/'

export type AvatarSize = 28 | 32 | 64

/** Written out verbatim so Tailwind sees it: a class assembled from strings would not get its CSS generated. */
const SIZE_CLASS: Record<AvatarSize, string> = {
  28: 'h-7 w-7 text-xs',
  32: 'h-8 w-8 text-sm',
  64: 'h-16 w-16 text-2xl',
}

function isAllowedSrc(src: string | null): src is string {
  return src !== null && src.startsWith(AVATAR_ORIGIN)
}

/**
 * One size for every place: GitHub is asked for a 128 px image.
 *
 * Without `s`, avatars.githubusercontent.com returns the image at its original size, a few hundred px, for a place that shows 28 px.
 * One fixed size instead of a size per place (header 28, comment 28
 * or 32, profile 64): each person has a single URL, so the browser downloads the image once and reuses it in every
 * place. 128 is sharp enough for the largest place, 64 px, on a 2x screen.
 *
 * `set` rather than `append`: an existing `s` is replaced, not repeated; `v` (image version) and any other
 * parameter are kept. Only called after `isAllowedSrc`: the host is fixed by the prefix, the rest is a path
 * and query, which the URL parser never rejects, so `new URL` here does not throw.
 */
const GITHUB_AVATAR_PIXELS = '128'

function sizedSrc(src: string): string {
  const url = new URL(src)
  url.searchParams.set('s', GITHUB_AVATAR_PIXELS)
  return url.href
}

/**
 * The initial letter of the name, uppercased: one grapheme, not one code unit — a decomposed letter (e plus
 * two combining marks) or an emoji joined with ZWJ is still one whole glyph. Without Segmenter it
 * takes the first code point after NFC (enough for every Vietnamese letter). An empty name gives "?".
 * `graphemeSegmenter` is null where `Intl.Segmenter` is missing (Firefox before 125).
 */
export function initialOf(
  name: string,
  segmenter: Intl.Segmenter | null = graphemeSegmenter(DEFAULT_LOCALE),
  locale: Locale = DEFAULT_LOCALE,
): string {
  const text = name.normalize('NFC').trim()
  const first = segmenter ? segmenter.segment(text)[Symbol.iterator]().next().value?.segment : Array.from(text)[0]
  return first ? upperCase(first, locale) : '?'
}

export function Avatar({
  name,
  src,
  size = 28,
  className = '',
}: {
  /** Display name, only used to take the initial letter when there is no image. */
  name: string
  src: string | null
  size?: AvatarSize
  className?: string
}) {
  // Remember the URL that failed rather than a boolean flag: switching to another person (a different src) tries loading again. Remembered by the
  // original URL of that person, not by the URL with the size added: the comparison just below is against the original `src`.
  const locale = asLocale(useLocale())
  const [failedSrc, setFailedSrc] = useState<string | null>(null)

  if (isAllowedSrc(src) && src !== failedSrc) {
    return (
      <Image
        src={sizedSrc(src)}
        alt=""
        width={size}
        height={size}
        unoptimized
        onError={() => setFailedSrc(src)}
        className={`${SIZE_CLASS[size]} shrink-0 rounded-full bg-neutral-100 object-cover dark:bg-neutral-800 ${className}`.trim()}
      />
    )
  }

  return (
    <span
      aria-hidden="true"
      className={`${SIZE_CLASS[size]} inline-flex shrink-0 select-none items-center justify-center rounded-full bg-neutral-200 font-semibold text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 ${className}`.trim()}
    >
      {initialOf(name, graphemeSegmenter(locale), locale)}
    </span>
  )
}
