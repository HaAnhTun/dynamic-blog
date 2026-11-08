import { act, fireEvent, screen, within } from '@testing-library/react'
import { hydrateRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderMarkdown } from '@/lib/markdown'
import { IntlWrapper } from '@/test/intl'
import { msg, renderWithIntl } from '@/test/render-intl'
import { CodeBlock } from '../CodeBlock'
import { CodeTabs } from './CodeTabs'

const TWO_TABS = [
  ':::code-tabs{title="Install it"}',
  '',
  '```bash title="npm"',
  'npm install thing',
  '```',
  '',
  '```bash title="pnpm"',
  'pnpm add thing',
  '```',
  '',
  '```python title="pip"',
  'pip install thing',
  '```',
  '',
  ':::',
].join('\n')

/** The real pipeline with the real components: fence meta in, tabs out. */
async function renderTabs(markdown = TWO_TABS) {
  const { content, problems } = await renderMarkdown(markdown)
  expect(problems).toEqual([])
  return { content, ...renderWithIntl(<>{content}</>) }
}

const tabs = () => screen.getAllByRole('tab')
/** The panel a tab controls, found through `aria-controls`: the name of a hidden panel is not computed by the testing library. */
const panel = (name: string) => {
  const tab = tabs().find((candidate) => candidate.textContent === name)!
  return document.getElementById(tab.getAttribute('aria-controls')!)!
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard')
})

describe('CodeTabs: what the reader sees', () => {
  it('labels each tab with the title of its fence, and names the group by its title', async () => {
    await renderTabs()

    expect(tabs().map((tab) => tab.textContent)).toEqual(['npm', 'pnpm', 'pip'])
    expect(screen.getByRole('tablist', { name: 'Install it' })).toBeInTheDocument()
  })

  it('keeps every panel in the document and shows only the selected one, the first at the start', async () => {
    const { container } = await renderTabs()

    expect(container.textContent).toContain('npm install thing')
    expect(container.textContent).toContain('pnpm add thing')
    expect(container.textContent).toContain('pip install thing')
    expect(panel('npm')).toBeVisible()
    expect(panel('pnpm')).not.toBeVisible()
    expect(panel('pip')).not.toBeVisible()
    expect(tabs().map((tab) => tab.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false'])
  })

  it('wires each tab to its panel both ways, with ids that are unique even for two groups on one page', async () => {
    const { container } = await renderTabs(`${TWO_TABS}\n\nBetween.\n\n${TWO_TABS}`)

    const ids = [...container.querySelectorAll('[role="tab"], [role="tabpanel"]')].map((element) => element.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const tab of tabs()) {
      const target = document.getElementById(tab.getAttribute('aria-controls')!)!
      expect(target).toHaveAttribute('role', 'tabpanel')
      expect(target).toHaveAttribute('aria-labelledby', tab.id)
    }
  })

  it('does not repeat the fence title inside the panel: the tab already says it', async () => {
    const { container } = await renderTabs()

    expect(container.querySelector('[data-code-title]')).toBeNull()
  })

  it('selects a tab on click and shows its panel only', async () => {
    await renderTabs()

    fireEvent.click(tabs()[1]!)

    expect(panel('pnpm')).toBeVisible()
    expect(panel('npm')).not.toBeVisible()
    expect(tabs()[1]).toHaveAttribute('aria-selected', 'true')
    expect(tabs()[0]).toHaveAttribute('aria-selected', 'false')
  })

  it('copies the code of the visible panel only', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true })
    await renderTabs()
    fireEvent.click(tabs()[2]!)

    await act(async () => {
      within(panel('pip'))
        .getByRole('button', { name: msg('Site.code.copy') })
        .click()
    })

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('pip install thing')
  })
})

describe('CodeTabs: keyboard (the WAI-ARIA tabs pattern)', () => {
  it('keeps one tab in the tab order, the selected one', async () => {
    await renderTabs()

    expect(tabs().map((tab) => tab.tabIndex)).toEqual([0, -1, -1])
    fireEvent.click(tabs()[2]!)
    expect(tabs().map((tab) => tab.tabIndex)).toEqual([-1, -1, 0])
  })

  it('moves to the next and the previous tab with the arrow keys, wrapping around, and moves focus with it', async () => {
    await renderTabs()
    tabs()[0]!.focus()

    fireEvent.keyDown(tabs()[0]!, { key: 'ArrowRight' })
    expect(tabs()[1]).toHaveFocus()
    expect(tabs()[1]).toHaveAttribute('aria-selected', 'true')
    expect(panel('pnpm')).toBeVisible()

    fireEvent.keyDown(tabs()[1]!, { key: 'ArrowRight' })
    fireEvent.keyDown(tabs()[2]!, { key: 'ArrowRight' })
    expect(tabs()[0]).toHaveFocus()
    expect(panel('npm')).toBeVisible()

    fireEvent.keyDown(tabs()[0]!, { key: 'ArrowLeft' })
    expect(tabs()[2]).toHaveFocus()
    expect(tabs()[2]).toHaveAttribute('aria-selected', 'true')
    expect(panel('pip')).toBeVisible()
  })

  it('jumps to the first tab with Home and to the last with End', async () => {
    await renderTabs()
    tabs()[0]!.focus()

    fireEvent.keyDown(tabs()[0]!, { key: 'End' })
    expect(tabs()[2]).toHaveFocus()
    expect(panel('pip')).toBeVisible()

    fireEvent.keyDown(tabs()[2]!, { key: 'Home' })
    expect(tabs()[0]).toHaveFocus()
    expect(panel('npm')).toBeVisible()
  })

  it('stops the page from scrolling on the keys it handles, and leaves every other key alone', async () => {
    await renderTabs()
    tabs()[0]!.focus()

    expect(fireEvent.keyDown(tabs()[0]!, { key: 'ArrowRight' })).toBe(false)
    expect(fireEvent.keyDown(tabs()[1]!, { key: 'a' })).toBe(true)
    expect(fireEvent.keyDown(tabs()[1]!, { key: 'Tab' })).toBe(true)
    expect(tabs()[1]).toHaveAttribute('aria-selected', 'true')
  })

  it('does not take the browser shortcuts that use an arrow key (Alt+Left is "back")', async () => {
    await renderTabs()
    tabs()[0]!.focus()

    expect(fireEvent.keyDown(tabs()[0]!, { key: 'ArrowRight', altKey: true })).toBe(true)
    expect(fireEvent.keyDown(tabs()[0]!, { key: 'ArrowRight', ctrlKey: true })).toBe(true)
    expect(fireEvent.keyDown(tabs()[0]!, { key: 'ArrowRight', metaKey: true })).toBe(true)

    expect(tabs()[0]).toHaveAttribute('aria-selected', 'true')
  })
})

describe('CodeTabs: other shapes', () => {
  it('gives a tab without a title the number of its place, and the group a plain name without a title', () => {
    renderWithIntl(
      <CodeTabs props={{}}>
        <CodeBlock>
          <code>one</code>
        </CodeBlock>
        <CodeBlock data-title="Two">
          <code>two</code>
        </CodeBlock>
      </CodeTabs>,
    )

    expect(tabs().map((tab) => tab.textContent)).toEqual([msg('Site.blocks.codeTabs.tab', { n: 1 }), 'Two'])
    expect(screen.getByRole('tablist', { name: msg('Site.blocks.codeTabs.label') })).toBeInTheDocument()
  })

  it('ignores the whitespace between the code blocks and shows plain content when there is nothing to put in a tab', () => {
    const { container } = renderWithIntl(
      <CodeTabs props={{}}>
        {'\n'}
        <p>Only text.</p>
        {'\n'}
      </CodeTabs>,
    )

    expect(screen.queryByRole('tablist')).toBeNull()
    expect(container).toHaveTextContent('Only text.')
  })
})

describe('CodeTabs: content that is not only code', () => {
  it('shows a body that mixes code with other content as it is, so nothing is lost', () => {
    const { container } = renderWithIntl(
      <CodeTabs props={{}}>
        <CodeBlock data-title="One">
          <code>one</code>
        </CodeBlock>
        <p>Stray text.</p>
      </CodeTabs>,
    )

    expect(screen.queryByRole('tablist')).toBeNull()
    expect(container).toHaveTextContent('one')
    expect(container).toHaveTextContent('Stray text.')
  })
})

describe('CodeTabs: server render and hydration', () => {
  it('renders the first panel visible and the others hidden in the server HTML, then hydrates without an error and works', async () => {
    const { content } = await renderMarkdown(TWO_TABS)
    const host = document.createElement('div')
    host.innerHTML = renderToStaticMarkup(<IntlWrapper>{content}</IntlWrapper>)
    document.body.append(host)

    expect([...host.querySelectorAll('[role="tabpanel"]')].map((element) => element.hasAttribute('hidden'))).toEqual([
      false,
      true,
      true,
    ])

    const errors: unknown[] = []
    const root = hydrateRoot(host, <IntlWrapper>{content}</IntlWrapper>, { onRecoverableError: (error) => errors.push(error) })
    await act(async () => {})

    expect(errors).toEqual([])
    fireEvent.keyDown(within(host).getAllByRole('tab')[0]!, { key: 'End' })
    expect(within(host).getByRole('tabpanel', { name: 'pip' })).toBeVisible()
    expect(within(host).getByRole('tab', { name: 'npm' })).toHaveAttribute('aria-selected', 'false')

    root.unmount()
    host.remove()
  })
})
