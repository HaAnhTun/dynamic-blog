'use client'

import Image from 'next/image'
import { useTranslations } from 'next-intl'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { TIMELINE_LIMITS, type Timeline, type TimelineEntry, type TimelineKind } from '@/lib/site-content-types'
import { STATUS_TEXT, button } from '../ui'
import {
  RepeatableSection,
  RowFrame,
  SaveBar,
  SelectField,
  TextField,
  clean,
  joinParagraphs,
  newRow,
  orNull,
  splitParagraphs,
  toRows,
  useSave,
  type Row,
  type SaveSection,
} from './fields'

type EntryRow = {
  kind: TimelineKind
  title: string
  org: string
  period: string
  summary: string
  url: string
  location: string
  department: string
  highlights: string
  tech: string
  /** Kept from the stored entry and sent again; only an import sets one, the form can remove it. */
  logo: string | null
}

const MAX_ENTRIES = 30
const KINDS: TimelineKind[] = ['experience', 'education']

const toEntryRow = (entry: TimelineEntry): EntryRow => ({
  kind: entry.kind,
  title: entry.title,
  org: entry.org ?? '',
  period: entry.period ?? '',
  summary: entry.summary,
  url: entry.url ?? '',
  location: entry.location ?? '',
  department: entry.department ?? '',
  highlights: joinParagraphs(entry.highlights ?? []),
  tech: joinParagraphs(entry.tech ?? []),
  logo: entry.logo ?? null,
})

const EMPTY_ROW: EntryRow = {
  kind: 'experience',
  title: '',
  org: '',
  period: '',
  summary: '',
  url: '',
  location: '',
  department: '',
  highlights: '',
  tech: '',
  logo: null,
}

const lines = (text: string): string[] => splitParagraphs(text).map(clean)

/** The entry as the backend stores it: an empty optional field is left out, never sent as an empty string or an empty list. */
function toEntry(row: EntryRow): TimelineEntry {
  const url = orNull(row.url)
  const location = orNull(row.location)
  const department = orNull(row.department)
  const highlights = lines(row.highlights)
  const tech = lines(row.tech)
  return {
    kind: row.kind,
    title: clean(row.title),
    org: orNull(row.org),
    period: orNull(row.period),
    summary: clean(row.summary),
    ...(url === null ? {} : { url }),
    ...(location === null ? {} : { location }),
    ...(department === null ? {} : { department }),
    ...(highlights.length === 0 ? {} : { highlights }),
    ...(tech.length === 0 ? {} : { tech }),
    ...(row.logo === null ? {} : { logo: row.logo }),
  }
}

type ListProblem = 'tooMany' | 'tooLong' | null

/** What the backend would refuse in a line list, found before sending. */
function listProblem(text: string, maxLines: number, maxLength: number): ListProblem {
  const items = lines(text)
  if (items.length > maxLines) return 'tooMany'
  if (items.some((item) => item.length > maxLength)) return 'tooLong'
  return null
}

const entryProblems = (row: EntryRow) => ({
  highlights: listProblem(row.highlights, TIMELINE_LIMITS.highlights, TIMELINE_LIMITS.highlight),
  tech: listProblem(row.tech, TIMELINE_LIMITS.tech, TIMELINE_LIMITS.techItem),
})

type Move = { uid: number; direction: 'up' | 'down' }

/**
 * The journey: a summary and a repeatable list of entries (experience or education), each with every field of the card on the
 * public pages. Lists (highlights, technologies) are edited as lines. Entries can be added, removed and moved; the logo is only
 * ever brought by a ZIP import, so the form keeps the stored one (a save never drops it) and can remove it. A line list the backend
 * would refuse is named next to its box and blocks the save; anything else the backend refuses comes back in the problem list.
 *
 * After a move the focus goes back to a move button of the entry (the one in the same direction, or the other when the entry
 * reached the end of the list): the button that held it moved with its row.
 */
export default function TimelineForm({ value, onSave }: { value: Timeline; onSave: SaveSection }) {
  const t = useTranslations('Admin.settings.timeline')
  const [summary, setSummary] = useState(value.experienceSummary)
  const [rows, setRows] = useState<Row<EntryRow>[]>(() => toRows(value.entries.map(toEntryRow)))
  const moved = useRef<Move | null>(null)
  const root = useRef<HTMLFormElement>(null)
  const save = useSave(onSave)

  useEffect(() => {
    const target = moved.current
    if (target === null) return
    moved.current = null
    const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>(`[data-move-uid="${target.uid}"]`) ?? [])
    const wanted = buttons.find((candidate) => candidate.dataset.moveDirection === target.direction && !candidate.disabled)
    ;(wanted ?? buttons.find((candidate) => !candidate.disabled))?.focus()
  }, [rows])

  const patch = (uid: number, change: Partial<EntryRow>) =>
    setRows((current) => current.map((row) => (row.uid === uid ? { ...row, value: { ...row.value, ...change } } : row)))
  const move = (uid: number, direction: 'up' | 'down') => {
    setRows((current) => {
      const index = current.findIndex((row) => row.uid === uid)
      const target = direction === 'up' ? index - 1 : index + 1
      if (index === -1 || target < 0 || target >= current.length) return current
      const next = [...current]
      ;[next[index], next[target]] = [next[target]!, next[index]!]
      return next
    })
    moved.current = { uid, direction }
  }

  const blocked = rows.some(({ value: row }) => Object.values(entryProblems(row)).some((problem) => problem !== null))
  const kindOptions = KINDS.map((kind) => ({ value: kind, label: t(`kinds.${kind}`) }))
  const problemText = (problem: ListProblem, lengthLimit: number, maxLines: number): ReactNode =>
    problem === null ? null : (
      <span className="block font-medium text-red-700">
        {problem === 'tooMany' ? t('tooMany', { max: maxLines }) : t('tooLong', { length: lengthLimit })}
      </span>
    )

  return (
    <form
      ref={root}
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault()
        if (blocked) return
        void save.run({
          experienceSummary: clean(summary),
          entries: rows.map(({ value: row }) => toEntry(row)),
        } satisfies Timeline)
      }}
    >
      <TextField
        label={t('summary')}
        value={summary}
        onChange={setSummary}
        rows={3}
        maxLength={TIMELINE_LIMITS.summary}
        hint={t('summaryHint')}
      />

      <RepeatableSection
        heading={t('entries')}
        count={rows.length}
        max={MAX_ENTRIES}
        addLabel={t('addEntry')}
        onAdd={() => setRows((current) => [...current, newRow({ ...EMPTY_ROW })])}
      >
        {rows.map((row, index) => {
          const entry = row.value
          const problems = entryProblems(entry)
          const name = clean(entry.title) === '' ? t('untitled') : clean(entry.title)
          return (
            <RowFrame
              key={row.uid}
              title={t('entryTitle', { n: index + 1 })}
              onRemove={() => setRows((current) => current.filter((candidate) => candidate.uid !== row.uid))}
            >
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  data-move-uid={row.uid}
                  data-move-direction="up"
                  disabled={index === 0}
                  onClick={() => move(row.uid, 'up')}
                  aria-label={t('moveUpAria', { title: name })}
                  className={button('secondary', 'sm')}
                >
                  {t('moveUp')}
                </button>
                <button
                  type="button"
                  data-move-uid={row.uid}
                  data-move-direction="down"
                  disabled={index === rows.length - 1}
                  onClick={() => move(row.uid, 'down')}
                  aria-label={t('moveDownAria', { title: name })}
                  className={button('secondary', 'sm')}
                >
                  {t('moveDown')}
                </button>
              </div>
              <SelectField
                label={t('kind')}
                value={entry.kind}
                onChange={(kind) => patch(row.uid, { kind: kind as TimelineKind })}
                options={kindOptions}
              />
              <TextField
                label={t('title')}
                value={entry.title}
                onChange={(title) => patch(row.uid, { title })}
                required
                maxLength={120}
              />
              <TextField label={t('org')} value={entry.org} onChange={(org) => patch(row.uid, { org })} maxLength={120} />
              <TextField
                label={t('period')}
                value={entry.period}
                onChange={(period) => patch(row.uid, { period })}
                maxLength={60}
                hint={t('periodHint')}
              />
              <TextField
                label={t('entrySummary')}
                value={entry.summary}
                onChange={(text) => patch(row.uid, { summary: text })}
                rows={3}
                maxLength={TIMELINE_LIMITS.summary}
              />
              <TextField
                label={t('url')}
                value={entry.url}
                onChange={(url) => patch(row.uid, { url })}
                type="url"
                mono
                maxLength={300}
                hint={t('urlHint')}
              />
              <TextField
                label={t('location')}
                value={entry.location}
                onChange={(location) => patch(row.uid, { location })}
                maxLength={TIMELINE_LIMITS.location}
              />
              <TextField
                label={t('department')}
                value={entry.department}
                onChange={(department) => patch(row.uid, { department })}
                maxLength={TIMELINE_LIMITS.department}
              />
              <TextField
                label={t('highlights')}
                value={entry.highlights}
                onChange={(highlights) => patch(row.uid, { highlights })}
                rows={5}
                hint={
                  <>
                    {t('highlightsHint', { max: TIMELINE_LIMITS.highlights, length: TIMELINE_LIMITS.highlight })}
                    {problemText(problems.highlights, TIMELINE_LIMITS.highlight, TIMELINE_LIMITS.highlights)}
                  </>
                }
              />
              <TextField
                label={t('tech')}
                value={entry.tech}
                onChange={(tech) => patch(row.uid, { tech })}
                rows={4}
                hint={
                  <>
                    {t('techHint', { max: TIMELINE_LIMITS.tech, length: TIMELINE_LIMITS.techItem })}
                    {problemText(problems.tech, TIMELINE_LIMITS.techItem, TIMELINE_LIMITS.tech)}
                  </>
                }
              />
              <section className="space-y-2" aria-label={t('logoHeading')}>
                {entry.logo !== null ? (
                  <div className="flex items-center gap-4">
                    <Image
                      src={entry.logo}
                      alt=""
                      width={96}
                      height={96}
                      unoptimized
                      className="h-16 w-16 rounded-md border border-slate-200 bg-white object-contain p-1"
                    />
                    <button type="button" onClick={() => patch(row.uid, { logo: null })} className={button('danger', 'sm')}>
                      {t('logoRemove')}
                    </button>
                  </div>
                ) : (
                  <p className={STATUS_TEXT}>{t('logoNone')}</p>
                )}
                <p className="text-xs text-slate-500">{t('logoHint')}</p>
              </section>
            </RowFrame>
          )
        })}
      </RepeatableSection>

      <SaveBar state={save} disabled={blocked} />
    </form>
  )
}
