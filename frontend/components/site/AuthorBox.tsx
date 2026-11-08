import Image from 'next/image'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import type { ReactNode } from 'react'
import { BrandIcon } from '@/components/BrandIcon'
import { MailIcon, RssIcon, UserIcon } from '@/components/icons'
import type { Contact, Profile } from '@/lib/site-content-types'
import { profileHref } from '@/lib/profile'
import { FEED_PATH } from '@/lib/site'
import type { PostAuthor } from '@/lib/types'
import { githubProfileUrl, otherAuthor } from './ArticleJsonLd'
import { Avatar } from './Avatar'
import { githubUrl } from './ContactSection'
import { INLINE_LINK, TITLE_LINK } from './SectionHeading'

const HEADING_ID = 'tac-gia'

/** A text link with a leading icon, like the contact row of ContactSection. */
const ICON_LINK = `inline-flex items-center gap-2 ${INLINE_LINK} max-sm:py-3`

/** A plain text link of the box: a 44px row on a phone (an inline-block, not a flex box: a flex box would swallow the space before the arrow). */
const TEXT_LINK = `${INLINE_LINK} max-sm:inline-block max-sm:py-3`

const PANEL = 'rounded-card border border-neutral-200 bg-neutral-50 p-5 sm:p-8 dark:border-neutral-800 dark:bg-neutral-900'

/**
 * The links of the box. Below `sm` a two-column grid of 44px rows (the long "first time here" link takes a whole row; `grid-flow-dense`
 * lets the short ones fill the hole beside it), from `sm` the wrapping row of text links it always was.
 */
const LINKS = 'mt-3 grid grid-flow-dense grid-cols-2 gap-x-4 text-sm sm:mt-4 sm:flex sm:flex-wrap sm:gap-x-5 sm:gap-y-2'

/** Like Avatar: only a GitHub picture over https; the site owner branch never draws an initial-letter circle in place of an image. */
const GITHUB_AVATAR_ORIGIN = 'https://avatars.githubusercontent.com/'

function Eyebrow() {
  const t = useTranslations('Site.authorBox')
  return (
    <p className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-neutral-600 uppercase dark:text-neutral-400">
      <UserIcon size={14} />
      {t('eyebrow')}
    </p>
  )
}

/**
 * The author box at the end of a post, the panel recipe of ContactSection: hairline border, background
 * neutral-50, `rounded-card` corners.
 *
 * Two forms. A post by the site owner — or an older backend that sends no `author` — has the full profile below;
 * a post by another author gets a minimal box (`OtherAuthorBox`).
 *
 * Eyebrow [User] Author, name (h2: a section of the page, at the same level as the related-posts heading
 * below), tagline, then the ways onward: the About page, the best-posts page for
 * newcomers, GitHub (`rel="me"`: declares the two identities one person, like Hero and
 * ContactSection), email, RSS. No link name is an icon: icons are aria-hidden, names are text.
 *
 * The avatar only when there is a real image: `profile.avatar` (default null), or the GitHub picture of the site owner account when
 * that account has linked GitHub (`author.avatarUrl`, TODO T-004). No illustration, no initial-letter circle
 * — a fake face is worse than none. `unoptimized`: the avatar is a "path or URL" filled in by the site owner, while `images` in
 * next.config.ts only opens `/media/**` to the optimizer, so going through the optimizer would throw at render time.
 *
 * The data comes as props from the page (site content), like ContactSection: both the avatar and the contact branches can be
 * reached from tests without mocking the content module. `positioning` is the site's positioning line (`site.positioning`).
 */
export function AuthorBox({
  author,
  data,
  contactData,
  positioning,
}: {
  author?: PostAuthor
  data: Profile
  contactData: Contact
  positioning: string
}) {
  const t = useTranslations('Site.authorBox')
  const tReader = useTranslations('Site.reader')
  const arrow = (chunks: ReactNode) => <span aria-hidden="true">{chunks}</span>
  const other = otherAuthor(author)
  if (other) return <OtherAuthorBox author={other} />
  const githubAvatar = author?.avatarUrl?.startsWith(GITHUB_AVATAR_ORIGIN) ? author.avatarUrl : null
  const hasAvatar = Boolean(data.avatar || githubAvatar)

  const links: { key: string; node: ReactNode; span?: boolean }[] = [
    {
      key: 'about',
      node: (
        <Link href="/about" className={TEXT_LINK}>
          {t.rich('about', { arrow })}
        </Link>
      ),
    },
    {
      key: 'start-here',
      span: true,
      node: (
        <Link href="/start-here" className={TEXT_LINK}>
          {t.rich('startHere', { arrow })}
        </Link>
      ),
    },
  ]
  if (contactData.github) {
    links.push({
      key: 'github',
      node: (
        <a href={githubUrl(contactData.github)} rel="me noreferrer" className={ICON_LINK}>
          <BrandIcon name="github" />
          GitHub
        </a>
      ),
    })
  }
  if (contactData.email) {
    links.push({
      key: 'email',
      node: (
        <a href={`mailto:${contactData.email}`} className={ICON_LINK}>
          <MailIcon />
          {t('email')}
        </a>
      ),
    })
  }
  links.push({
    key: 'subscribe',
    node: (
      <Link href="/newsletter" className={`${TEXT_LINK} sm:hidden`}>
        {tReader('subscribe')}
      </Link>
    ),
  })
  links.push({
    key: 'rss',
    node: (
      <a href={FEED_PATH} className={ICON_LINK}>
        <RssIcon />
        RSS
      </a>
    ),
  })

  return (
    <aside aria-labelledby={HEADING_ID} className={PANEL}>
      {/* A grid so the sentence under the name can use the whole width of the box on a phone (avatar and name on one line, then the
          sentence); from `sm` the avatar spans two rows and auto-placement puts the sentence in the column beside it, as before.
          Without an avatar the single column is the text. */}
      <div
        className={`grid items-start gap-y-3 sm:gap-y-0 ${hasAvatar ? 'grid-cols-[auto_minmax(0,1fr)] gap-x-4' : 'grid-cols-1'}`}
      >
        {data.avatar ? (
          <Image
            src={data.avatar}
            alt=""
            width={56}
            height={56}
            unoptimized
            className="h-14 w-14 shrink-0 rounded-full border border-neutral-200 object-cover sm:row-span-2 dark:border-neutral-800"
          />
        ) : githubAvatar ? (
          <Avatar name={data.name} src={githubAvatar} size={64} className="shrink-0 sm:row-span-2" />
        ) : null}
        <div className="min-w-0 self-center sm:self-start">
          <Eyebrow />
          <h2 id={HEADING_ID} className="mt-1 text-lg font-semibold tracking-tight">
            {data.name}
          </h2>
        </div>
        <p
          className={`max-w-2xl text-neutral-700 sm:mt-2 dark:text-neutral-300 ${hasAvatar ? 'col-span-full sm:col-span-1' : ''}`}
        >
          {positioning}
        </p>
      </div>

      <ul className={LINKS}>
        {links.map((link) => (
          <li key={link.key} className={link.span ? 'col-span-2 sm:col-span-1' : undefined}>
            {link.node}
          </li>
        ))}
      </ul>
    </aside>
  )
}

/**
 * An author who is not the site owner: only what the backend publishes about that person. No email, /about, tagline or
 * `rel="me"` — those talk about the site owner, attaching them to someone else would be wrong. The image goes through Avatar (GitHub hosts only).
 */
function OtherAuthorBox({ author }: { author: PostAuthor }) {
  const github = githubProfileUrl(author.githubLogin)
  // Profile /u/<slug>; an old backend that sends no profileSlug leaves the name as plain text.
  const href = profileHref(author)
  const who = (
    <>
      <Avatar name={author.displayName} src={author.avatarUrl} size={64} className="absolute top-1/2 left-0 -translate-y-1/2" />
      <bdi>{author.displayName}</bdi>
    </>
  )

  return (
    <aside aria-labelledby={HEADING_ID} className={PANEL}>
      {/* The avatar is absolute in the left column (64px + 16px) so it sits in the SAME link as the name without changing the layout. */}
      <div className="relative flex min-h-16 items-center pl-20">
        <div className="min-w-0">
          <Eyebrow />
          {/* <bdi>: the name is user-set; a long name wraps anywhere, like ProfileCard. */}
          <h2 id={HEADING_ID} className="mt-1 text-lg font-semibold tracking-tight [overflow-wrap:anywhere]">
            {href !== null ? (
              <Link href={href} className={TITLE_LINK}>
                {who}
              </Link>
            ) : (
              who
            )}
          </h2>
          {github ? (
            <p className="mt-2 text-sm">
              <a href={github} rel="noopener noreferrer" className={`${ICON_LINK} [overflow-wrap:anywhere]`}>
                <BrandIcon name="github" />@{author.githubLogin}
              </a>
            </p>
          ) : null}
        </div>
      </div>
    </aside>
  )
}
