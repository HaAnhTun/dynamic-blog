import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SampleContentResult } from '@/lib/admin-sample-content'
import { msg, renderWithIntl } from '@/test/render-intl'
import SampleContentPanel from './SampleContentPanel'

const created: SampleContentResult = { posts: 4, series: 1, categories: 1, tags: 2, skipped: 0 }
const button = () => screen.getByRole('button', { name: msg('Admin.settings.sampleContent.submit') })

describe('SampleContentPanel', () => {
  it('shows only the button before anything is loaded', () => {
    renderWithIntl(<SampleContentPanel onLoad={vi.fn()} />)

    expect(button()).toBeEnabled()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })

  it('loads once on click, shows what was created and what was skipped', async () => {
    const onLoad = vi.fn(async () => created)
    renderWithIntl(<SampleContentPanel onLoad={onLoad} />, { locale: 'en' })

    fireEvent.click(button())

    expect(onLoad).toHaveBeenCalledTimes(1)
    expect(await screen.findByText(msg('Admin.settings.sampleContent.created', created, 'en'))).toBeInTheDocument()
    expect(screen.getByText(msg('Admin.settings.sampleContent.skipped', { skipped: 0 }, 'en'))).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(msg('Admin.settings.sampleContent.done', undefined, 'en'))
  })

  it('a repeated load that finds everything says that nothing new was created and counts the skipped items', async () => {
    const again: SampleContentResult = { posts: 0, series: 0, categories: 0, tags: 0, skipped: 8 }
    renderWithIntl(<SampleContentPanel onLoad={async () => again} />, { locale: 'en' })

    fireEvent.click(button())

    expect(await screen.findByText(msg('Admin.settings.sampleContent.nothingNew', undefined, 'en'))).toBeInTheDocument()
    expect(screen.getByText(msg('Admin.settings.sampleContent.skipped', { skipped: 8 }, 'en'))).toBeInTheDocument()
  })

  it('disables the button and says so while the request is running, then enables it again', async () => {
    let finish: (value: SampleContentResult) => void = () => {}
    const onLoad = vi.fn(() => new Promise<SampleContentResult>((resolve) => (finish = resolve)))
    renderWithIntl(<SampleContentPanel onLoad={onLoad} />, { locale: 'en' })

    fireEvent.click(button())

    expect(button()).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent(msg('Admin.settings.sampleContent.loading', undefined, 'en'))
    finish(created)
    await waitFor(() => expect(button()).toBeEnabled())
    expect(onLoad).toHaveBeenCalledTimes(1)
  })

  it('shows the error of a refused request and no summary', async () => {
    renderWithIntl(<SampleContentPanel onLoad={async () => ({ error: 'Refused for a test' })} />, { locale: 'en' })

    fireEvent.click(button())

    expect(await screen.findByText('Refused for a test')).toBeInTheDocument()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
    expect(button()).toBeEnabled()
  })

  it('an action that throws shows the unreachable sentence instead of an unhandled rejection', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    renderWithIntl(
      <SampleContentPanel
        onLoad={async () => {
          throw new Error('fetch failed')
        }}
      />,
      { locale: 'en' },
    )

    fireEvent.click(button())

    expect(await screen.findByText(msg('Admin.settings.sampleContent.unreachable', undefined, 'en'))).toBeInTheDocument()
  })

  it('renders in the other language with its own sentences', async () => {
    renderWithIntl(<SampleContentPanel onLoad={async () => created} />, { locale: 'vi' })

    fireEvent.click(screen.getByRole('button', { name: msg('Admin.settings.sampleContent.submit', undefined, 'vi') }))

    expect(await screen.findByText(msg('Admin.settings.sampleContent.created', created, 'vi'))).toBeInTheDocument()
  })
})
