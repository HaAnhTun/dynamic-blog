import { render, screen, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { describe, expect, it } from 'vitest'
import { BriefcaseIcon, GraduationCapIcon } from '@/components/icons'
import { defaultSiteContent } from '@/content/defaults'
import type { Timeline as TimelineContent, TimelineEntry } from '@/lib/site-content-types'
import { TEST_LOCALE } from '@/test/intl'
import { Timeline } from './Timeline'
import { msg } from '@/test/render-intl'

/** The drawn part of an icon; see the comment of the same name in components/site/Header.test.tsx. */
function glyphOf(icon: ReactElement): string {
  const { container, unmount } = render(icon)
  const markup = container.querySelector('svg')!.innerHTML
  unmount()
  return markup
}

const { timeline } = defaultSiteContent(TEST_LOCALE)

const entry = (overrides: Partial<TimelineEntry> = {}): TimelineEntry => ({
  kind: 'experience',
  title: 'Title',
  org: null,
  period: null,
  summary: 'Description.',
  ...overrides,
})

const wrap = (entries: TimelineEntry[]): TimelineContent => ({
  experienceSummary: 'Experience summary.',
  entries,
})

describe('Timeline', () => {
  it('renders a null org and a null period as nothing at all', () => {
    // An owner may leave org and period out: a fabricated date is the worst thing the
    // content could carry. So the absence must render as absence: no 'N/A', no em dash, no "present" label, and no empty element holding a margin.
    render(<Timeline data={wrap([entry()])} />)

    const item = screen.getByRole('listitem')

    // An exact textContent, which is the only form of this assertion that cannot be
    // satisfied by a placeholder: every string in the output is one this test supplied.
    expect(item.textContent).toBe(msg('Site.home.timeline.experience') + 'Title' + 'Description.')
    // And the element itself is gone, not merely empty.
    expect(item.querySelectorAll('p')).toHaveLength(2)
    for (const placeholder of ['N/A', '—', '-', '·', 'null', 'undefined', '?']) {
      expect(item.textContent, placeholder).not.toContain(placeholder)
    }
  })

  it('renders an org and a period together when both exist', () => {
    render(
      <Timeline data={wrap([entry({ kind: 'education', title: 'Degree', org: 'School X', period: 'Mar 2019 – Jun 2021' })])} />,
    )

    expect(screen.getByText('School X · Mar 2019 – Jun 2021')).toBeInTheDocument()
    expect(screen.getByText(msg('Site.home.timeline.education'))).toBeInTheDocument()
  })

  it('renders the one fact it has, with no separator, when the other is null', () => {
    const { rerender } = render(<Timeline data={wrap([entry({ org: 'School X' })])} />)
    // `[org, period].join(' · ')` without the filter prints "School X · " here.
    expect(screen.getByText('School X')).toBeInTheDocument()

    rerender(<Timeline data={wrap([entry({ period: '2024' })])} />)
    expect(screen.getByText('2024')).toBeInTheDocument()
  })

  it('treats an empty string the same as null', () => {
    // An empty string is the same absence wearing a different type, and `[''].join(' · ')`
    // would render a stray separator with nothing on either side of it.
    render(<Timeline data={wrap([entry({ org: '', period: '   ' })])} />)

    const item = screen.getByRole('listitem')
    expect(item.querySelectorAll('p')).toHaveLength(2)
    expect(item.textContent).toBe(msg('Site.home.timeline.experience') + 'Title' + 'Description.')
  })

  it('places an icon by item kind: a graduation cap for education, a briefcase for experience', () => {
    render(<Timeline data={wrap([entry({ kind: 'education', title: 'Degree' }), entry({ title: 'Job' })])} />)
    const [education, experience] = screen.getAllByRole('listitem')

    for (const [item, icon, label] of [
      [education!, <GraduationCapIcon key="education" />, msg('Site.home.timeline.education')],
      [experience!, <BriefcaseIcon key="experience" />, msg('Site.home.timeline.experience')],
    ] as const) {
      const svgs = item.querySelectorAll('svg')
      expect(svgs, label).toHaveLength(1)
      expect(svgs[0]).toHaveAttribute('aria-hidden', 'true')
      expect(svgs[0]).toHaveAttribute('focusable', 'false')
      expect(svgs[0]!.innerHTML, label).toBe(glyphOf(icon))
      // The icon sits on the kind label, beside its text. The "absent" pair: the h3 title has no icon
      // (no icon on a heading).
      expect(svgs[0]!.closest('p')?.textContent).toBe(label)
      expect(item.querySelector('h3 svg')).toBeNull()
    }
  })

  it('uses an ordered list, because the entries are in a deliberate order', () => {
    const { container } = render(<Timeline data={wrap([entry({ title: 'One' }), entry({ title: 'Two' })])} />)

    expect(container.querySelector('ol')).not.toBeNull()
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['One', 'Two'])
  })

  it('renders the packaged timeline, with a meta line only where there are facts', () => {
    render(<Timeline data={timeline} />)

    expect(screen.getByText(timeline.experienceSummary)).toBeInTheDocument()
    for (const packaged of timeline.entries) {
      expect(screen.getByRole('heading', { level: 3, name: packaged.title })).toBeInTheDocument()
    }

    // Counts the paragraphs instead of searching for placeholder text: each entry renders a kind label
    // and a summary, and only an entry with an org or a period renders the third paragraph.
    const withFacts = timeline.entries.filter((e) => e.org || e.period).length
    expect(document.querySelectorAll('ol p')).toHaveLength(timeline.entries.length * 2 + withFacts)
  })

  describe('details', () => {
    const FULL = entry({
      title: 'Software engineer',
      org: 'Example Org',
      period: '09/2023 - Present',
      summary: 'Short blurb.',
      url: 'https://example.org',
      location: 'Example City',
      department: 'Platform team',
      highlights: ['Built the first thing.', 'Improved the second thing.'],
      tech: ['Java', 'PostgreSQL'],
      logo: '/media/0b8d6b2e-1d3f-4a52-9a8e-3f7a5b0f2c11.png',
    })

    it('links the company name to its address and keeps the period on the same line', () => {
      render(<Timeline data={wrap([FULL])} />)

      const link = screen.getByRole('link', { name: 'Example Org' })
      expect(link).toHaveAttribute('href', 'https://example.org')
      expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
      expect(link.closest('p')).toHaveTextContent('Example Org · 09/2023 - Present')
    })

    it('shows the location and the department on a line of their own', () => {
      render(<Timeline data={wrap([FULL])} />)

      expect(screen.getByText('Example City · Platform team')).toBeInTheDocument()
    })

    it('draws the highlights as a list and the technologies as named pills', () => {
      const { container } = render(<Timeline data={wrap([FULL])} />)

      const item = container.querySelector<HTMLElement>('ol > li')!
      expect(
        within(item)
          .getAllByRole('listitem')
          .map((li) => li.textContent),
      ).toEqual(['Built the first thing.', 'Improved the second thing.', 'Java', 'PostgreSQL'])
      const pills = within(item).getByRole('list', { name: msg('Site.entry.techLabel') })
      expect(
        within(pills)
          .getAllByRole('listitem')
          .map((li) => li.textContent),
      ).toEqual(['Java', 'PostgreSQL'])
    })

    it('draws the logo as a decorative image of the stored file', () => {
      const { container } = render(<Timeline data={wrap([FULL])} />)

      const logo = container.querySelector('li img')!
      expect(logo.getAttribute('src')).toContain('0b8d6b2e-1d3f-4a52-9a8e-3f7a5b0f2c11.png')
      expect(logo).toHaveAttribute('alt', '')
    })

    it('does not link an address that is not https, and keeps the name as plain text', () => {
      render(<Timeline data={wrap([entry({ org: 'Example Org', url: 'http://example.org' })])} />)

      expect(screen.queryByRole('link')).not.toBeInTheDocument()
      expect(screen.getByText('Example Org')).toBeInTheDocument()
    })

    it('renders blank optional values as nothing: no empty list, no image, no extra line', () => {
      const { container } = render(
        <Timeline data={wrap([entry({ url: '', location: ' ', department: null, highlights: [' '], tech: [], logo: null })])} />,
      )

      expect(container.querySelectorAll('ul')).toHaveLength(0)
      expect(container.querySelector('img')).toBeNull()
      expect(screen.getByRole('listitem').querySelectorAll('p')).toHaveLength(2)
    })

    it('an education entry shows the school, the degree and the years without experience details', () => {
      render(
        <Timeline
          data={wrap([entry({ kind: 'education', title: 'Degree name', org: 'School X', period: '2019 - 2021', summary: '' })])}
        />,
      )

      const item = screen.getByRole('listitem')
      expect(within(item).getByRole('heading', { level: 3 })).toHaveTextContent('Degree name')
      expect(within(item).getByText('School X · 2019 - 2021')).toBeInTheDocument()
      // A blank summary is no empty paragraph: the kind label and the meta line are the only two.
      expect(item.querySelectorAll('p')).toHaveLength(2)
    })
  })

  describe('bare', () => {
    it('renders the section without a Container and without vertical padding', () => {
      const { container } = render(<Timeline bare data={timeline} />)
      const root = container.firstElementChild as HTMLElement

      expect(root.tagName).toBe('SECTION')
      expect(root.className).not.toContain('mx-auto')
      expect(root.className).not.toContain('px-4')
      expect(root.className).not.toContain('max-w-')
      expect(root.className).not.toMatch(/(^|\s)(sm:)?py-/)
    })

    it('keeps the Container and the padding by default', () => {
      const { container } = render(<Timeline data={timeline} />)
      const root = container.firstElementChild as HTMLElement

      expect(root.className).toContain('mx-auto')
      expect(root.className).toContain('py-')
    })
  })

  it('names the bare section by its heading and keeps the journey list', () => {
    const { container } = render(<Timeline bare data={timeline} />)

    expect(container.querySelector('section')).toHaveAttribute('aria-labelledby', 'chang-duong')
    expect(container.querySelector('h2#chang-duong')).not.toBeNull()
    expect(container.querySelectorAll('ol > li')).toHaveLength(timeline.entries.length)
  })
})
