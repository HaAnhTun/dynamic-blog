import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { hydrateRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { renderMarkdown, renderMarkdownToFeedHtml } from '@/lib/markdown'
import { IntlWrapper } from '@/test/intl'
import { msg, renderWithIntl } from '@/test/render-intl'
import { AiBlock } from './AiBlock'
import { CodeTabsView } from './CodeTabsView'
import { Tabs } from './Tabs'

const THREE_TABS = [
  '::::tabs{title="Install it"}',
  ':::tab{title="macOS"}',
  'Run `brew install thing`.',
  ':::',
  ':::tab{title="Linux"}',
  'Use **your package manager**.',
  ':::',
  ':::tab{title="Windows"}',
  'Download the installer.',
  ':::',
  '::::',
].join('\n')

/** The real pipeline with the real components: directives in, tabs out. */
async function renderTabs(markdown = THREE_TABS) {
  const { content, problems } = await renderMarkdown(markdown)
  expect(problems).toEqual([])
  return { content, ...renderWithIntl(<>{content}</>) }
}

/** The tabs of the outer group (a nested group has its own list). */
const tabs = () => screen.getAllByRole('tab')
/** The panel a tab controls, found through `aria-controls`: the name of a hidden panel is not computed by the testing library. */
const panel = (name: string) => {
  const tab = tabs().find((candidate) => candidate.textContent === name)!
  return document.getElementById(tab.getAttribute('aria-controls')!)!
}

describe('Tabs: what the reader sees', () => {
  it('labels each tab with the title of its tab block, and names the group by its title', async () => {
    await renderTabs()

    expect(tabs().map((tab) => tab.textContent)).toEqual(['macOS', 'Linux', 'Windows'])
    expect(screen.getByRole('tablist', { name: 'Install it' })).toBeInTheDocument()
  })

  it('reads the labels from the props of the tab elements the pipeline hands over', () => {
    renderWithIntl(
      <Tabs props={{}}>
        {'\n'}
        <AiBlock block="tab" title="First">
          <p>One.</p>
        </AiBlock>
        {'\n'}
        <AiBlock block="tab" title="C++ & Rust">
          <p>Two.</p>
        </AiBlock>
        {'\n'}
      </Tabs>,
    )

    expect(tabs().map((tab) => tab.textContent)).toEqual(['First', 'C++ & Rust'])
    expect(panel('C++ & Rust')).toHaveTextContent('Two.')
  })

  it('reads the labels in a preview too, where the dispatcher is wrapped to hand the package images over', async () => {
    const { content, problems } = await renderMarkdown(THREE_TABS, { imageSource: new Map() })
    expect(problems).toEqual([])
    render(<>{content}</>)

    expect(tabs().map((tab) => tab.textContent)).toEqual(['macOS', 'Linux', 'Windows'])
  })

  it('gives a group without a title a plain name from the catalog', async () => {
    await renderTabs(THREE_TABS.replace('{title="Install it"}', ''))

    expect(screen.getByRole('tablist', { name: msg('Site.blocks.tabsLabel') })).toBeInTheDocument()
    expect(screen.queryByText('Install it')).toBeNull()
  })

  it('shows the title of the group above the tabs, as a paragraph and never as a heading', async () => {
    const { container } = await renderTabs()

    expect(screen.getByText('Install it').tagName).toBe('P')
    expect(container.querySelector('h1,h2,h3,h4,h5,h6')).toBeNull()
  })

  it('keeps every panel in the document and shows only the selected one, the first at the start', async () => {
    const { container } = await renderTabs()

    expect(container.textContent).toContain('brew install thing')
    expect(container.textContent).toContain('your package manager')
    expect(container.textContent).toContain('Download the installer.')
    expect(panel('macOS')).toBeVisible()
    expect(panel('Linux')).not.toBeVisible()
    expect(panel('Windows')).not.toBeVisible()
    expect(panel('Linux')).toHaveAttribute('hidden')
    expect(tabs().map((tab) => tab.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false'])
  })

  it('renders the Markdown of a tab inside its panel', async () => {
    await renderTabs()

    expect(within(panel('macOS')).getByText('brew install thing').tagName).toBe('CODE')
    expect(within(panel('Linux')).getByText('your package manager').tagName).toBe('STRONG')
  })

  it('names each panel by its tab, and wires both ways, with ids that are unique even for two groups on one page', async () => {
    const { container } = await renderTabs(`${THREE_TABS}\n\nBetween.\n\n${THREE_TABS}`)

    const ids = [...container.querySelectorAll('[role="tab"], [role="tabpanel"]')].map((element) => element.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(12)
    for (const tab of tabs()) {
      const target = document.getElementById(tab.getAttribute('aria-controls')!)!
      expect(target).toHaveAttribute('role', 'tabpanel')
      expect(target).toHaveAttribute('aria-labelledby', tab.id)
    }
  })

  it('selects a tab on click and shows its panel only', async () => {
    await renderTabs()

    fireEvent.click(tabs()[2]!)

    expect(panel('Windows')).toBeVisible()
    expect(panel('macOS')).not.toBeVisible()
    expect(tabs()[2]).toHaveAttribute('aria-selected', 'true')
    expect(tabs()[0]).toHaveAttribute('aria-selected', 'false')
  })

  it('marks every panel with its block and puts nothing of the tab block itself in the way of the tabs', async () => {
    const { container } = await renderTabs()

    expect(container.querySelectorAll('[data-block="tabs"]')).toHaveLength(1)
    expect(container.querySelectorAll('[role="tabpanel"] > [data-block="tab"]')).toHaveLength(3)
    // The label is the tab: no second name for the panel inside it.
    expect(container.querySelector('[data-block="tab"][aria-label], [data-block="tab"][role]')).toBeNull()
  })

  it('names the group in the language of the page', async () => {
    const { content } = await renderMarkdown(THREE_TABS.replace('{title="Install it"}', ''))
    renderWithIntl(<>{content}</>, { locale: 'en' })

    expect(screen.getByRole('tablist', { name: msg('Site.blocks.tabsLabel', undefined, 'en') })).toBeInTheDocument()
  })
})

describe('Tabs: keyboard (the WAI-ARIA tabs pattern)', () => {
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
    expect(panel('Linux')).toBeVisible()

    fireEvent.keyDown(tabs()[1]!, { key: 'ArrowRight' })
    fireEvent.keyDown(tabs()[2]!, { key: 'ArrowRight' })
    expect(tabs()[0]).toHaveFocus()
    expect(panel('macOS')).toBeVisible()

    fireEvent.keyDown(tabs()[0]!, { key: 'ArrowLeft' })
    expect(tabs()[2]).toHaveFocus()
    expect(tabs()[2]).toHaveAttribute('aria-selected', 'true')
    expect(panel('Windows')).toBeVisible()
    expect(panel('macOS')).not.toBeVisible()
  })

  it('jumps to the first tab with Home and to the last with End', async () => {
    await renderTabs()
    tabs()[0]!.focus()

    fireEvent.keyDown(tabs()[0]!, { key: 'End' })
    expect(tabs()[2]).toHaveFocus()
    expect(panel('Windows')).toBeVisible()

    fireEvent.keyDown(tabs()[2]!, { key: 'Home' })
    expect(tabs()[0]).toHaveFocus()
    expect(panel('macOS')).toBeVisible()
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
    expect(fireEvent.keyDown(tabs()[0]!, { key: 'ArrowRight', shiftKey: true })).toBe(true)

    expect(tabs()[0]).toHaveAttribute('aria-selected', 'true')
  })
})

describe('Tabs: what a tab can hold', () => {
  const NESTED = [
    ':::::tabs{title="Outer"}',
    '::::tab{title="With code"}',
    'Before the code.',
    '',
    ':::code-tabs{title="Inner"}',
    '```bash title="npm"',
    'npm install thing',
    '```',
    '```bash title="pnpm"',
    'pnpm add thing',
    '```',
    ':::',
    '::::',
    '::::tab{title="Plain"}',
    'Only text.',
    '::::',
    ':::::',
  ].join('\n')

  it('holds a group of code tabs that works on its own, apart from the outer tabs', async () => {
    await renderTabs(NESTED)
    const outer = screen.getByRole('tablist', { name: 'Outer' })
    const inner = screen.getByRole('tablist', { name: 'Inner' })
    expect(panel('With code')).toContainElement(inner)
    expect(outer).not.toContainElement(inner)

    const innerTabs = within(inner).getAllByRole('tab')
    innerTabs[0]!.focus()
    fireEvent.keyDown(innerTabs[0]!, { key: 'ArrowRight' })

    expect(innerTabs[1]).toHaveFocus()
    expect(innerTabs[1]).toHaveAttribute('aria-selected', 'true')
    expect(within(outer).getAllByRole('tab')[0]).toHaveAttribute('aria-selected', 'true')
    expect(panel('With code')).toBeVisible()
  })

  it('keeps the arrow keys of the outer tabs from selecting an inner tab', async () => {
    await renderTabs(NESTED)
    const outerTabs = within(screen.getByRole('tablist', { name: 'Outer' })).getAllByRole('tab')
    outerTabs[0]!.focus()

    fireEvent.keyDown(outerTabs[0]!, { key: 'ArrowRight' })

    expect(outerTabs[1]).toHaveAttribute('aria-selected', 'true')
    // The inner group is in a hidden panel now, which the role queries skip unless they are told otherwise.
    const innerTabs = within(screen.getByRole('tablist', { name: 'Inner', hidden: true })).getAllByRole('tab', { hidden: true })
    expect(innerTabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['true', 'false'])
  })

  it('keeps the code of a tab that is not shown in the page, with its own panels hidden', async () => {
    const { container } = await renderTabs(NESTED)

    expect(container.textContent).toContain('npm install thing')
    expect(container.textContent).toContain('pnpm add thing')
    fireEvent.click(within(screen.getByRole('tablist', { name: 'Outer' })).getAllByRole('tab')[1]!)
    expect(screen.getByText('Only text.')).toBeVisible()
    expect(screen.getByText('Before the code.')).not.toBeVisible()
  })

  it('holds a callout, steps and a file tree, each drawn by its own block inside the panel', async () => {
    const { container } = await renderTabs(
      [
        '::::::tabs',
        ':::::tab{title="Callout"}',
        '::::callout{type="tip" title="Mind this"}',
        'Take a copy first.',
        '::::',
        ':::::',
        ':::::tab{title="Steps"}',
        '::::steps',
        ':::step{title="Install"}',
        'Get it.',
        ':::',
        ':::step{title="Run"}',
        'Start it.',
        ':::',
        '::::',
        ':::::',
        ':::::tab{title="Files"}',
        '::::file-tree',
        '- src/',
        '  - index.ts',
        '::::',
        ':::::',
        '::::::',
      ].join('\n'),
    )

    expect(panel('Callout').querySelector('[data-block="callout"]')).not.toBeNull()
    expect(panel('Steps').querySelectorAll('[data-block="step"]')).toHaveLength(2)
    expect(panel('Files').querySelector('[data-block="file-tree"]')).toHaveTextContent('index.ts')
    expect(container.querySelectorAll('[role="tabpanel"]')).toHaveLength(3)
  })
})

describe('Tabs: other shapes', () => {
  it('shows the content as it is when what it holds is not a set of tab blocks, so nothing is lost', () => {
    const { container } = renderWithIntl(
      <Tabs props={{}}>
        {'\n'}
        <p>Stray text.</p>
        <AiBlock block="tab" title="One">
          <p>One.</p>
        </AiBlock>
      </Tabs>,
    )

    expect(screen.queryByRole('tablist')).toBeNull()
    expect(container).toHaveTextContent('Stray text.')
    expect(container).toHaveTextContent('One.')
  })

  it('shows plain content for a tab that arrives without a title, since it could not be labelled', () => {
    const { container } = renderWithIntl(
      <Tabs props={{}}>
        <AiBlock block="tab">
          <p>No title.</p>
        </AiBlock>
        <AiBlock block="tab" title="Two">
          <p>Two.</p>
        </AiBlock>
      </Tabs>,
    )

    expect(screen.queryByRole('tablist')).toBeNull()
    expect(container).toHaveTextContent('No title.')
    expect(container).toHaveTextContent('Two.')
  })

  it('shows nothing but the root when the group is empty', () => {
    const { container } = renderWithIntl(<Tabs props={{}} />)

    expect(screen.queryByRole('tablist')).toBeNull()
    expect(container.querySelector('[data-block="tabs"]')).not.toBeNull()
  })
})

describe('Tabs: the island is shared with the code tabs', () => {
  const panels = [<p key="a">Alpha.</p>, <p key="b">Beta.</p>]

  it('puts the class it is given on every panel, instead of the class made for code', () => {
    render(<CodeTabsView groupLabel="Group" labels={['A', 'B']} panels={panels} panelClass="custom-panel" />)

    const shown = screen.getAllByRole('tabpanel', { hidden: true })
    expect(shown).toHaveLength(2)
    for (const element of shown) {
      expect(element).toHaveClass('custom-panel')
      expect(element.className).not.toContain('[&_pre]')
    }
  })

  it('keeps the code class on the panels when none is given', () => {
    render(<CodeTabsView groupLabel="Group" labels={['A', 'B']} panels={panels} />)

    for (const element of screen.getAllByRole('tabpanel', { hidden: true })) expect(element.className).toContain('[&_pre]')
  })
})

describe('Tabs: server render and hydration', () => {
  it('renders the first panel visible and the others hidden in the server HTML, then hydrates without an error and works', async () => {
    const { content } = await renderMarkdown(THREE_TABS)
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
    expect(within(host).getByRole('tabpanel', { name: 'Windows' })).toBeVisible()
    expect(within(host).getByRole('tab', { name: 'macOS' })).toHaveAttribute('aria-selected', 'false')

    root.unmount()
    host.remove()
  })
})

describe('Tabs: the feed', () => {
  it('shows every tab as a titled section, one after the other, with no tab widgets', async () => {
    const html = await renderMarkdownToFeedHtml(THREE_TABS, 'https://blog.example/posts/x')

    expect(html).not.toContain('role="tab')
    expect(html).not.toContain('<button')
    const order = ['macOS', 'brew install thing', 'Linux', 'your package manager', 'Windows', 'Download the installer.'].map(
      (text) => html.indexOf(text),
    )
    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(html).toMatch(/<section><p><strong>macOS<\/strong><\/p>/)
  })
})
