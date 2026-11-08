import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PostArticleCheck, PostPreview, PostPreviewFile } from '@/lib/post-import'
import { msg } from '@/test/intl'
import PostImport from './PostImport'

/**
 * The package and article parts of the import page: ZIP packages next to Markdown files, the facts of a package, the check of the
 * blocks that merges its mistakes into the cards, and the article preview. The steps that did not change (the tick, the apply, the
 * result) are tested in PostImport.test.tsx.
 */

const p = (key: string, args?: Record<string, string | number>) => msg(`Admin.posts.import.${key}`, args)
const hash = (letter: string) => letter.repeat(64)

const previewFile = (over: Partial<PostPreviewFile> = {}): PostPreviewFile => ({
  position: 1,
  fileName: 'one.md',
  bytes: 120,
  sha256: hash('a'),
  slug: 'one',
  slugSource: null,
  language: 'en',
  state: 'new',
  changes: {
    title: { before: null, after: 'First title' },
    description: { before: null, after: 'First description' },
    category: { before: null, after: 'Guides' },
    tagsAdded: 2,
    tagsRemoved: 0,
    tagsKept: 0,
    contentDiffers: true,
    linkWillBeAdded: false,
    series: null,
    seriesPart: null,
  },
  notes: [],
  newCategories: [],
  newTags: [],
  newSeries: [],
  problems: [],
  problemsTotal: 0,
  ignored: [],
  ignoredTotal: 0,
  previewState: 'bmV3fHx8',
  pkg: null,
  ...over,
})

const preview = (files: PostPreviewFile[]): PostPreview => ({
  files,
  filesWithProblems: files.filter((file) => file.state === 'error').map((file) => file.position),
  problemsOmitted: 0,
  newCategoryCount: 0,
  newTagCount: 0,
  newSeriesCount: 0,
  totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
})

const packageFile = (over: Partial<PostPreviewFile> = {}) =>
  previewFile({
    fileName: 'article.zip',
    pkg: { entries: 5, assets: 3, assetBytes: 2048, usedAssets: 2, unusedAssets: 1, unsupportedItems: 0 },
    ...over,
  })

const check = (over: Partial<PostArticleCheck> = {}): PostArticleCheck => ({
  problems: [],
  problemsTotal: 0,
  blocks: [],
  ...over,
})

const upload = (name: string, content = 'x') => new File([content], name)
const fileInput = () => document.querySelector<HTMLInputElement>('input[type="file"]')!
async function choose(...files: File[]) {
  await act(async () => {
    fireEvent.change(fileInput(), { target: { files } })
  })
}
const click = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })
}
const tick = (name: string) => screen.getByRole('checkbox', { name: p('preview.select', { name }) })
const cardOf = (name: string) => within(tick(name).closest('li')!)

type Props = Parameters<typeof PostImport>[0]
type Mock = ReturnType<typeof vi.fn>

const setup = (files: PostPreviewFile[], over: { onCheck?: Mock; onArticle?: Mock; onApply?: Mock } = {}) => {
  const onPreview = vi.fn().mockResolvedValue(preview(files))
  const onApply = over.onApply ?? vi.fn()
  const onCheck = over.onCheck ?? vi.fn().mockResolvedValue(check())
  const onArticle = over.onArticle ?? vi.fn().mockResolvedValue({ article: <p>Drawn article</p> })
  render(
    <PostImport
      onPreview={onPreview as Props['onPreview']}
      onApply={onApply as Props['onApply']}
      onCheck={onCheck as Props['onCheck']}
      onArticle={onArticle as Props['onArticle']}
    />,
  )
  return { onPreview, onApply, onCheck, onArticle }
}

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('PostImport with ZIP packages', () => {
  it('accepts .zip next to .md in the file input and sends a package like any file', async () => {
    const { onPreview } = setup([packageFile()])

    expect(fileInput().accept).toContain('.zip')
    await choose(upload('article.zip'), upload('post.md'))

    expect((onPreview.mock.calls[0]![0] as FormData).getAll('file').map((part) => (part as File).name)).toEqual([
      'article.zip',
      'post.md',
    ])
  })

  it('refuses a package over its cap by position without calling the server', async () => {
    const { onPreview } = setup([packageFile()])
    const big = new File(['x'], 'big.zip')
    Object.defineProperty(big, 'size', { value: 5 * 1024 * 1024 })

    await choose(big)

    expect(onPreview).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(p('errors.packageTooLarge', { position: 1, maxPackageMib: 4 }))
  })

  it('shows the facts of a package: images, size, used and unused', async () => {
    setup([packageFile()])
    await choose(upload('article.zip'))

    expect(
      cardOf('article.zip').getByText(p('preview.package.facts', { assets: 3, kib: 2, used: 2, unused: 1 })),
    ).toBeInTheDocument()
  })

  it('says which image is unused, by the path the backend reports, and counts the items that cannot be used', async () => {
    setup([
      packageFile({
        notes: [{ code: 'asset_unused', key: 'assets/spare.png', line: null }],
        pkg: { entries: 4, assets: 2, assetBytes: 1024, usedAssets: 1, unusedAssets: 1, unsupportedItems: 2 },
      }),
    ])
    await choose(upload('article.zip'))

    const card = cardOf('article.zip')
    expect(card.getByText(p('preview.notes.asset_unused', { path: 'assets/spare.png' }))).toBeInTheDocument()
    expect(card.getByText(p('preview.package.unsupported', { count: 2 }))).toBeInTheDocument()
  })

  it('shows nothing about a package for a Markdown file', async () => {
    setup([previewFile()])
    await choose(upload('one.md'))

    expect(cardOf('one.md').queryByText(/ZIP/)).not.toBeInTheDocument()
  })
})

describe('PostImport block check', () => {
  it('checks each file that could be imported, one call at a time, with that file alone', async () => {
    const files = [
      previewFile({ position: 1, fileName: 'a.md' }),
      previewFile({ position: 2, fileName: 'same.md', state: 'unchanged', changes: null, previewState: null }),
      packageFile({ position: 3, fileName: 'c.zip' }),
      previewFile({
        position: 4,
        fileName: 'broken.md',
        state: 'error',
        changes: null,
        previewState: null,
        problems: [{ position: 4, key: null, line: 1, message: 'No title.' }],
        problemsTotal: 1,
      }),
    ]
    let running = 0
    let overlap = false
    const names: string[][] = []
    const onCheck = vi.fn(async (form: FormData) => {
      names.push(form.getAll('file').map((part) => (part as File).name))
      running += 1
      overlap ||= running > 1
      await Promise.resolve()
      running -= 1
      return check()
    })
    setup(files, { onCheck })

    await choose(upload('a.md'), upload('same.md'), upload('c.zip'), upload('broken.md'))

    expect(names).toEqual([['a.md'], ['c.zip']])
    expect(overlap).toBe(false)
  })

  it('shows how many blocks of each type the article uses, or that it has none', async () => {
    const onCheck = vi
      .fn()
      .mockResolvedValueOnce(check({ blocks: [{ type: 'callout', count: 2 }] }))
      .mockResolvedValueOnce(check())
    setup([previewFile({ position: 1, fileName: 'a.md' }), previewFile({ position: 2, fileName: 'b.md' })], { onCheck })

    await choose(upload('a.md'), upload('b.md'))

    expect(cardOf('a.md').getByText(p('preview.blocks.summary', { names: 'callout (2)' }))).toBeInTheDocument()
    expect(cardOf('b.md').getByText(p('preview.blocks.none'))).toBeInTheDocument()
  })

  it('does not call the article plain Markdown when a block of it is refused and so no block was recognised', async () => {
    const onCheck = vi.fn().mockResolvedValueOnce(
      check({
        problems: [{ line: 10, code: 'unknown-block', block: 'banner', message: 'Unknown block "banner".' }],
        problemsTotal: 1,
        blocks: [],
      }),
    )
    setup([previewFile({ position: 1, fileName: 'a.md' })], { onCheck })

    await choose(upload('a.md'))

    const card = cardOf('a.md')
    expect(
      card.getByText(
        p('preview.problem', { where: `${p('preview.lineNumber', { line: 10 })}, banner`, message: 'Unknown block "banner".' }),
      ),
    ).toBeInTheDocument()
    expect(card.queryByText(p('preview.blocks.none'))).not.toBeInTheDocument()
  })

  it('turns a file with mistakes in its blocks into an error file: listed with the line, unticked and not selectable', async () => {
    const onCheck = vi.fn().mockResolvedValueOnce(
      check({
        problems: [
          { line: 12, code: 'bad-attribute', block: 'callout', message: 'Attribute "type" on "callout" must be one of tip.' },
        ],
        problemsTotal: 1,
        blocks: [{ type: 'callout', count: 1 }],
      }),
    )
    setup([previewFile({ position: 1, fileName: 'a.md' }), previewFile({ position: 2, fileName: 'b.md' })], { onCheck })

    await choose(upload('a.md'), upload('b.md'))

    expect(tick('a.md')).not.toBeChecked()
    expect(tick('a.md')).toBeDisabled()
    expect(tick('b.md')).toBeChecked()
    const card = cardOf('a.md')
    expect(card.getByText(p('preview.state.error'))).toBeInTheDocument()
    expect(
      card.getByText(
        p('preview.problem', {
          where: `${p('preview.lineNumber', { line: 12 })}, callout`,
          message: 'Attribute "type" on "callout" must be one of tip.',
        }),
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: p('preview.apply', { count: 1 }) })).toBeEnabled()
    expect(screen.getByRole('alert')).toHaveTextContent(p('preview.filesWithProblems', { count: 1 }))
  })

  it('keeps the import closed while the check runs and says so', async () => {
    let answer: (value: PostArticleCheck) => void = () => {}
    const onCheck = vi.fn(() => new Promise<PostArticleCheck>((resolve) => (answer = resolve)))
    setup([previewFile()], { onCheck })

    await choose(upload('one.md'))

    expect(screen.getByRole('status')).toHaveTextContent(p('status.checking'))
    expect(cardOf('one.md').getByText(p('preview.blocks.checking'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: p('preview.apply', { count: 1 }) })).toBeDisabled()

    await act(async () => answer(check()))

    expect(screen.getByRole('status')).toHaveTextContent(p('status.previewReady'))
    expect(screen.getByRole('button', { name: p('preview.apply', { count: 1 }) })).toBeEnabled()
  })

  it('leaves a file as it was when its check fails, with a note, so the import is not blocked', async () => {
    const onCheck = vi.fn().mockResolvedValue({ error: 'Too many requests' })
    setup([previewFile()], { onCheck })

    await choose(upload('one.md'))

    expect(cardOf('one.md').getByText(p('preview.blocks.failed'))).toBeInTheDocument()
    expect(tick('one.md')).toBeChecked()
    expect(screen.getByRole('button', { name: p('preview.apply', { count: 1 }) })).toBeEnabled()
  })

  it('a thrown failure of the check is the same note, and the console gets one line', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    setup([previewFile()], { onCheck: vi.fn().mockRejectedValue(new TypeError('fetch failed')) })

    await choose(upload('one.md'))

    expect(cardOf('one.md').getByText(p('preview.blocks.failed'))).toBeInTheDocument()
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('forgets the checks when the files are removed, and ignores an answer that arrives afterwards', async () => {
    let answer: (value: PostArticleCheck) => void = () => {}
    const onCheck = vi.fn(() => new Promise<PostArticleCheck>((resolve) => (answer = resolve)))
    setup([previewFile()], { onCheck })
    await choose(upload('one.md'))

    await click(p('files.remove'))
    await act(async () => answer(check({ problems: [], problemsTotal: 1, blocks: [] })))

    expect(screen.queryByText(p('preview.heading'))).not.toBeInTheDocument()
    expect(screen.getByText(p('files.dropTitle'))).toBeInTheDocument()
  })
})

describe('PostImport article preview', () => {
  it('offers the preview for a readable file only', async () => {
    setup([
      previewFile({ position: 1, fileName: 'a.md' }),
      previewFile({
        position: 2,
        fileName: 'broken.md',
        state: 'error',
        changes: null,
        previewState: null,
        problems: [{ position: 2, key: null, line: 1, message: 'No title.' }],
        problemsTotal: 1,
      }),
    ])
    await choose(upload('a.md'), upload('broken.md'))

    expect(cardOf('a.md').getByRole('button', { name: p('preview.article.show') })).toHaveAttribute('aria-expanded', 'false')
    expect(cardOf('broken.md').queryByRole('button', { name: p('preview.article.show') })).not.toBeInTheDocument()
  })

  it('asks the server for the article of that file alone, shows it in a labelled region and moves focus to its heading', async () => {
    const { onArticle } = setup([previewFile({ position: 1, fileName: 'a.md' }), previewFile({ position: 2, fileName: 'b.md' })])
    await choose(upload('a.md'), upload('b.md'))

    await act(async () => {
      fireEvent.click(cardOf('b.md').getByRole('button', { name: p('preview.article.show') }))
    })

    const form = onArticle.mock.calls[0]![0] as FormData
    expect(form.getAll('file').map((part) => (part as File).name)).toEqual(['b.md'])
    const region = within(screen.getByRole('region', { name: p('preview.article.region', { name: 'b.md' }) }))
    expect(region.getByText('Drawn article')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: p('preview.article.region', { name: 'b.md' }) })).toHaveFocus()
    expect(cardOf('b.md').getByRole('button', { name: p('preview.article.hide') })).toHaveAttribute('aria-expanded', 'true')
    expect(cardOf('a.md').queryByText('Drawn article')).not.toBeInTheDocument()
  })

  it('shows one article at a time, closes it on the same button and does not ask again for one it already drew', async () => {
    const { onArticle } = setup([previewFile({ position: 1, fileName: 'a.md' }), previewFile({ position: 2, fileName: 'b.md' })])
    await choose(upload('a.md'), upload('b.md'))
    const open = async (name: string, label = p('preview.article.show')) =>
      act(async () => {
        fireEvent.click(cardOf(name).getByRole('button', { name: label }))
      })

    await open('a.md')
    await open('b.md')
    expect(screen.getAllByText('Drawn article')).toHaveLength(1)
    expect(screen.getByRole('region', { name: p('preview.article.region', { name: 'b.md' }) })).toBeInTheDocument()

    await open('b.md', p('preview.article.hide'))
    expect(screen.queryByText('Drawn article')).not.toBeInTheDocument()

    await open('a.md')
    expect(screen.getByText('Drawn article')).toBeInTheDocument()
    expect(onArticle).toHaveBeenCalledTimes(2)
  })

  it('says it is preparing the article and then that it is ready, in the status line', async () => {
    let answer: (value: { article: unknown }) => void = () => {}
    const onArticle = vi.fn(() => new Promise((resolve) => (answer = resolve)))
    setup([previewFile()], { onArticle })
    await choose(upload('one.md'))

    await click(p('preview.article.show'))
    expect(screen.getByRole('status')).toHaveTextContent(p('status.articleLoading'))
    expect(screen.getByRole('region', { name: p('preview.article.region', { name: 'one.md' }) })).toHaveAttribute(
      'aria-busy',
      'true',
    )

    await act(async () => answer({ article: <p>Drawn article</p> }))
    expect(screen.getByRole('status')).toHaveTextContent(p('status.articleReady'))
  })

  it('ignores an article that arrives after its preview was closed, but keeps it for the next time', async () => {
    let answer: (value: { article: unknown }) => void = () => {}
    const onArticle = vi.fn(() => new Promise((resolve) => (answer = resolve)))
    setup([previewFile()], { onArticle })
    await choose(upload('one.md'))
    await click(p('preview.article.show'))

    await click(p('preview.article.hide'))
    await act(async () => answer({ article: <p>Drawn article</p> }))

    expect(screen.queryByText('Drawn article')).not.toBeInTheDocument()
    await click(p('preview.article.show'))
    expect(screen.getByText('Drawn article')).toBeInTheDocument()
    expect(onArticle).toHaveBeenCalledTimes(1)
  })

  it('does not let a link of the article leave the page, while a link to a place in the article works', async () => {
    const onArticle = vi.fn().mockResolvedValue({
      article: (
        <>
          <a href="/categories/guides">Category</a>
          <a href="https://example.com/page">External</a>
          <a href="#section">Jump</a>
        </>
      ),
    })
    setup([previewFile()], { onArticle })
    await choose(upload('one.md'))
    await click(p('preview.article.show'))

    // fireEvent returns false when the default action was prevented.
    expect(fireEvent.click(screen.getByRole('link', { name: 'Category' }))).toBe(false)
    expect(fireEvent.click(screen.getByRole('link', { name: 'External' }))).toBe(false)
    expect(fireEvent.click(screen.getByRole('link', { name: 'Jump' }))).toBe(true)
  })

  it('shows the sentence of a refused article and the unreachable sentence of a thrown failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const onArticle = vi
      .fn()
      .mockResolvedValueOnce({ error: p('errors.articleUnavailable') })
      .mockRejectedValueOnce(new TypeError('fetch failed'))
    setup([previewFile()], { onArticle })
    await choose(upload('one.md'))

    await click(p('preview.article.show'))
    expect(screen.getByRole('alert')).toHaveTextContent(p('errors.articleUnavailable'))

    await click(p('preview.article.hide'))
    await click(p('preview.article.show'))
    expect(screen.getByRole('alert')).toHaveTextContent(p('preview.article.failed'))
  })

  it('draws the article of a file whose blocks have mistakes too: its blocks show as plain text there', async () => {
    const onCheck = vi
      .fn()
      .mockResolvedValue(
        check({ problems: [{ line: 3, code: 'bad-attribute', block: 'callout', message: 'Bad.' }], problemsTotal: 1 }),
      )
    setup([previewFile()], { onCheck })
    await choose(upload('one.md'))

    expect(cardOf('one.md').getByText(p('preview.state.error'))).toBeInTheDocument()
    await click(p('preview.article.show'))

    expect(screen.getByText('Drawn article')).toBeInTheDocument()
  })

  it('drops the open article when a new preview is requested', async () => {
    setup([previewFile()])
    await choose(upload('one.md'))
    await click(p('preview.article.show'))

    await choose(upload('one.md'))

    expect(screen.queryByText('Drawn article')).not.toBeInTheDocument()
    expect(cardOf('one.md').getByRole('button', { name: p('preview.article.show') })).toBeInTheDocument()
  })
})

describe('PostImport result', () => {
  it('links each written draft to its saved preview page, next to the link to the editor', async () => {
    const postId = '1b4e28ba-2fa1-11d2-883f-0016d3cca427'
    const onApply = vi.fn().mockResolvedValue({
      importId: 1,
      files: [{ position: 1, fileName: 'one.md', result: 'created', postId, slug: 'one' }],
      created: 1,
      skipped: 0,
    })
    setup([previewFile()], { onApply })
    await choose(upload('one.md'))

    await click(p('preview.apply', { count: 1 }))

    expect(screen.getByRole('link', { name: p('result.previewFor', { name: 'one.md' }) })).toHaveAttribute(
      'href',
      `/admin/posts/${postId}/preview`,
    )
    expect(screen.getByRole('link', { name: p('result.openFor', { name: 'one.md' }) })).toHaveAttribute(
      'href',
      `/admin/posts/${postId}/edit`,
    )
  })
})
