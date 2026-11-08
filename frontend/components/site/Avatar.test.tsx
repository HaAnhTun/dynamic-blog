import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Avatar, initialOf } from './Avatar'
import {
  INITIAL_E_CIRCUMFLEX_TILDE,
  INITIAL_UPPER_D,
  LETTER_E_CIRCUMFLEX_TILDE,
  NAME_ACCENTED_N,
  NAME_LOWER_D,
  NAME_PADDED,
} from '@/test/fixtures/vi/avatar'

const GITHUB = 'https://avatars.githubusercontent.com/u/42?v=4'
/** Exactly that image at the fixed 128 px size: `v` is kept, `s` is appended. */
const GITHUB_128 = 'https://avatars.githubusercontent.com/u/42?v=4&s=128'

describe('Avatar', () => {
  it('a GitHub image goes straight to the browser (unoptimized), is decorative, correct size', () => {
    const { container } = render(<Avatar name="Reader Example" src={GITHUB} />)

    const img = container.querySelector('img')!
    // unoptimized: it does not go through /_next/image, so next.config.ts needs no remotePatterns. It goes straight
    // to GitHub, but asks GitHub for the 128 px size rather than the original image (test below).
    expect(img).toHaveAttribute('src', GITHUB_128)
    // The name always sits next to it (or is inside the button's name): empty alt so it is not read twice.
    expect(img).toHaveAttribute('alt', '')
    expect(img).toHaveAttribute('width', '28')
    expect(img).toHaveAttribute('height', '28')
    expect(img).toHaveClass('h-7', 'w-7', 'rounded-full', 'shrink-0')
  })

  it('size 64 for the profile page', () => {
    const { container } = render(<Avatar name="A" src={GITHUB} size={64} />)

    const img = container.querySelector('img')!
    expect(img).toHaveAttribute('width', '64')
    expect(img).toHaveClass('h-16', 'w-16')
  })

  it('without an image it is the initial letter, hidden from screen readers', () => {
    const { container } = render(<Avatar name={NAME_LOWER_D} src={null} />)

    expect(container.querySelector('img')).toBeNull()
    const initial = container.firstElementChild as HTMLElement
    expect(initial).toHaveTextContent(INITIAL_UPPER_D)
    expect(initial).toHaveAttribute('aria-hidden', 'true')
    expect(initial).toHaveClass('h-7', 'w-7', 'rounded-full')
  })

  it.each([
    ['other host', 'https://evil.example/u/42.png'],
    ['http instead of https', 'http://avatars.githubusercontent.com/u/42'],
    ['fake host with a similar prefix', 'https://avatars.githubusercontent.com.evil.example/u/42'],
    ['relative URL', '/media/x.png'],
  ])('%s: never loaded, uses the initial letter', (_label, src) => {
    // The backend only keeps avatars from avatars.githubusercontent.com; this is the second layer, so a
    // foreign URL that slips through does not become a tracking image on every page that person appears on.
    const { container } = render(<Avatar name="Owner Example" src={src} />)

    expect(container.querySelector('img')).toBeNull()
    expect(container).toHaveTextContent('O')
  })

  it('an image that fails to load switches to the initial letter', () => {
    const { container } = render(<Avatar name="Owner Example" src={GITHUB} />)

    fireEvent.error(container.querySelector('img')!)

    expect(container.querySelector('img')).toBeNull()
    expect(container).toHaveTextContent('O')
  })

  it('a failed image is remembered by the original URL: the same person stays a letter, another person tries loading their image', () => {
    const { container, rerender } = render(<Avatar name="Owner Example" src={GITHUB} />)
    fireEvent.error(container.querySelector('img')!)

    // The same original URL (parent component re-renders): do not retry an image that just failed.
    rerender(<Avatar name="Owner Example" src={GITHUB} />)
    expect(container.querySelector('img')).toBeNull()

    rerender(<Avatar name="Lan" src="https://avatars.githubusercontent.com/u/7?v=4" />)
    expect(container.querySelector('img')).toHaveAttribute('src', 'https://avatars.githubusercontent.com/u/7?v=4&s=128')
  })
})

/**
 * Without `s`, GitHub returns the image at its original size, a few hundred px, for a place that shows 28 px. One size for
 * every place — header 28, comment 28 or 32, profile 64 — so each person has only one file in the
 * browser cache; 128 is sharp enough for 64 px on a 2x screen.
 */
describe('Avatar: image size requested from GitHub', () => {
  it.each([28, 32, 64] as const)('display size %i still asks for exactly one 128 px file', (size) => {
    const { container } = render(<Avatar name="A" src={GITHUB} size={size} />)

    expect(container.querySelector('img')).toHaveAttribute('src', GITHUB_128)
  })

  it('an existing `s` is replaced rather than repeated, `v` (image version) is kept', () => {
    const { container } = render(<Avatar name="A" src="https://avatars.githubusercontent.com/u/42?s=460&v=4" />)

    expect(container.querySelector('img')).toHaveAttribute('src', 'https://avatars.githubusercontent.com/u/42?s=128&v=4')
  })

  it('a URL without a query gets `?s=128` added', () => {
    const { container } = render(<Avatar name="A" src="https://avatars.githubusercontent.com/u/42" />)

    expect(container.querySelector('img')).toHaveAttribute('src', 'https://avatars.githubusercontent.com/u/42?s=128')
  })

  it.each([
    ['other host, even when it already carries `s`', 'https://evil.example/u/42?s=128&v=4'],
    ['fake host using the GitHub name as userinfo', 'https://avatars.githubusercontent.com@evil.example/u/42?v=4'],
  ])('%s: still the initial letter, loads nothing', (_label, src) => {
    const { container } = render(<Avatar name="Owner Example" src={src} />)

    expect(container.querySelector('img')).toBeNull()
    expect(container).toHaveTextContent('O')
  })
})

describe('initialOf', () => {
  it.each([
    [NAME_ACCENTED_N, 'N'],
    [LETTER_E_CIRCUMFLEX_TILDE, INITIAL_E_CIRCUMFLEX_TILDE],
    // The decomposed form (e + combining mark) still yields one fully accented character.
    ['e\u0302\u0303', INITIAL_E_CIRCUMFLEX_TILDE],
    [NAME_PADDED, 'B'],
    ['👩‍💻 dev', '👩‍💻'],
    ['', '?'],
    ['   ', '?'],
  ])('%j → %j', (name, initial) => {
    expect(initialOf(name)).toBe(initial)
  })

  it('without Intl.Segmenter (Firefox before 125) it still yields the initial letter and does not throw', () => {
    expect(initialOf(NAME_LOWER_D, null)).toBe(INITIAL_UPPER_D)
    expect(initialOf('e\u0302\u0303 x', null)).toBe(INITIAL_E_CIRCUMFLEX_TILDE)
    expect(initialOf('  ', null)).toBe('?')
  })
})
