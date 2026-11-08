import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HeldNewsletterIssue } from '@/lib/types'
import { msg, renderWithIntl } from '@/test/render-intl'
import HeldNewsletterIssues from './HeldNewsletterIssues'

const onRelease = vi.fn()
const onDiscard = vi.fn()

afterEach(() => vi.clearAllMocks())

const FIRST = '11111111-1111-1111-1111-111111111111'
const SECOND = '22222222-2222-2222-2222-222222222222'

const issue = (over: Partial<HeldNewsletterIssue> = {}): HeldNewsletterIssue => ({
  postId: FIRST,
  slug: 'a-post',
  title: 'A post waiting',
  excerpt: 'The summary\nover two lines',
  language: 'en',
  authorName: 'Ada Author',
  heldAt: '2026-10-20T08:00:00Z',
  published: true,
  recipients: 12,
  version: 'version-of-the-text',
  ...over,
})

function renderList(issues: HeldNewsletterIssue[]) {
  return renderWithIntl(<HeldNewsletterIssues issues={issues} onRelease={onRelease} onDiscard={onDiscard} />)
}

const releaseName = (title: string) => `${msg('Admin.newsletter.held.release')} ${msg('Admin.newsletter.held.target', { title })}`
const discardName = (title: string) => `${msg('Admin.newsletter.held.discard')} ${msg('Admin.newsletter.held.target', { title })}`

describe('HeldNewsletterIssues', () => {
  it('shows what subscribers would read, who wrote it and how many would get it; the title links to the post', () => {
    renderList([issue()])

    const list = screen.getByRole('list', { name: msg('Admin.newsletter.held.listLabel') })
    const card = within(list).getByRole('article', { name: 'A post waiting' })
    expect(within(card).getByRole('link', { name: 'A post waiting' })).toHaveAttribute('href', `/admin/posts/${FIRST}/edit`)
    expect(card).toHaveTextContent(msg('Admin.newsletter.held.by', { name: 'Ada Author' }))
    expect(card).toHaveTextContent(msg('Admin.newsletter.held.recipients', { count: 12 }))
    expect(card).toHaveTextContent('The summary')
    // Not a badge or a warning while the post is published.
    expect(within(card).queryByText(msg('Admin.newsletter.held.unpublished'))).toBeNull()
  })

  it('a post taken down says so, and a missing excerpt or author has its own sentence', () => {
    renderList([issue({ published: false, excerpt: null, authorName: null })])

    expect(screen.getByText(msg('Admin.newsletter.held.unpublished'))).toBeInTheDocument()
    expect(screen.getByText(msg('Admin.newsletter.held.notPublished'))).toBeInTheDocument()
    expect(screen.getByText(msg('Admin.newsletter.held.noExcerpt'))).toBeInTheDocument()
    expect(screen.getByText(new RegExp(msg('Admin.newsletter.held.noAuthor')))).toBeInTheDocument()
  })

  it('markup in a title or an excerpt is plain text', () => {
    renderList([issue({ title: '<img src=x onerror=alert(1)>', excerpt: '<script>alert(1)</script>' })])

    expect(screen.getByRole('link', { name: '<img src=x onerror=alert(1)>' })).toBeInTheDocument()
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument()
    expect(document.querySelector('img, script')).toBeNull()
  })

  it('release: calls the action with the post id and the version that was read, removes the card and announces the result', async () => {
    onRelease.mockResolvedValue(null)
    renderList([issue(), issue({ postId: SECOND, title: 'Another post' })])

    fireEvent.click(screen.getByRole('button', { name: releaseName('A post waiting') }))

    await waitFor(() => expect(screen.queryByRole('article', { name: 'A post waiting' })).toBeNull())
    expect(onRelease).toHaveBeenCalledWith(FIRST, 'version-of-the-text')
    expect(onDiscard).not.toHaveBeenCalled()
    expect(screen.getByRole('article', { name: 'Another post' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(
      msg('Admin.newsletter.held.notice.released', { title: 'A post waiting' }),
    )
  })

  it('discard asks first: nothing is called until it is confirmed, and "keep waiting" goes back', async () => {
    onDiscard.mockResolvedValue(null)
    renderList([issue()])

    fireEvent.click(screen.getByRole('button', { name: discardName('A post waiting') }))
    expect(onDiscard).not.toHaveBeenCalled()
    const group = screen.getByRole('group')
    expect(group).toHaveTextContent(msg('Admin.newsletter.held.confirmDiscard'))

    fireEvent.click(within(group).getByRole('button', { name: msg('Admin.newsletter.held.keep') }))
    expect(screen.queryByRole('group')).toBeNull()
    expect(onDiscard).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: discardName('A post waiting') }))
    fireEvent.click(within(screen.getByRole('group')).getByRole('button', { name: msg('Admin.newsletter.held.discard') }))

    await waitFor(() => expect(screen.queryByRole('article')).toBeNull())
    expect(onDiscard).toHaveBeenCalledWith(FIRST)
    expect(screen.getByRole('status')).toHaveTextContent(
      msg('Admin.newsletter.held.notice.discarded', { title: 'A post waiting' }),
    )
  })

  it('an error sentence from the action stays on the card and the card stays', async () => {
    onRelease.mockResolvedValue({ error: 'Not allowed right now' })
    renderList([issue()])

    fireEvent.click(screen.getByRole('button', { name: releaseName('A post waiting') }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Not allowed right now')
    expect(screen.getByRole('article', { name: 'A post waiting' })).toBeInTheDocument()
  })

  it('a card refreshed with the new text releases the new version, not the one read before', async () => {
    onRelease.mockResolvedValueOnce({ error: msg('Errors.admin.codes.NEWSLETTER_ISSUE_CHANGED') })
    const { rerender } = renderList([issue()])

    fireEvent.click(screen.getByRole('button', { name: releaseName('A post waiting') }))
    expect(await screen.findByRole('alert')).toHaveTextContent(msg('Errors.admin.codes.NEWSLETTER_ISSUE_CHANGED'))
    expect(onRelease).toHaveBeenLastCalledWith(FIRST, 'version-of-the-text')

    // The action refreshed the page: the same post, with the text it has now and its new version.
    rerender(
      <HeldNewsletterIssues
        issues={[issue({ title: 'The title after the edit', version: 'version-after-the-edit' })]}
        onRelease={onRelease}
        onDiscard={onDiscard}
      />,
    )
    expect(screen.getByRole('article', { name: 'The title after the edit' })).toBeInTheDocument()
    onRelease.mockResolvedValueOnce(null)
    fireEvent.click(screen.getByRole('button', { name: releaseName('The title after the edit') }))

    await waitFor(() => expect(screen.queryByRole('article')).toBeNull())
    expect(onRelease).toHaveBeenLastCalledWith(FIRST, 'version-after-the-edit')
  })

  it('a second click while the first is pending is dropped', async () => {
    let finish: (value: null) => void = () => undefined
    onRelease.mockReturnValue(new Promise<null>((resolve) => (finish = resolve)))
    renderList([issue()])

    const releaseButton = screen.getByRole('button', { name: releaseName('A post waiting') })
    fireEvent.click(releaseButton)
    fireEvent.click(releaseButton)
    finish(null)

    await waitFor(() => expect(screen.queryByRole('article')).toBeNull())
    expect(onRelease).toHaveBeenCalledTimes(1)
  })
})
