import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Container } from './Container'
import { FRAME_MAX } from './reader/reader-layout'

/**
 * Container owns the max width and the horizontal gutter. jsdom does not run Tailwind, so what can be pinned is the
 * class list: which width class and which gutter each `width` produces.
 */

function classesOf(width?: Parameters<typeof Container>[0]['width'], className?: string): string[] {
  const { container } = render(
    <Container width={width} className={className}>
      x
    </Container>,
  )
  return (container.firstElementChild as HTMLElement).className.split(/\s+/)
}

describe('Container widths', () => {
  it('reader: the 1400px frame width (FRAME_MAX), with the standard gutter', () => {
    expect(FRAME_MAX).toBe('max-w-[87.5rem]')
    expect(classesOf('reader')).toEqual(['mx-auto', 'w-full', 'max-w-[87.5rem]', 'px-4', 'sm:px-6'])
  })

  it('has no frame prop and renders no marker attribute: the frame is the shell, not a Container option', () => {
    const { container } = render(
      <Container width="reader" labelledBy="h">
        x
      </Container>,
    )
    const element = container.firstElementChild as HTMLElement
    expect(element.getAttributeNames().sort()).toEqual(['aria-labelledby', 'class'])
    for (const name of element.getAttributeNames()) expect(name).not.toMatch(/^data-/)
    // @ts-expect-error `frame` was removed together with data-site-frame
    render(<Container frame>x</Container>)
  })

  it('bare: centred and full width, with no max width and no gutter', () => {
    const classes = classesOf('bare')
    expect(classes).toEqual(['mx-auto', 'w-full'])
    expect(classes.some((name) => name.startsWith('max-w-') || /(^|:)px-/.test(name))).toBe(false)
  })

  it('the existing widths render the same classes as before; `wide` is a deprecated alias and still the default until the last page converts', () => {
    expect(classesOf('prose')).toEqual(['mx-auto', 'w-full', 'max-w-3xl', 'px-4', 'sm:px-6'])
    expect(classesOf('wide')).toEqual(['mx-auto', 'w-full', 'max-w-5xl', 'px-4', 'sm:px-6'])
    expect(classesOf()).toEqual(classesOf('wide'))
  })

  it('the exact class string of the existing widths is unchanged, and a caller class is appended after it', () => {
    const { container } = render(
      <Container width="prose" className="py-10">
        x
      </Container>,
    )
    expect(container.firstElementChild!.getAttribute('class')).toBe('mx-auto w-full max-w-3xl px-4 sm:px-6 py-10')
    const plain = render(<Container>x</Container>)
    expect(plain.container.firstElementChild!.getAttribute('class')).toBe('mx-auto w-full max-w-5xl px-4 sm:px-6')
  })
})
