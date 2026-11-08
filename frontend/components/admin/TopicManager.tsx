'use client'

import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { useEffect, useId, useRef, useState } from 'react'
import { PlusIcon, Trash2Icon } from '@/components/icons'
import { LANGUAGE_NAMES } from '@/components/site/language-names'
import { DEFAULT_LOCALE, LOCALES } from '@/i18n/config'
import { asLocale, collator } from '@/lib/format'
import type { LocalizedText } from '@/lib/types'
import { EmptyState, ErrorAlert } from './primitives'
import { isRedirectError } from './PostEditor'
import { button, H2, HINT, INPUT, LABEL, LIST, META, SECTION_DESC, STATUS_TEXT } from './ui'

/** One category or tag on screen, with the number of posts using it (counted on the page, over every post). */
export type TopicItem = {
  id: string
  name: string
  slug: string
  /** Only categories have a description; tags are always null. */
  description: string | null
  /** Number of posts (any status) using it. */
  posts: number
  /** Of those, how many are published. */
  published: number
  /** The raw per-language texts (locale to name and description); absent means none. A tag has no description. */
  translations?: Record<string, LocalizedText>
}

/** The languages the base text is NOT in: each gets its own name (and description) fields next to the base ones. */
const TRANSLATED_LOCALES = LOCALES.filter((locale) => locale !== DEFAULT_LOCALE)

type TranslationDraft = Record<string, { name: string; description: string }>

function draftOf(item: TopicItem): TranslationDraft {
  return Object.fromEntries(
    TRANSLATED_LOCALES.map((locale) => [
      locale,
      { name: item.translations?.[locale]?.name ?? '', description: item.translations?.[locale]?.description ?? '' },
    ]),
  )
}

/** What is sent: the stored map with the edited languages replaced; a blank entry is dropped (the backend does too). */
function translationsOf(item: TopicItem, draft: TranslationDraft, withDescription: boolean): Record<string, LocalizedText> {
  const result: Record<string, LocalizedText> = { ...item.translations }
  for (const locale of TRANSLATED_LOCALES) {
    const name = draft[locale].name.trim()
    const description = withDescription ? draft[locale].description.trim() : ''
    if (name === '' && description === '') delete result[locale]
    else result[locale] = { name: name === '' ? null : name, description: description === '' ? null : description }
  }
  return result
}

/** What the action returns after saving: the category/tag as the backend wrote it, without the post count yet. */
type SavedTopic = Omit<TopicItem, 'posts' | 'published'>

export type TopicManagerProps = {
  kind: 'category' | 'tag'
  items: TopicItem[]
  onCreate: (name: string, description: string | null) => Promise<SavedTopic | { error: string }>
  onSave: (
    id: string,
    name: string,
    description: string | null,
    translations: Record<string, LocalizedText>,
  ) => Promise<SavedTopic | { error: string }>
  /** null means deleted. */
  onDelete: (id: string) => Promise<{ error: string } | null>
  /**
   * Merge `id` into `targetId`: every post of the source goes to the target, then the source is deleted. Returns the
   * target and the number of posts moved. Absent means there is no merge button.
   */
  onMerge?: (id: string, targetId: string) => Promise<{ target: SavedTopic; moved: number } | { error: string }>
}

const WORDS = {
  category: { path: '/categories/', filter: 'cat', maxName: 255 },
  tag: { path: '/tags/', filter: 'tag', maxName: 100 },
} as const

function isError<T extends object>(value: T | { error: string } | null): value is { error: string } {
  return value !== null && 'error' in value
}

/**
 * Calls an action, catching rejected promises too: throwing from an async handler reaches no error boundary, and
 * the user presses a button and sees nothing. undefined is a redirect error (expired session): the router is
 * navigating by itself, so it is not an error to show.
 */
async function settle<T>(action: () => Promise<T>, unreachable: string): Promise<T | { error: string } | undefined> {
  try {
    return await action()
  } catch (caught) {
    if (isRedirectError(caught)) return undefined
    console.error('Topic action failed', caught)
    return { error: unreachable }
  }
}

/**
 * The category or tag list of the Topics page: name, public path, number of posts
 * using it; edit the name (and description for a category) in place; delete through an in-place confirmation step; add a new one
 * at the end. Every change takes effect immediately (one action per operation), so there is no shared save button.
 *
 * A category that still has posts has no direct delete button (409 CATEGORY_IN_USE in the backend: a published post must have
 * a category) — instead there is a link to the list of those posts, and the move-posts-then-delete button: choose
 * another category, every post goes there, then this category is deleted. A tag with posts also has a merge button: the posts
 * carrying this tag carry the target tag, then this tag is deleted.
 */
export default function TopicManager({ kind, items: initial, onCreate, onSave, onDelete, onMerge }: TopicManagerProps) {
  const t = useTranslations('Admin.topics.manager')
  const id = useId()
  const locale = asLocale(useLocale())
  const byName = (a: TopicItem, b: TopicItem) => collator(locale).compare(a.name, b.name)
  // State initialized from props, and every saved change is applied at once from the action result. A half-edited box is
  // never overwritten: the text being typed is the row's own state (TopicRow), not this list's.
  const [items, setItems] = useState(() => [...initial].sort(byName))
  const [notice, setNotice] = useState('')
  const heading = useRef<HTMLHeadingElement>(null)

  // The server redraws the page after every write (updateTag), with the right post counts — the one thing the client cannot
  // compute by itself after merging tags (a post carrying both tags is counted once). React's "adjust state when a prop changes"
  // pattern, like CommentModeration: compare during render, not in an effect. The in-place updates below
  // are all idempotent when reapplied (replace by id, remove by id, add if missing), so the order in which the two
  // arrive does not matter.
  const [source, setSource] = useState(initial)
  if (initial !== source) {
    setSource(initial)
    setItems([...initial].sort(byName))
  }

  function replace(item: TopicItem) {
    setItems((current) => current.map((existing) => (existing.id === item.id ? item : existing)).sort(byName))
  }

  async function create(name: string, description: string | null): Promise<string | null> {
    setNotice('')
    const result = await settle(() => onCreate(name, description), t('unreachable'))
    if (result === undefined) return null
    if (isError(result)) return result.error
    setItems((current) =>
      current.some((existing) => existing.id === result.id)
        ? current
        : [...current, { ...result, posts: 0, published: 0 }].sort(byName),
    )
    setNotice(t(`${kind}.added`, { name: result.name }))
    return null
  }

  async function save(
    item: TopicItem,
    name: string,
    description: string | null,
    translations: Record<string, LocalizedText>,
  ): Promise<string | null> {
    setNotice('')
    const result = await settle(() => onSave(item.id, name, description, translations), t('unreachable'))
    if (result === undefined) return null
    if (isError(result)) return result.error
    replace({ ...item, ...result })
    setNotice(result.name === item.name ? t(`${kind}.saved`, { name: result.name }) : t('renamed', { name: result.name }))
    return null
  }

  async function remove(item: TopicItem): Promise<string | null> {
    setNotice('')
    const result = await settle(() => onDelete(item.id), t('unreachable'))
    if (result === undefined) return null
    if (isError(result)) return result.error
    setItems((current) => current.filter((existing) => existing.id !== item.id))
    setNotice(t(`${kind}.deleted`, { name: item.name }))
    // The button holding focus left the page with its row: go to the list heading, not falling to <body>.
    heading.current?.focus()
    return null
  }

  /**
   * Merge `item` into `targetId`. In place only the source is removed: the target's right post count arrives with the same server
   * redraw (synced from props above) — for tags, a post carrying both is counted once, which the client cannot know.
   */
  async function merge(item: TopicItem, targetId: string): Promise<string | null> {
    if (onMerge === undefined) return null
    setNotice('')
    const result = await settle(() => onMerge(item.id, targetId), t('unreachable'))
    if (result === undefined) return null
    if (isError(result)) return result.error
    setItems((current) => current.filter((existing) => existing.id !== item.id))
    setNotice(t(`${kind}.merged`, { name: item.name, target: result.target.name, moved: result.moved }))
    heading.current?.focus()
    return null
  }

  const headingId = `${id}-heading`

  return (
    <section aria-labelledby={headingId}>
      <h2
        id={headingId}
        ref={heading}
        tabIndex={-1}
        className={`${H2} rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 outline-brand`}
      >
        {/* Whitespace between the two parts: the accessible name (of the heading, and of the whole section) joins the text of the
            children, without it the label and number would be glued together. */}
        {t(`${kind}.title`)} <span className="ml-1 text-sm font-normal text-slate-500">{items.length}</span>
      </h2>
      <p className={SECTION_DESC}>{t(`${kind}.description`)}</p>

      <div className="mt-5">
        {items.length === 0 ? (
          <EmptyState title={t(`${kind}.empty`)}>{t(`${kind}.emptyHint`)}</EmptyState>
        ) : (
          <ul aria-label={t(`${kind}.listLabel`)} className={LIST}>
            {items.map((item) => (
              <TopicRow
                key={item.id}
                kind={kind}
                item={item}
                targets={onMerge === undefined ? [] : items.filter((other) => other.id !== item.id)}
                onSave={(name, description, translations) => save(item, name, description, translations)}
                onDelete={() => remove(item)}
                onMerge={(targetId) => merge(item, targetId)}
              />
            ))}
          </ul>
        )}
      </div>

      {/* Always present: a live region must exist before its content changes for the change to be announced. */}
      <p role="status" className={`mt-3 ${STATUS_TEXT}`}>
        {notice}
      </p>

      <CreateForm kind={kind} onCreate={create} />
    </section>
  )
}

function TopicRow({
  kind,
  item,
  targets,
  onSave,
  onDelete,
  onMerge,
}: {
  kind: TopicManagerProps['kind']
  item: TopicItem
  /** The other categories/tags that can be merged into; empty means there is no merge button. */
  targets: TopicItem[]
  onSave: (name: string, description: string | null, translations: Record<string, LocalizedText>) => Promise<string | null>
  onDelete: () => Promise<string | null>
  onMerge: (targetId: string) => Promise<string | null>
}) {
  const t = useTranslations('Admin.topics.manager')
  const id = useId()
  const words = WORDS[kind]
  const [mode, setMode] = useState<'view' | 'edit' | 'confirm' | 'merge'>('view')
  const [name, setName] = useState(item.name)
  const [description, setDescription] = useState(item.description ?? '')
  const [translated, setTranslated] = useState(() => draftOf(item))
  const [targetId, setTargetId] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const editButton = useRef<HTMLButtonElement>(null)
  const deleteButton = useRef<HTMLButtonElement>(null)
  const mergeButton = useRef<HTMLButtonElement>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const cancelDelete = useRef<HTMLButtonElement>(null)
  const targetSelect = useRef<HTMLSelectElement>(null)
  // The button that must regain focus when returning to view mode; null when the page has just loaded (no focus jolt). Remember the KIND of
  // button, not the element: in edit/confirm mode those two buttons are not drawn, their ref is null,
  // and they only exist again after view mode has rendered — i.e. in the effect below.
  const returnTo = useRef<'edit' | 'delete' | 'merge' | null>(null)

  useEffect(() => {
    if (mode === 'edit') nameInput.current?.focus()
    else if (mode === 'confirm') cancelDelete.current?.focus()
    else if (mode === 'merge') targetSelect.current?.focus()
    else if (returnTo.current !== null) {
      const back = { edit: editButton, delete: deleteButton, merge: mergeButton }[returnTo.current]
      back.current?.focus()
      returnTo.current = null
    }
  }, [mode])

  // Save, delete or merge failed: while pending the buttons are disabled so focus fell back to <body>. Put it where work can
  // continue: the name box (edit and save again), cancel of the confirmation step, or the target select (choose another and merge again).
  // The error sentence is role="alert", so it is announced by itself.
  useEffect(() => {
    if (pending || error === null) return
    if (mode === 'edit') nameInput.current?.focus()
    else if (mode === 'confirm') cancelDelete.current?.focus()
    else if (mode === 'merge') targetSelect.current?.focus()
  }, [pending, error, mode])

  function close(back: 'edit' | 'delete' | 'merge') {
    setError(null)
    returnTo.current = back
    setMode('view')
  }

  async function run(action: () => Promise<string | null>, after: () => void) {
    setError(null)
    setPending(true)
    try {
      const failure = await action()
      if (failure !== null) setError(failure)
      else after()
    } finally {
      setPending(false)
    }
  }

  const usage =
    item.posts === 0
      ? t('usageNone')
      : item.published === item.posts
        ? t('usageAll', { count: item.posts })
        : t('usagePartly', { count: item.posts, published: item.published })
  const promptId = `${id}-prompt`
  const nameId = `${id}-name`
  const descriptionId = `${id}-description`
  const targetFieldId = `${id}-target`
  const consequenceId = `${id}-consequence`
  // Merging only makes sense when this one has posts and there is somewhere else to move them. With no posts delete is enough.
  const mergeable = item.posts > 0 && targets.length > 0
  const target = targets.find((candidate) => candidate.id === targetId) ?? null

  return (
    <li className="px-4 py-3.5 sm:px-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-medium break-words text-slate-900">{item.name}</p>
          <p className={`${META} flex flex-wrap gap-x-3`}>
            <span className="font-mono break-all">
              {words.path}
              {item.slug}
            </span>
            <span>{usage}</span>
          </p>
          {item.description !== null && <p className={`${META} mt-1 text-slate-600`}>{item.description}</p>}
          {TRANSLATED_LOCALES.map((locale) => {
            const text = item.translations?.[locale]
            if (!text?.name && !text?.description) return null
            return (
              <p key={locale} lang={locale} className={`${META} mt-1 text-slate-600`}>
                <span className="font-medium">{LANGUAGE_NAMES[locale]}:</span> {text.name}
                {text.name && text.description ? ' \u00b7 ' : ''}
                {text.description}
              </p>
            )
          })}
        </div>
        {mode === 'view' && (
          // At most 45% of the row from sm: a category that still has posts has three buttons (the move-posts-then-delete one), and in the two-column
          // layout (xl) they used to squeeze the name to ~130px, with the path breaking mid-word. The third button wraps instead.
          <div className="flex shrink-0 flex-wrap items-center gap-1 sm:max-w-[45%] sm:justify-end">
            <button
              ref={editButton}
              type="button"
              onClick={() => {
                setName(item.name)
                setDescription(item.description ?? '')
                setTranslated(draftOf(item))
                setMode('edit')
              }}
              className={button('ghost', 'sm')}
            >
              {/* Whitespace OUTSIDE the span, and the full name in ONE sr-only span: Chrome inserts whitespace
                  around each sr-only span (position:absolute), so splitting the name into several spans breaks the name. */}
              {t('edit')} <span className="sr-only">{t(`${kind}.subject`, { name: item.name })}</span>
            </button>
            {kind === 'tag' && mergeable && (
              <button
                ref={mergeButton}
                type="button"
                onClick={() => {
                  setTargetId('')
                  setMode('merge')
                }}
                className={button('ghost', 'sm')}
              >
                {/* The "…" (more will be asked) is only for the eye; the full name is in ONE sr-only span. The merge word and "…" share
                    one span: the button is inline-flex with a gap, and two separate text nodes would leave "…" far from the word. */}
                <span>
                  {t('merge')}
                  <span aria-hidden="true">…</span>
                </span>{' '}
                <span className="sr-only">{t('tag.mergeSr', { name: item.name })}</span>
              </button>
            )}
            {kind === 'category' && item.posts > 0 ? (
              <>
                <Link
                  href={`/admin?${words.filter}=${encodeURIComponent(item.slug)}`}
                  title={t('viewPostsTitle')}
                  className={button('ghost', 'sm')}
                >
                  {t('viewPosts', { count: item.posts })} <span className="sr-only">{t('viewPostsSr', { name: item.name })}</span>
                </Link>
                {mergeable && (
                  <button
                    ref={mergeButton}
                    type="button"
                    onClick={() => {
                      setTargetId('')
                      setMode('merge')
                    }}
                    className={button('ghost', 'sm', 'text-red-700 hover:bg-red-50 hover:text-red-800')}
                  >
                    {t('moveAndDelete')} <span className="sr-only">{t('category.subject', { name: item.name })}</span>
                  </button>
                )}
              </>
            ) : (
              <button
                ref={deleteButton}
                type="button"
                onClick={() => setMode('confirm')}
                className={button('ghost', 'sm', 'text-red-700 hover:bg-red-50 hover:text-red-800')}
              >
                {t('delete')} <span className="sr-only">{t(`${kind}.subject`, { name: item.name })}</span>
              </button>
            )}
          </div>
        )}
      </div>

      {mode === 'merge' && (
        <form
          aria-labelledby={`${id}-merge-title`}
          className="mt-3 space-y-3 rounded-lg border border-red-200 bg-red-50/60 p-3 sm:p-4"
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !pending) {
              event.preventDefault()
              close('merge')
            }
          }}
          onSubmit={(event) => {
            event.preventDefault()
            if (pending || target === null) return
            void run(
              () => onMerge(target.id),
              // Success: this row leaves the list (TopicManager moves focus to the heading).
              () => undefined,
            )
          }}
        >
          <p id={`${id}-merge-title`} className="text-[13px] font-semibold text-red-900">
            {t(`${kind}.mergeTitle`, { name: item.name })}
          </p>
          <div>
            <label htmlFor={targetFieldId} className={LABEL}>
              {t(`${kind}.mergeLabel`, { name: item.name, count: item.posts })}
            </label>
            <select
              ref={targetSelect}
              id={targetFieldId}
              value={targetId}
              required
              disabled={pending}
              onChange={(event) => {
                setError(null)
                setTargetId(event.target.value)
              }}
              className={`${INPUT} max-w-full`}
            >
              <option value="">{t(`${kind}.mergePlaceholder`)}</option>
              {targets.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {t('targetOption', { name: candidate.name, count: candidate.posts })}
                </option>
              ))}
            </select>
          </div>
          {/* The consequence, naming both and the post count; attached to the confirm button (aria-describedby), so a screen
              reader reads it right when reaching the button. Only present once a target is chosen: before that there is nothing to say. */}
          {target !== null && (
            <p id={consequenceId} className="text-[13px] leading-5 text-red-900 [overflow-wrap:anywhere]">
              {t(`${kind}.consequence`, {
                count: item.posts,
                partial: item.published < item.posts ? 'yes' : 'no',
                published: item.published,
                name: item.name,
                target: target.name,
                path: `${words.path}${item.slug}`,
              })}
            </p>
          )}
          {error !== null && <ErrorAlert>{error}</ErrorAlert>}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={pending || target === null}
              aria-describedby={target === null ? undefined : consequenceId}
              className={button('dangerSolid', 'sm')}
            >
              {pending
                ? t('moving')
                : kind === 'tag'
                  ? target === null
                    ? t('tag.mergeSubmit')
                    : t('tag.mergeSubmitInto', { target: target.name })
                  : t('category.mergeSubmit', { name: item.name })}
            </button>
            <button type="button" disabled={pending} onClick={() => close('merge')} className={button('secondary', 'sm')}>
              {t('cancel')}
            </button>
          </div>
        </form>
      )}

      {mode === 'edit' && (
        <form
          className="mt-3 space-y-3 rounded-md border border-slate-200 bg-slate-50/60 p-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (pending) return
            void run(
              () => onSave(name, kind === 'category' ? description : null, translationsOf(item, translated, kind === 'category')),
              () => close('edit'),
            )
          }}
        >
          <div>
            <label htmlFor={nameId} className={LABEL}>
              {t(`${kind}.nameLabel`)}
            </label>
            <input
              ref={nameInput}
              id={nameId}
              value={name}
              required
              maxLength={words.maxName}
              disabled={pending}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') close('edit')
              }}
              aria-describedby={`${nameId}-hint`}
              className={INPUT}
            />
            <p id={`${nameId}-hint`} className={HINT}>
              {t('pathHint', { path: `${words.path}${item.slug}` })}
            </p>
          </div>
          {kind === 'category' && (
            <div>
              <label htmlFor={descriptionId} className={LABEL}>
                {t('descriptionLabel')}
              </label>
              <textarea
                id={descriptionId}
                rows={2}
                value={description}
                maxLength={1000}
                disabled={pending}
                onChange={(event) => setDescription(event.target.value)}
                className={INPUT}
              />
            </div>
          )}
          {TRANSLATED_LOCALES.map((locale) => (
            <fieldset key={locale} className="space-y-3">
              <legend className={LABEL}>{t('translationLegend', { language: LANGUAGE_NAMES[locale] })}</legend>
              <div>
                <label htmlFor={`${nameId}-${locale}`} className="sr-only">
                  {t('translatedNameLabel', { language: LANGUAGE_NAMES[locale] })}
                </label>
                <input
                  id={`${nameId}-${locale}`}
                  lang={locale}
                  value={translated[locale].name}
                  maxLength={words.maxName}
                  disabled={pending}
                  placeholder={t('translatedNamePlaceholder')}
                  onChange={(event) =>
                    setTranslated((current) => ({ ...current, [locale]: { ...current[locale], name: event.target.value } }))
                  }
                  className={INPUT}
                />
              </div>
              {kind === 'category' && (
                <div>
                  <label htmlFor={`${descriptionId}-${locale}`} className="sr-only">
                    {t('translatedDescriptionLabel', { language: LANGUAGE_NAMES[locale] })}
                  </label>
                  <textarea
                    id={`${descriptionId}-${locale}`}
                    lang={locale}
                    rows={2}
                    value={translated[locale].description}
                    maxLength={1000}
                    disabled={pending}
                    onChange={(event) =>
                      setTranslated((current) => ({
                        ...current,
                        [locale]: { ...current[locale], description: event.target.value },
                      }))
                    }
                    className={INPUT}
                  />
                </div>
              )}
            </fieldset>
          ))}
          {error !== null && <ErrorAlert>{error}</ErrorAlert>}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={pending} className={button('primary', 'sm')}>
              {pending ? t('saving') : t('save')}
            </button>
            <button type="button" disabled={pending} onClick={() => close('edit')} className={button('secondary', 'sm')}>
              {t('cancel')}
            </button>
          </div>
        </form>
      )}

      {mode === 'confirm' && (
        <div
          role="group"
          aria-labelledby={promptId}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !pending) close('delete')
          }}
          className="mt-3 rounded-lg border border-red-200 bg-red-50/60 p-4"
        >
          <p id={promptId} className="text-[13px] leading-5 text-red-900">
            <strong className="font-semibold">{t(`${kind}.deleteQuestion`, { name: item.name })}</strong>{' '}
            {kind === 'tag' && item.posts > 0 && `${t('tag.deleteLeavesPosts', { count: item.posts })} `}
            {t('irreversible')}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() => void run(onDelete, () => undefined)}
              className={button('dangerSolid', 'sm')}
            >
              <Trash2Icon />
              {t('deleteConfirm')}
            </button>
            <button
              ref={cancelDelete}
              type="button"
              disabled={pending}
              onClick={() => close('delete')}
              className={button('secondary', 'sm')}
            >
              {t('cancel')}
            </button>
          </div>
          {error !== null && <ErrorAlert className="mt-3">{error}</ErrorAlert>}
        </div>
      )}
    </li>
  )
}

/** Add new at the end of the list. A form of its own: Enter in the name box is add, and sends nothing else. */
function CreateForm({
  kind,
  onCreate,
}: {
  kind: TopicManagerProps['kind']
  onCreate: (name: string, description: string | null) => Promise<string | null>
}) {
  const t = useTranslations('Admin.topics.manager')
  const id = useId()
  const words = WORDS[kind]
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const submitted = useRef(false)

  // After submitting, success or failure: focus returns to the name box. While pending the box and button are disabled so focus fell back to
  // <body>, and the next thing is typing the next name or fixing the name that was a duplicate.
  useEffect(() => {
    if (pending || !submitted.current) return
    submitted.current = false
    nameInput.current?.focus()
  }, [pending])

  const nameId = `${id}-name`
  const descriptionId = `${id}-description`

  return (
    <form
      className="mt-4 space-y-3"
      onSubmit={async (event) => {
        event.preventDefault()
        if (pending || name.trim() === '') return
        setError(null)
        submitted.current = true
        setPending(true)
        try {
          const failure = await onCreate(name, kind === 'category' ? description : null)
          if (failure !== null) {
            setError(failure)
            return
          }
          // Only clear the text on success: on a duplicate name the user keeps editing the exact text they typed.
          setName('')
          setDescription('')
        } finally {
          setPending(false)
        }
      }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 grow basis-56">
          <label htmlFor={nameId} className={LABEL}>
            {t(`${kind}.newNameLabel`)}
          </label>
          <input
            ref={nameInput}
            id={nameId}
            value={name}
            maxLength={words.maxName}
            disabled={pending}
            onChange={(event) => setName(event.target.value)}
            className={INPUT}
          />
        </div>
        <button type="submit" disabled={pending || name.trim() === ''} className={button('secondary')}>
          <PlusIcon />
          {t(`${kind}.addButton`)}
        </button>
      </div>
      {kind === 'category' && (
        <div>
          <label htmlFor={descriptionId} className={LABEL}>
            {t('descriptionLabel')} <span className="font-normal text-slate-500">{t('optional')}</span>
          </label>
          <textarea
            id={descriptionId}
            rows={2}
            value={description}
            maxLength={1000}
            disabled={pending}
            onChange={(event) => setDescription(event.target.value)}
            className={INPUT}
          />
        </div>
      )}
      {error !== null && <ErrorAlert>{error}</ErrorAlert>}
    </form>
  )
}
