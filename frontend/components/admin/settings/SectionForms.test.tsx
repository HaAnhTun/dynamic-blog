import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultPayload } from '@/content/defaults'
import { msg } from '@/test/render-intl'
import AboutForm from './AboutForm'
import ContactForm from './ContactForm'
import ProfileForm from './ProfileForm'
import SiteForm from './SiteForm'
import SkillsForm from './SkillsForm'
import type { SaveSection } from './fields'

vi.mock('@/lib/prepare-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/prepare-upload')>()),
  prepareUpload: async (file: File) => file,
}))

const SAVED = { saved: true as const, payload: {}, updatedAt: '2026-10-11T00:00:00Z' }
const onSave = vi.fn<SaveSection>()

const type = (label: string, value: string, index = 0) =>
  fireEvent.change(screen.getAllByLabelText(label)[index]!, { target: { value } })
const press = async (name: string, index = 0) => {
  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name })[index]!)
  })
}
const sent = () => onSave.mock.calls[0]![0]

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('SiteForm', () => {
  const value = defaultPayload('en', 'site')

  it('labels every field, sends the trimmed values and announces the save', async () => {
    onSave.mockResolvedValue(SAVED)
    render(<SiteForm value={value} onSave={onSave} />)

    expect(screen.getByLabelText(msg('Admin.settings.site.name'))).toHaveValue(value.name)
    expect(screen.getByLabelText(msg('Admin.settings.site.name'))).toBeRequired()
    type(msg('Admin.settings.site.name'), '  My site  ')
    type(msg('Admin.settings.site.positioning'), 'One\nline')
    await press(msg('Admin.settings.save'))

    expect(sent()).toEqual({ name: 'My site', tagline: value.tagline, positioning: 'One line' })
    expect(screen.getByRole('status')).toHaveTextContent(msg('Admin.settings.saved'))
  })

  it('shows the error in an alert with the refused fields and keeps what was typed', async () => {
    onSave.mockResolvedValue({
      error: msg('Admin.settings.errors.invalid'),
      problems: [{ pointer: '/name', reason: 'size must be between 1 and 80' }],
    })
    render(<SiteForm value={value} onSave={onSave} />)

    type(msg('Admin.settings.site.name'), 'Typed name')
    await press(msg('Admin.settings.save'))

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(msg('Admin.settings.errors.invalid'))
    expect(screen.getByText('/name')).toBeInTheDocument()
    expect(screen.getByLabelText(msg('Admin.settings.site.name'))).toHaveValue('Typed name')
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('a rejected action shows the generic error instead of failing silently', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    onSave.mockRejectedValue(new Error('boom'))
    render(<SiteForm value={value} onSave={onSave} />)

    await press(msg('Admin.settings.save'))

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Admin.settings.errors.unreachable'))
  })
})

describe('ProfileForm', () => {
  const value = { ...defaultPayload('en', 'profile'), avatar: '/media/0b8d6b2e-1d3f-4a52-9a8e-3f7a5b0f2c11.jpg' }

  it('turns empty optional boxes into null, removes the avatar and keeps the hero group', async () => {
    onSave.mockResolvedValue(SAVED)
    render(<ProfileForm value={value} onSave={onSave} onUploadAvatar={vi.fn()} />)

    type(msg('Admin.settings.profile.seeking'), '   ')
    type(msg('Admin.settings.profile.galleryLead'), '')
    await press(msg('Admin.settings.profile.avatarRemove'))
    await press(msg('Admin.settings.save'))

    expect(sent()).toMatchObject({ seeking: null, avatar: null, galleryLead: null, hero: value.hero, name: value.name })
    expect(screen.getByText(msg('Admin.settings.profile.avatarNone'))).toBeInTheDocument()
  })

  it('uploads the avatar through the action and sends the returned URL when the profile is saved', async () => {
    const url = '/media/11111111-2222-4333-8444-555555555555.png'
    const onUploadAvatar = vi.fn(async (form: FormData) => {
      expect(form.get('file')).toBeInstanceOf(File)
      return { url }
    })
    onSave.mockResolvedValue(SAVED)
    render(<ProfileForm value={{ ...value, avatar: null }} onSave={onSave} onUploadAvatar={onUploadAvatar} />)

    const file = new File(['x'], 'me.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText(msg('Admin.settings.profile.avatarFile')), { target: { files: [file] } })
    await press(msg('Admin.settings.profile.avatarUpload'))
    expect(onUploadAvatar).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: msg('Admin.settings.profile.avatarRemove') })).toBeInTheDocument()
    await press(msg('Admin.settings.save'))

    expect(sent()).toMatchObject({ avatar: url })
  })

  it('an upload error is shown in an alert and the avatar does not change', async () => {
    const onUploadAvatar = vi.fn(async () => ({ error: 'refused' }))
    render(<ProfileForm value={{ ...value, avatar: null }} onSave={onSave} onUploadAvatar={onUploadAvatar} />)

    fireEvent.change(screen.getByLabelText(msg('Admin.settings.profile.avatarFile')), {
      target: { files: [new File(['x'], 'me.png', { type: 'image/png' })] },
    })
    await press(msg('Admin.settings.profile.avatarUpload'))

    expect(screen.getByRole('alert')).toHaveTextContent('refused')
    expect(screen.getByText(msg('Admin.settings.profile.avatarNone'))).toBeInTheDocument()
  })
})

describe('AboutForm', () => {
  it('adds a section, splits the paragraphs by line and sends the list in order', async () => {
    onSave.mockResolvedValue(SAVED)
    render(<AboutForm value={{ intro: 'Intro', sections: [] }} onSave={onSave} />)

    await press(msg('Admin.settings.about.addSection'))
    type(msg('Admin.settings.about.sectionId'), 'story')
    type(msg('Admin.settings.about.sectionHeading'), 'My story')
    type(msg('Admin.settings.about.sectionBody'), 'First\n\n  Second  \n')
    await press(msg('Admin.settings.save'))

    expect(sent()).toEqual({ intro: 'Intro', sections: [{ id: 'story', title: 'My story', body: ['First', 'Second'] }] })
  })

  it('sends the body as typed (line breaks and tabs kept) and leaves the field out when it is empty', async () => {
    onSave.mockResolvedValue(SAVED)
    render(<AboutForm value={{ intro: 'Intro', sections: [] }} onSave={onSave} />)

    type(msg('Admin.settings.about.body'), '## Heading\n\n:::callout{type=tip}\n\tKept.\n:::\n\n')
    await press(msg('Admin.settings.save'))

    expect(sent()).toEqual({ intro: 'Intro', body: '## Heading\n\n:::callout{type=tip}\n\tKept.\n:::', sections: [] })

    onSave.mockClear()
    type(msg('Admin.settings.about.body'), '  \n ')
    await press(msg('Admin.settings.save'))

    expect(sent()).toEqual({ intro: 'Intro', sections: [] })
  })

  it('shows the stored body, a character counter against the limit and a link to the authoring prompt', () => {
    render(<AboutForm value={{ intro: 'Intro', body: 'Hello', sections: [] }} onSave={onSave} />)

    const body = screen.getByLabelText(msg('Admin.settings.about.body'))
    expect(body).toHaveValue('Hello')
    expect(body).toHaveAttribute('maxlength', '20000')
    expect(body).toHaveAccessibleDescription(msg('Admin.settings.about.bodyHint'))
    expect(screen.getByText(msg('Admin.settings.about.bodyCount', { count: 5, max: 20000 }))).toBeInTheDocument()
    expect(screen.getByRole('link', { name: msg('Admin.settings.about.bodyPrompt') })).toHaveAttribute(
      'href',
      '/admin/posts/import/authoring-prompt',
    )

    type(msg('Admin.settings.about.body'), 'Hello world')
    expect(screen.getByText(msg('Admin.settings.about.bodyCount', { count: 11, max: 20000 }))).toBeInTheDocument()
  })

  it('keeps the stored photo when saving and shows it with a hint that only the import brings it', async () => {
    onSave.mockResolvedValue(SAVED)
    const photo = '/media/00000000-0000-4000-8000-000000000002.jpg'
    const { container } = render(<AboutForm value={{ intro: 'Intro', photo, sections: [] }} onSave={onSave} />)

    expect(container.querySelector('img')).toHaveAttribute('src', photo)
    expect(screen.getByText(msg('Admin.settings.about.photoHint'))).toBeInTheDocument()
    expect(container.querySelector('input[type="file"]')).toBeNull()
    await press(msg('Admin.settings.save'))

    expect(sent()).toEqual({ intro: 'Intro', photo, sections: [] })
  })

  it('removes the photo on request and sends no photo after that', async () => {
    onSave.mockResolvedValue(SAVED)
    const { container } = render(
      <AboutForm
        value={{ intro: 'Intro', photo: '/media/00000000-0000-4000-8000-000000000002.png', sections: [] }}
        onSave={onSave}
      />,
    )

    await press(msg('Admin.settings.about.photoRemove'))

    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText(msg('Admin.settings.about.photoNone'))).toBeInTheDocument()
    await press(msg('Admin.settings.save'))
    expect(sent()).toEqual({ intro: 'Intro', sections: [] })
  })

  it('shows no photo and sends none for a page without one, whether the field is absent or null', async () => {
    onSave.mockResolvedValue(SAVED)
    const { container } = render(<AboutForm value={{ intro: 'Intro', photo: null, sections: [] }} onSave={onSave} />)

    expect(container.querySelector('img')).toBeNull()
    expect(screen.queryByRole('button', { name: msg('Admin.settings.about.photoRemove') })).toBeNull()
    await press(msg('Admin.settings.save'))
    expect(sent()).toEqual({ intro: 'Intro', sections: [] })
  })

  it('removing a row moves focus to the add button and the add button stops at ten sections', async () => {
    const sections = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, title: `T${i}`, body: ['p'] }))
    render(<AboutForm value={{ intro: 'Intro', sections }} onSave={onSave} />)

    expect(screen.getByRole('button', { name: msg('Admin.settings.about.addSection') })).toBeDisabled()
    await press(msg('Admin.settings.removeAria', { title: msg('Admin.settings.about.sectionTitle', { n: 3 }) }))

    expect(screen.getAllByLabelText(msg('Admin.settings.about.sectionId'))).toHaveLength(9)
    expect(screen.getByRole('button', { name: msg('Admin.settings.about.addSection') })).toHaveFocus()
  })
})

describe('ContactForm', () => {
  it('sends null for empty email and GitHub and the cleaned social links', async () => {
    onSave.mockResolvedValue(SAVED)
    render(<ContactForm value={{ email: null, github: null, blurb: 'Hi', social: [] }} onSave={onSave} />)

    await press(msg('Admin.settings.contact.addSocial'))
    type(msg('Admin.settings.contact.socialLabel'), ' Mastodon ')
    type(msg('Admin.settings.contact.socialUrl'), 'https://example.org/@me')
    await press(msg('Admin.settings.save'))

    expect(sent()).toEqual({
      email: null,
      github: null,
      blurb: 'Hi',
      social: [{ label: 'Mastodon', url: 'https://example.org/@me' }],
    })
  })
})

describe('SkillsForm', () => {
  it('omits the level of an item that follows its group and keeps an explicit one', async () => {
    onSave.mockResolvedValue(SAVED)
    render(<SkillsForm value={[]} onSave={onSave} />)

    await press(msg('Admin.settings.skills.addGroup'))
    type(msg('Admin.settings.skills.groupId'), 'backend')
    type(msg('Admin.settings.skills.groupHeading'), 'Backend')
    const group = screen.getByRole('region', { name: msg('Admin.settings.skills.groups') })
    await act(async () => {
      fireEvent.click(within(group).getByRole('button', { name: msg('Admin.settings.skills.addItem') }))
      fireEvent.click(within(group).getByRole('button', { name: msg('Admin.settings.skills.addItem') }))
    })
    type(msg('Admin.settings.skills.itemName'), 'Java', 0)
    type(msg('Admin.settings.skills.itemName'), 'Rust', 1)
    type(msg('Admin.settings.skills.itemNote'), 'Daily', 0)
    fireEvent.change(screen.getAllByLabelText(msg('Admin.settings.skills.itemLevel'))[1]!, { target: { value: 'learning' } })
    await press(msg('Admin.settings.save'))

    expect(sent()).toEqual({
      groups: [
        {
          id: 'backend',
          title: 'Backend',
          defaultLevel: 'worked-with',
          items: [
            { name: 'Java', note: 'Daily' },
            { name: 'Rust', level: 'learning' },
          ],
        },
      ],
    })
  })
})
