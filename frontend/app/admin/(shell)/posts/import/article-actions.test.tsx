import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { previewPostArticle, redirect } = vi.hoisted(() => ({
  previewPostArticle: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;push;${url};307;` })
  }),
}))
vi.mock('@/lib/admin-post-import', () => ({ previewPostFiles: vi.fn(), applyPostFiles: vi.fn(), previewPostArticle }))
vi.mock('@/lib/admin-api', async () => {
  const actual = await import('@/lib/api')
  return {
    SessionExpiredError: class SessionExpiredError extends actual.ApiError {
      constructor() {
        super(401, 'UNAUTHENTICATED', 'expired')
      }
    },
  }
})
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect,
}))
vi.mock('next/cache', () => ({ updateTag: vi.fn(), revalidateTag: vi.fn(), revalidatePath: vi.fn() }))

import { SessionExpiredError } from '@/lib/admin-api'
import { ApiError } from '@/lib/api'
import { POST_IMPORT_LIMIT_VALUES, POST_IMPORT_MAX_BLOCK_PROBLEMS, type PostArticlePreview } from '@/lib/post-import'
import { msg } from '@/test/render-intl'
import { checkArticle, renderArticle } from './actions'

const article = (over: Partial<PostArticlePreview> = {}): PostArticlePreview => ({
  fileName: 'one.md',
  title: 'A tidy article',
  excerpt: 'What it is about.',
  category: 'Guides',
  tags: ['one', 'two'],
  language: 'en',
  slug: 'a-tidy-article',
  body: '## Start\n\nText.\n',
  bodyLine: 5,
  assets: [],
  pkg: null,
  problems: [],
  problemsTotal: 0,
  ...over,
})
const file = (name = 'one.md', content = 'x') => new File([content], name)
const form = (...files: File[]) => {
  const data = new FormData()
  for (const f of files) data.append('file', f)
  return data
}
const errors = (key: string, values: Record<string, unknown> = {}) => ({
  error: msg(`Admin.posts.import.errors.${key}`, { ...POST_IMPORT_LIMIT_VALUES, position: 0, ...values }),
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('checkArticle', () => {
  it('asks the backend for the article of the one file and lists the blocks it uses, most used first', async () => {
    previewPostArticle.mockResolvedValue(
      article({
        body: ':::callout{type=tip}\nOne.\n:::\n\n:::callout{type=note}\nTwo.\n:::\n\n::figure{src="assets/a.png" alt="A"}\n',
      }),
    )

    const result = await checkArticle(form(file('pack.zip')))

    expect((previewPostArticle.mock.calls[0]![0] as File).name).toBe('pack.zip')
    expect(result).toEqual({
      problems: [],
      problemsTotal: 0,
      blocks: [
        { type: 'callout', count: 2 },
        { type: 'figure', count: 1 },
      ],
    })
  })

  it('reports a block mistake on the line of the FILE, not of the body', async () => {
    previewPostArticle.mockResolvedValue(article({ bodyLine: 5, body: 'Intro.\n\n:::callout{type=loud}\nText.\n:::\n' }))

    const result = await checkArticle(form(file()))

    expect(result).toMatchObject({ problemsTotal: 1, problems: [{ line: 7, block: 'callout', code: 'bad-attribute' }] })
    expect((result as { problems: { message: string }[] }).problems[0]!.message).toContain('"type"')
  })

  it('keeps the first problems only and says how many there are', async () => {
    const body = Array.from({ length: POST_IMPORT_MAX_BLOCK_PROBLEMS + 10 }, () => ':::callout{type=loud}\nx\n:::\n').join('\n')
    previewPostArticle.mockResolvedValue(article({ bodyLine: 1, body }))

    const result = await checkArticle(form(file()))

    expect(result).toMatchObject({ problemsTotal: POST_IMPORT_MAX_BLOCK_PROBLEMS + 10 })
    expect((result as { problems: unknown[] }).problems).toHaveLength(POST_IMPORT_MAX_BLOCK_PROBLEMS)
  })

  it('has nothing to say about a file the backend could not read', async () => {
    previewPostArticle.mockResolvedValue(article({ body: null, bodyLine: 0 }))

    await expect(checkArticle(form(file()))).resolves.toEqual({ problems: [], problemsTotal: 0, blocks: [] })
  })

  it('refuses anything but exactly one acceptable file before calling the backend', async () => {
    await expect(checkArticle(form())).resolves.toEqual(errors('noFile'))
    await expect(checkArticle(form(file(), file('two.md')))).resolves.toEqual(errors('badArguments'))
    await expect(checkArticle(form(file('one.txt')))).resolves.toEqual(errors('notMarkdown', { position: 1 }))
    await expect(checkArticle(form(file('one.zip', '')))).resolves.toEqual(errors('emptyFile', { position: 1 }))
    const notAFile = new FormData()
    notAFile.append('file', 'text')
    await expect(checkArticle(notAFile)).resolves.toEqual(errors('badArguments'))
    expect(previewPostArticle).not.toHaveBeenCalled()
  })

  it('shows the rate limit sentence and sends an expired session to login', async () => {
    previewPostArticle.mockRejectedValueOnce(new ApiError(429, 'RATE_LIMITED', 'Too many requests'))
    await expect(checkArticle(form(file()))).resolves.toEqual({ error: msg('Errors.admin.codes.RATE_LIMITED') })

    previewPostArticle.mockRejectedValueOnce(new SessionExpiredError())
    await expect(checkArticle(form(file()))).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login')
  })
})

describe('renderArticle', () => {
  const shown = async (over: Partial<PostArticlePreview> = {}) => {
    previewPostArticle.mockResolvedValue(article(over))
    const result = await renderArticle(form(file()))
    if ('error' in result) throw new Error(result.error)
    return render(<>{result.article}</>)
  }

  it('draws the article inside the real article template: the title, the lead, the category and the body', async () => {
    await shown({ body: '## Start\n\nFirst paragraph.\n\n### Detail\n\nMore.\n\n## End\n\nLast.\n' })

    expect(screen.getByRole('heading', { level: 1, name: 'A tidy article' })).toBeInTheDocument()
    expect(screen.getByText('What it is about.')).toBeInTheDocument()
    expect(screen.getByText('Guides')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Start' })).toBeInTheDocument()
    expect(screen.getByText('Last.')).toBeInTheDocument()
  })

  it('links a Vietnamese category and tag to the slugs the backend makes, accents and the stroke-d letter included', async () => {
    // Built from code points: the English guard allows Vietnamese letters only in a few files, and this is not one of them.
    const category = String.fromCodePoint(0x48, 0x1b0, 0x1edb, 0x6e, 0x67, 0x20, 0x64, 0x1eab, 0x6e)
    const tag = String.fromCodePoint(0x110, 0x1edd, 0x69, 0x20, 0x73, 0xf3, 0x6e, 0x67)
    await shown({ category, tags: [tag] })

    expect(screen.getByRole('link', { name: category })).toHaveAttribute(
      'href',
      expect.stringMatching(/\/categories\/huong-dan$/),
    )
    expect(screen.getByRole('link', { name: tag })).toHaveAttribute('href', expect.stringMatching(/\/tags\/doi-song$/))
  })

  it('names the article after its file when the front matter has no title, and invents no date or reading time', async () => {
    const view = await shown({ title: null, fileName: 'my-draft.zip', excerpt: null, category: null, tags: [] })

    expect(screen.getByRole('heading', { level: 1, name: 'my-draft' })).toBeInTheDocument()
    expect(view.container.querySelector('time')).toBeNull()
  })

  it('shows the images of the package from their bytes, in Markdown images and in the figure block', async () => {
    const view = await shown({
      body: '![First](assets/a.png)\n\n::figure{src="assets/a.png" alt="Second"}\n',
      assets: [{ path: 'assets/a.png', contentType: 'image/png', base64: 'AAAA', width: 1, height: 1 }],
    })

    const sources = [...view.container.querySelectorAll('img')].map((image) => image.getAttribute('src'))
    expect(sources).toContain('data:image/png;base64,AAAA')
    expect(view.container.innerHTML).not.toContain('assets/a.png')
  })

  it('draws a block with mistakes as plain content: nothing of the article is lost', async () => {
    await shown({ body: ':::callout{type=loud}\nKeep this sentence.\n:::\n' })

    expect(screen.getByText('Keep this sentence.')).toBeInTheDocument()
  })

  it('has no article to draw for a file the backend could not read', async () => {
    previewPostArticle.mockResolvedValue(article({ body: null, bodyLine: 0 }))

    await expect(renderArticle(form(file()))).resolves.toEqual(errors('articleUnavailable'))
  })

  it('refuses a bad request before calling the backend and maps backend refusals like the preview', async () => {
    await expect(renderArticle(form())).resolves.toEqual(errors('noFile'))
    await expect(renderArticle(form(file(), file()))).resolves.toEqual(errors('badArguments'))
    expect(previewPostArticle).not.toHaveBeenCalled()

    previewPostArticle.mockRejectedValueOnce(
      new ApiError(400, 'POST_IMPORT_INVALID_FILE', 'File 1: line 3 has a control character'),
    )
    await expect(renderArticle(form(file()))).resolves.toEqual({
      error: msg('Errors.admin.refusedDetail', { detail: 'File 1: line 3 has a control character' }),
    })
  })
})
