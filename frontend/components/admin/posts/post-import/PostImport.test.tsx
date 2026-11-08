import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  POST_IMPORT_LIMIT_VALUES,
  type PostApplyResult,
  type PostArticleCheck,
  type PostPreview,
  type PostPreviewFile,
} from '@/lib/post-import'
import { msg } from '@/test/intl'
import PostImport from './PostImport'

const p = (key: string, args?: Record<string, string | number>) => msg(`Admin.posts.import.${key}`, args)
const hash = (letter: string) => letter.repeat(64)
const encode = (plain: string) => btoa(plain).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const POST_ID = '1b4e28ba-2fa1-11d2-883f-0016d3cca427'
const updateState = (status: string) => encode(`update|${POST_ID}|${status}|${hash('f')}`)

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
  previewState: encode('new|||'),
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

/** A new post, a change to a draft, a change to a published post, an unchanged post and a file with an error. */
const mixed = () =>
  preview([
    previewFile({ position: 1, fileName: 'new.md', slug: 'new-post' }),
    previewFile({
      position: 2,
      fileName: 'draft.md',
      slug: 'draft-post',
      state: 'will_change',
      previewState: updateState('DRAFT'),
      changes: {
        title: { before: 'Old title', after: 'New title' },
        description: { before: 'Old', after: 'New' },
        category: { before: 'Guides', after: 'Notes' },
        tagsAdded: 1,
        tagsRemoved: 2,
        tagsKept: 3,
        contentDiffers: false,
        linkWillBeAdded: true,
        series: null,
        seriesPart: null,
      },
    }),
    previewFile({
      position: 3,
      fileName: 'live.md',
      slug: 'live-post',
      state: 'will_change',
      previewState: updateState('PUBLISHED'),
      notes: [{ code: 'published_goes_live', key: null, line: null }],
    }),
    previewFile({ position: 4, fileName: 'same.md', slug: 'same-post', state: 'unchanged', changes: null, previewState: null }),
    previewFile({
      position: 5,
      fileName: 'broken.md',
      slug: null,
      language: null,
      state: 'error',
      changes: null,
      previewState: null,
      problems: [{ position: 5, key: 'language', line: 3, message: 'The language is not enabled on this site.' }],
      problemsTotal: 2,
    }),
  ])

const markdown = (name = 'one.md', content = '---\ntitle: One\n---\nBody\n') =>
  new File([content], name, { type: 'text/markdown' })
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
const card = (name: string) => screen.getByRole('checkbox', { name: p('preview.select', { name }) })

type Props = Parameters<typeof PostImport>[0]

type Mock = ReturnType<typeof vi.fn>

/** A check that finds nothing wrong and no block. */
const clean = (): PostArticleCheck => ({ problems: [], problemsTotal: 0, blocks: [] })

const setup = (over: { onPreview?: Mock; onApply?: Mock; onCheck?: Mock; onArticle?: Mock } = {}) => {
  const onPreview = over.onPreview ?? vi.fn().mockResolvedValue(mixed())
  const onApply = over.onApply ?? vi.fn()
  const onCheck = over.onCheck ?? vi.fn().mockResolvedValue(clean())
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

const result = (over: Partial<PostApplyResult> = {}): PostApplyResult => ({
  importId: 9,
  files: [
    { position: 1, fileName: 'new.md', result: 'created', postId: POST_ID, slug: 'new-post' },
    { position: 2, fileName: 'draft.md', result: 'updated', postId: '2c5ea4c0-4067-11e9-8bad-9b1deb4d3b7d', slug: 'draft-post' },
    { position: 3, fileName: 'live.md', result: 'skipped', postId: null, slug: null },
  ],
  created: 1,
  skipped: 1,
  ...over,
})

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('PostImport idle state', () => {
  it('offers the template of the chosen language and no preview or result', () => {
    setup()

    expect(screen.getByRole('link', { name: p('template.download') })).toHaveAttribute(
      'href',
      '/admin/posts/import/template?locale=vi',
    )
    fireEvent.change(screen.getByLabelText(p('template.language')), { target: { value: 'en' } })
    expect(screen.getByRole('link', { name: p('template.download') })).toHaveAttribute(
      'href',
      '/admin/posts/import/template?locale=en',
    )
    expect(screen.getByText(p('files.dropTitle'))).toBeInTheDocument()
    expect(screen.queryByText(p('preview.heading'))).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('the file input accepts several files and is reachable by keyboard, described by its hint', () => {
    setup()

    const input = screen.getByLabelText(p('files.dropTitle'), { exact: false })
    expect(input).toBe(fileInput())
    expect(input).toHaveAttribute('multiple')
    expect(input).toHaveAccessibleDescription(p('files.hint'))
  })
})

describe('PostImport preview', () => {
  it('sends every chosen file as a file part in order, shows the preview and moves focus to its heading', async () => {
    const { onPreview } = setup()

    await choose(markdown('new.md'), markdown('draft.md'))

    const form = onPreview.mock.calls[0]![0] as FormData
    expect((form.getAll('file') as File[]).map((file) => file.name)).toEqual(['new.md', 'draft.md'])
    expect(form.has('manifest')).toBe(false)
    expect(screen.getByRole('heading', { name: p('preview.heading') })).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent(p('status.previewReady'))
    expect(screen.getByRole('list', { name: p('preview.listLabel') })).toBeInTheDocument()
    expect(screen.getAllByRole('listitem').some((item) => item.textContent?.includes('new.md'))).toBe(true)
  })

  it('accepts several files dropped on the drop zone', async () => {
    const { onPreview } = setup()

    await act(async () => {
      fireEvent.drop(screen.getByText(p('files.dropTitle')), {
        dataTransfer: { files: [markdown('a.md'), markdown('b.md'), markdown('c.md')] },
      })
    })

    expect((onPreview.mock.calls[0]![0] as FormData).getAll('file')).toHaveLength(3)
  })

  it('ticks new posts and changes to drafts, and leaves published, unchanged and error files unticked', async () => {
    setup()
    await choose(markdown())

    expect(card('new.md')).toBeChecked()
    expect(card('draft.md')).toBeChecked()
    expect(card('live.md')).not.toBeChecked()
    expect(card('live.md')).toBeEnabled()
    expect(card('same.md')).not.toBeChecked()
    expect(card('same.md')).toBeDisabled()
    expect(card('broken.md')).not.toBeChecked()
    expect(card('broken.md')).toBeDisabled()
    expect(screen.getByRole('button', { name: p('preview.apply', { count: 2 }) })).toBeEnabled()
  })

  it('warns that a published post goes live, and shows state, slug, changes, notes and problems of each file', async () => {
    setup({
      onPreview: vi.fn().mockResolvedValue(
        preview([
          previewFile({
            slugSource: 'file_name',
            newCategories: ['Fresh topic'],
            newTags: ['alpha'],
            notes: [
              { code: 'language_defaulted', key: null, line: null },
              { code: 'featured_ignored', key: 'featured', line: 4 },
              { code: 'translation_of_ignored', key: 'translation_of', line: 5 },
              { code: 'slug_from_file_name', key: null, line: null },
              { code: 'tags_will_be_created', key: null, line: null },
              { code: 'published_goes_live', key: null, line: null },
              { code: 'something_new', key: null, line: null },
            ],
            ignored: [
              { name: 'colour', line: 7 },
              { name: null, line: 9 },
            ],
            ignoredTotal: 3,
          }),
          ...mixed()
            .files.slice(1, 3)
            .map((file) => ({ ...file, position: file.position })),
          mixed().files[4]!,
        ]),
      ),
    })
    await choose(markdown())

    const first = within(screen.getByRole('checkbox', { name: p('preview.select', { name: 'one.md' }) }).closest('li')!)
    expect(first.getByText(p('preview.state.new'))).toBeInTheDocument()
    expect(first.getByText(p('preview.slug', { slug: 'one' }))).toBeInTheDocument()
    expect(first.getByText(p('preview.changes.tags', { added: 2, removed: 0, kept: 0 }))).toBeInTheDocument()
    expect(first.getByText(p('preview.newCategories', { names: 'Fresh topic' }))).toBeInTheDocument()
    expect(first.getByText(p('preview.newTags', { names: 'alpha' }))).toBeInTheDocument()
    expect(first.getByText(p('preview.notes.language_defaulted'))).toBeInTheDocument()
    expect(first.getByText(p('preview.notes.featured_ignored'))).toBeInTheDocument()
    expect(first.getByText(p('preview.notes.translation_of_ignored'))).toBeInTheDocument()
    expect(first.getAllByText(p('preview.notes.slug_from_file_name'))).toHaveLength(1)
    expect(first.getByText(p('preview.notes.other'))).toBeInTheDocument()
    expect(first.getByText(p('preview.ignoredHeading', { count: 3 }))).toBeInTheDocument()
    expect(first.getByText(p('preview.ignoredNamed', { name: 'colour', line: 7 }))).toBeInTheDocument()
    expect(first.getByText(p('preview.ignoredUnnamed', { line: 9 }))).toBeInTheDocument()
    expect(first.getByText(p('preview.ignoredMore', { count: 1 }))).toBeInTheDocument()

    const live = within(card('live.md').closest('li')!)
    expect(live.getByText(p('preview.published'))).toBeInTheDocument()
    expect(live.getByText(p('preview.state.will_change'))).toBeInTheDocument()

    const broken = within(card('broken.md').closest('li')!)
    expect(broken.getByText(p('preview.state.error'))).toBeInTheDocument()
    expect(
      broken.getByText(
        p('preview.problem', {
          where: `${p('preview.lineNumber', { line: 3 })}, language`,
          message: 'The language is not enabled on this site.',
        }),
      ),
    ).toBeInTheDocument()
    expect(broken.getByText(p('preview.problemsMore', { count: 1 }))).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(p('preview.filesWithProblems', { count: 1 }))
  })

  it('shows before and after of a change to an existing post, and the link and content lines', async () => {
    setup()
    await choose(markdown())

    const draft = within(card('draft.md').closest('li')!)
    expect(draft.getByText('Old title')).toBeInTheDocument()
    expect(draft.getByText('New title')).toBeInTheDocument()
    expect(draft.getByText(p('preview.changes.tags', { added: 1, removed: 2, kept: 3 }))).toBeInTheDocument()
    expect(draft.getByText(p('preview.changes.content', { differs: 'no' }))).toBeInTheDocument()
    expect(draft.getByText(p('preview.changes.link'))).toBeInTheDocument()
  })

  it('shows the series and the part as change rows and a sentence for each series note', async () => {
    setup({
      onPreview: vi.fn().mockResolvedValue(
        preview([
          previewFile({
            changes: {
              ...previewFile().changes!,
              series: { before: 'Old series', after: 'Queues in practice' },
              seriesPart: { before: null, after: 3 },
            },
            newSeries: ['Queues in practice'],
            notes: [
              { code: 'series_will_be_created', key: 'series', line: 4 },
              { code: 'series_title_differs', key: 'series', line: 4 },
              { code: 'series_description_ignored', key: 'series_description', line: 6 },
              { code: 'series_description_will_be_set', key: 'series_description', line: 6 },
              { code: 'series_ignored_author', key: 'series', line: 4 },
            ],
          }),
        ]),
      ),
    })
    await choose(markdown())

    const first = within(card('one.md').closest('li')!)
    expect(first.getByText(p('preview.changes.series'))).toBeInTheDocument()
    expect(first.getByText('Old series')).toBeInTheDocument()
    expect(first.getByText('Queues in practice')).toBeInTheDocument()
    expect(first.getByText(p('preview.changes.seriesPart'))).toBeInTheDocument()
    expect(first.getByText('3')).toBeInTheDocument()
    for (const code of [
      'series_will_be_created',
      'series_title_differs',
      'series_description_ignored',
      'series_description_will_be_set',
      'series_ignored_author',
    ]) {
      expect(first.getByText(p(`preview.notes.${code}`))).toBeInTheDocument()
    }
    expect(first.queryByText(p('preview.notes.other'))).not.toBeInTheDocument()
  })

  it('shows a sentence for each cover note', async () => {
    setup({
      onPreview: vi.fn().mockResolvedValue(
        preview([
          previewFile({
            notes: [
              { code: 'cover_will_be_set', key: 'cover', line: 5 },
              { code: 'cover_will_be_replaced', key: 'cover', line: 5 },
            ],
          }),
        ]),
      ),
    })
    await choose(markdown())

    const first = within(card('one.md').closest('li')!)
    for (const code of ['cover_will_be_set', 'cover_will_be_replaced']) {
      expect(first.getByText(p(`preview.notes.${code}`))).toBeInTheDocument()
    }
    expect(first.queryByText(p('preview.notes.other'))).not.toBeInTheDocument()
  })

  it('tells that a post without a category cannot be published before one is chosen, as a note and not a problem', async () => {
    setup({
      onPreview: vi
        .fn()
        .mockResolvedValue(preview([previewFile({ notes: [{ code: 'category_missing', key: 'category', line: null }] })])),
    })
    await choose(markdown())

    const first = within(card('one.md').closest('li')!)
    expect(first.getByText(p('preview.notes.category_missing'))).toBeInTheDocument()
    expect(first.queryByText(p('preview.notes.other'))).not.toBeInTheDocument()
    expect(first.getByText(p('preview.state.new'))).toBeInTheDocument()
  })

  it('shows no series row when the file changes nothing about the series', async () => {
    setup()
    await choose(markdown())

    expect(screen.queryByText(p('preview.changes.series'))).not.toBeInTheDocument()
    expect(screen.queryByText(p('preview.changes.seriesPart'))).not.toBeInTheDocument()
  })

  it('a preview that fails shows the sentence and keeps the files for another try', async () => {
    const onPreview = vi
      .fn()
      .mockResolvedValueOnce({ error: 'Too many requests, wait a few minutes.' })
      .mockResolvedValueOnce(mixed())
    setup({ onPreview })

    await choose(markdown('one.md'))

    expect(screen.getByRole('alert')).toHaveTextContent('Too many requests, wait a few minutes.')
    expect(screen.queryByText(p('preview.heading'))).not.toBeInTheDocument()
    await click(p('files.previewAgain'))
    expect(onPreview).toHaveBeenCalledTimes(2)
    expect((onPreview.mock.calls[1]![0] as FormData).getAll('file')).toHaveLength(1)
    expect(screen.getByText(p('preview.heading'))).toBeInTheDocument()
  })

  it('a thrown failure becomes the unreachable sentence', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setup({ onPreview: vi.fn().mockRejectedValue(new TypeError('fetch failed')) })

    await choose(markdown())

    expect(screen.getByRole('alert')).toHaveTextContent(p('errors.unreachable'))
  })

  it('drops the answer of a preview that a newer choice has replaced', async () => {
    let resolveFirst: (value: PostPreview) => void = () => {}
    const onPreview = vi
      .fn()
      .mockReturnValueOnce(new Promise<PostPreview>((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce(preview([previewFile({ fileName: 'second.md', slug: 'second' })]))
    setup({ onPreview })

    await choose(markdown('first.md'))
    await choose(markdown('second.md'))
    await act(async () => resolveFirst(preview([previewFile({ fileName: 'first.md', slug: 'first' })])))

    expect(card('second.md')).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: p('preview.select', { name: 'first.md' }) })).not.toBeInTheDocument()
  })

  it('removing the files while a preview is running drops its answer', async () => {
    let resolveFirst: (value: PostPreview) => void = () => {}
    setup({ onPreview: vi.fn().mockReturnValue(new Promise<PostPreview>((resolve) => (resolveFirst = resolve))) })

    await choose(markdown())
    await click(p('files.remove'))
    await act(async () => resolveFirst(mixed()))

    expect(screen.queryByText(p('preview.heading'))).not.toBeInTheDocument()
    expect(screen.getByText(p('files.dropTitle'))).toBeInTheDocument()
  })
})

describe('PostImport refusals before the upload', () => {
  const big = (size: number, name = 'big.md') => {
    const file = markdown(name)
    Object.defineProperty(file, 'size', { value: size })
    return file
  }

  it.each([
    ['a wrong extension', [markdown('one.md'), markdown('notes.txt')], () => p('errors.notMarkdown', { position: 2 })],
    ['an empty file', [markdown('one.md', '')], () => p('errors.emptyFile', { position: 1 })],
    [
      'a file over the cap',
      [big(POST_IMPORT_LIMIT_VALUES.maxKib * 1024 + 1)],
      () => p('errors.fileTooLarge', { position: 1, ...POST_IMPORT_LIMIT_VALUES }),
    ],
    [
      'more than 20 files',
      Array.from({ length: 21 }, (_, i) => markdown(`p${i}.md`)),
      () => p('errors.tooMany', POST_IMPORT_LIMIT_VALUES),
    ],
    [
      'a total over the cap',
      Array.from({ length: 17 }, (_, i) => big(POST_IMPORT_LIMIT_VALUES.maxKib * 1024, `p${i}.md`)),
      () => p('errors.totalTooLarge', POST_IMPORT_LIMIT_VALUES),
    ],
  ])('%s is refused without calling the server', async (_name, files, expected) => {
    const { onPreview } = setup()

    await choose(...files)

    expect(screen.getByRole('alert')).toHaveTextContent(expected())
    expect(onPreview).not.toHaveBeenCalled()
    expect(screen.getByText(p('files.dropTitle'))).toBeInTheDocument()
  })
})

describe('PostImport confirm', () => {
  it('sends the file parts in order and exactly one manifest with the hash, the tick and the state of each file', async () => {
    const { onApply } = setup({ onApply: vi.fn().mockResolvedValue(result()) })
    await choose(markdown('new.md'), markdown('draft.md'), markdown('live.md'), markdown('same.md'), markdown('broken.md'))
    fireEvent.click(card('live.md'))
    fireEvent.click(card('draft.md'))

    await click(p('preview.apply', { count: 2 }))

    const form = onApply.mock.calls[0]![0] as FormData
    expect((form.getAll('file') as File[]).map((file) => file.name)).toEqual([
      'new.md',
      'draft.md',
      'live.md',
      'same.md',
      'broken.md',
    ])
    expect(form.getAll('manifest')).toHaveLength(1)
    const manifest = JSON.parse(form.get('manifest') as string) as { sha256: string; selected: boolean; state: string | null }[]
    expect(manifest.map((item) => item.selected)).toEqual([true, false, true, false, false])
    expect(manifest.every((item) => item.sha256 === hash('a'))).toBe(true)
    expect(manifest[0]!.state).toBe(encode('new|||'))
    expect(manifest[2]!.state).toBe(updateState('PUBLISHED'))
    expect(manifest[3]!.state).toBeNull()
    expect(Object.keys(manifest[0]!).sort()).toEqual(['selected', 'sha256', 'state'])
  })

  it('cannot confirm with nothing ticked, and says so', async () => {
    setup()
    await choose(markdown())

    fireEvent.click(card('new.md'))
    fireEvent.click(card('draft.md'))

    expect(screen.getByRole('button', { name: p('preview.apply', { count: 0 }) })).toBeDisabled()
    expect(screen.getByText(p('preview.nothingSelected'))).toBeInTheDocument()
  })

  it('cannot confirm a preview in which every file has an error or is unchanged', async () => {
    setup({ onPreview: vi.fn().mockResolvedValue(preview([mixed().files[3]!, mixed().files[4]!])) })
    await choose(markdown())

    expect(screen.getByRole('button', { name: p('preview.apply', { count: 0 }) })).toBeDisabled()
    expect(card('same.md')).toBeDisabled()
    expect(card('broken.md')).toBeDisabled()
  })

  it('shows the result with a link to the editor of each written post, and moves focus to its heading', async () => {
    setup({ onApply: vi.fn().mockResolvedValue(result()) })
    await choose(markdown('new.md'), markdown('draft.md'), markdown('live.md'))

    await click(p('preview.apply', { count: 2 }))

    expect(screen.getByRole('heading', { name: p('result.heading') })).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent(p('status.applied'))
    expect(screen.getByText(p('result.summary', { created: 1, updated: 1, unchanged: 0, skipped: 1 }))).toBeInTheDocument()
    expect(screen.getByRole('link', { name: p('result.openFor', { name: 'new.md' }) })).toHaveAttribute(
      'href',
      `/admin/posts/${POST_ID}/edit`,
    )
    expect(screen.getByRole('link', { name: p('result.openFor', { name: 'draft.md' }) })).toHaveAttribute(
      'href',
      '/admin/posts/2c5ea4c0-4067-11e9-8bad-9b1deb4d3b7d/edit',
    )
    expect(screen.getAllByRole('link', { name: new RegExp(p('result.open')) })).toHaveLength(2)
    expect(screen.queryByText(p('preview.heading'))).not.toBeInTheDocument()
  })

  it('"import more files" goes back to the start', async () => {
    setup({ onApply: vi.fn().mockResolvedValue(result()) })
    await choose(markdown())
    await click(p('preview.apply', { count: 2 }))

    await click(p('result.another'))

    expect(screen.getByText(p('files.dropTitle'))).toBeInTheDocument()
    expect(screen.queryByText(p('result.heading'))).not.toBeInTheDocument()
  })

  it('a refusal keeps the preview and the ticks, shows the sentence and gives the focus back to the import button', async () => {
    const { onApply } = setup({ onApply: vi.fn().mockResolvedValue({ error: 'Too many requests, wait a few minutes.' }) })
    await choose(markdown())
    fireEvent.click(card('live.md'))

    await click(p('preview.apply', { count: 3 }))

    expect(onApply).toHaveBeenCalledTimes(1)
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toContain('Too many requests, wait a few minutes.')
    expect(card('live.md')).toBeChecked()
    expect(screen.getByRole('button', { name: p('preview.apply', { count: 3 }) })).toHaveFocus()
  })

  it('an answer that asks for a new preview drops the old preview, keeps the files and focuses "preview again"', async () => {
    const onPreview = vi.fn().mockResolvedValue(mixed())
    const stale = 'Some posts changed since the preview, so nothing was imported. Preview the files again.'
    const { onApply } = setup({ onPreview, onApply: vi.fn().mockResolvedValue({ error: stale, stale: true }) })
    await choose(markdown('new.md'), markdown('draft.md'))

    await click(p('preview.apply', { count: 2 }))

    expect(screen.getByRole('alert')).toHaveTextContent(stale)
    expect(screen.queryByText(p('preview.heading'))).not.toBeInTheDocument()
    expect(screen.getByText('new.md')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: p('files.previewAgain') })).toHaveFocus()

    await click(p('files.previewAgain'))

    expect(onPreview).toHaveBeenCalledTimes(2)
    expect((onPreview.mock.calls[1]![0] as FormData).getAll('file')).toHaveLength(2)
    expect(onApply).toHaveBeenCalledTimes(1)
    expect(screen.getByText(p('preview.heading'))).toBeInTheDocument()
  })

  it('a thrown failure during the apply is the unreachable sentence and the preview stays', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setup({ onApply: vi.fn().mockRejectedValue(new TypeError('fetch failed')) })
    await choose(markdown())

    await click(p('preview.apply', { count: 2 }))

    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toContain(p('errors.unreachable'))
    expect(screen.getByText(p('preview.heading'))).toBeInTheDocument()
  })

  it('removing all files goes back to the start', async () => {
    setup()
    await choose(markdown())

    await click(p('files.remove'))

    expect(screen.queryByText(p('preview.heading'))).not.toBeInTheDocument()
    expect(screen.getByText(p('files.dropTitle'))).toBeInTheDocument()
  })
})
