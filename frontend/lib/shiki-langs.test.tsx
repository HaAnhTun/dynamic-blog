import { IntlWrapper } from '@/test/intl'
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '@/lib/markdown'
import { renderToStaticMarkup } from 'react-dom/server'

async function html(md: string) {
  const { content } = await renderMarkdown(md)
  return renderToStaticMarkup(<IntlWrapper>{content as never}</IntlWrapper>)
}

describe('shiki language coverage', () => {
  it.each([
    ['python', 'def handler(event, context):\n    return {"ok": True}'],
    ['xml', '<dependency>\n  <groupId>org.x</groupId>\n</dependency>'],
    ['tsx', 'const A = () => <div className="x">hi</div>'],
    ['java', 'public class A { }'],
  ])('highlights %s', async (lang, code) => {
    const out = await html('```' + lang + '\n' + code + '\n```\n')
    // A highlighted fence carries per-token <span style="color:...">. An unhighlighted
    // one falls back to `text` and has a single span with no colour, so counting
    // coloured spans is the channel that distinguishes them.
    const coloured = (out.match(/style="color:/g) ?? []).length
    expect(coloured, `${lang} produced ${coloured} coloured tokens`).toBeGreaterThan(2)
  })

  it('a genuinely unknown language falls back instead of throwing', async () => {
    // The control for the assertion above: this proves the >2 threshold is measuring
    // highlighting and not just "the fence rendered".
    const out = await html('```klingon\nnuqneH\n```\n')
    expect(out).toContain('nuqneH')
    expect((out.match(/style="color:/g) ?? []).length).toBeLessThanOrEqual(2)
  })
})
