import { describe, expect, it } from 'vitest'
import { colonsOf } from './authoring-prompt'
import { validateBlocks } from './validate'
import type { Problem } from './types'

const codes = (problems: Problem[]) => problems.map((p) => p.code)
const one = (markdown: string): Problem => {
  const problems = validateBlocks(markdown)
  expect(problems, markdown).toHaveLength(1)
  return problems[0]!
}

describe('validateBlocks: articles that are valid', () => {
  it('accepts an article of headings and prose with no block at all', () => {
    expect(validateBlocks('## One\n\nText with a [link](https://example.com) and `code`.\n\n### Two\n\n- a\n- b\n')).toEqual([])
  })

  it('accepts an empty article', () => {
    expect(validateBlocks('')).toEqual([])
  })

  it('accepts an article of several callouts, a table, code and a diagram', () => {
    const markdown = [
      '## Design',
      '',
      ':::callout{type=warning title="Careful" variant=prominent}',
      'Do not run this twice.',
      ':::',
      '',
      ':::comparison{title="Options" caption="Measured on one machine."}',
      '| Option | Cost |',
      '| --- | --- |',
      '| A | low |',
      ':::',
      '',
      ':::diagram{type=mermaid alt="Request flow"}',
      'graph TD',
      '  A[Client] --> B[Server]',
      ':::',
      '',
      '```java title="Hello.java"',
      'class Hello {}',
      '```',
      '',
      ':::callout{type=tip}',
      'Cache it.',
      ':::',
    ].join('\n')
    expect(validateBlocks(markdown)).toEqual([])
  })

  it('accepts a tutorial: steps with nested blocks, details, a checklist and a figure', () => {
    const markdown = [
      '## Setup',
      '',
      '::::steps{title="Install"}',
      ':::step{title="Download"}',
      'Get the archive.',
      '',
      '::figure{src="assets/download.png" alt="The download page" caption="The page"}',
      ':::',
      ':::step{title="Run"}',
      '```bash',
      './run.sh',
      '```',
      ':::',
      '::::',
      '',
      ':::checklist{title="Before you start"}',
      '- [ ] Java installed',
      '- [x] Archive downloaded',
      ':::',
      '',
      ':::details{title="Troubleshooting" variant=appendix open}',
      'If it fails, read the log.',
      ':::',
    ].join('\n')
    expect(validateBlocks(markdown)).toEqual([])
  })

  it('accepts compare with panes, code tabs, a gallery, takeaways and a pullquote', () => {
    const markdown = [
      '::::compare{variant=before-after}',
      ':::pane{title="Before"}',
      'Slow.',
      ':::',
      ':::pane{title="After"}',
      'Fast.',
      ':::',
      '::::',
      '',
      ':::code-tabs{title="Hello"}',
      '```python title="hello.py"',
      'print(1)',
      '```',
      '```bash title="Shell"',
      'echo 1',
      '```',
      ':::',
      '',
      ':::gallery{columns=3 caption="Screens"}',
      '![First](assets/a.png)',
      '![Second](assets/b.png)',
      ':::',
      '',
      ':::takeaways{title="Remember"}',
      '- One',
      '- Two',
      ':::',
      '',
      ':::pullquote{attribution="A reader"}',
      'Short and sharp.',
      ':::',
    ].join('\n')
    expect(validateBlocks(markdown)).toEqual([])
  })

  it('does not look inside code fences or inline code', () => {
    const markdown = ['```markdown', ':::nonsense{x=1}', 'text', '```', '', 'Write `:::callout` to start one.'].join('\n')
    expect(validateBlocks(markdown)).toEqual([])
  })

  it('leaves prose with colons alone: times, ratios, emoji codes and words after a colon', () => {
    expect(validateBlocks('Meet at 10:30, ratio 3:2, Note:this and :smile: and http://example.com/a:b.')).toEqual([])
  })
})

describe('validateBlocks: each class of problem is reported with a line and an actionable message', () => {
  it('unknown block: names it, lists the supported blocks and suggests the closest', () => {
    const problem = one('Intro\n\n:::callot{type=note}\nText\n:::\n')
    expect(problem).toMatchObject({ line: 3, code: 'unknown-block' })
    expect(problem.message).toContain('Unknown block "callot"')
    expect(problem.message).toContain('"callout"')
    expect(problem.message).toContain('"code-tabs"')
    expect(problem.message).toContain('Did you mean "callout"?')
  })

  it('unknown attribute: lists the allowed attributes', () => {
    const problem = one(':::callout{kind=warning}\nText\n:::')
    expect(problem).toMatchObject({ line: 1, code: 'unknown-attribute', block: 'callout' })
    expect(problem.message).toContain('"kind"')
    expect(problem.message).toContain('"type", "title", "variant"')
  })

  it('class and id shortcuts are unknown attributes, never CSS hooks', () => {
    const problems = validateBlocks(':::callout{.wide #x}\nText\n:::')
    expect(codes(problems)).toEqual(['unknown-attribute', 'unknown-attribute'])
  })

  it('missing required attribute', () => {
    const problem = one('::figure{src="assets/a.png"}')
    expect(problem).toMatchObject({ line: 1, code: 'missing-attribute', block: 'figure' })
    expect(problem.message).toContain('"alt"')
  })

  it('bad enum value: lists the allowed values', () => {
    const problem = one(':::callout{type=alert}\nText\n:::')
    expect(problem).toMatchObject({ line: 1, code: 'bad-attribute' })
    expect(problem.message).toContain('"info", "note", "tip", "warning", "danger"')
    expect(problem.message).toContain('got "alert"')
  })

  it('bad integer and bad flag', () => {
    expect(one(':::gallery{columns=5}\n![a](assets/a.png)\n![b](assets/b.png)\n:::').message).toContain('from 2 to 3')
    expect(one(':::details{title=T open=yes}\nText\n:::').message).toContain('flag')
  })

  it('refuses an image source that is not a package path, a /media path or an https URL', () => {
    for (const src of [
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      'http://example.com/a.png',
      '//example.com/a.png',
      '../a.png',
      '/etc/passwd',
      'a\\\\b.png',
    ]) {
      const problem = one(`::figure{src="${src}" alt="x"}`)
      expect(problem.code, src).toBe('bad-attribute')
    }
    for (const src of [
      'assets/a.png',
      'a/b/c.webp',
      '/media/0b5c3f1e-2d4a-4b6c-8d9e-0f1a2b3c4d5e.png#640x480',
      'https://example.com/a.png',
    ]) {
      expect(validateBlocks(`::figure{src="${src}" alt="x"}`), src).toEqual([])
    }
  })

  it('too long text', () => {
    expect(one(`:::callout{title="${'x'.repeat(121)}"}\nText\n:::`).message).toContain('longer than 120')
  })

  it('heading inside a block, with the heading line', () => {
    const problem = one(':::callout\nText\n\n## Not here\n:::')
    expect(problem).toMatchObject({ line: 4, code: 'heading-in-block', block: 'callout' })
  })

  it('heading inside a list inside a block', () => {
    const problems = validateBlocks(':::details{title=T}\n- item\n\n  ## deep\n:::')
    expect(codes(problems)).toContain('heading-in-block')
  })

  it('unclosed block: points at the opening line and explains the colon rule', () => {
    const problem = one('Text\n\n:::callout{type=note}\nNever closed.\n')
    expect(problem).toMatchObject({ line: 3, code: 'unclosed-block', block: 'callout' })
    // The example in the message is the real nesting, with the counts the registry computes (never counts written by hand).
    const colons = (type: string) => ':'.repeat(colonsOf(type))
    expect(problem.message).toContain(`${colons('steps')}steps around ${colons('step')}step around ${colons('callout')}callout`)
  })

  it('an inner block closed by the outer fence is unclosed too', () => {
    const problems = validateBlocks(['::::steps', ':::step{title=A}', 'text', '::::'].join('\n'))
    expect(problems.map((p) => [p.line, p.code, p.block])).toEqual([[2, 'unclosed-block', 'step']])
  })

  it('a block nested with as many colons as its parent cannot close', () => {
    const problems = validateBlocks([':::steps', ':::step{title=A}', 'text', ':::', ':::'].join('\n'))
    expect(codes(problems)).toContain('unclosed-block')
  })

  it('bad nesting: a block the parent does not allow', () => {
    const problem = one(['::::callout', '::figure{src="assets/a.png" alt="x"}', '::::'].join('\n'))
    expect(problem).toMatchObject({ line: 2, code: 'bad-nesting', block: 'figure' })
    expect(problem.message).toContain('Markdown only')
  })

  it('bad nesting: pane or step on their own', () => {
    expect(one(':::pane{title=A}\nText\n:::')).toMatchObject({ code: 'bad-nesting', block: 'pane' })
    expect(one(':::step{title=A}\nText\n:::').message).toContain('"steps"')
  })

  it('bad nesting: a block inside a list or a quote', () => {
    const problems = validateBlocks('- item\n\n  :::callout\n  Text\n  :::\n')
    expect(codes(problems)).toEqual(['bad-nesting'])
    expect(validateBlocks('> :::callout\n> Text\n> :::\n').map((p) => p.code)).toEqual(['bad-nesting'])
  })

  it('a text directive that looks like a block', () => {
    const problem = one('Use :callout{type=note} here.')
    expect(problem).toMatchObject({ line: 1, code: 'text-directive', block: 'callout' })
    expect(problem.message).toContain(':::callout')
    expect(one('Look at :smile[happy] now.').code).toBe('text-directive')
  })

  it('a line that looks like a block line but is not one: a broken attribute list, an extra closing line, two colons used as a closer', () => {
    const broken = validateBlocks(['Intro.', '', ':::callout{type="tip}', 'Body.', ':::'].join('\n'))
    expect(broken.map((p) => [p.line, p.code])).toEqual([
      [3, 'bad-fence'],
      [5, 'bad-fence'],
    ])
    expect(broken[0]!.message).toContain('check the quotes and the closing brace')

    const extra = validateBlocks([':::callout', 'Body.', ':::', '', ':::'].join('\n'))
    expect(extra.map((p) => [p.line, p.code])).toEqual([[5, 'bad-fence']])

    const wrongCloser = validateBlocks([':::callout', 'Body.', '::'].join('\n'))
    expect(wrongCloser.map((p) => p.code).sort()).toEqual(['bad-fence', 'unclosed-block'])

    // A block that starts on the line right after a paragraph interrupts it, as a code fence does: nothing to report.
    expect(validateBlocks(['Intro line', ':::callout', 'Body.', ':::'].join('\n'))).toEqual([])
  })

  it('does not report colons in prose, code, or escaped at the start of a line', () => {
    expect(validateBlocks('Text.\n\n\\::not a directive\n\n```\n:::\n```\n\nAnd a: b::c.')).toEqual([])
  })

  it('the reserved <ai-block> tag', () => {
    expect(one('<ai-block block="callout">x</ai-block>')).toMatchObject({ line: 1, code: 'reserved-tag' })
  })

  it('a label in square brackets', () => {
    expect(one(':::callout[Title here]\nText\n:::').code).toBe('bad-label')
  })

  it('leaf and container forms: a container block written as a leaf and the other way round', () => {
    expect(one('::callout{type=note}').code).toBe('bad-form')
    const figure = validateBlocks(':::figure{src="assets/a.png" alt="x"}\nBody text.\n:::')
    expect(codes(figure)).toEqual(['bad-body'])
    expect(validateBlocks(':::figure{src="assets/a.png" alt="x"}\n:::')).toEqual([])
  })

  it('body rules: comparison needs a table, takeaways a list, checklist a task list', () => {
    expect(one(':::comparison\nOnly text.\n:::').message).toContain('table')
    expect(one(':::takeaways\nOnly text.\n:::').message).toContain('list')
    expect(one(':::checklist\n- plain\n- items\n:::').message).toContain('- [ ] item')
  })

  it('body rules: gallery of images only with alt text and at least two', () => {
    expect(one(':::gallery\nText.\n:::').message).toContain('images only')
    expect(one(':::gallery\n![](assets/a.png)\n![b](assets/b.png)\n:::').message).toContain('alternative text')
    expect(one(':::gallery\n![a](assets/a.png)\n:::').message).toContain('at least 2')
  })

  it('body rules: compare takes two or three panes, two for before-after; steps takes steps only', () => {
    expect(one('::::compare\n:::pane{title=A}\nx\n:::\n::::').message).toContain('at least 2')
    const three =
      '::::compare{variant=before-after}\n:::pane{title=A}\nx\n:::\n:::pane{title=B}\ny\n:::\n:::pane{title=C}\nz\n:::\n::::'
    expect(one(three).message).toContain('at most 2')
    expect(codes(validateBlocks('::::steps\nStray text.\n:::step{title=A}\nx\n:::\n::::'))).toEqual(['bad-body'])
  })

  it('body rules: code tabs need titled fences, unique, and at least two', () => {
    const untitled = ':::code-tabs\n```js\na\n```\n```py title="B"\nb\n```\n:::'
    expect(one(untitled).message).toContain('tab label')
    const duplicate = ':::code-tabs\n```js title="A"\na\n```\n```py title="a"\nb\n```\n:::'
    expect(one(duplicate).message).toContain('both labelled')
    expect(one(':::code-tabs\n```js title="A"\na\n```\n:::').message).toContain('at least 2')
  })

  it('body rules: empty bodies and an empty diagram', () => {
    expect(one(':::callout\n:::').message).toContain('no content')
    expect(one(':::diagram{type=mermaid}\n:::').message).toContain('no source')
  })

  it('a diagram body is raw: Markdown-looking lines inside it are not problems', () => {
    expect(validateBlocks(':::diagram{type=mermaid}\n# comment\n- a\n:name{x}\n## not a heading\n:::')).toEqual([])
  })

  it('a diagram body wrapped in a Markdown fence is a problem with an actionable message', () => {
    for (const fence of ['```', '~~~']) {
      const problem = one(`:::diagram{type=mermaid}\n${fence}mermaid\ngraph TD\n  A-->B\n${fence}\n:::`)
      expect(problem.code).toBe('bad-body')
      expect(problem.block).toBe('diagram')
      expect(problem.message).toContain('without a code fence')
      expect(problem.message).toContain(':::diagram')
    }
  })

  it('a fence-looking line later in a diagram body is not a problem', () => {
    expect(validateBlocks(':::diagram{type=mermaid}\ngraph TD\n  A-->B\n%% ```not a wrapper\n:::')).toEqual([])
  })

  it('a code fence title that is too long', () => {
    expect(one('```js title="' + 'x'.repeat(130) + '"\na\n```').code).toBe('bad-fence-title')
  })

  it('reports several problems in line order', () => {
    const problems = validateBlocks([':::callot', 'x', ':::', '', ':::callout{type=bad}', 'y', ':::'].join('\n'))
    expect(problems.map((p) => [p.line, p.code])).toEqual([
      [1, 'unknown-block'],
      [5, 'bad-attribute'],
    ])
  })

  it('works on text with Windows line endings', () => {
    const problems = validateBlocks(':::callout{type=bad}\r\nText\r\n:::\r\n\r\n:::diagram{type=mermaid}\r\ngraph TD\r\n:::\r\n')
    expect(codes(problems)).toEqual(['bad-attribute'])
  })
})

describe('validateBlocks: file-tree, timeline, metrics and tabs', () => {
  const metrics = (...lines: string[]) => [':::metrics{title="Figures"}', ...lines, ':::'].join('\n')
  const metric = '::metric{label="p95" value="38 ms" trend=down note="was 410 ms"}'
  const other = '::metric{label="Errors" value="0.2%"}'
  const tabs = (...tabs: string[]) =>
    ['::::tabs{title="Systems"}', ...tabs.map((title) => `:::tab{title="${title}"}\nText.\n:::`), '::::'].join('\n')

  it('accepts a file tree, a timeline with events, metrics with one-line metrics and tabs', () => {
    const markdown = [
      ':::file-tree{title="Layout"}',
      '- src/',
      '  - main.py',
      '- README.md',
      ':::',
      '',
      '::::timeline{title="Order of events"}',
      ':::event{title="First alert" when="09:02"}',
      'Paged.',
      ':::',
      ':::event{title="Fixed" when="11:30"}',
      ':::',
      '::::',
      '',
      metrics(metric, other),
      '',
      tabs('macOS', 'Linux'),
    ].join('\n')
    expect(validateBlocks(markdown)).toEqual([])
  })

  it('needs a list in a file tree, two events, two to six metrics and two tabs', () => {
    expect(one(':::file-tree\nJust text.\n:::').message).toContain('Markdown list')
    expect(one('::::timeline\n:::event{title=A when=1}\n:::\n::::').message).toContain('at least 2')
    expect(one(metrics(metric)).message).toContain('at least 2')
    expect(one(metrics(...Array.from({ length: 7 }, () => other))).message).toContain('at most 6')
    expect(one(tabs('Only one')).message).toContain('at least 2')
  })

  it('keeps a metric on one line, inside metrics, with its two required attributes', () => {
    expect(codes(validateBlocks(':::metrics\n:::metric{label=a value=1}\n:::\n' + other + '\n:::'))).toContain('bad-form')
    expect(one(metric)).toMatchObject({ code: 'bad-nesting', block: 'metric' })
    expect(one(metrics('::metric{label=a}', other))).toMatchObject({ code: 'missing-attribute', block: 'metric' })
    expect(one(metrics('::metric{label=a value=1 trend=sideways}', other)).message).toContain('"up", "down", "flat"')
  })

  it('keeps an event inside a timeline and a tab inside tabs', () => {
    expect(one(':::event{title=A when=1}\nx\n:::')).toMatchObject({ code: 'bad-nesting', block: 'event' })
    expect(one(':::tab{title=A}\nx\n:::')).toMatchObject({ code: 'bad-nesting', block: 'tab' })
  })

  it('names the new top-level blocks and every place a nested block belongs when a block is unknown', () => {
    const message = one(':::metricz\nx\n:::').message

    for (const type of ['file-tree', 'timeline', 'metrics', 'tabs']) expect(message).toContain(`"${type}"`)
    expect(message).toContain(
      '"pane" inside "compare", "step" inside "steps", "event" inside "timeline", "metric" inside "metrics" and "tab" inside "tabs"',
    )
  })

  it('reports two tabs with the same title, ignoring case, on the second one', () => {
    const problem = one(tabs('macOS', 'Linux', 'MACOS'))
    expect(problem).toMatchObject({ code: 'bad-body', block: 'tabs', line: 8 })
    expect(problem.message).toContain('both titled "MACOS"')
    expect(validateBlocks(tabs('macOS', 'Linux', 'Windows'))).toEqual([])
  })

  it('holds a tab to the blocks it lists: steps and a file tree are fine, a timeline is not', () => {
    const inside = (block: string) =>
      ['::::::tabs', ':::::tab{title=A}', block, ':::::', ':::::tab{title=B}', 'x', ':::::', '::::::'].join('\n')
    expect(validateBlocks(inside(':::file-tree\n- a/\n:::'))).toEqual([])
    expect(validateBlocks(inside('::::steps\n:::step{title=S}\n:::\n::::'))).toEqual([])
    expect(
      codes(validateBlocks(inside('::::timeline\n:::event{title=A when=1}\n:::\n:::event{title=B when=2}\n:::\n::::'))),
    ).toContain('bad-nesting')
  })

  it('takes a group on details', () => {
    expect(validateBlocks(':::details{title="Q" group="faq"}\nA.\n:::')).toEqual([])
    expect(one(':::details{title="Q" group=""}\nA.\n:::').code).toBe('bad-attribute')
  })

  describe('in a step and in details', () => {
    const tree = ':::file-tree{title="Layout"}\n- src/\n  - main.py\n:::'
    // Plenty of colons around the block, so that the only question is whether the parent lets it stand there.
    const inStep = (block: string) => ['::::::::steps', ':::::::step{title="Set up"}', block, ':::::::', '::::::::'].join('\n')
    const inDetails = (block: string) => ['::::::::details{title="More"}', block, '::::::::'].join('\n')

    it('lets a step and a details block hold a file tree', () => {
      expect(validateBlocks(inStep(tree))).toEqual([])
      expect(validateBlocks(inDetails(tree))).toEqual([])
    })

    it.each([
      ['tabs', tabs('macOS', 'Linux')],
      ['timeline', '::::timeline\n:::event{title=A when=1}\n:::\n:::event{title=B when=2}\n:::\n::::'],
      ['metrics', metrics(metric, other)],
    ])('keeps %s out of a step and out of details, where it would cost every author more colons', (type, block) => {
      for (const problems of [validateBlocks(inStep(block)), validateBlocks(inDetails(block))]) {
        expect(codes(problems), type).toContain('bad-nesting')
      }
    })
  })
})

describe('validateBlocks: fence highlight', () => {
  const fence = (meta: string, lines = 8) =>
    '```yaml ' + meta + '\n' + Array.from({ length: lines }, (_, i) => `k${i}: ${i}`).join('\n') + '\n```'

  it('accepts lines and ranges inside the code, on a fence and on a code tab', () => {
    expect(validateBlocks(fence('highlight="2,5-7"'))).toEqual([])
    expect(validateBlocks(fence('title="a.yaml" highlight=3'))).toEqual([])
    expect(validateBlocks(':::code-tabs\n' + fence('title="A" highlight="1"') + '\n' + fence('title="B"') + '\n:::')).toEqual([])
  })

  it('reports a highlight that is not lines and ranges, out of order, empty or too long a list', () => {
    expect(one(fence('highlight="a"'))).toMatchObject({ code: 'bad-fence-highlight', line: 1 })
    expect(one(fence('highlight="5,2"')).message).toContain('go up')
    expect(one(fence('highlight=""')).message).toContain('needs line numbers')
    const many = Array.from({ length: 41 }, (_, i) => String(i * 2 + 1)).join(',')
    expect(one(fence(`highlight="${many}"`, 100)).message).toContain('at most 40')
  })

  it('reports a highlight that is cut short or has no value, instead of drawing the fence plain without a word', () => {
    for (const meta of ['highlight="2', "highlight='2", 'highlight=']) {
      expect(one(fence(meta)), meta).toMatchObject({ code: 'bad-fence-highlight', line: 1 })
    }
  })

  it('does not take the text of a valid title for a highlight', () => {
    expect(validateBlocks(fence('title="use highlight= to mark"'))).toEqual([])
  })

  it('reports a line the code does not have, with numbers only', () => {
    const problem = one(fence('highlight="2,9"'))
    expect(problem.code).toBe('bad-fence-highlight')
    expect(problem.message).toContain('line 9')
    expect(problem.message).toContain('8 lines')
    expect(validateBlocks(fence('highlight="8"'))).toEqual([])
  })

  it('reports a highlight written where the language belongs, which would be read as the language', () => {
    const problem = one('```highlight="1"\na\nb\n```')
    expect(problem.code).toBe('bad-fence-highlight')
    expect(problem.message).toContain('after the language')
  })

  it('does not mistake a word that contains the name for a highlight', () => {
    expect(validateBlocks(fence('nohighlight="9"'))).toEqual([])
  })
})

describe('validateBlocks: an article nested too deeply to parse for blocks', () => {
  const hostile = ':::callout\nx\n\n'.repeat(2000)

  it('reports the nesting once, and not one stray-colons problem for each line of text it leaves behind', () => {
    const started = performance.now()
    const problems = validateBlocks(hostile)

    expect(performance.now() - started).toBeLessThan(1_000)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({ code: 'too-deep', line: 25 })
  }, 20_000)

  it('keeps the problems that do not need the directive syntax, in line order', () => {
    const problems = validateBlocks(`<ai-block block="callout"></ai-block>\n\n${hostile}`)

    expect(codes(problems)).toEqual(['reserved-tag', 'too-deep'])
  }, 20_000)
})
