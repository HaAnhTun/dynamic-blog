import { describe, expect, it } from 'vitest'
import { translatorFor } from '@/test/intl'
import type { Post } from './types'
import { altFromFileName, exportFileName, exportZipFileName, imageMarkdown, insertBlock, toSeedMarkdown } from './post-markdown'
import { msg } from '@/test/render-intl'
import { SCREENSHOT_FILE_VI } from '@/test/fixtures/vi/accented-text'

const t = translatorFor('vi', 'Admin.postImages')

const post = (over: Partial<Post> = {}): Post => ({
  id: 'p1',
  title: 'From API Gateway to SQS',
  slug: 'sample-post-11',
  language: 'en',
  translations: [],
  excerpt: 'Why I chose async.',
  status: 'DRAFT',
  category: { id: 'c1', name: 'Architecture', slug: 'kien-truc', description: null },
  tags: [
    { id: 't1', name: 'AWS', slug: 'aws' },
    { id: 't2', name: 'Architecture', slug: 'kien-truc' },
  ],
  featured: true,
  readingMinutes: 3,
  publishedAt: null,
  content: '## Intro\n\nParagraph one.\n',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-02T00:00:00Z',
  ...over,
})

/**
 * Reads the front matter back exactly as seed/push.py `parse_frontmatter` does: `text.split('---', 2)`, drops blank
 * lines and `#` lines, splits each `key: value` line at the first `:`, strips both sides; the body is the third part
 * with leading `\n` removed. Copied here so the test speaks about what push.py will actually see, not the string we expect.
 */
function parseLikePush(text: string): { meta: Record<string, string>; body: string } {
  expect(text.startsWith('---')).toBe(true)
  const first = text.indexOf('---')
  const second = text.indexOf('---', first + 3)
  expect(second).toBeGreaterThan(first)
  const rawMeta = text.slice(first + 3, second)
  const body = text.slice(second + 3).replace(/^\n+/, '')
  const meta: Record<string, string> = {}
  // Python's splitlines() splits at these characters; a value containing them would break into several lines.
  for (const line of rawMeta.trim().split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const colon = line.indexOf(':')
    expect(colon, `line without a colon: ${line}`).toBeGreaterThan(0)
    meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim()
  }
  return { meta, body }
}

describe('toSeedMarkdown: the seed/push.py format', () => {
  it('all five fields push.py requires, status for information, then the body verbatim', () => {
    const { meta, body } = parseLikePush(toSeedMarkdown(post()))

    expect(meta).toEqual({
      title: 'From API Gateway to SQS',
      excerpt: 'Why I chose async.',
      category: 'Architecture',
      tags: 'AWS, Architecture',
      featured: 'true',
      status: 'DRAFT',
      slug: 'sample-post-11',
      language: 'en',
    })
    expect(body).toBe('## Intro\n\nParagraph one.\n')
  })

  it('the keys come in a stable order: the old ones first, the new ones (slug, language, translation_of) after them', () => {
    const text = toSeedMarkdown(
      post({ translations: [{ language: 'vi', slug: 'ban-vi', title: 'Ban vi', status: 'PUBLISHED' }] }),
    )

    const keys = text
      .split('\n---\n')[0]
      .split('\n')
      .filter((line) => !line.startsWith('#') && line !== '---' && line !== '')
      .map((line) => line.slice(0, line.indexOf(':')))
    expect(keys).toEqual(['title', 'excerpt', 'category', 'tags', 'featured', 'status', 'slug', 'language', 'translation_of'])
  })

  it('the whole file for a fixed post, byte for byte (seed/test_push.py parses the same text with the real push.py)', () => {
    expect(toSeedMarkdown(post())).toBe(
      [
        '---',
        '# Exported from the admin. "status" is informational only: seed/push.py publishes every file it pushes.',
        'title: From API Gateway to SQS',
        'excerpt: Why I chose async.',
        'category: Architecture',
        'tags: AWS, Architecture',
        'featured: true',
        'status: DRAFT',
        'slug: sample-post-11',
        'language: en',
        '---',
        '',
        '## Intro',
        '',
        'Paragraph one.',
        '',
      ].join('\n'),
    )
  })

  it('translation_of names the published sibling and is left out of the file when there is none', () => {
    const none = parseLikePush(toSeedMarkdown(post({ translations: [] }))).meta
    const missing = parseLikePush(toSeedMarkdown(post({ translations: undefined }))).meta
    const sibling = parseLikePush(
      toSeedMarkdown(post({ translations: [{ language: 'vi', slug: 'ban-vi', title: 'Ban vi', status: 'PUBLISHED' }] })),
    ).meta

    expect(none).not.toHaveProperty('translation_of')
    expect(missing).not.toHaveProperty('translation_of')
    expect(sibling.translation_of).toBe('ban-vi')
  })

  it('with several published siblings the first one by language is named, and a draft sibling never is', () => {
    const only = (translations: Post['translations']) => parseLikePush(toSeedMarkdown(post({ translations }))).meta.translation_of
    const vi = { language: 'vi', slug: 'ban-vi', title: 'Ban vi', status: 'PUBLISHED' }
    const fr = { language: 'fr', slug: 'ban-fr', title: 'Ban fr', status: 'PUBLISHED' }
    const de = { language: 'de', slug: 'ban-de', title: 'Ban de', status: 'DRAFT' }

    expect(only([vi, fr, de])).toBe('ban-fr')
    expect(only([de])).toBeUndefined()
  })

  it('slug, language and translation_of are one-line values like the others', () => {
    const meta = parseLikePush(
      toSeedMarkdown(
        post({
          slug: 'a---b\nc',
          language: 'e\u2028n',
          translations: [{ language: 'vi', slug: 'x, y---z', title: 'T', status: 'PUBLISHED' }],
        }),
      ),
    ).meta

    expect(meta.slug).toBe('a—b c')
    expect(meta.language).toBe('e n')
    expect(meta.translation_of).toBe('x, y—z')
  })

  it('a post without a language (older backend) writes no language line: the import reads that as absent', () => {
    expect(parseLikePush(toSeedMarkdown(post({ language: undefined }))).meta).not.toHaveProperty('language')
  })

  it('null fields become empty, featured false, no tags gives an empty `tags:`', () => {
    const { meta } = parseLikePush(
      toSeedMarkdown(post({ excerpt: null, category: null, tags: [], featured: false, status: 'PUBLISHED' })),
    )

    expect(meta).toMatchObject({ excerpt: '', category: '', tags: '', featured: 'false', status: 'PUBLISHED' })
  })

  it('a body containing --- (a horizontal rule) stays intact: push.py splits only at the first two ---', () => {
    const content = 'Above\n\n---\n\nBelow\n\n```yaml\n---\nkey: v\n```\n'
    const { body } = parseLikePush(toSeedMarkdown(post({ content })))

    expect(body).toBe(content)
  })

  it('a body that does not end with a newline gets one (the only loss to the body)', () => {
    expect(parseLikePush(toSeedMarkdown(post({ content: 'One line' }))).body).toBe('One line\n')
  })

  it('values are always one line: line breaks (including the characters Python splitlines() splits at) become spaces', () => {
    const { meta } = parseLikePush(
      toSeedMarkdown(
        post({
          title: 'Line one\u2028line two',
          excerpt: 'Sentence one.\n\nSentence two.\r\nSentence three.\u0085Sentence four.',
        }),
      ),
    )

    expect(meta.title).toBe('Line one line two')
    expect(meta.excerpt).toBe('Sentence one. Sentence two. Sentence three. Sentence four.')
  })

  it('--- inside a value becomes “—”: otherwise push.py cuts the front matter in the middle of the title', () => {
    const { meta, body } = parseLikePush(toSeedMarkdown(post({ title: 'Before --- after', excerpt: 'a ---- b' })))

    expect(meta.title).toBe('Before — after')
    expect(meta.excerpt).toBe('a — b')
    expect(body).toBe('## Intro\n\nParagraph one.\n')
  })

  it('a comma in a tag name becomes a space: push.py splits tags on commas', () => {
    const { meta } = parseLikePush(
      toSeedMarkdown(
        post({
          tags: [
            { id: 't1', name: 'Node.js, Deno', slug: 'node' },
            { id: 't2', name: 'AWS', slug: 'aws' },
          ],
        }),
      ),
    )

    expect(meta.tags.split(',').map((tag) => tag.trim())).toEqual(['Node.js Deno', 'AWS'])
  })

  it('a colon in a value is kept: push.py splits only at the first colon', () => {
    expect(parseLikePush(toSeedMarkdown(post({ title: 'Java: what I learned' }))).meta.title).toBe('Java: what I learned')
  })
})

describe('exportFileName', () => {
  it('the slug is the file name (push.py takes the slug from the file name)', () => {
    expect(exportFileName('sample-post-11')).toBe('sample-post-11.md')
  })

  it('odd characters (impossible in a backend-generated slug) do not leak into the Content-Disposition header', () => {
    expect(exportFileName('a"b\r\nc/../d')).toBe('a-b-c-d.md')
    expect(exportFileName('"')).toBe('bai-viet.md')
  })
})

describe('exportZipFileName', () => {
  it('takes the name the backend sent', () => {
    expect(exportZipFileName('attachment; filename="sample-post-11.zip"')).toBe('sample-post-11.zip')
    expect(exportZipFileName('attachment; filename=sample-post-11.zip')).toBe('sample-post-11.zip')
  })

  it('falls back to a neutral name when the header is missing, empty or names no file', () => {
    expect(exportZipFileName(null)).toBe('bai-viet.zip')
    expect(exportZipFileName('')).toBe('bai-viet.zip')
    expect(exportZipFileName('attachment')).toBe('bai-viet.zip')
    expect(exportZipFileName('attachment; filename=""')).toBe('bai-viet.zip')
  })

  it('odd characters do not leak into the Content-Disposition header; the extension is always .zip', () => {
    expect(exportZipFileName('attachment; filename="a b/../c.zip"')).toBe('a-b-c.zip')
    expect(exportZipFileName('attachment; filename="report.exe"')).toBe('report-exe.zip')
    expect(exportZipFileName("attachment; filename*=UTF-8''x%C3%A9.zip")).toBe('bai-viet.zip')
  })
})

describe('altFromFileName', () => {
  it.each([
    ['so-do_kien-truc.png', 'so do kien truc'],
    ['Diagram pipeline.final.jpg', 'Diagram pipeline.final'],
    ['image.png', msg('Site.footer.links.gallery')],
    ['IMG_2041.JPG', msg('Site.footer.links.gallery')],
    ['Screenshot 2026-10-09 at 10.12.33.png', msg('Admin.postImages.altScreenshot')],
    [SCREENSHOT_FILE_VI, msg('Admin.postImages.altScreenshot')],
    ['.png', msg('Site.footer.links.gallery')],
    ['', msg('Site.footer.links.gallery')],
  ])('%j → %j', (name, alt) => {
    expect(altFromFileName(name, t)).toBe(alt)
  })

  it('at most 120 characters, cut by code point', () => {
    const alt = altFromFileName(`${'😀'.repeat(200)}.png`, t)

    expect([...alt]).toHaveLength(120)
    expect(alt.endsWith('😀')).toBe(true)
  })
})

describe('imageMarkdown', () => {
  it('a Markdown image pointing at /media/<file>, and the position of the alt text so the editor can preselect it', () => {
    const snippet = imageMarkdown({ fileName: '0b9d6f3a-5c1e-4f7a-9d2b-3e4f5a6b7c8d.jpg' }, 'Diagram')

    expect(snippet.markdown).toBe('![Diagram](/media/0b9d6f3a-5c1e-4f7a-9d2b-3e4f5a6b7c8d.jpg)')
    expect(snippet.markdown.slice(snippet.altStart, snippet.altEnd)).toBe('Diagram')
  })

  it('an image with known size carries the #WxH hint, so the post page sets width/height without guessing', () => {
    const snippet = imageMarkdown({ fileName: 'a.png', width: 1280, height: 720 }, 'Diagram')

    expect(snippet.markdown).toBe('![Diagram](/media/a.png#1280x720)')
    expect(snippet.markdown.slice(snippet.altStart, snippet.altEnd)).toBe('Diagram')
  })

  it('an invalid size gives no hint', () => {
    expect(imageMarkdown({ fileName: 'a.png', width: 0, height: 720 }, 'a').markdown).toBe('![a](/media/a.png)')
    expect(imageMarkdown({ fileName: 'a.png', width: 12.5, height: 7 }, 'a').markdown).toBe('![a](/media/a.png)')
  })

  it('[ ] and \\ in alt are escaped, a line break becomes a space: alt does not break the image syntax', () => {
    const snippet = imageMarkdown({ fileName: 'a.png' }, 'Table [v2]\n\\x')

    expect(snippet.markdown).toBe('![Table \\[v2\\] \\\\x](/media/a.png)')
    expect(snippet.markdown.slice(snippet.altStart, snippet.altEnd)).toBe('Table \\[v2\\] \\\\x')
  })
})

describe('insertBlock: an image is its own paragraph', () => {
  const IMG = '![a](/media/x.jpg)'

  it.each([
    // [before the cursor, after the cursor, result]
    ['', '', `${IMG}\n`],
    ['Paragraph one.', '', `Paragraph one.\n\n${IMG}\n`],
    ['Paragraph one.\n', '', `Paragraph one.\n\n${IMG}\n`],
    ['Paragraph one.\n\n', '', `Paragraph one.\n\n${IMG}\n`],
    ['', 'Paragraph two.', `${IMG}\n\nParagraph two.`],
    ['One', 'two', `One\n\n${IMG}\n\ntwo`],
    ['One\n', '\ntwo', `One\n\n${IMG}\n\ntwo`],
    ['One\n\n', '\n\ntwo', `One\n\n${IMG}\n\ntwo`],
    // After the cursor only the trailing blank line of the post remains (e.g. right after an image was just inserted): reuse it, no extra padding.
    ['One', '\n', `One\n\n${IMG}\n`],
    ['One', '\n\n', `One\n\n${IMG}\n\n`],
  ])('%j | %j', (before, after, expected) => {
    const result = insertBlock(before + after, before.length, before.length, IMG)

    expect(result.value).toBe(expected)
    expect(result.value.slice(result.offset, result.offset + IMG.length)).toBe(IMG)
  })

  it('replaces the selected paragraph', () => {
    const result = insertBlock('One PICK two', 4, 8, IMG)

    expect(result.value).toBe(`One \n\n${IMG}\n\n two`)
  })

  it('a position outside the string is clamped, a reversed range is swapped', () => {
    expect(insertBlock('abc', 99, 99, IMG).value).toBe(`abc\n\n${IMG}\n`)
    expect(insertBlock('abc', 2, 1, IMG).value).toBe(`a\n\n${IMG}\n\nc`)
  })
})
