import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BLOCK_TYPES, type BlockType } from '@/lib/blocks/registry'
import { AiBlock } from './AiBlock'
import { BLOCK_COMPONENTS } from './index'

const DIR = join(process.cwd(), 'components', 'site', 'blocks')

/** `code-tabs` to `CodeTabs`. */
const componentName = (type: string) =>
  type
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('')

/** What is on one side and not on the other: a registry entry with no component, and a component with no registry entry. */
function mismatch(registryTypes: readonly string[], componentTypes: readonly string[]) {
  return {
    withoutComponent: registryTypes.filter((type) => !componentTypes.includes(type)),
    withoutEntry: componentTypes.filter((type) => !registryTypes.includes(type)),
  }
}

describe('registry and components', () => {
  it('have one component for every registry entry and no component without an entry', () => {
    expect(mismatch(BLOCK_TYPES, Object.keys(BLOCK_COMPONENTS))).toEqual({ withoutComponent: [], withoutEntry: [] })
  })

  it('the check itself sees both kinds of mismatch', () => {
    expect(mismatch(['a', 'b'], ['a'])).toEqual({ withoutComponent: ['b'], withoutEntry: [] })
    expect(mismatch(['a'], ['a', 'z'])).toEqual({ withoutComponent: [], withoutEntry: ['z'] })
  })

  it('keep one file per type, named after it, that exports the component the registry maps', () => {
    for (const type of BLOCK_TYPES) {
      const file = join(DIR, `${componentName(type)}.tsx`)
      expect(existsSync(file), `${type}: ${file}`).toBe(true)
      expect(readFileSync(file, 'utf8'), type).toMatch(new RegExp(`export function ${componentName(type)}\\b`))
      expect(typeof BLOCK_COMPONENTS[type], type).toBe('function')
      expect(BLOCK_COMPONENTS[type].name, type).toBe(componentName(type))
    }
  })
})

describe('AiBlock', () => {
  afterEach(() => vi.restoreAllMocks())

  it('draws a valid block with its content, through the component of its type', () => {
    vi.spyOn(BLOCK_COMPONENTS, 'callout').mockImplementation(({ children }) => <div data-testid="callout">{children}</div>)

    const { getByTestId } = render(
      <AiBlock block="callout" type="tip">
        <p>Inside.</p>
      </AiBlock>,
    )

    expect(getByTestId('callout')).toHaveTextContent('Inside.')
  })

  it('hands the component the checked attributes with the defaults applied, and nothing else', () => {
    const spy = vi.spyOn(BLOCK_COMPONENTS, 'callout').mockReturnValue(null)

    render(<AiBlock block="callout" title="Hello" className="x" id="y" onClick="alert(1)" style="color:red" />)

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]![0]).toEqual({ props: { type: 'info', title: 'Hello', variant: 'compact' }, children: undefined })
  })

  it('passes an attribute the way the HTML tree carries it: a flag as true, a number as a number', () => {
    const details = vi.spyOn(BLOCK_COMPONENTS, 'details').mockReturnValue(null)
    const gallery = vi.spyOn(BLOCK_COMPONENTS, 'gallery').mockReturnValue(null)

    render(
      <>
        <AiBlock block="details" title="T" open />
        <AiBlock block="gallery" columns="3" />
      </>,
    )

    expect(details.mock.calls[0]![0].props).toEqual({ title: 'T', open: true, variant: 'inline' })
    expect(gallery.mock.calls[0]![0].props).toEqual({ columns: 3 })
  })

  it('hands a raw block its body as source text', () => {
    const spy = vi.spyOn(BLOCK_COMPONENTS, 'diagram').mockReturnValue(null)

    render(
      <AiBlock block="diagram" type="mermaid">
        {'graph TD\n  A --> B'}
      </AiBlock>,
    )

    expect(spy.mock.calls[0]![0]).toMatchObject({ source: 'graph TD\n  A --> B', props: { type: 'mermaid' } })
  })

  it('draws an unknown block, a missing block type and attributes that do not pass as plain content', () => {
    const cases: Record<string, unknown>[] = [
      { block: 'nope' },
      {},
      { block: 'callout', type: 'alert' },
      { block: 'figure', src: 'javascript:alert(1)', alt: 'x' },
      { block: 'figure', src: 'assets/a.png' },
      { block: 'details' },
      { block: 'gallery', columns: '9' },
    ]
    for (const attributes of cases) {
      const { container, unmount } = render(
        <AiBlock {...attributes}>
          <p>kept text</p>
        </AiBlock>,
      )

      expect(container.querySelector('[data-block]'), JSON.stringify(attributes)).toBeNull()
      expect(container).toHaveTextContent('kept text')
      unmount()
    }
  })

  it('cannot be made to draw what a directive could not: an invalid raw tag falls back, nothing is built from its extras', () => {
    const calls = (Object.keys(BLOCK_COMPONENTS) as BlockType[]).map((type) =>
      vi.spyOn(BLOCK_COMPONENTS, type).mockReturnValue(null),
    )

    render(<AiBlock block="figure" src="//evil.example/a.png" alt="x" href="javascript:alert(1)" />)
    render(<AiBlock block="callout" type="danger; background:url(x)" />)

    for (const call of calls) expect(call).not.toHaveBeenCalled()
  })
})
