import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import Link from 'next/link'
import { renderToString } from 'react-dom/server'

// Only prepareUpload is replaced (the part that touches the canvas), as in CoverPanel.test.tsx; UploadRejectedError keeps the
// real one so the editor recognizes it with instanceof.
const { prepareUpload } = vi.hoisted(() => ({ prepareUpload: vi.fn() }))
vi.mock('@/lib/prepare-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/prepare-upload')>()),
  prepareUpload,
}))

import { CATALOGS, currentTestLocale, IntlWrapper, msg } from '@/test/intl'
import { OLD_SLUG_WARNING, VI_TITLE, VI_TITLE_SHORT, VI_TITLE_SUFFIX } from '@/test/fixtures/vi/post-editor-slug'
import { UploadRejectedError } from '@/lib/prepare-upload'
import type { MediaRef, Post, PostRevision } from '@/lib/types'
import type { ImageListOutcome, ImageUploadOutcome, RevisionOutcome } from './editor-types'

import { draftKey } from '@/lib/draft-storage'
import { DraftOwner } from './DraftOwner'
import PostEditor, { isRedirectError, readingMinutes, wordCount } from './PostEditor'
import { DRAFT_DEBOUNCE_MS } from './useDraftAutosave'

const SESSION_EXPIRED = msg('Errors.admin.sessionExpired')

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** A case-insensitive regular expression for a catalog message, optionally anchored. */
const rx = (text: string, { start = false, end = false } = {}) =>
  new RegExp(`${start ? '^' : ''}${escapeRegExp(text)}${end ? '$' : ''}`, 'i')
/** The text of a message before / after one ICU argument (the argument itself is dynamic in the test). */
const before = (key: string, arg: string, extra: Record<string, string> = {}) =>
  msg(key, { ...extra, [arg]: '@@' }).split('@@')[0]
const after = (key: string, arg: string) => msg(key, { [arg]: '@@' }).split('@@')[1]
/** The label of the <login> link inside the rich session-expired sentence of the editor. */
const LOGIN_LINK = (
  (CATALOGS[currentTestLocale()] as { Admin: { editor: { sessionExpired: string } } }).Admin.editor.sessionExpired.match(
    /<login>(.*?)<\/login>/,
  ) as RegExpMatchArray
)[1]

const TITLE = rx(msg('Admin.editor.titleLabel'))
const SLUG = rx(msg('Admin.editor.slugLabel'))
const CONTENT = rx(msg('Admin.editor.contentLabel'))
const EXCERPT = rx(msg('Admin.editor.excerptLabel'))
const CATEGORY = rx(msg('Admin.editor.categoryLabel'), { start: true, end: true })
const UNPUBLISH = rx(msg('Admin.editor.unpublish'))
const PUBLISH = rx(msg('Admin.editor.publish'), { start: true })
const SAVE = rx(msg('Admin.editor.save'))
const ADD = rx(msg('Admin.editor.inlineCreate.add'), { start: true, end: true })
const ADD_CATEGORY = rx(msg('Admin.editor.addCategory'))
const CATEGORY_NAME = rx(msg('Admin.editor.categoryName'))
const ADD_TAG = rx(msg('Admin.editor.addTag'))
const TAG_NAME = rx(msg('Admin.editor.tagName'))
const LEAVE_GROUP = rx(msg('Admin.editor.leaveQuestion'))
const LINT_COUNT = rx(after('Admin.editor.lintCountSr', 'count'))
const DRAFT_OFFER = rx(before('Admin.editor.draftOffer', 'time').trim())
const VIEW_REVISION = rx(before('Admin.revisions.viewAria', 'time'), { start: true })
const SAVED_AT = new RegExp(`^${escapeRegExp(msg('Admin.editor.state.savedAt', { time: '@@' })).replace('@@', '\\d{2}:\\d{2}')}$`)
const SAVED_AT_PREFIX = rx(before('Admin.editor.state.savedAt', 'time'), { start: true })
const PUBLISHED_AT_PREFIX = rx(before('Admin.editor.state.publishedAt', 'time'), { start: true })

// The local draft lives in jsdom's localStorage, shared by every test in the file: if not cleaned, one
// test leaves a draft behind and the next one opens with a restore offer.
beforeEach(() => {
  localStorage.clear()
})

/**
 * The originally drafted `import userEvent from '@testing-library/user-event'` cannot resolve: the
 * package is not a dependency of this project and not in package-lock.json either
 * (`grep -c user-event package-lock.json` -> 0). Verbatim, with that import:
 *
 *   Error: Failed to resolve import "@testing-library/user-event" from
 *   "components/admin/PostEditor.test.tsx". Does the file exist?
 *
 * Installing it would rewrite package.json, package-lock.json and node_modules, none of
 * which belong to this task, so the three calls the tests use are shimmed here instead.
 * Every test body below is unchanged from the original draft.
 *
 * `type` replays one change event PER CHARACTER with the cumulative value rather than a
 * single bulk change, and that is load-bearing: the slug derivation runs in the title's
 * onChange, so a single event would also pass against an implementation that only
 * derived on blur, and the "stops deriving once the author types in the slug box" test
 * would no longer prove a latch. `act` wraps each one so React flushes state and so an
 * async click handler's promise settles before the next line of the test reads the DOM.
 */
const userEvent = {
  async type(element: HTMLElement, text: string): Promise<void> {
    const field = element as HTMLInputElement | HTMLTextAreaElement
    for (const character of text) {
      const next = field.value + character
      await act(async () => {
        fireEvent.change(field, { target: { value: next } })
      })
    }
  },
  async clear(element: HTMLElement): Promise<void> {
    await act(async () => {
      fireEvent.change(element, { target: { value: '' } })
    })
  },
  async click(element: HTMLElement): Promise<void> {
    await act(async () => {
      fireEvent.click(element)
    })
  },
}

const save = vi.fn()
const publish = vi.fn()
const unpublish = vi.fn()

const baseProps = {
  post: null,
  categories: [{ id: 'c1', name: 'Java', slug: 'java', description: null }],
  tags: [{ id: 't1', name: 'Spring', slug: 'spring' }],
  onSave: save,
  onPublish: publish,
  onUnpublish: unpublish,
  preview: null,
}

describe('PostEditor', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('derives the slug from a Vietnamese title until the author edits it', async () => {
    render(<PostEditor {...baseProps} />)

    await userEvent.type(screen.getByLabelText(TITLE), VI_TITLE)

    // The backend would derive the same slug, but the author has to SEE it before
    // publishing, because after publishing the URL is permanent.
    expect(screen.getByLabelText(SLUG)).toHaveValue('hoc-spring-boot-tu-dau')
  })

  it('empties the slug box when the title is cleared, rather than showing untitled', async () => {
    render(<PostEditor {...baseProps} />)
    const title = screen.getByLabelText(TITLE)

    await userEvent.type(title, 'Temp')
    await userEvent.clear(title)

    // The backend substitutes "untitled" when nothing survives normalisation, which is
    // right for a post with no usable title and wrong for a box the author is still
    // typing into — they would publish /posts/untitled without noticing.
    expect(screen.getByLabelText(SLUG)).toHaveValue('')
  })

  it('stops deriving once the author types in the slug box', async () => {
    render(<PostEditor {...baseProps} />)

    await userEvent.type(screen.getByLabelText(TITLE), 'Title one')
    await userEvent.clear(screen.getByLabelText(SLUG))
    await userEvent.type(screen.getByLabelText(SLUG), 'toi-tu-chon')
    await userEvent.type(screen.getByLabelText(TITLE), ' two')

    // Re-deriving here would silently discard a slug the author chose on purpose.
    expect(screen.getByLabelText(SLUG)).toHaveValue('toi-tu-chon')
  })

  it('does not derive a slug for an existing post, whatever happens to the title', async () => {
    render(
      <PostEditor
        {...baseProps}
        post={{
          id: 'p1',
          title: 'Old title',
          slug: 'tieu-de-cu',
          excerpt: null,
          content: 'noi dung',
          status: 'PUBLISHED',
          category: null,
          tags: [],
          publishedAt: '2026-10-01T00:00:00Z',
          featured: false,
          readingMinutes: 1,
          createdAt: '2026-10-01T00:00:00Z',
          updatedAt: '2026-10-01T00:00:00Z',
        }}
      />,
    )

    await userEvent.clear(screen.getByLabelText(TITLE))
    await userEvent.type(screen.getByLabelText(TITLE), 'A completely new title')

    expect(screen.getByLabelText(SLUG)).toHaveValue('tieu-de-cu')
  })

  it('pre-selects the tags the post already has', () => {
    render(
      <PostEditor
        {...baseProps}
        tags={[
          { id: 't1', name: 'Spring', slug: 'spring' },
          { id: 't2', name: 'Java', slug: 'java' },
        ]}
        post={{
          id: 'p1',
          title: 't',
          slug: 's',
          excerpt: null,
          content: 'c',
          status: 'DRAFT',
          category: null,
          tags: [{ id: 't2', name: 'Java', slug: 'java' }],
          publishedAt: null,
          featured: false,
          readingMinutes: 1,
          createdAt: '2026-10-01T00:00:00Z',
          updatedAt: '2026-10-01T00:00:00Z',
        }}
      />,
    )

    // This is what Task 1's tag-object change bought. With names only, the editor would
    // have had to guess which checkbox matched "Java".
    expect(screen.getByRole('checkbox', { name: 'Java' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Spring' })).not.toBeChecked()
  })

  it('offers publish for a draft and unpublish for a published post, never both', () => {
    const { unmount } = render(<PostEditor {...baseProps} />)
    expect(screen.queryByRole('button', { name: UNPUBLISH })).toBeNull()
    unmount()

    render(
      <PostEditor
        {...baseProps}
        post={{
          id: 'p1',
          title: 't',
          slug: 's',
          excerpt: null,
          content: 'c',
          status: 'PUBLISHED',
          category: null,
          tags: [],
          publishedAt: '2026-10-01T00:00:00Z',
          featured: false,
          readingMinutes: 1,
          createdAt: '2026-10-01T00:00:00Z',
          updatedAt: '2026-10-01T00:00:00Z',
        }}
      />,
    )
    expect(screen.getByRole('button', { name: UNPUBLISH })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: PUBLISH })).toBeNull()
  })

  it('adds a category created inline and selects it, without a page reload', async () => {
    const addCategory = vi.fn().mockResolvedValue({ id: 'c2', name: 'Spring', slug: 'spring', description: null })
    render(<PostEditor {...baseProps} onCreateCategory={addCategory} />)

    await userEvent.click(screen.getByRole('button', { name: ADD_CATEGORY }))
    await userEvent.type(screen.getByLabelText(CATEGORY_NAME), 'Spring')
    await userEvent.click(screen.getByRole('button', { name: ADD }))

    // Category creation is inline for one reason: publishing REQUIRES a
    // category, so a fresh install has no way to publish its first post without it.
    // Losing the draft to a navigation would defeat the point, so the new option has to
    // appear in the select that is already on screen.
    expect(addCategory).toHaveBeenCalledWith('Spring')
    expect(await screen.findByRole('option', { name: 'Spring' })).toBeInTheDocument()
    expect(screen.getByLabelText(CATEGORY)).toHaveValue('c2')
  })

  it('keeps the typed body when a tag is created inline', async () => {
    const addTag = vi.fn().mockResolvedValue({ id: 't2', name: 'Testcontainers', slug: 'testcontainers' })
    render(<PostEditor {...baseProps} onCreateTag={addTag} />)

    await userEvent.type(screen.getByLabelText(CONTENT), 'a long body')
    await userEvent.click(screen.getByRole('button', { name: ADD_TAG }))
    await userEvent.type(screen.getByLabelText(TAG_NAME), 'Testcontainers')
    await userEvent.click(screen.getByRole('button', { name: ADD }))

    expect(screen.getByRole('checkbox', { name: 'Testcontainers' })).toBeChecked()
    expect(screen.getByLabelText(CONTENT)).toHaveValue('a long body')
  })

  it('reports an inline-create failure without clearing the form', async () => {
    const addTag = vi.fn().mockResolvedValue({ error: 'Tag already exists' })
    render(<PostEditor {...baseProps} onCreateTag={addTag} />)

    await userEvent.click(screen.getByRole('button', { name: ADD_TAG }))
    await userEvent.type(screen.getByLabelText(TAG_NAME), 'Spring')
    await userEvent.click(screen.getByRole('button', { name: ADD }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Tag already exists')
    // TAG_ALREADY_EXISTS is the likeliest error here and it must not look like a crash.
    expect(screen.getByRole('checkbox', { name: 'Spring' })).toBeInTheDocument()
  })

  it('shows the error an action returns instead of losing what was typed', async () => {
    save.mockResolvedValue({ error: 'Post must have a category before publishing' })
    render(<PostEditor {...baseProps} />)

    await userEvent.type(screen.getByLabelText(TITLE), msg('Admin.editor.titleNew'))
    await userEvent.type(screen.getByLabelText(CONTENT), 'noi dung')
    await userEvent.click(screen.getByRole('button', { name: SAVE }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Post must have a category')
    // The failure that matters: an author who wrote 2000 words must not lose them to a
    // validation error.
    expect(screen.getByLabelText(CONTENT)).toHaveValue('noi dung')
  })

  // ---------------------------------------------------------------------------------
  // Three extra tests. Each exists because a mutation proved the baseline tests do not
  // catch something load-bearing; the mutation is
  // quoted in each comment.
  // ---------------------------------------------------------------------------------

  it('creates a tag inline without submitting the post', async () => {
    const addTag = vi.fn().mockResolvedValue({ id: 't2', name: 'Testcontainers', slug: 'testcontainers' })
    save.mockResolvedValue({ id: 'p1', slug: 's' })
    render(<PostEditor {...baseProps} onCreateTag={addTag} />)

    // Filled first so the submit this test is hunting is not blocked instead by the
    // browser's own constraint validation on the two `required` fields -- which would
    // make the assertion below pass for the wrong reason.
    await userEvent.type(screen.getByLabelText(TITLE), msg('Admin.editor.titleNew'))
    await userEvent.type(screen.getByLabelText(CONTENT), 'noi dung')

    await userEvent.click(screen.getByRole('button', { name: ADD_TAG }))
    await userEvent.type(screen.getByLabelText(TAG_NAME), 'Testcontainers')
    await userEvent.click(screen.getByRole('button', { name: ADD }))

    expect(addTag).toHaveBeenCalledWith('Testcontainers')
    // HTML forbids nested forms, so InlineCreate's controls necessarily sit inside the
    // editor's own <form>. With `type="submit"` the add button saves the post instead of
    // creating the tag. Measured: changing InlineCreate's add button to type="submit"
    // left all ten baseline tests green ("Tests 16 passed (16)") -- nothing in the
    // file looked at `save`, so the whole hazard was unguarded.
    expect(save).not.toHaveBeenCalled()
  })

  it('sends every field the Server Action reads, one tagIds entry per checked tag', async () => {
    save.mockResolvedValue({ id: 'p1', slug: 'hoc-spring' })
    render(
      <PostEditor
        {...baseProps}
        tags={[
          { id: 't1', name: 'Spring', slug: 'spring' },
          { id: 't2', name: 'Java', slug: 'java' },
        ]}
      />,
    )

    await userEvent.type(screen.getByLabelText(TITLE), VI_TITLE_SHORT)
    await userEvent.type(screen.getByLabelText(EXCERPT), 'mo ta')
    await userEvent.type(screen.getByLabelText(CONTENT), 'noi dung')
    await userEvent.click(screen.getByRole('checkbox', { name: 'Spring' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Java' }))
    await userEvent.click(screen.getByRole('button', { name: SAVE }))

    const form = save.mock.calls[0][0] as FormData
    // Every name below is a string `inputFrom` looks up in the FormData. A missing or
    // misspelled `name` attribute is invisible to every other test here: the action would
    // simply receive undefined and that field would never be saved, with nothing red.
    expect(form.get('title')).toBe(VI_TITLE_SHORT)
    expect(form.get('slug')).toBe('hoc-spring')
    expect(form.get('excerpt')).toBe('mo ta')
    expect(form.get('content')).toBe('noi dung')
    // '' rather than null: the select is unset, but the field is present. `null` here
    // would mean the name attribute is gone.
    expect(form.get('categoryId')).toBe('')
    // Two entries under ONE name -- the repeated-field shape that `inputFrom`'s getAll
    // exists for. The action-side test proves getAll reads it; this proves the editor
    // actually emits it.
    expect(form.getAll('tagIds')).toEqual(['t1', 't2'])
  })

  it('runs the publish and unpublish actions when their buttons are pressed', async () => {
    const existing = {
      id: 'p1',
      title: 't',
      slug: 's',
      excerpt: null,
      content: 'c',
      category: null,
      tags: [],
      featured: false,
      readingMinutes: 1,
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
    }
    publish.mockResolvedValue({ id: 'p1', slug: 's' })
    unpublish.mockResolvedValue({ id: 'p1', slug: 's' })

    const { unmount } = render(<PostEditor {...baseProps} post={{ ...existing, status: 'DRAFT', publishedAt: null }} />)
    await userEvent.click(screen.getByRole('button', { name: PUBLISH }))
    expect(publish).toHaveBeenCalledTimes(1)
    unmount()

    render(<PostEditor {...baseProps} post={{ ...existing, status: 'PUBLISHED', publishedAt: '2026-10-01T00:00:00Z' }} />)
    await userEvent.click(screen.getByRole('button', { name: UNPUBLISH }))
    // The baseline test asserts only which of the two buttons is RENDERED. Measured: an
    // onClick replaced with `() => {}` on either button kept all ten green, so a button
    // that did nothing at all would have shipped -- in the task whose entire point is
    // publishing a post.
    expect(unpublish).toHaveBeenCalledTimes(1)
  })

  it('shows the slug the backend actually stored, not the one that was submitted', async () => {
    // The backend does not have to honour the submitted slug: SlugGenerator.ensureUnique
    // appends `-2`, `-3` ... when it collides, silently, and the response carries what it
    // really wrote. Leaving the submitted value on screen would show the author a URL
    // that is not their post's -- on the one field whose entire reason for being visible
    // is that the URL is about to become permanent.
    save.mockResolvedValue({ id: 'p1', slug: 'hoc-spring-boot-tu-dau-2' })
    render(<PostEditor {...baseProps} />)

    await userEvent.type(screen.getByLabelText(TITLE), VI_TITLE)
    // The pre-condition: before the save, the box shows the locally derived slug.
    expect(screen.getByLabelText(SLUG)).toHaveValue('hoc-spring-boot-tu-dau')
    await userEvent.type(screen.getByLabelText(CONTENT), 'noi dung')
    await userEvent.click(screen.getByRole('button', { name: SAVE }))

    expect(screen.getByLabelText(SLUG)).toHaveValue('hoc-spring-boot-tu-dau-2')
  })

  it('keeps the stored slug even if the title is edited again afterwards', async () => {
    save.mockResolvedValue({ id: 'p1', slug: 'hoc-spring-boot-tu-dau-2' })
    render(<PostEditor {...baseProps} />)

    await userEvent.type(screen.getByLabelText(TITLE), VI_TITLE)
    await userEvent.type(screen.getByLabelText(CONTENT), 'noi dung')
    await userEvent.click(screen.getByRole('button', { name: SAVE }))
    await userEvent.type(screen.getByLabelText(TITLE), VI_TITLE_SUFFIX)

    // Reading the slug back is only half of it: the post now EXISTS, so re-deriving on
    // the next keystroke would overwrite a live URL with a guess. Without the latch this
    // reads back as 'hoc-spring-boot-tu-dau-nua'.
    expect(screen.getByLabelText(SLUG)).toHaveValue('hoc-spring-boot-tu-dau-2')
  })

  it('does not report a redirect as a form error when the action navigates away', async () => {
    // A Server Action that calls `redirect()` has its client promise REJECTED on purpose:
    // "the action promise will be rejected with a redirect so that it's handled by
    // RedirectBoundary" -- node_modules/next/dist/client/components/router-reducer/
    // reducers/server-action-reducer.js:242. app/admin/posts/new/page.tsx redirects on
    // every successful create, so a catch-all here would greet the author with
    // "NEXT_REDIRECT" on the one path that just worked.
    //
    // Honest limit on this assertion: it distinguishes "swallowed" from "shown as a form
    // error", not from "left as an unhandled rejection" -- both of the latter render no
    // alert. Confirming the console is clean needs the browser walkthrough.
    save.mockRejectedValue(Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;push;/admin/posts/p1/edit;303;' }))
    render(<PostEditor {...baseProps} />)

    await userEvent.type(screen.getByLabelText(TITLE), msg('Admin.editor.titleNew'))
    await userEvent.type(screen.getByLabelText(CONTENT), 'noi dung')
    await userEvent.click(screen.getByRole('button', { name: SAVE }))

    expect(screen.queryByRole('alert')).toBeNull()
    // Re-enabled, so the author is not left looking at a dead form if the navigation is
    // slow or never comes.
    expect(screen.getByRole('button', { name: SAVE })).toBeEnabled()
  })

  // ---------------------------------------------------------------------------------
  // Silent error (QA): the guard in posts/actions.ts rethrows SessionExpiredError and network errors,
  // `run` rethrows again, and the author presses Save and sees nothing. Now every error shows in place and the
  // post being edited stays intact.
  // ---------------------------------------------------------------------------------

  async function typeDraftAndSave() {
    await userEvent.type(screen.getByLabelText(TITLE), msg('Admin.editor.titleNew'))
    await userEvent.type(screen.getByLabelText(CONTENT), 'two thousand words being drafted')
    await userEvent.click(screen.getByRole('button', { name: SAVE }))
  }

  it('session expired: an in-place instruction, the login link opens a new tab, the post being edited stays intact', async () => {
    save.mockResolvedValue({ error: SESSION_EXPIRED, sessionExpired: true })
    render(<PostEditor {...baseProps} />)

    await typeDraftAndSave()

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(SESSION_EXPIRED)
    const login = within(alert).getByRole('link', { name: LOGIN_LINK })
    expect(login).toHaveAttribute('href', '/admin/login')
    // New tab: navigating away in this tab would lose the post being edited.
    expect(login).toHaveAttribute('target', '_blank')
    expect(login.getAttribute('rel')).toMatch(/\bnoopener\b/)
    expect(screen.getByLabelText(TITLE)).toHaveValue(msg('Admin.editor.titleNew'))
    expect(screen.getByLabelText(CONTENT)).toHaveValue('two thousand words being drafted')
    expect(screen.getByRole('button', { name: SAVE })).toBeEnabled()
  })

  it('an ordinary error has no login link', async () => {
    save.mockResolvedValue({ error: msg('Errors.admin.invalidDetail', { detail: 'size must be between 0 and 255' }) })
    render(<PostEditor {...baseProps} />)

    await typeDraftAndSave()

    expect(await screen.findByRole('alert')).toHaveTextContent(
      msg('Errors.admin.invalidDetail', { detail: 'size must be between 0 and 255' }),
    )
    expect(within(screen.getByRole('alert')).queryByRole('link')).toBeNull()
  })

  it('the action promise is rejected (network to Next dropped): "Could not reach the server", nothing thrown, the post stays intact', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cause = new TypeError('Failed to fetch')
    save.mockRejectedValue(cause)
    render(<PostEditor {...baseProps} />)

    await typeDraftAndSave()

    expect(await screen.findByRole('alert')).toHaveTextContent(msg('Errors.admin.unreachable'))
    expect(log).toHaveBeenCalledWith(expect.any(String), cause)
    expect(screen.getByLabelText(CONTENT)).toHaveValue('two thousand words being drafted')
    expect(screen.getByRole('button', { name: SAVE })).toBeEnabled()
    log.mockRestore()
  })

  it('a rejected publish also shows the error in place', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    publish.mockRejectedValue(new Error('An unexpected response was received from the server.'))
    render(
      <PostEditor
        {...baseProps}
        post={{
          id: 'p1',
          title: 't',
          slug: 's',
          excerpt: null,
          content: 'c',
          status: 'DRAFT',
          category: null,
          tags: [],
          publishedAt: null,
          featured: false,
          readingMinutes: 1,
          createdAt: '2026-10-01T00:00:00Z',
          updatedAt: '2026-10-01T00:00:00Z',
        }}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: PUBLISH }))

    expect(await screen.findByRole('alert')).toHaveTextContent(msg('Errors.admin.unreachable'))
    log.mockRestore()
  })

  it('in-place tag creation rejected: an in-place error instead of an unhandled promise', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const addTag = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    render(<PostEditor {...baseProps} onCreateTag={addTag} />)

    await userEvent.type(screen.getByLabelText(CONTENT), 'a long body')
    await userEvent.click(screen.getByRole('button', { name: ADD_TAG }))
    await userEvent.type(screen.getByLabelText(TAG_NAME), 'Testcontainers')
    await userEvent.click(screen.getByRole('button', { name: ADD }))

    expect(await screen.findByRole('alert')).toHaveTextContent(msg('Errors.admin.unreachable'))
    expect(screen.getByLabelText(CONTENT)).toHaveValue('a long body')
    log.mockRestore()
  })

  it('session expired while creating a category in place: the same sentence with the login link', async () => {
    const addCategory = vi.fn().mockResolvedValue({ error: SESSION_EXPIRED, sessionExpired: true })
    render(<PostEditor {...baseProps} onCreateCategory={addCategory} />)

    await userEvent.click(screen.getByRole('button', { name: ADD_CATEGORY }))
    await userEvent.type(screen.getByLabelText(CATEGORY_NAME), 'AWS')
    await userEvent.click(screen.getByRole('button', { name: ADD }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(SESSION_EXPIRED)
    expect(within(alert).getByRole('link', { name: LOGIN_LINK })).toHaveAttribute('target', '_blank')
  })
})

describe('PostEditor — writing desk (redesigned Ghost-style)', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  const draft = {
    id: 'p1',
    title: msg('Admin.statuses.post.DRAFT'),
    slug: 'ban-nhap',
    excerpt: null,
    content: 'noi dung da luu',
    status: 'DRAFT',
    category: null,
    tags: [],
    publishedAt: null,
    featured: false,
    readingMinutes: 1,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  }

  function status() {
    return screen.getAllByRole('status')[0]
  }

  it('status line: "Saved" when opened, "Unsaved changes" while typing, "Saved at …" after saving', async () => {
    save.mockResolvedValue({ id: 'p1', slug: 'ban-nhap' })
    render(<PostEditor {...baseProps} post={draft} />)

    expect(status()).toHaveTextContent(msg('Admin.editor.state.saved'))
    await userEvent.type(screen.getByLabelText(CONTENT), ' them')
    expect(status()).toHaveTextContent(msg('Admin.editor.state.unsaved'))

    await userEvent.click(screen.getByRole('button', { name: SAVE }))
    expect(status()).toHaveTextContent(SAVED_AT)
  })

  it('typing exactly the saved text again clears "unsaved": compared with the saved version, not with "ever typed"', async () => {
    render(<PostEditor {...baseProps} post={draft} />)
    const content = screen.getByLabelText(CONTENT)

    await userEvent.type(content, 'x')
    expect(status()).toHaveTextContent(msg('Admin.editor.state.unsaved'))
    await act(async () => {
      fireEvent.change(content, { target: { value: 'noi dung da luu' } })
    })
    expect(status()).toHaveTextContent(msg('Admin.editor.state.saved'))
  })

  it('"Publish" with unsaved changes: saves first, then publishes', async () => {
    save.mockResolvedValue({ id: 'p1', slug: 'ban-nhap' })
    publish.mockResolvedValue({ id: 'p1', slug: 'ban-nhap' })
    render(<PostEditor {...baseProps} post={draft} />)

    await userEvent.type(screen.getByLabelText(CONTENT), ' moi')
    await userEvent.click(screen.getByRole('button', { name: PUBLISH }))

    // Publishing reads the SAVED version in the backend: without this save the old version would be published.
    expect(save).toHaveBeenCalledTimes(1)
    expect((save.mock.calls[0][0] as FormData).get('content')).toBe('noi dung da luu moi')
    expect(publish).toHaveBeenCalledTimes(1)
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(publish.mock.invocationCallOrder[0])
    expect(status()).toHaveTextContent(PUBLISHED_AT_PREFIX)
  })

  it('a failed save does not publish, and the error of the save shows', async () => {
    save.mockResolvedValue({ error: msg('Errors.admin.invalid') })
    render(<PostEditor {...baseProps} post={draft} />)

    await userEvent.type(screen.getByLabelText(CONTENT), ' moi')
    await userEvent.click(screen.getByRole('button', { name: PUBLISH }))

    expect(publish).not.toHaveBeenCalled()
    expect(await screen.findByRole('alert')).toHaveTextContent(msg('Errors.admin.invalid'))
  })

  it('with no changes "Publish" only publishes, with no redundant save', async () => {
    publish.mockResolvedValue({ id: 'p1', slug: 'ban-nhap' })
    render(<PostEditor {...baseProps} post={draft} />)

    await userEvent.click(screen.getByRole('button', { name: PUBLISH }))

    expect(save).not.toHaveBeenCalled()
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('Ctrl+S saves anywhere on the page, through exactly the same path as the Save button', async () => {
    save.mockResolvedValue({ id: 'p1', slug: 'ban-nhap' })
    render(<PostEditor {...baseProps} post={draft} />)

    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })
    await act(async () => {
      window.dispatchEvent(event)
    })

    expect(event.defaultPrevented).toBe(true)
    expect(save).toHaveBeenCalledTimes(1)
    expect((save.mock.calls[0][0] as FormData).get('title')).toBe(msg('Admin.statuses.post.DRAFT'))
  })

  it('leaving through the "Posts" link with unsaved changes: asks again in place, focus on "Stay"', async () => {
    render(<PostEditor {...baseProps} post={draft} />)
    const back = screen.getByRole('link', { name: msg('Site.about.readNextLinks.writing') })

    // Nothing changed: the link goes straight through, no question.
    expect(fireEvent.click(back)).toBe(true)
    expect(screen.queryByRole('group', { name: LEAVE_GROUP })).toBeNull()

    await userEvent.type(screen.getByLabelText(CONTENT), ' moi')
    await act(async () => {
      fireEvent.click(back)
    })
    const prompt = screen.getByRole('group', { name: LEAVE_GROUP })
    expect(within(prompt).getByRole('button', { name: msg('Admin.editor.stay') })).toHaveFocus()
    expect(within(prompt).getByRole('link', { name: msg('Admin.editor.leave') })).toHaveAttribute('href', '/admin')

    await userEvent.click(within(prompt).getByRole('button', { name: msg('Admin.editor.stay') }))
    expect(screen.queryByRole('group', { name: LEAVE_GROUP })).toBeNull()
    expect(screen.getByLabelText(CONTENT)).toHaveValue('noi dung da luu moi')
  })

  it('closing the tab with unsaved changes: the browser is asked to warn; once saved, it is not', async () => {
    render(<PostEditor {...baseProps} post={draft} />)
    const fire = () => {
      const event = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    }

    expect(fire()).toBe(false)
    await userEvent.type(screen.getByLabelText(CONTENT), ' moi')
    expect(fire()).toBe(true)
  })

  it('Enter in the title moves to the description box, no new line; pasting several lines joins them with spaces', async () => {
    render(<PostEditor {...baseProps} />)
    const title = screen.getByLabelText(TITLE)

    title.focus()
    fireEvent.keyDown(title, { key: 'Enter' })
    expect(screen.getByLabelText(EXCERPT)).toHaveFocus()

    await act(async () => {
      fireEvent.change(title, { target: { value: 'Line one\nLine two' } })
    })
    expect(title).toHaveValue('Line one Line two')
  })

  it('every box of the post belongs to the post form; the cover image box and the in-place tag box do not', async () => {
    render(
      <PostEditor
        {...baseProps}
        post={draft}
        onCreateTag={vi.fn()}
        aside={
          <section aria-label={msg('Admin.editor.cover.heading')}>
            <label htmlFor="alt">{msg('Admin.editor.cover.altLabel')}</label>
            <input id="alt" />
          </section>
        }
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: ADD_TAG }))

    const form = screen
      .getByRole('button', { name: msg('Site.comments.item.editSave') })
      .closest('div')!
      .ownerDocument.querySelector('form')!
    const names = Array.from(form.elements)
      .map((element) => (element as HTMLInputElement).name)
      .filter((name) => name !== '')
    expect(new Set(names)).toEqual(new Set(['title', 'excerpt', 'content', 'slug', 'categoryId', 'tagIds', 'language']))
    // Enter in these two boxes must not submit the post.
    expect((screen.getByLabelText(msg('Admin.editor.cover.altLabel')) as HTMLInputElement).form).toBeNull()
    expect((screen.getByLabelText(TAG_NAME) as HTMLInputElement).form).toBeNull()
  })

  it('preview of the saved version: hidden by default, the toggle button states its state via aria-pressed, the content box keeps its text', async () => {
    render(<PostEditor {...baseProps} post={draft} preview={<p>Rendered version</p>} />)
    const toggle = screen.getByRole('button', { name: msg('Admin.posts.row.preview') })

    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByText('Rendered version')).toBeNull()

    await userEvent.click(toggle)
    // A fixed label, the state in aria-pressed: changing both makes a screen reader read a self-contradicting sentence.
    expect(screen.getByRole('button', { name: msg('Admin.posts.row.preview') })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Rendered version')).toBeInTheDocument()
    expect(screen.getByLabelText(CONTENT)).not.toBeVisible()
    expect(screen.getByLabelText(CONTENT)).toHaveValue('noi dung da luu')
  })

  it('while previewing with empty content: pressing Save reopens the writing area instead of silently blocking the submit', async () => {
    render(<PostEditor {...baseProps} post={draft} preview={<p>Rendered version</p>} />)
    const content = screen.getByLabelText(CONTENT)
    await act(async () => {
      fireEvent.change(content, { target: { value: '' } })
    })
    await userEvent.click(screen.getByRole('button', { name: msg('Admin.posts.row.preview') }))
    expect(content).not.toBeVisible()

    await userEvent.click(screen.getByRole('button', { name: SAVE }))

    // The empty box is still invalid so no save happens — but the box is shown again so the browser can point at it.
    expect(save).not.toHaveBeenCalled()
    expect(content).toBeVisible()
    expect(screen.getByRole('button', { name: msg('Admin.posts.row.preview') })).toHaveAttribute('aria-pressed', 'false')
  })

  it('the leave-page prompt stops applying once saved: typing again does not bring it back or jolt focus', async () => {
    save.mockResolvedValue({ id: 'p1', slug: 'ban-nhap' })
    render(<PostEditor {...baseProps} post={draft} />)
    const content = screen.getByLabelText(CONTENT)

    await userEvent.type(content, ' a')
    await act(async () => {
      fireEvent.click(screen.getByRole('link', { name: msg('Site.about.readNextLinks.writing') }))
    })
    expect(screen.getByRole('group', { name: LEAVE_GROUP })).toBeInTheDocument()

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }))
    })
    expect(save).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('group', { name: LEAVE_GROUP })).toBeNull()

    content.focus()
    await userEvent.type(content, 'bc')
    expect(screen.queryByRole('group', { name: LEAVE_GROUP })).toBeNull()
    expect(content).toHaveFocus()
    expect(content).toHaveValue('noi dung da luu abc')
  })

  it('every same-origin link in the editor asks again while there are changes, including links in the settings column', async () => {
    render(
      <PostEditor
        {...baseProps}
        post={draft}
        aside={
          // next/link like the real post edit page: the blocker must catch Link navigation too.
          <p>
            <Link href="/admin/series/s-1">{msg('Admin.posts.manageSeries')}</Link>
          </p>
        }
      />,
    )
    await userEvent.type(screen.getByLabelText(CONTENT), ' moi')
    const manage = screen.getByRole('link', { name: msg('Admin.posts.manageSeries') })

    let allowed = true
    await act(async () => {
      allowed = fireEvent.click(manage)
    })

    expect(allowed).toBe(false)
    const prompt = screen.getByRole('group', { name: LEAVE_GROUP })
    // Leaving goes exactly where the writer meant to go, not always to /admin.
    expect(within(prompt).getByRole('link', { name: msg('Admin.editor.leave') })).toHaveAttribute('href', '/admin/series/s-1')

    // Staying closes the question and returns focus to the link that was clicked, not falling back to <body>.
    await userEvent.click(within(prompt).getByRole('button', { name: msg('Admin.editor.stay') }))
    expect(screen.queryByRole('group', { name: LEAVE_GROUP })).toBeNull()
    expect(manage).toHaveFocus()
  })

  it('Ctrl/⌘-click (opens a new tab) and links that open a new tab are not blocked: nothing is lost here', async () => {
    render(<PostEditor {...baseProps} post={{ ...draft, status: 'PUBLISHED', publishedAt: '2026-10-01T00:00:00Z' }} />)
    await userEvent.type(screen.getByLabelText(CONTENT), ' moi')

    expect(fireEvent.click(screen.getByRole('link', { name: msg('Admin.posts.preview.viewOnBlog') }), { button: 0 })).toBe(true)
    expect(screen.queryByRole('group', { name: LEAVE_GROUP })).toBeNull()
    const back = screen.getByRole('link', { name: msg('Site.about.readNextLinks.writing') })
    back.addEventListener('click', (event) => event.preventDefault(), { once: true })
    fireEvent.click(back, { ctrlKey: true })
    expect(screen.queryByRole('group', { name: LEAVE_GROUP })).toBeNull()
  })

  it('"Unpublish" does not overwrite a half-edited path: unpublishing does not send the slug', async () => {
    unpublish.mockResolvedValue({ id: 'p1', slug: 'ban-nhap' })
    render(<PostEditor {...baseProps} post={{ ...draft, status: 'PUBLISHED', publishedAt: '2026-10-01T00:00:00Z' }} />)
    const slug = screen.getByLabelText(SLUG)

    await act(async () => {
      fireEvent.change(slug, { target: { value: 'duong-dan-moi' } })
    })
    await userEvent.click(screen.getByRole('button', { name: UNPUBLISH }))

    expect(unpublish).toHaveBeenCalledTimes(1)
    expect(slug).toHaveValue('duong-dan-moi')
    expect(status()).toHaveTextContent(msg('Admin.editor.state.unsaved'))
  })

  it('new post: no publish button, Save is the primary button; the status line is empty', () => {
    render(<PostEditor {...baseProps} />)

    expect(screen.queryByRole('button', { name: PUBLISH })).toBeNull()
    expect(screen.getByRole('button', { name: msg('Site.comments.item.editSave') })).toHaveClass('bg-slate-900')
    expect(status()).toHaveTextContent('')
    expect(screen.getByRole('heading', { level: 1, name: msg('Admin.editor.titleNew') })).toBeInTheDocument()
  })

  it('a published post has a view-on-blog link, opening a new tab', () => {
    render(<PostEditor {...baseProps} post={{ ...draft, status: 'PUBLISHED', publishedAt: '2026-10-01T00:00:00Z' }} />)

    const view = screen.getByRole('link', { name: msg('Admin.posts.preview.viewOnBlog') })
    expect(view).toHaveAttribute('href', '/posts/ban-nhap')
    expect(view).toHaveAttribute('target', '_blank')
  })

  it('published post: the hint under the path box says the old link redirects to the new one automatically', () => {
    render(<PostEditor {...baseProps} post={{ ...draft, status: 'PUBLISHED', publishedAt: '2026-10-01T00:00:00Z' }} />)

    // PINNED: previously this sentence said "changing the path breaks the old link" — true back then, because
    // the post page returned 404 for the old slug. Now the backend remembers a published post's old slug and the post page
    // redirects with 308, so the old sentence scared the writer away from editing a path whose edit no longer does any harm.
    const slug = screen.getByLabelText(SLUG)
    const hint = document.getElementById(slug.getAttribute('aria-describedby') ?? '')
    expect(hint).toHaveTextContent(msg('Admin.editor.slugHintPublished'))
    expect(screen.queryByText(rx(OLD_SLUG_WARNING))).not.toBeInTheDocument()
  })
})

describe('readingMinutes (same formula as the backend PostMapper.readingMinutes)', () => {
  it.each([
    [0, 1],
    [1, 1],
    [200, 1],
    [201, 2],
    [2440, 13],
  ])('%i words → %i minutes', (words, minutes) => {
    expect(readingMinutes(words)).toBe(minutes)
  })

  it('shows right next to the word count while writing', async () => {
    render(<PostEditor {...baseProps} />)
    await act(async () => {
      fireEvent.change(screen.getByLabelText(CONTENT), { target: { value: 'word '.repeat(450) } })
    })

    expect(
      screen.getByText(msg('Admin.editor.wordsWithMinutes', { count: 450, formatted: '450', minutes: 3 })),
    ).toBeInTheDocument()
  })

  it('NBSP (text pasted from the web, Option+Space) does not split words, like the backend: 199 words + "a b" with NBSP is 200 words, 1 minute', async () => {
    render(<PostEditor {...baseProps} />)
    await act(async () => {
      fireEvent.change(screen.getByLabelText(CONTENT), { target: { value: `${'word '.repeat(199)}a\u00A0b` } })
    })

    expect(
      screen.getByText(msg('Admin.editor.wordsWithMinutes', { count: 200, formatted: '200', minutes: 1 })),
    ).toBeInTheDocument()
  })
})

describe('wordCount (same counting as PostMapper.readingMinutes: Java strip() then split("\\\\s+"))', () => {
  it.each([
    ['', 0],
    [' \n\t ', 0],
    ['one two  three\nfour\tfive', 5],
    // Java's \s is only [ \t\n\x0B\f\r]: other Unicode whitespace does not split words.
    ['a\u00A0b', 1],
    ['a\u202Fb', 1],
    ['a\u3000b', 1],
    ['a\uFEFFb', 1],
    // strip() removes Unicode whitespace at both ends (Character.isWhitespace), but not NBSP.
    ['\u3000\u2003a b\u2028', 2],
    ['\u00A0', 1],
  ])('%j → %i words', (text, words) => {
    expect(wordCount(text)).toBe(words)
  })
})

describe('isRedirectError', () => {
  it('matches only the digest redirect() throws', () => {
    expect(isRedirectError({ digest: 'NEXT_REDIRECT;push;/admin/posts/p1/edit;303;' })).toBe(true)
    expect(isRedirectError({ digest: 'NEXT_REDIRECT;replace;/admin/login;307;' })).toBe(true)
    // notFound() throws a digest-carrying error too. Reading it as a redirect would make
    // the editor swallow it, and the author would press Save and see nothing happen --
    // the worst of the three outcomes, because there is no error to react to.
    expect(isRedirectError({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' })).toBe(false)
    expect(isRedirectError({ digest: 'NEXT_REDIRECTION_SOMETHING_ELSE' })).toBe(false)
    expect(isRedirectError(new Error('boom'))).toBe(false)
    expect(isRedirectError({ digest: 123 })).toBe(false)
    expect(isRedirectError(null)).toBe(false)
    expect(isRedirectError(undefined)).toBe(false)
  })
})

/* ------------------------------------------------------------------------------------------------- *
 * Local draft, images inside the post body, pre-publish check, preview, ZIP download, duplicate,
 * history.
 * ------------------------------------------------------------------------------------------------- */

const SAVED_POST: Post = {
  id: 'p1',
  title: msg('Admin.statuses.post.DRAFT'),
  slug: 'ban-nhap',
  excerpt: null,
  content: 'noi dung da luu',
  status: 'DRAFT',
  category: null,
  tags: [],
  publishedAt: null,
  featured: false,
  readingMinutes: 1,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-09T03:00:00.000Z',
}

/** A description of 100–400 characters: the lint description rule does not intrude on tests that are only about content. */
const GOOD_EXCERPT =
  'A description long enough for the post: it says what the post is about and what the reader gets after finishing it.'

const IMAGE: MediaRef = {
  id: '0b9d6f3a-5c1e-4f7a-9d2b-3e4f5a6b7c8d',
  fileName: '0b9d6f3a-5c1e-4f7a-9d2b-3e4f5a6b7c8d.png',
  width: 1200,
  height: 800,
  altText: 'so do kien truc',
  dominantColor: null,
}
// With the size hint #WxH (lib/post-markdown.ts imageMarkdown): the post page reads it as width/height.
const IMAGE_MD = `![so do kien truc](/media/${IMAGE.fileName}#1200x800)`

const png = (name = 'so-do_kien-truc.png') => new File([new Uint8Array(64)], name, { type: 'image/png' })

function contentBox(): HTMLTextAreaElement {
  return screen.getByLabelText(CONTENT) as HTMLTextAreaElement
}

function fileInput(): HTMLInputElement {
  return document.querySelector('input[type="file"]') as HTMLInputElement
}

async function chooseFiles(files: File[]) {
  await act(async () => {
    fireEvent.change(fileInput(), { target: { files } })
  })
}

describe('PostEditor — local draft', () => {
  const OWNER = '11111111-1111-1111-1111-111111111111'
  const KEY = draftKey(OWNER, 'p1')
  /** The shell wraps every editor in DraftOwner, which binds the signed-in account in the browser. */
  const withOwner = (ui: React.ReactElement) => <DraftOwner owner={OWNER}>{ui}</DraftOwner>
  const stored = (snapshot: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    JSON.stringify({
      v: 2,
      owner: OWNER,
      base: SAVED_POST.updatedAt,
      at: '2026-10-09T04:30:00.000Z',
      snapshot: {
        title: msg('Admin.statuses.post.DRAFT'),
        slug: 'ban-nhap',
        excerpt: '',
        content: 'noi dung da luu',
        categoryId: '',
        tagIds: [],
        ...snapshot,
      },
      ...over,
    })

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-09T05:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('typing leaves a draft in localStorage after one second; once saved the draft is deleted', async () => {
    save.mockResolvedValue({ id: 'p1', slug: 'ban-nhap' })
    render(withOwner(<PostEditor {...baseProps} post={SAVED_POST} />))

    await act(async () => {
      fireEvent.change(contentBox(), { target: { value: 'noi dung da luu them' } })
    })
    expect(localStorage.getItem(KEY)).toBeNull()
    await act(async () => {
      vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS)
    })
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({
      v: 2,
      owner: OWNER,
      base: SAVED_POST.updatedAt,
      snapshot: { content: 'noi dung da luu them' },
    })

    await userEvent.click(screen.getByRole('button', { name: SAVE }))

    expect(save).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('reopening a post that has a draft: the offer "There is an unsaved copy from hh:mm"; "Restore" fills the boxes again', async () => {
    localStorage.setItem(
      KEY,
      stored({ title: 'Unsaved title', content: 'half-written text from yesterday', excerpt: 'half-written excerpt' }),
    )
    render(withOwner(<PostEditor {...baseProps} post={SAVED_POST} />))

    // 04:30Z is 11:30 in Asia/Ho_Chi_Minh (the test suite TZ), the same day as "now": time only.
    const offer = screen.getByRole('group', { name: msg('Admin.editor.draftOffer', { time: '11:30' }) })
    await userEvent.click(within(offer).getByRole('button', { name: msg('Admin.revisions.restore') }))

    expect(screen.queryByRole('group', { name: DRAFT_OFFER })).toBeNull()
    expect(screen.getByLabelText(TITLE)).toHaveValue('Unsaved title')
    expect(screen.getByLabelText(EXCERPT)).toHaveValue('half-written excerpt')
    expect(contentBox()).toHaveValue('half-written text from yesterday')
    expect(contentBox()).toHaveFocus()
    // The restored copy is an UNSAVED change: it only becomes the saved version once the writer presses Save.
    expect(screen.getAllByRole('status')[0]).toHaveTextContent(msg('Admin.editor.state.unsaved'))
  })

  it('a draft from another day: includes the date', () => {
    localStorage.setItem(KEY, stored({ content: 'old' }, { at: '2026-10-07T02:05:00.000Z' }))
    render(withOwner(<PostEditor {...baseProps} post={SAVED_POST} />))

    expect(screen.getByRole('group', { name: msg('Admin.editor.draftOffer', { time: '09:05, 07/10/2026' }) })).toBeInTheDocument()
  })

  it('restoring drops categories and tags deleted since then, keeps the ones that remain', async () => {
    localStorage.setItem(KEY, stored({ categoryId: 'c-da-xoa', tagIds: ['t1', 't-da-xoa'], content: 'other' }))
    render(withOwner(<PostEditor {...baseProps} post={SAVED_POST} />))

    await userEvent.click(screen.getByRole('button', { name: msg('Admin.revisions.restore') }))

    expect(screen.getByLabelText(CATEGORY)).toHaveValue('')
    expect(screen.getByRole('checkbox', { name: 'Spring' })).toBeChecked()
  })

  it('"Discard": deletes the draft, keeps the saved version', async () => {
    localStorage.setItem(KEY, stored({ content: 'half-written text' }))
    render(withOwner(<PostEditor {...baseProps} post={SAVED_POST} />))

    await userEvent.click(screen.getByRole('button', { name: msg('Admin.editor.draftDiscard') }))

    expect(screen.queryByRole('group', { name: DRAFT_OFFER })).toBeNull()
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(contentBox()).toHaveValue('noi dung da luu')
  })

  it('server version newer than the draft (saved elsewhere afterwards): no offer, the draft is discarded', () => {
    localStorage.setItem(KEY, stored({ content: 'half-written text' }, { base: '2026-10-08T00:00:00.000Z' }))
    render(withOwner(<PostEditor {...baseProps} post={SAVED_POST} />))

    expect(screen.queryByRole('group', { name: DRAFT_OFFER })).toBeNull()
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('the server HTML has no offer; after hydration it does, without mismatch, and the draft is not deleted before it could be offered', async () => {
    localStorage.setItem(KEY, stored({ content: 'half-written text' }))
    const ui = withOwner(<PostEditor {...baseProps} post={SAVED_POST} />)
    const html = renderToString(<IntlWrapper locale="vi">{ui}</IntlWrapper>)
    expect(html).not.toContain(before('Admin.editor.draftOffer', 'time').trim())

    const container = document.body.appendChild(document.createElement('div'))
    container.innerHTML = html
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => {
      render(ui, { container, hydrate: true })
    })

    expect(screen.getByRole('group', { name: DRAFT_OFFER })).toBeInTheDocument()
    // The hydrate render uses the server snapshot ("not read yet"): deleting the draft in that render would delete exactly what is about to be offered.
    expect(localStorage.getItem(KEY)).not.toBeNull()
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it('new post: the first save creates the post and navigates, so the "moi" draft is deleted and not written again', async () => {
    save.mockRejectedValue(Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;push;/admin/posts/p9/edit;303;' }))
    render(withOwner(<PostEditor {...baseProps} />))

    await act(async () => {
      fireEvent.change(screen.getByLabelText(TITLE), { target: { value: msg('Admin.editor.titleNew') } })
      fireEvent.change(contentBox(), { target: { value: 'noi dung' } })
    })
    await act(async () => {
      vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS)
    })
    expect(localStorage.getItem(draftKey(OWNER, null))).not.toBeNull()

    await act(async () => {
      fireEvent.change(contentBox(), { target: { value: 'noi dung them' } })
    })
    await userEvent.click(screen.getByRole('button', { name: SAVE }))
    await act(async () => {
      vi.advanceTimersByTime(5 * DRAFT_DEBOUNCE_MS)
      window.dispatchEvent(new Event('pagehide'))
    })

    expect(localStorage.getItem(draftKey(OWNER, null))).toBeNull()
  })

  it('storage throws on every access: typing and saving still work as before', async () => {
    const boom = () => {
      throw new DOMException('denied', 'SecurityError')
    }
    vi.stubGlobal('localStorage', {
      getItem: boom,
      setItem: boom,
      removeItem: boom,
      key: boom,
      get length(): number {
        return boom()
      },
    })
    save.mockResolvedValue({ id: 'p1', slug: 'ban-nhap' })
    render(withOwner(<PostEditor {...baseProps} post={SAVED_POST} />))

    await act(async () => {
      fireEvent.change(contentBox(), { target: { value: 'noi dung da luu them' } })
    })
    await act(async () => {
      vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS)
    })
    expect(contentBox()).toHaveValue('noi dung da luu them')
    await userEvent.click(screen.getByRole('button', { name: SAVE }))

    expect((save.mock.calls[0][0] as FormData).get('content')).toBe('noi dung da luu them')
    expect(screen.getAllByRole('status')[0]).toHaveTextContent(SAVED_AT_PREFIX)
  })
})

describe('PostEditor — images inside the post body', () => {
  const upload = vi.fn<(form: FormData) => Promise<ImageUploadOutcome>>()
  const remove = vi.fn<(mediaId: string) => Promise<ImageListOutcome>>()

  function renderWithImages(images: MediaRef[] | null = [], post: Post = SAVED_POST) {
    return render(<PostEditor {...baseProps} post={post} images={images} onUploadImage={upload} onDeleteImage={remove} />)
  }

  beforeEach(() => {
    prepareUpload.mockImplementation(async (file: File) => file)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('"Insert image" → choose a file: downsized first, uploaded with alt from the file name, inserted as a paragraph at the cursor, alt preselected', async () => {
    const prepared = png('da-thu-nho.png')
    prepareUpload.mockResolvedValue(prepared)
    upload.mockResolvedValue({ image: IMAGE })
    renderWithImages()
    const box = contentBox()
    box.setSelectionRange(3, 3)

    expect(screen.getByRole('button', { name: msg('Admin.editor.insertImage') })).toHaveAttribute('data-image-control')
    await chooseFiles([png()])

    expect(prepareUpload).toHaveBeenCalledWith(expect.objectContaining({ name: 'so-do_kien-truc.png' }))
    const form = upload.mock.calls[0][0]
    expect(form.get('file')).toBe(prepared)
    expect(form.get('altText')).toBe('so do kien truc')
    expect(box).toHaveValue(`noi\n\n${IMAGE_MD}\n\n dung da luu`)
    // The alt text is preselected: the writer types over it to make it their own description.
    expect(box.value.slice(box.selectionStart, box.selectionEnd)).toBe('so do kien truc')
    expect(screen.getByText(msg('Admin.postImages.insertedOne'))).toBeInTheDocument()
    expect(screen.getAllByRole('status')[0]).toHaveTextContent(msg('Admin.editor.state.unsaved'))
    // The image enters the in-post images list.
    const panel = screen.getByRole('region', { name: msg('Admin.postImages.heading') })
    expect(within(panel).getByText('so do kien truc')).toBeInTheDocument()
  })

  it('the file input is not part of the post form and has no name: image bytes do not travel with a Save', () => {
    renderWithImages()

    expect(fileInput().form).toBeNull()
    expect(fileInput().name).toBe('')
    expect(fileInput().accept).toBe('image/jpeg,image/png,image/webp')
  })

  it('pasting a screenshot: uploaded and inserted at the cursor; a clipboard that also has text pastes the text as usual', async () => {
    upload.mockResolvedValue({ image: IMAGE })
    renderWithImages()
    const box = contentBox()
    box.setSelectionRange(box.value.length, box.value.length)

    let allowed = true
    await act(async () => {
      allowed = fireEvent.paste(box, { clipboardData: { files: [png('image.png')], getData: () => '' } })
    })
    expect(allowed).toBe(false)
    // An image pasted from the clipboard is named "image.png": the default alt is the Vietnamese word for "image", and that is also the inserted text.
    expect(upload.mock.calls[0][0].get('altText')).toBe(msg('Site.footer.links.gallery'))
    expect(box).toHaveValue(`noi dung da luu\n\n![${msg('Site.footer.links.gallery')}](/media/${IMAGE.fileName}#1200x800)\n`)

    upload.mockClear()
    await act(async () => {
      allowed = fireEvent.paste(box, {
        clipboardData: { files: [png('bang.png')], getData: (type: string) => (type === 'text/plain' ? 'A1\tB1' : '') },
      })
    })
    expect(allowed).toBe(true)
    expect(upload).not.toHaveBeenCalled()
  })

  it('dragging and dropping a file into the box: blocks the default behavior (opening the file, leaving the editor) and uploads; dragging text is left alone', async () => {
    upload.mockResolvedValue({ image: IMAGE })
    renderWithImages()
    const box = contentBox()
    const files = { types: ['Files'], files: [png()], dropEffect: 'none' }

    expect(fireEvent.dragOver(box, { dataTransfer: files })).toBe(false)
    let allowed = true
    await act(async () => {
      allowed = fireEvent.drop(box, { dataTransfer: files })
    })

    expect(allowed).toBe(false)
    expect(upload).toHaveBeenCalledTimes(1)
    expect(box.value).toContain(IMAGE_MD)
    expect(fireEvent.dragOver(box, { dataTransfer: { types: ['text/plain'], files: [] } })).toBe(true)
  })

  it('new post: the button is there but says why it cannot be used yet; dropping a file does not upload or leave the page', async () => {
    render(<PostEditor {...baseProps} />)
    const button = screen.getByRole('button', { name: msg('Admin.editor.insertImage') })

    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(document.getElementById(button.getAttribute('aria-describedby')!)).toHaveTextContent(msg('Admin.postImages.saveFirst'))
    await userEvent.click(button)
    expect(screen.getByText(rx(msg('Admin.postImages.needSave'), { start: true }))).toBeInTheDocument()

    let allowed = true
    await act(async () => {
      allowed = fireEvent.drop(contentBox(), { dataTransfer: { types: ['Files'], files: [png()] } })
    })
    expect(allowed).toBe(false)
    expect(upload).not.toHaveBeenCalled()
    expect(fileInput()).toBeInTheDocument()
  })

  it.each([
    ['quota exceeded', { error: msg('Errors.admin.codes.MEDIA_QUOTA_EXCEEDED') }, msg('Errors.admin.codes.MEDIA_QUOTA_EXCEEDED')],
    [
      'wrong format',
      { error: msg('Errors.admin.codes.MEDIA_UNSUPPORTED_TYPE') },
      msg('Errors.admin.codes.MEDIA_UNSUPPORTED_TYPE'),
    ],
  ])('action error (%s): shown in place, content unchanged', async (_case, outcome, message) => {
    upload.mockResolvedValue(outcome)
    renderWithImages()

    await chooseFiles([png()])

    expect(screen.getByRole('alert')).toHaveTextContent(message)
    expect(contentBox()).toHaveValue('noi dung da luu')
  })

  it('image too large or unreadable in the browser (prepareUpload rejects): in-place message, no action called', async () => {
    prepareUpload.mockRejectedValue(new UploadRejectedError(msg('Admin.postImages.uploadRejected.stillTooLarge')))
    renderWithImages()

    await chooseFiles([png()])

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Admin.postImages.uploadRejected.stillTooLarge'))
    expect(upload).not.toHaveBeenCalled()
  })

  it('session expired while uploading an image: a sentence with a login link in a new tab, no navigation', async () => {
    upload.mockResolvedValue({ error: SESSION_EXPIRED, sessionExpired: true })
    renderWithImages()

    await chooseFiles([png()])

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe(SESSION_EXPIRED)
    expect(within(alert).getByRole('link', { name: LOGIN_LINK })).toHaveAttribute('target', '_blank')
  })

  it('several files: uploaded and inserted one after another, stopping at the first broken file', async () => {
    const second = { ...IMAGE, id: 'img-2', fileName: '1c9d6f3a-5c1e-4f7a-9d2b-3e4f5a6b7c8d.png', altText: 'hai' }
    upload
      .mockResolvedValueOnce({ image: IMAGE })
      .mockResolvedValueOnce({ image: second })
      .mockResolvedValueOnce({ error: msg('Errors.admin.codes.MEDIA_QUOTA_EXCEEDED') })
    renderWithImages()
    const box = contentBox()
    box.setSelectionRange(box.value.length, box.value.length)

    await chooseFiles([png('mot.png'), png('hai.png'), png('ba.png'), png('bon.png')])

    expect(upload).toHaveBeenCalledTimes(3)
    // One after another, the later image below the earlier one. Pinned verbatim: if the earlier image alt is preselected, the later image replaces
    // that alt text (a bug seen before: "![\n\n![hai](…)").
    expect(box).toHaveValue(
      `noi dung da luu\n\n![mot](/media/${IMAGE.fileName}#1200x800)\n\n![hai](/media/${second.fileName}#1200x800)\n`,
    )
    expect(screen.getByText(msg('Admin.postImages.insertedMany', { count: '2' }))).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(msg('Errors.admin.codes.MEDIA_QUOTA_EXCEEDED'))
  })

  it('"Insert again" an image in the list: inserts at the cursor with the saved alt', async () => {
    renderWithImages([IMAGE])
    contentBox().setSelectionRange(0, 0)

    await userEvent.click(
      screen.getByRole('button', { name: msg('Admin.postImages.reinsertAria', { label: 'so do kien truc' }) }),
    )

    expect(contentBox()).toHaveValue(`${IMAGE_MD}\n\nnoi dung da luu`)
  })

  it('delete an image: in-place confirmation (says the image is in use), then delete, new list, focus returns to the region heading', async () => {
    remove.mockResolvedValue({ images: [] })
    renderWithImages([IMAGE], { ...SAVED_POST, content: `Text\n\n${IMAGE_MD}\n` })
    const panel = screen.getByRole('region', { name: msg('Admin.postImages.heading') })
    expect(within(panel).getByText(rx(msg('Admin.postImages.sizeInUse', { width: '1200', height: '800' })))).toBeInTheDocument()

    await userEvent.click(
      within(panel).getByRole('button', { name: msg('Admin.postImages.deleteAria', { label: 'so do kien truc' }) }),
    )
    const prompt = within(panel).getByRole('group', {
      name: msg('Admin.postImages.deleteQuestion', { label: 'so do kien truc' }),
    })
    expect(prompt).toHaveAccessibleDescription(rx(msg('Admin.postImages.deleteDetailsInUse')))
    expect(within(prompt).getByRole('button', { name: msg('Site.comments.form.cancel') })).toHaveFocus()

    await userEvent.click(within(prompt).getByRole('button', { name: msg('Admin.posts.delete.forever') }))

    expect(remove).toHaveBeenCalledWith(IMAGE.id)
    expect(within(panel).queryByText('so do kien truc')).toBeNull()
    expect(within(panel).getByRole('heading', { name: msg('Admin.postImages.heading') })).toHaveFocus()
  })

  it('cancelling delete: focus returns to the "Delete" button of that image', async () => {
    renderWithImages([IMAGE])
    const panel = screen.getByRole('region', { name: msg('Admin.postImages.heading') })

    await userEvent.click(
      within(panel).getByRole('button', { name: msg('Admin.postImages.deleteAria', { label: 'so do kien truc' }) }),
    )
    await userEvent.click(within(panel).getByRole('button', { name: msg('Site.comments.form.cancel') }))

    expect(
      within(panel).getByRole('button', { name: msg('Admin.postImages.deleteAria', { label: 'so do kien truc' }) }),
    ).toHaveFocus()
    expect(remove).not.toHaveBeenCalled()
  })

  it('the image list cannot be loaded (null): says so, a new image can still be inserted', async () => {
    upload.mockResolvedValue({ image: IMAGE })
    renderWithImages(null)

    expect(screen.getByText(rx(msg('Admin.postImages.loadFailed')))).toBeInTheDocument()
    await chooseFiles([png()])
    expect(contentBox().value).toContain(IMAGE_MD)
  })
})

describe('PostEditor — pre-publish check', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('warnings show in the settings column, update while typing; the warning count next to the publish button leads to the list', async () => {
    render(<PostEditor {...baseProps} post={{ ...SAVED_POST, excerpt: GOOD_EXCERPT }} />)
    const panel = screen.getByRole('region', { name: msg('Admin.lint.heading') })
    expect(within(panel).getByText(msg('Admin.lint.allClear'))).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: LINT_COUNT })).toBeNull()

    await act(async () => {
      fireEvent.change(contentBox(), { target: { value: 'Open\n\n# Big title\n\n```\nls\n```\n' } })
    })

    expect(within(panel).getByText(rx(msg('Admin.lint.bodyH1', { line: 3 }), { start: true }))).toBeInTheDocument()
    expect(within(panel).getByText(rx(msg('Admin.lint.fenceLanguageMissing', { line: 5 }), { start: true }))).toBeInTheDocument()
    const count = screen.getByRole('button', { name: msg('Admin.editor.lintCountSr', { count: '2' }) })
    await userEvent.click(count)
    expect(within(panel).getByRole('heading', { name: msg('Admin.lint.heading') })).toHaveFocus()
  })

  it('blocks nothing: with warnings left it can still publish', async () => {
    publish.mockResolvedValue({ id: 'p1', slug: 'ban-nhap' })
    render(<PostEditor {...baseProps} post={{ ...SAVED_POST, content: '# H1\n```\nx' }} />)
    expect(screen.getByRole('button', { name: LINT_COUNT })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: PUBLISH }))

    expect(publish).toHaveBeenCalledTimes(1)
    expect(screen.getAllByRole('status')[0]).toHaveTextContent(PUBLISHED_AT_PREFIX)
  })

  it('new post: the list is in the settings column, but there is no count next to the Save button (nothing to publish yet)', () => {
    render(<PostEditor {...baseProps} />)

    expect(
      within(screen.getByRole('region', { name: msg('Admin.lint.heading') })).getByText(
        rx(before('Admin.lint.excerptEmpty', 'min', { max: '@@max' }), { start: true }),
      ),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: LINT_COUNT })).toBeNull()
  })
})

describe('PostEditor — preview, ZIP download, duplicate', () => {
  const duplicate = vi.fn<() => Promise<{ error: string; sessionExpired?: boolean }>>()

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('"Open preview": a new tab to the admin preview page; its name differs from the "Preview" toggle button', () => {
    render(<PostEditor {...baseProps} post={SAVED_POST} preview={<p>x</p>} />)

    const link = screen.getByRole('link', { name: msg('Admin.editor.previewLinkSr') })
    expect(link).toHaveAttribute('href', '/admin/posts/p1/preview')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link.getAttribute('rel')).toMatch(/\bnoopener\b/)
    expect(screen.getByRole('button', { name: msg('Admin.posts.row.preview') })).toBeInTheDocument()
  })

  it('new post: no preview, ZIP download or duplicate (no saved post yet)', () => {
    render(<PostEditor {...baseProps} onDuplicate={duplicate} />)

    expect(screen.queryByRole('link', { name: msg('Admin.editor.previewLinkSr') })).toBeNull()
    expect(screen.queryByRole('link', { name: msg('Admin.editor.download') })).toBeNull()
    expect(screen.queryByRole('button', { name: msg('Admin.editor.duplicate') })).toBeNull()
    expect(screen.queryByRole('link', { name: msg('Admin.editor.commentsLink') })).toBeNull()
  })

  it('"Comments on this post": the Comments page pre-filtered by the post, every status', () => {
    render(<PostEditor {...baseProps} post={SAVED_POST} onDuplicate={duplicate} adminTools />)

    expect(screen.getByRole('link', { name: msg('Admin.editor.commentsLink') })).toHaveAttribute(
      'href',
      `/admin/comments?post=${encodeURIComponent(SAVED_POST.id)}&status=all`,
    )
    expect(screen.getByRole('link', { name: msg('Admin.editor.facts.manage') })).toHaveAttribute('href', '/admin/curated')
  })

  it('without adminTools (AUTHOR): no path to Comments or Posts; ZIP download and duplicate remain', () => {
    render(<PostEditor {...baseProps} post={SAVED_POST} onDuplicate={duplicate} />)

    expect(screen.queryByRole('link', { name: msg('Admin.editor.commentsLink') })).toBeNull()
    expect(screen.queryByRole('link', { name: msg('Admin.editor.facts.manage') })).toBeNull()
    expect(screen.getByRole('link', { name: msg('Admin.editor.download') })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: msg('Admin.editor.duplicate') })).toBeInTheDocument()
  })

  it('"Download ZIP": download link of the saved version, the ZIP by default; unsaved changes do not trigger the leave-page prompt either', async () => {
    render(<PostEditor {...baseProps} post={SAVED_POST} onDuplicate={duplicate} />)
    const link = screen.getByRole('link', { name: msg('Admin.editor.download') })
    // No `format` query: the default of the route is the ZIP package, `?format=md` is the legacy Markdown.
    expect(link).toHaveAttribute('href', '/admin/posts/p1/export')
    expect(link).toHaveAttribute('download')

    await act(async () => {
      fireEvent.change(contentBox(), { target: { value: 'other' } })
    })
    link.addEventListener('click', (event) => event.preventDefault(), { once: true })
    fireEvent.click(link)

    expect(screen.queryByRole('group', { name: LEAVE_GROUP })).toBeNull()
    expect(screen.getByText(rx(msg('Admin.editor.toolsDirty')))).toBeInTheDocument()
  })

  it('"Duplicate": calls the action; navigating to the copy shows no error and the button stays locked', async () => {
    duplicate.mockRejectedValue(
      Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;push;/admin/posts/p2/edit;303;' }),
    )
    render(<PostEditor {...baseProps} post={SAVED_POST} onDuplicate={duplicate} />)
    const button = screen.getByRole('button', { name: msg('Admin.editor.duplicate') })
    expect(document.getElementById(button.getAttribute('aria-describedby')!)).toHaveTextContent(rx(msg('Admin.editor.toolsHint')))

    await userEvent.click(button)

    expect(duplicate).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: msg('Admin.editor.duplicating') })).toBeDisabled()
  })

  it('"Duplicate" locks while there are unsaved changes (the copy takes the saved version)', async () => {
    render(<PostEditor {...baseProps} post={SAVED_POST} onDuplicate={duplicate} />)

    await act(async () => {
      fireEvent.change(contentBox(), { target: { value: 'other' } })
    })

    expect(screen.getByRole('button', { name: msg('Admin.editor.duplicate') })).toBeDisabled()
  })

  it('failed "Duplicate": in-place error, the button unlocks', async () => {
    duplicate.mockResolvedValue({ error: msg('Errors.admin.codes.POST_NOT_FOUND') })
    render(<PostEditor {...baseProps} post={SAVED_POST} onDuplicate={duplicate} />)

    await userEvent.click(screen.getByRole('button', { name: msg('Admin.editor.duplicate') }))

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Site.article.notFoundTitle'))
    expect(screen.getByRole('button', { name: msg('Admin.editor.duplicate') })).toBeEnabled()
  })

  it('the page just restored an old version: the status line says so', () => {
    render(<PostEditor {...baseProps} post={SAVED_POST} initialNotice={msg('Admin.editor.restoredNotice')} />)

    expect(screen.getAllByRole('status')[0]).toHaveTextContent(msg('Admin.editor.restoredNotice'))
  })
})

describe('PostEditor — history', () => {
  const load = vi.fn<(id: string) => Promise<RevisionOutcome>>()
  const restore = vi.fn<(id: string) => Promise<{ error: string; sessionExpired?: boolean }>>()
  const SUMMARY = { id: 'r1', title: 'Yesterday title', createdAt: '2026-10-08T03:00:00.000Z' }
  const REVISION: PostRevision = { ...SUMMARY, excerpt: 'Yesterday excerpt', content: '## Text of the old version' }

  function renderHistory(revisions: (typeof SUMMARY)[] | null = [SUMMARY]) {
    return render(
      <PostEditor {...baseProps} post={SAVED_POST} revisions={revisions} onLoadRevision={load} onRestoreRevision={restore} />,
    )
  }

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('lists the versions; "Xem" loads a version and shows its text, read-only', async () => {
    load.mockResolvedValue({ revision: REVISION })
    renderHistory()
    const panel = screen.getByRole('region', { name: msg('Admin.revisions.heading') })
    expect(within(panel).getByText('Yesterday title')).toBeInTheDocument()
    // Time by the writer's clock (Asia/Ho_Chi_Minh in the test suite).
    const view = within(panel).getByRole('button', { name: msg('Admin.revisions.viewAria', { time: '10:00, 08/10/2026' }) })
    expect(view).toHaveAttribute('aria-expanded', 'false')

    await userEvent.click(view)

    expect(load).toHaveBeenCalledWith('r1')
    expect(view).toHaveAttribute('aria-expanded', 'true')
    expect(
      within(panel).getByRole('region', { name: msg('Admin.revisions.textRegionAria', { time: '10:00, 08/10/2026' }) }),
    ).toHaveTextContent('## Text of the old version')
    expect(within(panel).getByText('Yesterday excerpt')).toBeInTheDocument()
  })

  it('"Restore this version" locks while there are unsaved changes, with the reason', async () => {
    load.mockResolvedValue({ revision: REVISION })
    renderHistory()
    await userEvent.click(screen.getByRole('button', { name: VIEW_REVISION }))

    await act(async () => {
      fireEvent.change(contentBox(), { target: { value: 'half edited' } })
    })

    const button = screen.getByRole('button', { name: msg('Admin.revisions.restoreThis') })
    expect(button).toBeDisabled()
    expect(document.getElementById(button.getAttribute('aria-describedby')!)).toHaveTextContent(
      rx(msg('Admin.revisions.dirtyHint')),
    )
  })

  it('restore: in-place confirmation (focus "Cancel"), then calls the action; on navigation the button stays locked', async () => {
    load.mockResolvedValue({ revision: REVISION })
    restore.mockRejectedValue(
      Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/admin/posts/p1/edit?restored=x;303;' }),
    )
    renderHistory()
    await userEvent.click(screen.getByRole('button', { name: VIEW_REVISION }))

    await userEvent.click(screen.getByRole('button', { name: msg('Admin.revisions.restoreThis') }))
    const prompt = screen.getByRole('group', { name: msg('Admin.revisions.restoreQuestion', { time: '10:00, 08/10/2026' }) })
    expect(prompt).toHaveAccessibleDescription(rx(msg('Admin.revisions.restoreDetails')))
    expect(within(prompt).getByRole('button', { name: msg('Site.comments.form.cancel') })).toHaveFocus()
    await userEvent.click(within(prompt).getByRole('button', { name: msg('Admin.revisions.restore') }))

    expect(restore).toHaveBeenCalledWith('r1')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(within(prompt).getByRole('button', { name: msg('Admin.revisions.restoring') })).toBeDisabled()
  })

  it('a version that was cleaned up: in-place error', async () => {
    load.mockResolvedValue({ error: msg('Errors.admin.codes.REVISION_NOT_FOUND') })
    renderHistory()

    await userEvent.click(screen.getByRole('button', { name: VIEW_REVISION }))

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Errors.admin.codes.REVISION_NOT_FOUND'))
    expect(screen.getByRole('button', { name: VIEW_REVISION })).toHaveAttribute('aria-expanded', 'false')
  })

  it('no versions yet, or the history cannot be loaded: says so', () => {
    const { unmount } = renderHistory([])
    expect(
      within(screen.getByRole('region', { name: msg('Admin.revisions.heading') })).getByText(
        rx(msg('Admin.revisions.empty'), { start: true }),
      ),
    ).toBeInTheDocument()
    unmount()

    renderHistory(null)
    expect(
      within(screen.getByRole('region', { name: msg('Admin.revisions.heading') })).getByText(
        rx(msg('Admin.revisions.loadFailed'), { start: true }),
      ),
    ).toBeInTheDocument()
  })
})

describe('PostEditor: language', () => {
  const LANGUAGE = rx(msg('Admin.editor.languageLabel'), { start: true, end: true })
  const englishPost: Post = {
    id: 'p-en',
    title: 'Hello',
    slug: 'hello',
    excerpt: null,
    content: 'text',
    status: 'DRAFT',
    category: null,
    tags: [],
    publishedAt: null,
    featured: false,
    readingMinutes: 1,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    language: 'en',
  }

  function options() {
    return within(screen.getByLabelText(LANGUAGE)).getAllByRole('option')
  }

  it('offers the two enabled languages; a new post starts in the admin language', () => {
    render(<PostEditor {...baseProps} />)

    expect(options().map((option) => option.getAttribute('value'))).toEqual(['vi', 'en'])
    expect(screen.getByLabelText(LANGUAGE)).toHaveValue(currentTestLocale())
  })

  it('an existing post shows its own language, and Save sends the language field', async () => {
    save.mockResolvedValue({ id: 'p-en', slug: 'hello' })
    render(<PostEditor {...baseProps} post={englishPost} />)

    expect(screen.getByLabelText(LANGUAGE)).toHaveValue('en')
    await userEvent.type(screen.getByLabelText(CONTENT), ' more')
    await userEvent.click(screen.getByRole('button', { name: SAVE }))

    expect((save.mock.calls[0][0] as FormData).get('language')).toBe('en')
  })

  it('changing the language is an unsaved change, and it is sent on Save', async () => {
    save.mockResolvedValue({ id: 'p-en', slug: 'hello' })
    render(<PostEditor {...baseProps} post={englishPost} />)
    const status = () => screen.getAllByRole('status')[0]
    expect(status()).toHaveTextContent(msg('Admin.editor.state.saved'))

    await act(async () => {
      fireEvent.change(screen.getByLabelText(LANGUAGE), { target: { value: 'vi' } })
    })
    expect(status()).toHaveTextContent(msg('Admin.editor.state.unsaved'))
    await userEvent.click(screen.getByRole('button', { name: SAVE }))

    expect((save.mock.calls[0][0] as FormData).get('language')).toBe('vi')
    expect(status()).toHaveTextContent(SAVED_AT)
  })

  it('a server conflict on the language (409) is shown in the editor error box, the typed text stays', async () => {
    save.mockResolvedValue({ error: msg('Errors.admin.codes.TRANSLATION_CONFLICT') })
    render(<PostEditor {...baseProps} post={englishPost} />)

    await act(async () => {
      fireEvent.change(screen.getByLabelText(LANGUAGE), { target: { value: 'vi' } })
    })
    await userEvent.click(screen.getByRole('button', { name: SAVE }))

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Errors.admin.codes.TRANSLATION_CONFLICT'))
    expect(screen.getByLabelText(LANGUAGE)).toHaveValue('vi')
  })
})
