import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderMarkdown, renderMarkdownToFeedHtml } from '@/lib/markdown'
import { msg } from '@/test/render-intl'
import { Checklist } from './Checklist'
import { Details } from './Details'
import { Pullquote } from './Pullquote'
import { Step } from './Step'
import { Steps } from './Steps'
import { Takeaways } from './Takeaways'

const page = async (markdown: string) => {
  const result = await renderMarkdown(markdown)
  return { ...result, ...render(<>{result.content}</>) }
}

/** Every class of the block that sets a fixed pixel width or a negative margin: blocks fill the column the page shell gives them. */
/** The wrapping rule that lets a long unbroken word break inside the frame of a block. */
const WRAP = '[overflow-wrap:anywhere]'

const FIXED_WIDTH = /(^|\s)(w|min-w|max-w)-\[\d+px\]|(^|\s)-m[xlrtb]?-/

function expectWidthAgnostic(container: HTMLElement) {
  for (const element of container.querySelectorAll('[class]')) {
    expect(element.getAttribute('class'), element.tagName).not.toMatch(FIXED_WIDTH)
  }
  const root = container.querySelector('[data-block]')!
  expect(root.className).toContain('not-prose')
  expect(root.className).toContain('min-w-0')
  expect(root.className).toContain('max-w-full')
}

describe('steps and step', () => {
  const sample = (variant: 'sequential' | 'grouped' = 'sequential', title?: string) => (
    <Steps props={{ variant, title }}>
      <Step props={{ title: 'Install the tool' }}>
        <p>Download it.</p>
      </Step>
      <Step props={{ title: 'Run it' }}>
        <p>Start it.</p>
      </Step>
    </Steps>
  )

  it('is an ordered list with one item per step and the title of each step in it', () => {
    const { container } = render(sample())

    const list = container.querySelector('ol')!
    expect(list).not.toBeNull()
    const items = list.querySelectorAll(':scope > li')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('Install the tool')
    expect(items[0]).toHaveTextContent('Download it.')
    expect(items[1]).toHaveTextContent('Run it')
    expect(container.querySelectorAll('[data-block="step"]')).toHaveLength(2)
  })

  it('keeps the list a list for assistive technology and hides the drawn number from it', () => {
    const { container } = render(sample())

    expect(container.querySelector('ol')).toHaveAttribute('role', 'list')
    const badges = container.querySelectorAll('li > [aria-hidden="true"]')
    expect(badges).toHaveLength(2)
    for (const badge of badges) expect(badge).toBeEmptyDOMElement()
  })

  it('names the list by its title, or by a default label when there is no title', () => {
    const titled = render(sample('sequential', 'Install'))
    const list = titled.container.querySelector('ol')!
    expect(titled.getByText('Install')).toHaveAttribute('id', list.getAttribute('aria-labelledby'))
    titled.unmount()

    const plain = render(sample())
    expect(plain.getByRole('list', { name: msg('Site.blocks.stepsLabel') })).toBeInTheDocument()
  })

  it('does not use a heading for the title, so the table of contents of the article stays right', () => {
    const { container } = render(sample('sequential', 'Install'))

    expect(container.querySelector('h1,h2,h3,h4,h5,h6')).toBeNull()
  })

  it('numbers the steps with a CSS counter: reset on the list, one increment and one drawn number per badge, in both variants', () => {
    // jsdom evaluates no counters, so the class tokens are what can be pinned here: without the reset on the list every badge
    // would read 1. The drawn numbers themselves need a browser to be checked.
    for (const variant of ['sequential', 'grouped'] as const) {
      const { container, unmount } = render(sample(variant))

      expect(container.querySelector('ol')!.className).toContain('[counter-reset:blk-step]')
      const badges = container.querySelectorAll('li > [aria-hidden="true"]')
      expect(badges, variant).toHaveLength(2)
      for (const badge of badges) {
        expect(badge.className, variant).toContain('[counter-increment:blk-step]')
        expect(badge.className, variant).toContain('before:content-[counter(blk-step)]')
      }
      unmount()
    }
  })

  it('marks the variant on the block and keeps one list item per step in both variants', () => {
    const sequential = render(sample('sequential'))
    expect(sequential.container.querySelector('[data-block="steps"]')).toHaveAttribute('data-variant', 'sequential')
    sequential.unmount()

    const grouped = render(sample('grouped'))
    expect(grouped.container.querySelector('[data-block="steps"]')).toHaveAttribute('data-variant', 'grouped')
    expect(grouped.container.querySelectorAll('ol > li')).toHaveLength(2)
  })

  it('lets a long step title wrap instead of overflowing', () => {
    const long = 'A'.repeat(200)
    const { container } = render(
      <Steps props={{ variant: 'sequential' }}>
        <Step props={{ title: long }} />
      </Steps>,
    )

    const title = within(container.querySelector('li')!).getByText(long)
    expect(title.className).toContain(WRAP)
    expect(title.className).not.toMatch(/truncate|whitespace-nowrap/)
  })

  it('has dark classes, container queries and no fixed pixel width', () => {
    const { container } = render(sample())

    expect(container.innerHTML).toContain('dark:')
    expect(container.querySelector('[data-block="steps"]')!.className).toContain('@container')
    expectWidthAgnostic(container)
  })

  it('keeps Markdown, code and images inside a step, in order, through the real pipeline', async () => {
    const { container, problems } = await page(
      [
        '::::steps{title="Install"}',
        ':::step{title="Get it"}',
        'Download the **archive**.',
        '',
        '1. First',
        '2. Second',
        '',
        '```bash',
        'curl -O https://example.com/a.zip',
        '```',
        ':::',
        ':::step{title="See it"}',
        '![The window](/media/0b5c3f1e-2d4a-4b6c-8d9e-0f1a2b3c4d5e.png#640x480)',
        ':::',
        '::::',
      ].join('\n'),
    )

    expect(problems).toEqual([])
    const items = container.querySelectorAll('[data-block="steps"] > ol > li')
    expect(items).toHaveLength(2)
    expect(items[0]!.querySelector('strong')).toHaveTextContent('archive')
    // A list inside a step is its own list and numbers from 1, not from the number of the step.
    expect(items[0]!.querySelectorAll('ol')).toHaveLength(1)
    expect(items[0]!.querySelector('pre')).toHaveTextContent('curl -O https://example.com/a.zip')
    expect(items[1]!.querySelector('img')).toHaveAttribute('alt', 'The window')
    // The newlines between the child blocks are not rendered as content.
    expect(container.textContent).not.toContain(':::')
  })

  it('becomes a plain ordered list in the feed', async () => {
    const html = await renderMarkdownToFeedHtml(
      '::::steps\n:::step{title="One"}\nText.\n:::\n:::step{title="Two"}\nMore.\n:::\n::::',
      'https://blog.example/posts/x',
    )

    expect(html).toContain('<ol>')
    expect(html.match(/<li>/g)).toHaveLength(2)
    expect(html).not.toContain('ai-block')
  })
})

describe('details', () => {
  const sample = (props: Partial<React.ComponentProps<typeof Details>['props']> = {}) => (
    <Details props={{ title: 'Troubleshooting', open: false, variant: 'inline', ...props }}>
      <p>Hidden text.</p>
    </Details>
  )

  it('is a native details element with the title as its summary', () => {
    const { container } = render(sample())

    const details = container.querySelector('details')!
    expect(details).not.toBeNull()
    expect(details.querySelector(':scope > summary')).toHaveTextContent('Troubleshooting')
    expect(details).toHaveTextContent('Hidden text.')
  })

  it('is closed by default and open when the prop says so', () => {
    const closed = render(sample())
    expect(closed.container.querySelector('details')).not.toHaveAttribute('open')
    closed.unmount()

    const open = render(sample({ open: true }))
    expect(open.container.querySelector('details')).toHaveAttribute('open')
  })

  it('is operated through its summary: focusable, never taken out of the tab order, toggling on activation', () => {
    const { container } = render(sample())
    const details = container.querySelector('details')!
    const summary = container.querySelector('summary')!

    // Enter and Space on a focused summary are turned into a click by the browser itself, with no script of ours: so the summary has
    // to stay a native, focusable summary, and a click has to toggle the details.
    summary.focus()
    expect(summary).toHaveFocus()
    expect(summary).not.toHaveAttribute('tabindex', '-1')
    expect(summary).not.toHaveAttribute('role')
    expect(details.open).toBe(false)
    fireEvent.click(summary)
    expect(details.open).toBe(true)
    fireEvent.click(summary)
    expect(details.open).toBe(false)
  })

  it('shows a visible focus ring on the summary and does not remove the native marker semantics', () => {
    const { container } = render(sample())

    expect(container.querySelector('summary')!.className).toMatch(/focus-visible:outline/)
  })

  it('marks the variant, and the two variants look different', () => {
    const inline = render(sample({ variant: 'inline' }))
    const inlineClass = inline.container.querySelector('details')!.className
    expect(inline.container.querySelector('[data-block="details"]')).toHaveAttribute('data-variant', 'inline')
    inline.unmount()

    const appendix = render(sample({ variant: 'appendix' }))
    expect(appendix.container.querySelector('[data-block="details"]')).toHaveAttribute('data-variant', 'appendix')
    expect(appendix.container.querySelector('details')!.className).not.toBe(inlineClass)
  })

  it('does not use a heading for the title, wraps a long one, and has dark classes and no fixed width', () => {
    const long = 'B'.repeat(200)
    const { container } = render(sample({ title: long }))

    expect(container.querySelector('h1,h2,h3,h4,h5,h6')).toBeNull()
    expect(screen.getByText(long).className).toContain(WRAP)
    expect(container.innerHTML).toContain('dark:')
    expectWidthAgnostic(container)
  })

  it('stops the chevron from animating for readers who ask for less motion', () => {
    const { container } = render(sample())

    const animated = [...container.querySelectorAll('[class]')].filter((element) =>
      /\btransition/.test(element.className.toString()),
    )
    for (const element of animated) expect(element.className.toString()).toContain('motion-reduce:transition-none')
  })

  it('becomes a native details element in the feed, open when asked', async () => {
    const html = await renderMarkdownToFeedHtml(
      ':::details{title="More" open}\nBody.\n:::\n\n:::details{title="Closed"}\nOther.\n:::',
      'https://blog.example/posts/x',
    )

    expect(html).toMatch(/<details open[^>]*><summary>More<\/summary>/)
    expect(html).toMatch(/<details><summary>Closed<\/summary>/)
  })

  it('keeps nested blocks and Markdown inside, through the real pipeline', async () => {
    const { container, problems } = await page(':::details{title="Why"}\nBecause **reasons**.\n\n- a\n- b\n:::')

    expect(problems).toEqual([])
    const details = container.querySelector('details')!
    expect(details.querySelector('strong')).toHaveTextContent('reasons')
    expect(details.querySelectorAll('li')).toHaveLength(2)
    expect(details).not.toHaveAttribute('open')
  })
})

describe('takeaways', () => {
  const sample = (title?: string) => (
    <Takeaways props={{ title }}>
      <ul>
        <li>One</li>
        <li>Two</li>
      </ul>
    </Takeaways>
  )

  it('keeps the list a list inside a labelled group', () => {
    const { container } = render(sample('In short'))

    const group = screen.getByRole('group', { name: 'In short' })
    expect(group).toContainElement(container.querySelector('ul'))
    expect(within(group).getAllByRole('listitem')).toHaveLength(2)
  })

  it('names the group with a default label when there is no title, and shows no empty title', () => {
    const { container } = render(sample())

    expect(screen.getByRole('group', { name: msg('Site.blocks.takeawaysLabel') })).toBeInTheDocument()
    expect(container.querySelector('p')).toBeNull()
  })

  it('does not use a heading, has dark classes and no fixed width', () => {
    const { container } = render(sample('In short'))

    expect(container.querySelector('h1,h2,h3,h4,h5,h6')).toBeNull()
    expect(container.innerHTML).toContain('dark:')
    expectWidthAgnostic(container)
  })

  it('has one list marker color, the brand one, and not the neutral marker of the shared block typography as well', () => {
    const { container } = render(sample('In short'))

    const tokens = container.querySelector('ul')!.parentElement!.className.split(/\s+/)
    expect(tokens).toContain('[&_li::marker]:text-brand')
    expect(tokens.filter((token) => token.includes('::marker]:text-'))).toEqual(['[&_li::marker]:text-brand'])
  })

  it('draws a Markdown list through the real pipeline, and is a plain list in the feed', async () => {
    const markdown = ':::takeaways{title="In short"}\n- First point\n- Second point\n:::'
    const { container, problems } = await page(markdown)

    expect(problems).toEqual([])
    expect(container.querySelectorAll('[data-block="takeaways"] li')).toHaveLength(2)

    const html = await renderMarkdownToFeedHtml(markdown, 'https://blog.example/posts/x')
    expect(html).toContain('In short')
    expect(html.match(/<li>/g)).toHaveLength(2)
  })
})

describe('checklist', () => {
  const MARKDOWN = ':::checklist{title="Before you start"}\n- [x] Install the tool\n- [ ] Read the **guide**\n:::'

  it('says for every item, as text, whether it is done', async () => {
    const { container, problems } = await page(MARKDOWN)

    expect(problems).toEqual([])
    const items = container.querySelectorAll('[data-block="checklist"] li')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent(`${msg('Site.blocks.itemDone')} Install the tool`)
    expect(items[1]).toHaveTextContent(`${msg('Site.blocks.itemNotDone')} Read the guide`)
    expect(items[1]!.querySelector('strong')).toHaveTextContent('guide')
  })

  it('is read-only: it holds no checkbox or other control a reader could change', async () => {
    const { container } = await page(MARKDOWN)

    expect(container.querySelector('input')).toBeNull()
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    expect(container.querySelector('[tabindex]')).toBeNull()
  })

  it('keeps the list semantics and names the group by its title, or by a default label', async () => {
    const titled = await page(MARKDOWN)
    expect(screen.getByRole('group', { name: 'Before you start' })).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    titled.unmount()

    render(
      <Checklist props={{}}>
        <ul>
          <li>Plain item</li>
        </ul>
      </Checklist>,
    )
    expect(screen.getByRole('group', { name: msg('Site.blocks.checklistLabel') })).toBeInTheDocument()
    // An item that is not a task is left as it is.
    expect(screen.getByText('Plain item')).toBeInTheDocument()
  })

  it('tells done from not done by the shape of the mark as well as by the text', async () => {
    const { container } = await page(MARKDOWN)

    const [done, notDone] = [...container.querySelectorAll('[data-block="checklist"] li [data-state]')]
    expect(done).toHaveAttribute('data-state', 'done')
    expect(done!.querySelector('svg')).not.toBeNull()
    expect(notDone).toHaveAttribute('data-state', 'todo')
    expect(notDone!.querySelector('svg')).toBeNull()
  })

  it('has dark classes and no fixed width, and no heading', async () => {
    const { container } = await page(MARKDOWN)

    expect(container.querySelector('h1,h2,h3,h4,h5,h6')).toBeNull()
    expect(container.querySelector('[data-block="checklist"]')!.innerHTML).toContain('dark:')
    expectWidthAgnostic(container)
  })

  it('is its list in the feed, with the task marks the reader draws', async () => {
    const html = await renderMarkdownToFeedHtml(MARKDOWN, 'https://blog.example/posts/x')

    expect(html).toContain('Before you start')
    expect(html).toContain('Install the tool')
    expect(html).not.toContain('ai-block')
  })

  it('writes the state of every task as text in the feed, where a reader may strip the checkboxes', async () => {
    const html = await renderMarkdownToFeedHtml(MARKDOWN, 'https://blog.example/posts/x')

    expect(html).not.toContain('<input')
    expect(html).toContain('[x] Install the tool')
    expect(html).toContain('[ ] Read the <strong>guide</strong>')
  })
})

describe('long unbroken words in the content of a block', () => {
  const LONG = 'https://example.com/' + 'a'.repeat(120)

  it.each([
    ['step', '[data-block="step"]', '::::steps\n:::step{title=A}\nLONG\n:::\n::::'],
    ['details', '[data-block="details"]', ':::details{title=T}\nLONG\n:::'],
    ['takeaways', '[data-block="takeaways"]', ':::takeaways\n- LONG\n:::'],
    ['checklist', '[data-block="checklist"]', ':::checklist\n- [ ] LONG\n:::'],
  ])('sets the wrapping rule on the content wrapper of %s', async (_name, selector, template) => {
    const { container, problems } = await page(template.replace('LONG', LONG))

    expect(problems).toEqual([])
    const content = container.querySelector(`${selector} .prose`)!
    expect(content).not.toBeNull()
    expect(content.className).toContain(WRAP)
  })
})

describe('pullquote', () => {
  it('is a blockquote with the quotation, and the attribution inside it', () => {
    const { container } = render(
      <Pullquote props={{ attribution: 'A teacher' }}>
        <p>Make it work first.</p>
      </Pullquote>,
    )

    const quote = container.querySelector('blockquote')!
    expect(quote).not.toBeNull()
    expect(quote).toHaveTextContent('Make it work first.')
    expect(quote.querySelector('footer')).toHaveTextContent('A teacher')
  })

  it('shows no attribution line when there is none', () => {
    const { container } = render(
      <Pullquote props={{}}>
        <p>Short.</p>
      </Pullquote>,
    )

    expect(container.querySelector('blockquote')).toHaveTextContent('Short.')
    expect(container.querySelector('footer')).toBeNull()
  })

  it('has dark classes and no fixed width', () => {
    const { container } = render(
      <Pullquote props={{ attribution: 'Someone' }}>
        <p>Quote.</p>
      </Pullquote>,
    )

    expect(container.innerHTML).toContain('dark:')
    expectWidthAgnostic(container)
  })

  it('keeps its own rule width, weight and colors against the .prose blockquote rules of the site, which are out of any layer', () => {
    // jsdom loads no CSS, so the class tokens are what can be pinned here: only an important modifier beats the unlayered rules.
    const { container } = render(
      <Pullquote props={{}}>
        <p>Quote.</p>
      </Pullquote>,
    )

    const tokens = container.querySelector('blockquote')!.className.split(/\s+/)
    for (const token of ['border-l-4!', 'font-medium!', 'text-neutral-900!', 'dark:text-neutral-100!']) {
      expect(tokens, token).toContain(token)
    }
  })

  it('draws Markdown inside the quotation through the real pipeline, and is a blockquote in the feed', async () => {
    const markdown = ':::pullquote{attribution="An author"}\nSmall **steps** count.\n:::'
    const { container, problems } = await page(markdown)

    expect(problems).toEqual([])
    expect(container.querySelector('[data-block="pullquote"] strong')).toHaveTextContent('steps')

    const html = await renderMarkdownToFeedHtml(markdown, 'https://blog.example/posts/x')
    expect(html).toContain('<blockquote>')
    expect(html).toContain('An author')
  })
})
