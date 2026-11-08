import { render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FIXTURES, packageNames } from '../../../scripts/fixtures/build-article-zips.mjs'
import { msg } from '@/test/render-intl'
import { renderMarkdown } from '../markdown'
import { countBlocks } from './summary'

/**
 * The example articles of `fixtures/article-packages/`, drawn through the real pipeline and the real block components (the other
 * fixture tests only read the Markdown): every block an article uses is drawn, and nothing is reported or left as plain content.
 */

function bodyOf(name: string): string {
  const text = readFileSync(join(FIXTURES, name, 'article.md'), 'utf8').replace(/\r\n/g, '\n')
  const match = /^---\n[\s\S]*?\n---\n\n([\s\S]*)$/.exec(text)
  if (!match) throw new Error(`${name}: the article needs front matter and a body`)
  return match[1]!
}

describe('the example article fixtures, rendered', () => {
  it.each(packageNames() as string[])('%s is drawn with every block it uses and with no problem', async (name) => {
    const body = bodyOf(name)
    const { content, problems } = await renderMarkdown(body)
    const { container } = render(<>{content}</>)

    expect(problems).toEqual([])
    expect(container.querySelector('ai-block')).toBeNull()
    expect(container.textContent).not.toMatch(/:::|::figure/)
    for (const { type, count } of countBlocks(body)) {
      expect(container.querySelectorAll(`[data-block="${type}"]`), type).toHaveLength(count)
    }
  })
})

describe('the postmortem example, rendered', () => {
  async function drawn() {
    const { content } = await renderMarkdown(bodyOf('g-postmortem'))
    return render(<>{content}</>).container
  }
  const texts = (elements: Iterable<Element>) => [...elements].map((element) => element.textContent)

  it('draws each figure with the arrow of its trend and the word for it', async () => {
    const container = await drawn()
    const metrics = [...container.querySelectorAll('[data-block="metrics"] [data-block="metric"]')]

    expect(metrics).toHaveLength(3)
    expect(metrics.map((metric) => metric.querySelector('svg')?.getAttribute('data-trend'))).toEqual(['down', 'up', 'flat'])
    metrics.forEach((metric, index) => {
      expect(metric.textContent).toContain(msg(`Site.blocks.metric.trend.${['down', 'up', 'flat'][index]}`))
    })
  })

  it('draws the timeline in order, with the callout inside the event that holds it', async () => {
    const container = await drawn()
    const events = [...container.querySelectorAll('[data-block="timeline"] > ol > [data-block="event"]')]

    expect(events).toHaveLength(4)
    expect(events.map((event) => event.querySelector('p')?.textContent)).toEqual(['09:02', '09:40', '10:15', '11:30'])
    expect(events[2]!.querySelector('[data-block="callout"]')).not.toBeNull()
  })

  it('draws the file tree as a nested list with a folder inside a folder', async () => {
    const container = await drawn()
    const tree = container.querySelector('[data-block="file-tree"]')!

    expect(tree.querySelectorAll('li')).toHaveLength(7)
    expect(tree.querySelector('ul ul ul')).not.toBeNull()
    const first = [...tree.querySelectorAll(':scope > div > ul > li')].map((item) => item.firstChild?.textContent?.trim())
    expect(first).toEqual(['relay/', 'deploy.yaml'])
  })

  it('draws three tabs, shows the first and keeps the steps of the last one in the page', async () => {
    const container = await drawn()
    const tabs = container.querySelector('[data-block="tabs"]')!
    const labels = [...tabs.querySelectorAll('[role="tab"]')]
    const panels = [...tabs.querySelectorAll('[role="tabpanel"]')]

    expect(texts(labels)).toEqual(['macOS', 'Linux', 'Windows'])
    expect(labels.map((label) => label.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false'])
    expect(panels.map((panel) => panel.hasAttribute('hidden'))).toEqual([false, true, true])
    expect(panels[2]!.querySelectorAll('[data-block="steps"] [data-block="step"]')).toHaveLength(2)
  })

  it('draws the two questions as details that share a name, so that one opens at a time', async () => {
    const container = await drawn()
    const questions = [...container.querySelectorAll('details[data-block="details"]')]

    expect(questions.map((question) => question.getAttribute('name'))).toEqual(['questions', 'questions'])
    expect(questions.some((question) => question.hasAttribute('open'))).toBe(false)
  })

  it('marks the lines of the diff and the lines the highlight names, and keeps the signs in the text', async () => {
    const container = await drawn()
    const panel = (title: string) =>
      [...container.querySelectorAll('[data-code-block]')].find(
        (block) => block.querySelector('[data-code-title]')?.textContent === title,
      )
    const diff = panel('deploy.yaml')
    const highlighted = panel('limits.yaml')

    expect(diff).toBeDefined()
    expect(highlighted).toBeDefined()
    expect(texts(diff!.querySelectorAll('.line[data-diff="remove"]')).map((text) => text?.trim()[0])).toEqual(['-', '-'])
    expect(texts(diff!.querySelectorAll('.line[data-diff="add"]')).map((text) => text?.trim()[0])).toEqual(['+', '+'])
    expect(texts(highlighted!.querySelectorAll('.line[data-highlighted]')).map((text) => text?.trim())).toEqual([
      'retries: 5',
      'name: default',
      'depth_alarm: 5000',
      'drain_rate: 100',
    ])
  })
})
