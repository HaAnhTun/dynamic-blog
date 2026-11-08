import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithIntl, msg } from '@/test/render-intl'
import { CommentLikeButton } from './CommentLikeButton'
import type { SubmitResult } from './CommentForm'

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const LIKE_NAME = new RegExp(
  `^${escapeRe(msg('Site.comments.like.ariaLabel', { author: 'x', n: 0, count: '0' }).split(' x ')[0]!)}`,
)
const COUNT_LABEL = (n: number) => msg('Site.comments.like.countLabel', { n })

/**
 * The like of one comment (button part only): a signed-in person has a server-confirmed toggle
 * button, a guest only sees the number. The path to the server (PUT/DELETE, reducer, live region,
 * 401) is in CommentSection and tested in CommentSection.test.tsx.
 */

type Toggle = (likedNow: boolean) => Promise<SubmitResult>

function setup(props: Partial<Parameters<typeof CommentLikeButton>[0]> = {}) {
  const onToggle = vi.fn<Toggle>(() => Promise.resolve({ ok: true }))
  const view = render(
    <div>
      <CommentLikeButton authorName="Reader" count={3} liked={false} interactive onToggle={onToggle} {...props} />
    </div>,
  )
  return { onToggle: (props.onToggle as typeof onToggle | undefined) ?? onToggle, view }
}

/** The reply of onToggle; the test decides when it returns. */
function deferred() {
  let resolve: (result: SubmitResult) => void = () => {}
  const onToggle = vi.fn<Toggle>(() => new Promise<SubmitResult>((done) => (resolve = done)))
  return { onToggle, finish: (result: SubmitResult) => act(async () => resolve(result)) }
}

describe('CommentLikeButton: signed in', () => {
  it('not liked: toggle button aria-pressed=false, outline heart, the number visible and part of the name', () => {
    setup()

    const button = screen.getByRole('button', {
      name: msg('Site.comments.like.ariaLabel', { author: 'Reader', n: 3, count: '3' }),
      pressed: false,
    })
    expect(button).toHaveAttribute('type', 'button')
    expect(button).toHaveTextContent(/^3$/)
    expect(button).toHaveAttribute('aria-busy', 'false')
    const svg = button.querySelector('svg')!
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg.querySelector('path')).not.toHaveAttribute('fill')
  })

  it('liked: aria-pressed=true, filled heart', () => {
    setup({ liked: true, count: 4 })

    const button = screen.getByRole('button', {
      name: msg('Site.comments.like.ariaLabel', { author: 'Reader', n: 4, count: '4' }),
      pressed: true,
    })
    expect(button.querySelector('svg path')).toHaveAttribute('fill', 'currentColor')
  })

  it('0 likes: the button is still there, the number 0 visible', () => {
    setup({ count: 0 })

    expect(
      screen.getByRole('button', { name: msg('Site.comments.like.ariaLabel', { author: 'Reader', n: 0, count: '0' }) }),
    ).toHaveTextContent('0')
  })

  it('the number is written in vi-VN, both on screen and in the name', () => {
    setup({ count: 1234 })

    const button = screen.getByRole('button', {
      name: msg('Site.comments.like.ariaLabel', { author: 'Reader', n: 1234, count: '1.234' }),
    })
    expect(button).toHaveTextContent('1.234')
  })

  it('40px touch area (TAP_TARGET), brand color when liked, wait cursor while waiting', () => {
    setup()

    const button = screen.getByRole('button', { name: LIKE_NAME })
    for (const name of [
      'after:-inset-y-2.5',
      'aria-pressed:text-brand',
      'aria-busy:cursor-wait',
      'focus-visible:outline-brand',
    ]) {
      expect(button.className.split(' ')).toContain(name)
    }
  })

  it('press: calls onToggle with the state at press time, aria-busy while waiting, further presses are dropped', async () => {
    const { onToggle, finish } = deferred()
    setup({ onToggle, liked: true })
    const button = screen.getByRole('button', { name: LIKE_NAME })

    fireEvent.click(button)
    fireEvent.click(button)
    fireEvent.click(button)

    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle).toHaveBeenCalledWith(true)
    expect(button).toHaveAttribute('aria-busy', 'true')
    // Not optimistic: nothing has changed on screen yet.
    expect(button).toHaveAttribute('aria-pressed', 'true')

    await finish({ ok: true })

    expect(button).toHaveAttribute('aria-busy', 'false')
    fireEvent.click(button)
    expect(onToggle).toHaveBeenCalledTimes(2)
  })

  it('failure: a visible error sentence in role="alert", focus stays on the button; pressing again makes the old sentence go', async () => {
    const { onToggle, finish } = deferred()
    setup({ onToggle })
    const button = screen.getByRole('button', { name: LIKE_NAME })
    button.focus()

    fireEvent.click(button)
    await finish({ ok: false, message: msg('Errors.interaction.byCode.COMMENT_NOT_FOUND') })

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(msg('Errors.interaction.byCode.COMMENT_NOT_FOUND'))
    expect(alert).toBeVisible()
    // A line of its own under the whole action row (the flex-wrap row of CommentItem).
    expect(alert.className).toContain('basis-full')
    expect(alert.className).toContain('order-last')
    expect(button).toHaveFocus()

    fireEvent.click(button)
    expect(screen.queryByRole('alert')).toBeNull()
    await finish({ ok: true })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('CommentLikeButton: guest', () => {
  it('just text: heart aria-hidden, the number, "likes" for screen readers; no button, no link, no Tab stop', () => {
    const { view } = setup({ interactive: false, count: 5 })

    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
    const count = view.container.querySelector<HTMLElement>('[data-like-count]')!
    expect(count.tagName).toBe('SPAN')
    expect(count).toHaveTextContent(`5 ${COUNT_LABEL(5)}`)
    expect(count.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByText(COUNT_LABEL(5))).toHaveClass('sr-only')
    expect(view.container.querySelector('[tabindex], a, button')).toBeNull()
  })

  it('0 likes: draws nothing', () => {
    const { view } = setup({ interactive: false, count: 0 })

    expect(view.container.firstElementChild).toBeEmptyDOMElement()
  })

  it('the session turns into a guest midway (401): the button gives way to the number, its error sentence goes with it', async () => {
    const { onToggle, finish } = deferred()
    const { view } = setup({ onToggle, count: 2 })
    fireEvent.click(screen.getByRole('button', { name: LIKE_NAME }))
    await finish({ ok: false, message: msg('Errors.interaction.byCode.RATE_LIMITED') })
    expect(screen.getByRole('alert')).toBeInTheDocument()

    view.rerender(
      <div>
        <CommentLikeButton authorName="Reader" count={2} liked={false} interactive={false} onToggle={onToggle} />
      </div>,
    )

    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(view.container.querySelector('[data-like-count]')).toHaveTextContent(`2 ${COUNT_LABEL(2)}`)
  })
})

describe('CommentLikeButton: number format follows the locale', () => {
  it.each([
    ['vi', '1.234'],
    ['en', '1,234'],
  ] as const)('%s writes 1234 as %s', (locale, written) => {
    renderWithIntl(<CommentLikeButton authorName="Reader" count={1234} liked={false} interactive={false} onToggle={vi.fn()} />, {
      locale,
    })

    expect(screen.getByText(written)).toBeInTheDocument()
  })
})
