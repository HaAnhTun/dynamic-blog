import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CommentAuthor, PublicComment } from '@/lib/types'
import { CommentItem } from './CommentItem'
import { msg } from '@/test/render-intl'

const READER: CommentAuthor = {
  displayName: 'Alice Nguyen',
  githubLogin: 'alice-gh',
  avatarUrl: 'https://avatars.githubusercontent.com/u/71?v=4',
  siteOwner: false,
  profileSlug: 'alice-n',
}

function comment(over: Partial<PublicComment> = {}): PublicComment {
  return {
    id: 'c1',
    status: 'VISIBLE',
    content: 'Great post.',
    author: READER,
    createdAt: '2026-10-08T07:30:00Z',
    edited: false,
    mine: false,
    editedAt: null,
    likeCount: null,
    likedByMe: false,
    ...over,
  }
}

function mount(value: PublicComment, reply = false) {
  const ok = async () => ({ ok: true as const })
  return render(
    <CommentItem
      comment={value}
      reply={reply}
      now={Date.parse('2026-10-08T08:00:00Z')}
      mine={false}
      onOpen={vi.fn()}
      onClose={vi.fn()}
      onSave={ok}
      onDelete={ok}
      onLike={ok}
    />,
  )
}

describe('CommentItem: link to the author profile (T-003)', () => {
  it('avatar and name are ONE link to /u/<slug>: the name is the link text, the decorative avatar sits inside the link', () => {
    const { container } = mount(comment())

    const article = screen.getByRole('article', { name: 'Alice Nguyen' })
    const links = within(article).getAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAccessibleName('Alice Nguyen')
    expect(links[0]).toHaveAttribute('href', '/u/alice-n')
    const avatar = container.querySelector('img')
    expect(links[0]).toContainElement(avatar)
    expect(avatar).toHaveAttribute('alt', '')
    // The site-wide keyboard focus ring.
    expect(links[0].className).toContain('focus-visible:outline-brand')
    // @login is still plain text next to the name, not a second link.
    expect(within(article).getByText('@alice-gh').closest('a')).toBeNull()
  })

  it('the left column keeps the image width + 12px, on a root comment and on a reply', () => {
    const root = mount(comment())
    expect(root.container.querySelector('img')?.closest('.relative')?.className).toContain('pl-11')
    root.unmount()

    const reply = mount(comment(), true)
    expect(reply.container.querySelector('img')?.closest('.relative')?.className).toContain('pl-10')
  })

  it('site owner: a link to /about, the "Owner" label still sits after the name and not inside the link', () => {
    mount(comment({ author: { ...READER, displayName: 'Owner Example', siteOwner: true, profileSlug: 'chu-blog' } }))

    const link = screen.getByRole('link', { name: 'Owner Example' })
    expect(link).toHaveAttribute('href', '/about')
    const badge = screen.getByText(msg('Site.comments.item.ownerBadge'))
    expect(link).not.toContainElement(badge)
  })

  it('an old backend that sends no profileSlug, a locked person (null slug), a malformed slug: name and avatar still show, no link', () => {
    const authors = [
      { ...READER, profileSlug: undefined },
      { ...READER, profileSlug: null },
      { ...READER, profileSlug: 'javascript:alert(1)' },
    ]
    for (const author of authors) {
      const { unmount } = mount(comment({ author }))
      const article = screen.getByRole('article', { name: 'Alice Nguyen' })
      expect(within(article).queryAllByRole('link')).toHaveLength(0)
      expect(article.querySelector('img')).toHaveAttribute('alt', '')
      unmount()
    }
  })

  it('a deleted comment (author null): a placeholder, no link, no name', () => {
    mount(comment({ status: 'DELETED', content: null, author: null }))

    expect(screen.getByText(msg('Site.comments.item.deleted'))).toBeInTheDocument()
    expect(screen.queryAllByRole('link')).toHaveLength(0)
  })
})
