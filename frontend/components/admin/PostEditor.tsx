'use client'

import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { ActionError, ImageListOutcome, ImageUploadOutcome, RevisionOutcome } from './editor-types'
import InlineCreate from './InlineCreate'
import LintPanel from './LintPanel'
import PostImagesPanel from './PostImagesPanel'
import { ErrorAlert, StatusBadge } from './primitives'
import { isRedirectError } from './redirect-error'
import RevisionsPanel from './RevisionsPanel'
import { BACK_LINK, button, FOCUS_RING, HINT, INPUT, LABEL, META, WARN_TEXT } from './ui'
import { useBodyImages } from './useBodyImages'
import { useDraftOwner } from './DraftOwner'
import { type EditorSnapshot, sameSnapshot, useDraftAutosave } from './useDraftAutosave'
import {
  ArrowDownIcon,
  ArrowUpRightIcon,
  CheckIcon,
  ChevronLeftIcon,
  CircleAlertIcon,
  CopyIcon,
  EyeIcon,
  ImagePlusIcon,
  StarIcon,
} from '@/components/icons'
import { LANGUAGE_NAMES } from '@/components/site/language-names'
import { LOCALES, isLocale } from '@/i18n/config'
import { formatDate } from '@/lib/date'
import { asLocale, dateFormat, numberFormat } from '@/lib/format'
import { formatLocalDateTime, formatLocalTime, isSameLocalDay } from '@/lib/local-time'
import { mediaPath } from '@/lib/media'
import { lintPost } from '@/lib/post-lint'
import { imageMarkdown, insertBlock } from '@/lib/post-markdown'
import { ACCEPTED_UPLOAD_TYPES } from '@/lib/prepare-upload'
import { slugifyOrEmpty } from '@/lib/slug'
import type { Category, MediaRef, Post, PostRevisionSummary, Tag } from '@/lib/types'

// Before this was extracted, this function lived here; CoverPanel, DeletePost and the tests still import it from PostEditor.
export { isRedirectError } from './redirect-error'

export type EditorProps = {
  post: Post | null
  categories: Category[]
  tags: Tag[]
  onSave: (form: FormData) => Promise<ActionOutcome>
  /**
   * No id parameter. The page that renders this editor already closed over the post id
   * when it defined the Server Action, and passing it again would mean two sources for
   * the same value — one of which the component could get wrong.
   */
  onPublish?: () => Promise<ActionOutcome>
  onUnpublish?: () => Promise<ActionOutcome>
  /** Inline creation, because publishing requires a category and a fresh install has none. */
  onCreateCategory?: (name: string) => Promise<Category | ActionError>
  onCreateTag?: (name: string) => Promise<Tag | ActionError>
  /** Rendered server-side by MarkdownPreview for the content as last saved. */
  preview?: ReactNode
  /**
   * The end of the settings column, built by the page: the series row, the cover image box. It sits OUTSIDE the post form (see
   * the component comment), so a button or input in it never submits the post form.
   */
  aside?: ReactNode
  /**
   * Images inside the post body: the images already uploaded for the post (newest first), null when the page could not load
   * the list. A new post has no such props: there is no post to attach images to yet, and the insert-image button says so.
   */
  images?: MediaRef[] | null
  onUploadImage?: (form: FormData) => Promise<ImageUploadOutcome>
  onDeleteImage?: (mediaId: string) => Promise<ImageListOutcome>
  /** History: the versions kept (newest first, without content), null when they could not be loaded. */
  revisions?: PostRevisionSummary[] | null
  onLoadRevision?: (revisionId: string) => Promise<RevisionOutcome>
  /** On success the action navigates (the editor is rebuilt); it only returns on error. */
  onRestoreRevision?: (revisionId: string) => Promise<ActionError>
  /** Duplicate: on success the action navigates to the copy; it only returns on error. */
  onDuplicate?: () => Promise<ActionError>
  /** The very end of the settings column, after every other section: the page's delete-post area. */
  dangerZone?: ReactNode
  /** The sentence of the status line when opened (the page just restored an old version). */
  initialNotice?: string
  /**
   * Paths to the screens only ADMIN can use: the featured posts list, the post's comments. Hidden by default; the backend still
   * refuses AUTHOR there even if the link showed.
   */
  adminTools?: boolean
}

type ActionOutcome = ActionError | { id: string; slug: string }
type EditorError = { message: string; sessionExpired: boolean }
type Pending = 'save' | 'publish' | 'unpublish' | null

function toEditorError(outcome: ActionError): EditorError {
  return { message: outcome.error, sessionExpired: outcome.sessionExpired === true }
}

/**
 * The session-expired sentence, with the login-page phrase as a link that opens a NEW TAB: navigating in this tab would lose
 * the post being edited. The text must match `Errors.admin.sessionExpired` (the server actions' sentence); a test pins that.
 */
function SessionExpiredMessage() {
  const t = useTranslations('Admin.editor')
  return t.rich('sessionExpired', {
    login: (chunks) => (
      <Link
        href="/admin/login"
        target="_blank"
        rel="noopener noreferrer"
        prefetch={false}
        className="font-medium underline underline-offset-4 hover:text-red-900"
      >
        {chunks}
      </Link>
    ),
  })
}

/**
 * What one Save sends, packed up for comparison: different from the saved version means unsaved changes. The type and the comparison
 * live in useDraftAutosave, because the local draft copies exactly these six boxes.
 */
type Snapshot = EditorSnapshot

/** A drag-and-drop carrying files (images from the machine), not text being dragged inside the box. */
function carriesFiles(data: DataTransfer | null): boolean {
  return data !== null && Array.from(data.types ?? []).includes('Files')
}

/** The box holding focus when an image finishes uploading: focus only goes into the content box if it is still the content box or an image button. */
function mayTakeFocus(content: HTMLTextAreaElement): boolean {
  const active = document.activeElement
  return (
    active === null ||
    active === document.body ||
    active === content ||
    (active instanceof HTMLElement && active.dataset.imageControl !== undefined)
  )
}

/**
 * Enter in the title or description moves to the next box (like Ghost), without inserting a new line into a single-line text. Shift+Enter
 * does not count, and neither does an Enter that commits a word of the input method (IME composing).
 */
function isPlainEnter(event: React.KeyboardEvent): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing
}

/**
 * The content box is hidden (preview mode) while invalid (empty, `required`): the browser cannot show
 * the error bubble for a hidden box, so it blocks the submit silently — Save is pressed and nothing is seen. Call it
 * right BEFORE submitting: `reveal` reopens the writing area synchronously (flushSync), so the validity check of this very
 * submit sees the box and points at it. A function outside the component: it only reads the DOM through its parameters, so it works in an effect.
 */
function revealIfHiddenInvalid(element: HTMLTextAreaElement | null, reveal: () => void): void {
  if (element !== null && element.hidden && !element.checkValidity()) reveal()
}

/** Word count, a rough count by whitespace: enough to know how long a post is, not for billing. */
/**
 * Java's `Character.isWhitespace`, which `String.strip()` and `isBlank()` use: Unicode whitespace
 * except the three non-breaking spaces (U+00A0, U+2007, U+202F), plus \t \n \v \f \r and U+001C–U+001F.
 */
const JAVA_WHITESPACE = '\\t\\n\\v\\f\\r\\x1C-\\x1F \\u1680\\u2000-\\u2006\\u2008-\\u200A\\u2028\\u2029\\u205F\\u3000'
const JAVA_STRIP = new RegExp(`^[${JAVA_WHITESPACE}]+|[${JAVA_WHITESPACE}]+$`, 'g')

/**
 * The word count exactly as PostMapper.readingMinutes counts: `strip()`, then `split("\\s+")`, where Java's `\s` (without the
 * UNICODE_CHARACTER_CLASS flag) is only [ \t\n\x0B\f\r]. JS `trim()` and `\s` are broader: they treat
 * NBSP (Option+Space, text pasted from the web or Google Docs), U+202F, U+3000, U+FEFF as whitespace, so the
 * editor would count more words, and report more minutes, than the figure the post has after saving.
 */
export function wordCount(text: string): number {
  const stripped = text.replace(JAVA_STRIP, '')
  return stripped === '' ? 0 : stripped.split(/[ \t\n\v\f\r]+/).length
}

/**
 * Estimated reading time, exactly the formula the backend uses for the "n minutes read" figure on the site
 * (PostMapper.readingMinutes: tokens split by whitespace, 200 per minute, rounded up, minimum
 * 1). The same counting as `wordCount` above, so the figure here is the figure the post will have after saving.
 */
export function readingMinutes(words: number): number {
  return Math.max(1, Math.ceil(words / 200))
}

/**
 * The three boxes of the writing area (title, description, content): borderless, like a sheet of paper. Their focus mark is
 * a brand-colored bar on the left; a negative margin pulls the text flush with the column edge, so the bar sits outside the text margin.
 * `field-sizing: content` lets supporting browsers auto-grow right from the server HTML; the title and description also
 * have a JS measuring piece for browsers that do not support it yet.
 */
const CANVAS_FIELD =
  '-ml-3.5 block w-[calc(100%+0.875rem)] resize-none border-0 border-l-2 border-transparent bg-transparent py-0 pr-0 pl-3 [field-sizing:content] placeholder:text-slate-500 focus:outline-none focus-visible:border-brand'

/**
 * The post editor, built as a writing desk: a fixed top bar (back, status, Save,
 * Publish/Unpublish), a writing area in the middle with only the title, a short description and the content, and a settings column on the right for
 * the secondary things (path, category, tags, cover image, series). Below `lg` the settings column moves underneath.
 *
 * ## One form, many regions
 *
 * The post's boxes live in three regions (top bar, writing area, settings column), with things in between that must NOT
 * belong to the post form: the cover image box (it has its own file and description boxes — Enter there must not submit the post,
 * and the image bytes must not travel with every Save), the in-place category/tag creation box, the preview. So the
 * `<form>` here is empty, and every box of the post attaches to it with the `form={formId}` attribute
 * (an HTML form-associated element): FormData, `required` and Enter-to-submit all count through it. A
 * post box that forgets `form=` would not be saved — the "sends every field…" test catches that.
 *
 * ## Unsaved changes
 *
 * Every render is compared with the latest saved version. While there are changes: the status line says so, publishing
 * saves first and then publishes (publishing reads the SAVED version in the backend — pressing Publish without saving would publish the old version),
 * the posts link asks again before leaving the page, and closing/reloading the tab shows the browser warning.
 * Ctrl/⌘+S saves anywhere on the page.
 *
 * ## Drafts, images, lint and history
 *
 * The local draft and the restore offer: useDraftAutosave. Images inside the post body (the insert-image button, paste, drag and
 * drop, the in-post images region): useBodyImages + PostImagesPanel. The pre-publish check: lib/post-lint.ts +
 * LintPanel. History: RevisionsPanel. The preview, ZIP download and duplicate: links and buttons right in this file.
 * All their errors show in the same error box as Save/Publish (with a login link when the session has expired).
 */
export default function PostEditor({
  post,
  categories: initialCategories,
  tags: initialTags,
  onSave,
  onPublish,
  onUnpublish,
  onCreateCategory,
  onCreateTag,
  preview,
  aside,
  images: initialImages,
  onUploadImage,
  onDeleteImage,
  revisions,
  onLoadRevision,
  onRestoreRevision,
  onDuplicate,
  dangerZone,
  initialNotice,
  adminTools = false,
}: EditorProps) {
  const t = useTranslations('Admin.editor')
  const tLint = useTranslations('Admin.lint')
  const tImages = useTranslations('Admin.postImages')
  const tErrors = useTranslations('Errors.admin')
  const locale = asLocale(useLocale())
  const formId = useId()
  const fieldId = (name: string) => `${formId}-${name}`
  const formRef = useRef<HTMLFormElement>(null)
  const titleRef = useRef<HTMLTextAreaElement>(null)
  const excerptRef = useRef<HTMLTextAreaElement>(null)
  const contentRef = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const lintHeading = useRef<HTMLHeadingElement>(null)

  const [title, setTitle] = useState(post?.title ?? '')
  const [slug, setSlug] = useState(post?.slug ?? '')
  const [excerpt, setExcerpt] = useState(post?.excerpt ?? '')
  const [content, setContent] = useState(post?.content ?? '')
  // Held in state, not read from props, so something created inline appears immediately.
  // Re-fetching the page instead would be a navigation, and a navigation loses the draft.
  const [categories, setCategories] = useState(initialCategories)
  const [categoryId, setCategoryId] = useState(post?.category?.id ?? '')
  // A new post starts in the admin's current language, which is what the writer is about to write in.
  const [language, setLanguage] = useState(post?.language ?? locale)
  const [tags, setTags] = useState(initialTags)
  const [checkedTagIds, setCheckedTagIds] = useState<string[]>(post?.tags.map((t) => t.id) ?? [])
  // An existing post's slug is a published URL. Deriving it from the title would change
  // that URL the first time a typo is fixed, which is precisely what the editable slug
  // field exists to prevent.
  const [slugLocked, setSlugLocked] = useState(post !== null)
  const [error, setError] = useState<EditorError | null>(null)
  const [pending, setPending] = useState<Pending>(null)
  // The result of the latest successful action (saved at 14:32), for the status line.
  const [notice, setNotice] = useState<string | null>(initialNotice ?? null)
  const [previewing, setPreviewing] = useState(false)
  const [duplicating, setDuplicating] = useState(false)

  const current: Snapshot = { title, slug, excerpt, content, categoryId, tagIds: checkedTagIds, language }
  // The latest saved version: when opened it is exactly the post from the server (for a new post, all boxes empty).
  const [saved, setSaved] = useState<Snapshot>(() => ({ ...current }))
  const dirty = !sameSnapshot(current, saved)

  // The local draft (localStorage) of unsaved text, and the restore offer when the post is reopened.
  const draftOwner = useDraftOwner()
  const autosave = useDraftAutosave({
    owner: draftOwner,
    postId: post?.id ?? null,
    base: post?.updatedAt ?? null,
    current,
    saved,
    dirty,
  })

  // The warnings of seed/push.py for the post being edited. Blocks nothing.
  const warnings = useMemo(() => lintPost({ excerpt, content }, tLint, locale), [excerpt, content, tLint, locale])

  // Images inside the post body. Errors go to the shared error box on the top bar (with a login link when the session has expired).
  const bodyImages = useBodyImages({
    initial: initialImages,
    onUpload: post === null ? undefined : onUploadImage,
    onDelete: onDeleteImage,
    insert: insertImage,
    report,
    failed: (caught) => {
      if (!isRedirectError(caught)) failed(caught)
    },
  })

  // The "leave the page with unsaved changes" prompt: where the user was going, and the version being edited when asked. The prompt is
  // only valid for that very version: once saved, or typing again, it expires — not shown again midway and
  // not jolting focus out of the box being typed in. `leaveTrigger` is the link that was clicked, to return focus when the prompt closes.
  const [leave, setLeave] = useState<{ href: string; from: Snapshot } | null>(null)
  const leaveTrigger = useRef<HTMLElement | null>(null)
  const promptBox = useRef<HTMLDivElement>(null)
  const asking = leave !== null && dirty && sameSnapshot(current, leave.from)

  /** Closes the prompt; if focus is inside it, returns it to the link that was clicked, not falling back to <body>. */
  function closeLeave() {
    const focusInside = promptBox.current?.contains(document.activeElement) ?? false
    setLeave(null)
    if (focusInside) leaveTrigger.current?.focus()
  }

  const isPublished = post?.status === 'PUBLISHED'

  /** The action promise was rejected and it is not a redirect: Next is unreachable (network down, server
   *  dead) or the action threw. Shown in place instead of rethrowing: throwing from an async handler reaches no error
   *  boundary, and the author presses Save and sees nothing. The post being edited stays intact on screen. */
  function failed(caught: unknown) {
    console.error('Post editor action failed', caught)
    setError({ message: tErrors('unreachable'), sessionExpired: false })
  }

  /** An error returned by an action (images, history, duplicate): same error box as Save/Publish on the top bar. */
  function report(outcome: ActionError) {
    setError(toEditorError(outcome))
  }

  /** Runs one post action. Returns true on success; the error has already been shown in place. */
  async function run(kind: Exclude<Pending, null>, action: () => Promise<ActionOutcome>, sent?: Snapshot) {
    setError(null)
    setPending(kind)
    try {
      const result = await action()
      if ('error' in result) {
        setError(toEditorError(result))
        return false
      }
      if (sent !== undefined) {
        // Save: the version just sent becomes the saved version (with the slug the backend wrote). Text typed in the meantime
        // is still an unsaved change, exactly as it really is.
        setSaved({ ...sent, slug: result.slug })
        // The STORED slug, not the submitted one. The backend suffixes a colliding slug
        // silently — SlugGenerator.ensureUnique appends `-2`, `-3` — and the response
        // carries what it actually wrote. Keeping the submitted value on screen would show
        // the author a URL that is not their post's, which matters most here because the
        // whole reason this field is visible is that the URL becomes permanent.
        // Only when the slug box still holds the text that was sent: text typed into the box meanwhile belongs to the writer.
        setSlug((now) => (now === sent.slug ? result.slug : now))
      }
      // Publish and unpublish do not send the slug, so they do not touch the box: a half-edited slug stays intact.
      // And latch it: the post now exists, so its slug is a live URL and the title must
      // stop re-deriving over the top of it.
      setSlugLocked(true)
      // Hour:minute by the writer's machine, only built in the browser, after a save.
      const at = dateFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date())
      setNotice(
        t(kind === 'save' ? 'state.savedAt' : kind === 'publish' ? 'state.publishedAt' : 'state.unpublishedAt', { time: at }),
      )
      // Once saved, the "leave the page" prompt (if open) has no reason to exist.
      closeLeave()
      return true
    } catch (caught) {
      // A Server Action that calls `redirect()` has its CLIENT promise REJECTED on
      // purpose — "the action promise will be rejected with a redirect so that it's
      // handled by RedirectBoundary", node_modules/next/dist/client/components/
      // router-reducer/reducers/server-action-reducer.js:242 — and the same reducer goes
      // on to perform the navigation itself whether or not anything handles the
      // rejection. app/admin/posts/new/page.tsx redirects on every successful create, so
      // without this the author meets `NEXT_REDIRECT` on the one path that just worked.
      if (!isRedirectError(caught)) failed(caught)
      // A new post was just created (the first save navigates to its edit page, which locks other drafts): the
      // "moi" draft became a real post and must not be offered again the next time "new post" is opened.
      else if (kind === 'save' && post === null) autosave.forget()
      return false
    } finally {
      setPending(null)
    }
  }

  function save(form: FormData) {
    const sent = { ...current }
    return run('save', () => onSave(form), sent)
  }

  async function publish() {
    if (onPublish === undefined) return
    // Publishing reads the saved version: with changes pending, save them first; if that fails, stop at the error of the save.
    if (dirty) {
      const form = formRef.current
      revealIfHiddenInvalid(contentRef.current, () => flushSync(() => setPreviewing(false)))
      if (form === null || !form.reportValidity()) return
      if (!(await save(new FormData(form)))) return
    }
    await run('publish', onPublish)
  }

  /**
   * Inserts an uploaded image at the content box cursor, as a block of its own (lib/post-markdown.ts
   * `insertBlock`), then preselects the alt text so the writer can type over it with their own description. Reads the text and cursor from the DOM,
   * not from state: this runs after an upload, and the state in the click closure is stale relative to text
   * typed in the meantime. Focus only goes into the content box when the writer is still there (or on an image button), so it does not jolt
   * focus out of another box they moved to while waiting.
   */
  function insertImage(image: MediaRef, alt: string, selectAlt = true) {
    const element = contentRef.current
    if (element === null) return
    const snippet = imageMarkdown(image, alt)
    const { value, offset } = insertBlock(element.value, element.selectionStart, element.selectionEnd, snippet.markdown)
    const takeFocus = mayTakeFocus(element)
    // Synchronous: the box must hold the new text (and be visible, if previewing) before the selection is set.
    flushSync(() => {
      setContent(value)
      setPreviewing(false)
    })
    if (selectAlt) element.setSelectionRange(offset + snippet.altStart, offset + snippet.altEnd)
    else element.setSelectionRange(offset + snippet.markdown.length, offset + snippet.markdown.length)
    if (takeFocus) element.focus()
  }

  /** Shared by the insert-image button, paste and drag-and-drop into the content box. */
  function uploadImages(files: File[]) {
    setError(null)
    void bodyImages.upload(files)
  }

  /** Restore the local draft: refill the six boxes, dropping categories and tags deleted since then. */
  function restoreDraft() {
    const snapshot = autosave.restore()
    if (snapshot === null) return
    setTitle(snapshot.title)
    setSlug(snapshot.slug)
    setExcerpt(snapshot.excerpt)
    setContent(snapshot.content)
    setCategoryId(categories.some((category) => category.id === snapshot.categoryId) ? snapshot.categoryId : '')
    setCheckedTagIds(snapshot.tagIds.filter((id) => tags.some((tag) => tag.id === id)))
    if (isLocale(snapshot.language)) setLanguage(snapshot.language)
    // New post: a path the writer edited by hand (different from the text derived from the title) is kept, as when they typed it.
    if (post === null) setSlugLocked(snapshot.slug !== slugifyOrEmpty(snapshot.title))
    setPreviewing(false)
    // The offer (holding focus) disappears: focus goes to the content box, where the writer will keep writing.
    contentRef.current?.focus()
  }

  function discardDraft() {
    autosave.discard()
    contentRef.current?.focus()
  }

  /** Duplicate: on success the action navigates to the copy (the promise is rejected with a redirect error). */
  async function duplicate() {
    if (onDuplicate === undefined) return
    setError(null)
    setDuplicating(true)
    try {
      report(await onDuplicate())
    } catch (caught) {
      // Navigating to the copy: keep the button locked until the new page takes its place, so no second copy is created.
      if (isRedirectError(caught)) return
      failed(caught)
    }
    setDuplicating(false)
  }

  /** Creates in place and returns the new record, or null on error (already shown). Never rejects. */
  async function create<T>(action: () => Promise<T | ActionError>): Promise<T | null> {
    setError(null)
    try {
      const created = await action()
      if (typeof created === 'object' && created !== null && 'error' in created) {
        setError(toEditorError(created))
        return null
      }
      return created as T
    } catch (caught) {
      if (!isRedirectError(caught)) failed(caught)
      return null
    }
  }

  async function addCategory(name: string) {
    if (onCreateCategory === undefined) return
    const created = await create(() => onCreateCategory(name))
    if (created === null) return
    setCategories((existing) => [...existing, created])
    // Selected straight away: the author pressed "add" because this is the one they want.
    setCategoryId(created.id)
  }

  async function addTag(name: string) {
    if (onCreateTag === undefined) return
    const created = await create(() => onCreateTag(name))
    if (created === null) return
    setTags((existing) => [...existing, created])
    setCheckedTagIds((existing) => [...existing, created.id])
  }

  // Ctrl/⌘+S saves anywhere on the page, replacing the browser's "Save page" box. requestSubmit
  // rather than calling save() directly: it goes through exactly the Save button's path, including the `required` check. A box that
  // handles this key itself (the cover image description box: Ctrl+S there is save-description) calls preventDefault, and that
  // is not a post save.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented) return
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 's') {
        event.preventDefault()
        revealIfHiddenInvalid(contentRef.current, () => flushSync(() => setPreviewing(false)))
        formRef.current?.requestSubmit()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Closing or reloading the tab with unsaved changes: the browser's warning box. Only attached while there are
  // changes, so a page that was just saved can be left without being asked.
  useEffect(() => {
    if (!dirty) return
    function warn(event: BeforeUnloadEvent) {
      event.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  // The title and description are textareas that auto-grow with the text: a long title wraps like on the post page instead
  // of sliding sideways in a one-line box. Re-measured when the text changes and when the window width changes.
  useLayoutEffect(() => {
    function fit() {
      for (const element of [titleRef.current, excerptRef.current]) {
        if (element === null) continue
        element.style.height = 'auto'
        element.style.height = `${element.scrollHeight}px`
      }
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [title, excerpt])

  const busy = pending !== null
  const words = wordCount(content)
  const saveState =
    pending === 'save'
      ? t('state.saving')
      : pending === 'publish'
        ? t('state.publishing')
        : pending === 'unpublish'
          ? t('state.unpublishing')
          : dirty
            ? t('state.unsaved')
            : (notice ?? (post !== null ? t('state.saved') : ''))
  const canPreview = preview !== undefined && preview !== null

  return (
    // Leaving the page through an in-app link does not fire beforeunload: every same-origin link in the
    // editor (posts, manage, manage series…) goes through here while there are unsaved changes and waits for the
    // prompt. Capture phase: block before the onClick of next/link navigates (it ignores events that were
    // preventDefault-ed). Links opening a new tab, Ctrl/⌘/Shift/Alt-click, middle click lose nothing: left alone.
    <div
      className="min-h-dvh bg-white"
      onClickCapture={(event) => {
        if (!dirty) return
        const anchor = (event.target as Element).closest('a[href]')
        if (!(anchor instanceof HTMLAnchorElement)) return
        if (anchor.target === '_blank' || anchor.hasAttribute('download') || anchor.dataset.leaveConfirmed !== undefined) return
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        const url = new URL(anchor.href, window.location.href)
        if (url.origin !== window.location.origin) return
        event.preventDefault()
        leaveTrigger.current = anchor
        setLeave({ href: `${url.pathname}${url.search}${url.hash}`, from: current })
      }}
    >
      {/* Empty on purpose: the boxes attach to this form with `form={formId}` (see the comment above). */}
      <form
        id={formId}
        ref={formRef}
        onSubmit={(event) => {
          event.preventDefault()
          // Block here and not only with disabled: Ctrl+S and Enter in a box still submit the form.
          if (busy) return
          void save(new FormData(event.currentTarget))
        }}
      />

      <div className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur-sm">
        <div className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 sm:px-6">
          <Link href="/admin" className={BACK_LINK}>
            <ChevronLeftIcon />
            {t('backToPosts')}
          </Link>
          <span aria-hidden="true" className="text-slate-400">
            /
          </span>
          <h1 className="text-sm font-medium text-slate-900">{post === null ? t('titleNew') : t('titleEdit')}</h1>
          {post !== null && <StatusBadge status={post.status} />}
          <p role="status" className="inline-flex items-center gap-1.5 text-[13px] text-slate-500">
            {!busy && !dirty && saveState !== '' && <CheckIcon size={14} className="text-emerald-600" />}
            {saveState}
          </p>

          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {post !== null && (
              // The admin preview page (the SAVED version, built like the public page, drafts included).
              // A name entirely different from the preview toggle button on the content box: a single sr-only text is the name, and the
              // visible text (from sm) sits inside that name.
              <a
                href={`/admin/posts/${encodeURIComponent(post.id)}/preview`}
                target="_blank"
                rel="noopener noreferrer"
                title={t('previewLinkTitle')}
                className={button('ghost', 'sm', 'px-2 sm:px-3')}
              >
                <span className="sr-only">{t('previewLinkSr')}</span>
                <span aria-hidden="true" className="hidden sm:inline">
                  {t('previewLinkText')}
                </span>
                <EyeIcon />
              </a>
            )}
            {isPublished && post !== null && (
              <a
                href={`/posts/${encodeURIComponent(post.slug)}`}
                target="_blank"
                rel="noopener noreferrer"
                title={t('viewOnBlogTitle')}
                className={button('ghost', 'sm', 'px-2 sm:px-3')}
              >
                <span className="sr-only sm:not-sr-only">{t('viewOnBlog')}</span>
                <ArrowUpRightIcon />
              </a>
            )}
            {post !== null && isPublished && onUnpublish !== undefined && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run('unpublish', onUnpublish)}
                className={button('secondary', 'sm')}
              >
                {t('unpublish')}
              </button>
            )}
            {post !== null && warnings.length > 0 && (
              // The warning count, right next to Save/Publish; pressing it goes to the list in the settings column. Blocks
              // nothing. The name is a single sr-only text (a count followed by a things-to-review phrase), with no "save" or "publish" at the
              // start: the Save and Publish buttons stay the only buttons carrying those names.
              <button
                type="button"
                onClick={() => lintHeading.current?.focus()}
                title={t('lintTitle')}
                className={button('ghost', 'sm', 'px-2 text-amber-700 hover:bg-amber-50 hover:text-amber-800')}
              >
                <CircleAlertIcon />
                <span className="sr-only">{t('lintCountSr', { count: warnings.length })}</span>
                <span aria-hidden="true">{warnings.length}</span>
              </button>
            )}
            <button
              type="submit"
              form={formId}
              disabled={busy}
              // Before the default behavior (submitting the form): empty content hidden behind the preview reopens
              // the writing area, so the browser can point at the box instead of blocking the submit silently.
              onClick={() => revealIfHiddenInvalid(contentRef.current, () => flushSync(() => setPreviewing(false)))}
              title={t('saveTitle')}
              className={button(post !== null && !isPublished && onPublish !== undefined ? 'secondary' : 'primary', 'sm')}
            >
              {pending === 'save' ? t('state.saving') : t('save')}
            </button>
            {post !== null && !isPublished && onPublish !== undefined && (
              <button type="button" disabled={busy} onClick={() => void publish()} className={button('primary', 'sm')}>
                {t('publish')}
              </button>
            )}
          </div>
        </div>

        {/* Saving (or typing again) while the prompt is open expires the prompt, and it disappears. */}
        <div ref={promptBox}>{asking && <LeavePrompt href={leave.href} onStay={closeLeave} />}</div>

        {/* The live region is present from the start: the offer only appears after the page has hydrated (reading
            localStorage), and must be announced when it appears. No focus goes there: the writer may already have
            started typing. */}
        <div aria-live="polite">
          {autosave.offer !== null && (
            <DraftRecoveryPrompt at={autosave.offer.at} onRestore={restoreDraft} onDiscard={discardDraft} />
          )}
        </div>

        {error !== null && (
          <div className="px-4 pb-3 sm:px-6">
            <ErrorAlert>{error.sessionExpired ? <SessionExpiredMessage /> : error.message}</ErrorAlert>
          </div>
        )}
      </div>

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_22rem]">
        {/* Writing area: the text is the only thing emphasized. A comfortable reading width, not spanning the whole screen. */}
        <div className="min-w-0 px-4 pt-8 pb-16 sm:px-8 lg:pt-14">
          <div className="mx-auto max-w-[46rem]">
            <label htmlFor={fieldId('title')} className="sr-only">
              {t('titleLabel')}
            </label>
            <textarea
              ref={titleRef}
              id={fieldId('title')}
              form={formId}
              name="title"
              value={title}
              required
              rows={1}
              maxLength={255}
              placeholder={t('titlePlaceholder')}
              onKeyDown={(event) => {
                if (!isPlainEnter(event)) return
                event.preventDefault()
                excerptRef.current?.focus()
              }}
              onChange={(event) => {
                // The title is one line: pasting several lines joins them with spaces.
                const value = event.target.value.replace(/\s*[\r\n]+\s*/g, ' ')
                setTitle(value)
                // slugifyOrEmpty, not slugify: clearing the title must empty the box rather
                // than filling it with "untitled", which the author would then publish.
                // A blank slug on save means "derive from the title", so the two agree.
                if (!slugLocked) setSlug(slugifyOrEmpty(value))
              }}
              className={`${CANVAS_FIELD} text-3xl leading-tight font-bold tracking-tight text-slate-900 sm:text-[2.5rem]`}
            />

            <label htmlFor={fieldId('excerpt')} className="sr-only">
              {t('excerptLabel')}
            </label>
            <textarea
              ref={excerptRef}
              id={fieldId('excerpt')}
              form={formId}
              name="excerpt"
              value={excerpt}
              rows={1}
              placeholder={t('excerptPlaceholder')}
              onKeyDown={(event) => {
                if (!isPlainEnter(event)) return
                event.preventDefault()
                contentRef.current?.focus()
              }}
              onChange={(event) => setExcerpt(event.target.value)}
              aria-describedby={fieldId('excerpt-hint')}
              className={`${CANVAS_FIELD} mt-4 text-lg leading-7 text-slate-600`}
            />
            <p id={fieldId('excerpt-hint')} className={`${META} mt-2`}>
              {t('excerptHint')}{' '}
              {excerpt.trim() !== '' &&
                t('excerptCount', {
                  count: excerpt.trim().length,
                  formatted: numberFormat(locale).format(excerpt.trim().length),
                })}
            </p>

            <div className="mt-8 flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-2">
              <label htmlFor={fieldId('content')} className="text-[13px] font-medium text-slate-600">
                {t('contentLabel')}
              </label>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className={META}>
                  {words > 0
                    ? t('wordsWithMinutes', {
                        count: words,
                        formatted: numberFormat(locale).format(words),
                        minutes: readingMinutes(words),
                      })
                    : t('words', { count: words, formatted: numberFormat(locale).format(words) })}
                </span>
                {/* aria-disabled rather than disabled: the button keeps focus while uploading (focus falling to <body>
                    would lose the place), and for an unsaved post it can still be pressed to say why it cannot be used yet. */}
                <button
                  type="button"
                  data-image-control=""
                  aria-disabled={!bodyImages.canUpload || bodyImages.busy ? true : undefined}
                  aria-describedby={bodyImages.canUpload ? undefined : fieldId('images-hint')}
                  onClick={() => {
                    if (!bodyImages.canUpload) uploadImages([])
                    else if (!bodyImages.busy) fileInput.current?.click()
                  }}
                  className={button('ghost', 'sm', 'aria-disabled:cursor-not-allowed aria-disabled:opacity-50')}
                >
                  <ImagePlusIcon />
                  {bodyImages.uploading ? t('uploadingImage') : t('insertImage')}
                </button>
                {canPreview && (
                  // A fixed label, the state in aria-pressed (and the button background): a toggle that changes both the
                  // label and aria-pressed would be read as a back-to-editing, pressed sentence — self-contradicting.
                  <button
                    type="button"
                    aria-pressed={previewing}
                    onClick={() => setPreviewing((now) => !now)}
                    className={button('ghost', 'sm', previewing ? 'bg-slate-200/70 text-slate-900' : '')}
                  >
                    <EyeIcon />
                    {t('previewToggle')}
                  </button>
                )}
              </div>
            </div>

            {/* Progress and result of inserting images. Always present (when empty only screen readers know it is there):
                a live region must exist before its content changes for the change to be announced. Errors go to the shared error box. */}
            <p role="status" className={bodyImages.status === '' ? 'sr-only' : `${META} mt-2`}>
              {bodyImages.status}
            </p>
            {/* The file input of the insert-image button. No `name`, no `form=`: the image bytes never travel with a
                Save (like the cover image box); the image goes its own way through prepareUpload and the upload action. */}
            <input
              ref={fileInput}
              type="file"
              accept={ACCEPTED_UPLOAD_TYPES.join(',')}
              multiple
              hidden
              tabIndex={-1}
              data-image-control=""
              onChange={(event) => {
                const files = Array.from(event.target.files ?? [])
                // Choosing exactly the file just chosen must still count as a new choice.
                event.target.value = ''
                uploadImages(files)
              }}
            />

            {/* The content box always stays in the page (hidden while previewing) so the value and the form do not change. */}
            <textarea
              ref={contentRef}
              id={fieldId('content')}
              form={formId}
              name="content"
              value={content}
              required
              rows={20}
              hidden={previewing}
              placeholder={t('contentPlaceholder')}
              onChange={(event) => setContent(event.target.value)}
              // Pasting an image (a screenshot) uploads it and inserts it at the cursor. A clipboard that also has text (an Excel cell,
              // a Word fragment with a preview image) pastes the text as usual: the writer is pasting text.
              onPaste={(event) => {
                const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith('image/'))
                if (files.length === 0 || event.clipboardData.getData('text/plain') !== '') return
                event.preventDefault()
                uploadImages(files)
              }}
              // Dropping a file into the box: blocks the default behavior (the browser opens that file, leaving the editor) and uploads. The image
              // goes where the cursor is: the browser does not report the drop position inside a textarea.
              // Dragging text inside the box carries no file: left alone.
              onDragOver={(event) => {
                if (!carriesFiles(event.dataTransfer)) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'copy'
              }}
              onDrop={(event) => {
                if (!carriesFiles(event.dataTransfer)) return
                event.preventDefault()
                uploadImages(Array.from(event.dataTransfer.files ?? []))
              }}
              className={`${CANVAS_FIELD} mt-5 min-h-[60vh] font-mono text-[15px] leading-7 text-slate-800`}
            />

            {previewing && canPreview && (
              <section aria-labelledby={fieldId('preview')} className="mt-6">
                <h2 id={fieldId('preview')} className="sr-only">
                  {t('previewHeading')}
                </h2>
                <p className="mb-6 rounded-md bg-slate-50 px-3 py-2 text-[13px] leading-5 text-slate-600">
                  {t('previewSavedNote')}
                  {dirty && <> {t('previewUnsavedNote')}</>}
                </p>
                {post !== null && (
                  <>
                    <p className="text-3xl leading-tight font-bold tracking-tight text-slate-900">{post.title}</p>
                    {post.excerpt !== null && post.excerpt.trim() !== '' && (
                      <p className="mt-4 text-lg leading-7 text-slate-600">{post.excerpt}</p>
                    )}
                  </>
                )}
                <div className="mt-8">{preview}</div>
              </section>
            )}
          </div>
        </div>

        {/* Settings column: secondary, so small text and a pale background; sticky from lg so it is always within reach. */}
        <aside
          aria-labelledby={fieldId('settings')}
          className="border-t border-slate-200 bg-slate-50/60 px-4 py-8 sm:px-8 lg:sticky lg:top-14 lg:h-[calc(100dvh-3.5rem)] lg:overflow-y-auto lg:border-t-0 lg:border-l lg:px-6"
        >
          {/* The column heading is larger and has an underline: the section labels below (Publish, Path…) at the same
              font size looked level with it (QA screenshot). */}
          <h2 id={fieldId('settings')} className="border-b border-slate-200 pb-3 text-base font-semibold text-slate-900">
            {t('settingsHeading')}
          </h2>

          <div className="mt-6 space-y-7">
            {post !== null && <PublishingFacts post={post} adminTools={adminTools} />}

            <LintPanel warnings={warnings} headingRef={lintHeading} />

            <div>
              <label htmlFor={fieldId('language')} className={LABEL}>
                {t('languageLabel')}
              </label>
              <select
                id={fieldId('language')}
                form={formId}
                name="language"
                value={language}
                onChange={(event) => setLanguage(event.target.value)}
                aria-describedby={fieldId('language-hint')}
                className={INPUT}
              >
                {LOCALES.map((option) => (
                  <option key={option} value={option} lang={option}>
                    {LANGUAGE_NAMES[option]}
                  </option>
                ))}
              </select>
              <p id={fieldId('language-hint')} className={HINT}>
                {t('languageHint')}
              </p>
            </div>

            <div>
              <label htmlFor={fieldId('slug')} className={LABEL}>
                {t('slugLabel')}
              </label>
              <div className="flex overflow-hidden rounded-md border border-slate-300 bg-white transition-colors duration-150 motion-reduce:transition-none hover:border-slate-400 focus-within:outline-2 focus-within:-outline-offset-1 outline-brand">
                <span
                  aria-hidden="true"
                  className="flex items-center border-r border-slate-200 bg-slate-50 px-2.5 font-mono text-[13px] text-slate-500"
                >
                  /posts/
                </span>
                <input
                  id={fieldId('slug')}
                  form={formId}
                  name="slug"
                  value={slug}
                  maxLength={255}
                  onChange={(event) => {
                    // One-way latch. Once the author touches this field, the title stops
                    // overwriting it — otherwise the next keystroke in the title silently
                    // discards a slug they chose deliberately.
                    setSlugLocked(true)
                    setSlug(event.target.value)
                  }}
                  aria-describedby={fieldId('slug-hint')}
                  className="min-w-0 flex-1 bg-transparent px-2.5 py-2 font-mono text-[13px] text-slate-900 focus:outline-none"
                />
              </div>
              <p id={fieldId('slug-hint')} className={HINT}>
                {isPublished
                  ? // The backend remembers a published post's old slug, and the post page redirects with 308 to the new slug.
                    t('slugHintPublished')
                  : slugLocked
                    ? t('slugHintLocked')
                    : t('slugHintAuto')}
              </p>
            </div>

            <div>
              <label htmlFor={fieldId('category')} className={LABEL}>
                {t('categoryLabel')}
              </label>
              <select
                id={fieldId('category')}
                form={formId}
                name="categoryId"
                value={categoryId}
                onChange={(event) => setCategoryId(event.target.value)}
                aria-describedby={fieldId('category-hint')}
                className={INPUT}
              >
                <option value="">{t('categoryNone')}</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
              <p id={fieldId('category-hint')} className={HINT}>
                {t('categoryHint')}
              </p>
              {onCreateCategory !== undefined && (
                <InlineCreate label={t('addCategory')} fieldLabel={t('categoryName')} onCreate={addCategory} />
              )}
            </div>

            <fieldset>
              <legend className={LABEL}>{t('tagsLegend')}</legend>
              {tags.length === 0 ? (
                <p className={META}>{t('noTags')}</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {tags.map((tag) => {
                    // Matching by id, which only works because Task 1 made the API return
                    // tag objects. With names only this would have been a guess.
                    const checked = checkedTagIds.includes(tag.id)
                    return (
                      <label
                        key={tag.id}
                        className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-slate-300 bg-white px-2.5 py-1 text-[13px] text-slate-700 transition-colors duration-150 select-none motion-reduce:transition-none hover:border-slate-400 has-checked:border-slate-900 has-checked:bg-slate-900 has-checked:text-white has-focus-visible:outline-2 has-focus-visible:outline-offset-2 outline-brand"
                      >
                        {/* The real checkbox, visually hidden: the pill is the visible part, and focus shows on the pill. */}
                        <input
                          type="checkbox"
                          form={formId}
                          name="tagIds"
                          value={tag.id}
                          checked={checked}
                          onChange={(event) =>
                            setCheckedTagIds((existing) =>
                              event.target.checked ? [...existing, tag.id] : existing.filter((id) => id !== tag.id),
                            )
                          }
                          className="sr-only"
                        />
                        {/* The check mark so the selected state is not conveyed by color alone. */}
                        {checked && <CheckIcon size={14} />}
                        {tag.name}
                      </label>
                    )
                  })}
                </div>
              )}
              {onCreateTag !== undefined && <InlineCreate label={t('addTag')} fieldLabel={t('tagName')} onCreate={addTag} />}
            </fieldset>

            {aside}

            <PostImagesPanel
              images={bodyImages.images}
              canUpload={bodyImages.canUpload}
              hintId={fieldId('images-hint')}
              busy={bodyImages.busy}
              // The content being edited or the saved version points to the image: deleting it leaves a broken image there.
              inUse={(image) => content.includes(mediaPath(image)) || saved.content.includes(mediaPath(image))}
              onInsert={(image) => insertImage(image, image.altText?.trim() || tImages('altDefault'))}
              onDelete={bodyImages.remove}
            />

            {post !== null && revisions !== undefined && onLoadRevision !== undefined && onRestoreRevision !== undefined && (
              <RevisionsPanel
                revisions={revisions}
                dirty={dirty}
                busy={busy}
                onLoad={onLoadRevision}
                onRestore={onRestoreRevision}
                report={report}
                failed={failed}
              />
            )}

            {post !== null && adminTools && (
              <section aria-labelledby={fieldId('comments')}>
                <h3 id={fieldId('comments')} className={LABEL}>
                  {t('commentsHeading')}
                </h3>
                {/* The Moderation page pre-filtered by this post, every status. A same-origin link: with unsaved changes
                    the leave-the-page blocker above asks first, like every other link in the editor. */}
                <a href={`/admin/comments?post=${encodeURIComponent(post.id)}&status=all`} className={button('secondary', 'sm')}>
                  {t('commentsLink')}
                </a>
              </section>
            )}

            {post !== null && (
              <section aria-labelledby={fieldId('tools')}>
                <h3 id={fieldId('tools')} className={LABEL}>
                  {t('toolsHeading')}
                </h3>
                <div className="flex flex-wrap gap-2">
                  {/* `download`: the browser saves it as a file (the route returns Content-Disposition: attachment), and the
                      leave-the-page blocker above leaves this link alone — downloading a file does not leave the editor. */}
                  <a
                    href={`/admin/posts/${encodeURIComponent(post.id)}/export`}
                    download
                    aria-describedby={fieldId('tools-hint')}
                    className={button('secondary', 'sm')}
                  >
                    <ArrowDownIcon />
                    {t('download')}
                  </a>
                  {onDuplicate !== undefined && (
                    <button
                      type="button"
                      disabled={dirty || busy || duplicating}
                      onClick={() => void duplicate()}
                      aria-describedby={fieldId('tools-hint')}
                      className={button('secondary', 'sm')}
                    >
                      <CopyIcon />
                      {duplicating ? t('duplicating') : t('duplicate')}
                    </button>
                  )}
                </div>
                <p id={fieldId('tools-hint')} className={HINT}>
                  {t('toolsHint')}
                </p>
                {dirty && <p className={`${WARN_TEXT} mt-1.5`}>{t('toolsDirty')}</p>}
              </section>
            )}

            {dangerZone}
          </div>
        </aside>
      </div>
    </div>
  )
}

/**
 * The restore offer for the local draft, under the top bar like the leave-the-page prompt. Time by the writer's
 * clock: the offer is only built in the browser (after reading localStorage), so there is no server HTML for it to
 * mismatch. Today shows only the time, another day includes the date.
 */
function DraftRecoveryPrompt({ at, onRestore, onDiscard }: { at: string; onRestore: () => void; onDiscard: () => void }) {
  const t = useTranslations('Admin.editor')
  const textId = useId()
  const when = isSameLocalDay(at, new Date().toISOString()) ? formatLocalTime(at) : formatLocalDateTime(at)
  return (
    <div
      role="group"
      aria-labelledby={textId}
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-amber-200 bg-amber-50 px-4 py-2.5 sm:px-6"
    >
      <p id={textId} className="text-sm text-amber-900">
        {t('draftOffer', { time: when ?? '' })}
      </p>
      <div className="flex gap-2">
        <button type="button" onClick={onRestore} className={button('primary', 'sm')}>
          {t('draftRestore')}
        </button>
        <button type="button" onClick={onDiscard} className={button('secondary', 'sm')}>
          {t('draftDiscard')}
        </button>
      </div>
    </div>
  )
}

/**
 * The read-only facts about the publishing of an existing post: publish date, reading time, views, and whether it is in
 * the featured posts list (choosing and ordering happen on a separate page, so this is the way there).
 * Reading time and views belong to the saved version, computed by the backend.
 */
function PublishingFacts({ post, adminTools }: { post: Post; adminTools: boolean }) {
  const t = useTranslations('Admin.editor.facts')
  const locale = asLocale(useLocale())
  const headingId = useId()
  const row = 'flex items-baseline justify-between gap-3 py-1.5'
  const rank = typeof post.featuredRank === 'number' ? post.featuredRank : null
  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId} className={LABEL}>
        {t('heading')}
      </h3>
      <dl className="divide-y divide-slate-200/70 text-[13px]">
        <div className={row}>
          <dt className="text-slate-500">{t('publishedOn')}</dt>
          <dd className="text-right text-slate-800">
            {post.publishedAt === null ? (
              t('notPublished')
            ) : (
              <time dateTime={post.publishedAt}>{formatDate(post.publishedAt, 'medium', locale)}</time>
            )}
          </dd>
        </div>
        <div className={row}>
          <dt className="text-slate-500">{t('readingTime')}</dt>
          <dd className="text-slate-800">{t('minutes', { minutes: String(post.readingMinutes) })}</dd>
        </div>
        {post.status === 'PUBLISHED' && (
          <div className={row}>
            <dt className="text-slate-500">{t('views')}</dt>
            <dd className="tabular-nums text-slate-800">{numberFormat(locale).format(post.viewCount ?? 0)}</dd>
          </div>
        )}
        <div className={row}>
          <dt className="text-slate-500">{t('featured')}</dt>
          <dd className="text-right">
            {post.featured ? (
              <span className="inline-flex items-center gap-1 text-slate-800">
                <StarIcon size={14} className="text-amber-600" />
                {rank === null ? t('yes') : `#${rank}`}
              </span>
            ) : (
              <span className="text-slate-800">{t('no')}</span>
            )}
            {adminTools && (
              <>
                {' · '}
                <Link
                  href="/admin/curated"
                  className={`rounded-sm font-medium text-slate-700 underline decoration-slate-300 underline-offset-4 hover:text-slate-900 ${FOCUS_RING}`}
                >
                  {t('manage')}
                </Link>
              </>
            )}
          </dd>
        </div>
      </dl>
    </section>
  )
}

/**
 * Asks again when leaving the editor through an in-app link while there are unsaved changes. In place, under
 * the top bar, no `window.confirm` (the browser box blocks the whole page and its text cannot be set). Focus goes to
 * stay when shown: another Enter on the same spot must be the safe action. Leave goes exactly where
 * the writer meant to go (`href`), and carries `data-leave-confirmed` so the link blocker lets it through.
 */
function LeavePrompt({ href, onStay }: { href: string; onStay: () => void }) {
  const t = useTranslations('Admin.editor')
  const promptId = useId()
  const stay = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    stay.current?.focus()
  }, [])
  return (
    <div
      role="group"
      aria-labelledby={promptId}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onStay()
      }}
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-amber-200 bg-amber-50 px-4 py-2.5 sm:px-6"
    >
      <p id={promptId} className="text-sm text-amber-900">
        {t('leaveQuestion')}
      </p>
      <div className="flex gap-2">
        <button ref={stay} type="button" onClick={onStay} className={button('secondary', 'sm')}>
          {t('stay')}
        </button>
        <Link href={href} data-leave-confirmed="" className={button('danger', 'sm')}>
          {t('leave')}
        </Link>
      </div>
    </div>
  )
}
