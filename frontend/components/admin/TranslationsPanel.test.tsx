import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TranslationsPanel, { type TranslationCandidate } from './TranslationsPanel'
import { LANGUAGE_NAMES } from '@/components/site/language-names'
import type { AdminPostTranslation } from '@/lib/admin-api'
import { msg } from '@/test/render-intl'

const onCreate = vi.fn()
const onLink = vi.fn()
const onUnlink = vi.fn()

afterEach(() => vi.clearAllMocks())

const t = (key: string, args?: Record<string, string | number>) => msg(`Admin.posts.translations.${key}`, args)

const ENGLISH: AdminPostTranslation = { id: 'p-en', language: 'en', slug: 'hello', title: 'Hello world', status: 'DRAFT' }
const CANDIDATE: TranslationCandidate = { id: 'p-other', title: 'Another post', language: 'en' }

function renderPanel(over: Partial<React.ComponentProps<typeof TranslationsPanel>> = {}) {
  return render(
    <TranslationsPanel
      language="vi"
      translations={[]}
      candidates={[]}
      onCreate={onCreate}
      onLink={onLink}
      onUnlink={onUnlink}
      {...over}
    />,
  )
}

async function submit(form: HTMLElement | null) {
  await act(async () => {
    fireEvent.submit(form!)
  })
}

describe('TranslationsPanel', () => {
  it('no linked post: says so, offers to create the missing language, no unlink button', () => {
    renderPanel()

    expect(screen.getByText(t('none'))).toBeInTheDocument()
    const select = screen.getByLabelText(t('createLanguage'))
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([LANGUAGE_NAMES.en])
    expect(screen.getByRole('button', { name: t('create') })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: t('unlink') })).toBeNull()
  })

  it('a linked post is listed with its language, status and an edit link; its language can no longer be created or linked', () => {
    renderPanel({ translations: [ENGLISH], candidates: [CANDIDATE] })

    const row = within(screen.getByRole('list', { name: t('listLabel') })).getByRole('listitem')
    expect(row).toHaveTextContent(LANGUAGE_NAMES.en)
    expect(within(row).getByRole('link', { name: new RegExp('Hello world') })).toHaveAttribute('href', '/admin/posts/p-en/edit')
    expect(screen.queryByLabelText(t('createLanguage'))).toBeNull()
    expect(screen.queryByLabelText(t('linkLabel'))).toBeNull()
    expect(screen.getByRole('button', { name: t('unlink') })).toBeInTheDocument()
  })

  it('the list could not be loaded: a notice, and no unlink', () => {
    renderPanel({ translations: null })

    expect(screen.getByText(t('loadFailed'))).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: t('unlink') })).toBeNull()
  })

  it('create: sends the language and the typed slug', async () => {
    onCreate.mockResolvedValue({ error: 'unused' })
    renderPanel()

    fireEvent.change(screen.getByLabelText(new RegExp(t('createSlug'))), { target: { value: 'hello' } })
    await submit(screen.getByRole('button', { name: t('create') }).closest('form'))

    expect(onCreate).toHaveBeenCalledWith('en', 'hello')
  })

  it('create: a server error (409 conflict, slug taken) shows in place', async () => {
    onCreate.mockResolvedValue({ error: msg('Errors.admin.codes.TRANSLATION_CONFLICT') })
    renderPanel()

    await submit(screen.getByRole('button', { name: t('create') }).closest('form'))

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Errors.admin.codes.TRANSLATION_CONFLICT'))
  })

  it('create: the redirect of a successful create is not an error', async () => {
    onCreate.mockRejectedValue(Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;push;/admin;307;' }))
    renderPanel()

    await submit(screen.getByRole('button', { name: t('create') }).closest('form'))

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('create: an unexpected rejection shows the "cannot connect" sentence', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    onCreate.mockRejectedValue(new TypeError('Failed to fetch'))
    renderPanel()

    await submit(screen.getByRole('button', { name: t('create') }).closest('form'))

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Errors.admin.unreachable'))
    log.mockRestore()
  })

  it('link: only posts of a language the group lacks are offered; the button waits for a choice, then sends the id', async () => {
    onLink.mockResolvedValue(null)
    renderPanel({ candidates: [CANDIDATE, { id: 'p-same', title: 'Same language', language: 'vi' }] })

    const select = screen.getByLabelText(t('linkLabel'))
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.getAttribute('value')),
    ).toEqual(['', 'p-other'])
    expect(screen.getByRole('button', { name: t('link') })).toBeDisabled()

    fireEvent.change(select, { target: { value: 'p-other' } })
    await submit(screen.getByRole('button', { name: t('link') }).closest('form'))

    expect(onLink).toHaveBeenCalledWith('p-other')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('link: a failure is shown and the choice is kept', async () => {
    onLink.mockResolvedValue({ error: msg('Errors.admin.codes.TRANSLATION_CONFLICT') })
    renderPanel({ candidates: [CANDIDATE] })

    fireEvent.change(screen.getByLabelText(t('linkLabel')), { target: { value: 'p-other' } })
    await submit(screen.getByRole('button', { name: t('link') }).closest('form'))

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Errors.admin.codes.TRANSLATION_CONFLICT'))
    expect(screen.getByLabelText(t('linkLabel'))).toHaveValue('p-other')
  })

  it('unlink: calls the action; a failure is shown', async () => {
    onUnlink.mockResolvedValueOnce({ error: msg('Errors.admin.codes.FORBIDDEN') })
    renderPanel({ translations: [ENGLISH] })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('unlink') }))
    })

    expect(onUnlink).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alert')).toHaveTextContent(msg('Errors.admin.codes.FORBIDDEN'))
  })

  it('a post in English offers Vietnamese as the missing language', () => {
    renderPanel({ language: 'en' })

    const select = screen.getByLabelText(t('createLanguage'))
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([LANGUAGE_NAMES.vi])
  })
})
