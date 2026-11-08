'use client'

import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { skillLevelOrder, type Skill, type SkillGroup, type SkillLevel } from '@/lib/site-content-types'
import {
  RepeatableSection,
  RowFrame,
  SaveBar,
  SelectField,
  TextField,
  clean,
  newRow,
  toRows,
  useSave,
  type Row,
  type SaveSection,
} from './fields'

type ItemRow = { name: string; level: SkillLevel | ''; note: string }
type GroupRow = { id: string; title: string; defaultLevel: SkillLevel; items: Row<ItemRow>[] }

const MAX_GROUPS = 12
const MAX_ITEMS = 30

const toGroupRow = (group: SkillGroup): GroupRow => ({
  id: group.id,
  title: group.title,
  defaultLevel: group.defaultLevel,
  items: toRows(group.items.map((item) => ({ name: item.name, level: item.level ?? '', note: item.note ?? '' }))),
})

function toItem(row: ItemRow): Skill {
  const note = clean(row.note)
  return { name: clean(row.name), ...(row.level === '' ? {} : { level: row.level }), ...(note === '' ? {} : { note }) }
}

/** Skill groups, each with a default level and a list of items that may override it. */
export default function SkillsForm({ value, onSave }: { value: SkillGroup[]; onSave: SaveSection }) {
  const t = useTranslations('Admin.settings.skills')
  const tLevels = useTranslations('Admin.settings.skills.levels')
  const [groups, setGroups] = useState<Row<GroupRow>[]>(() => toRows(value.map(toGroupRow)))
  const save = useSave(onSave)

  const levelOptions = skillLevelOrder.map((level) => ({ value: level, label: tLevels(level) }))
  const patchGroup = (uid: number, patch: Partial<GroupRow>) =>
    setGroups((current) => current.map((row) => (row.uid === uid ? { ...row, value: { ...row.value, ...patch } } : row)))
  const editItems = (groupUid: number, change: (items: Row<ItemRow>[]) => Row<ItemRow>[]) =>
    setGroups((current) =>
      current.map((group) =>
        group.uid === groupUid ? { ...group, value: { ...group.value, items: change(group.value.items) } } : group,
      ),
    )
  const patchItem = (groupUid: number, itemUid: number, patch: Partial<ItemRow>) =>
    setGroups((current) =>
      current.map((group) =>
        group.uid === groupUid
          ? {
              ...group,
              value: {
                ...group.value,
                items: group.value.items.map((item) =>
                  item.uid === itemUid ? { ...item, value: { ...item.value, ...patch } } : item,
                ),
              },
            }
          : group,
      ),
    )

  return (
    <form
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault()
        void save.run({
          groups: groups.map(({ value: group }) => ({
            id: clean(group.id),
            title: clean(group.title),
            defaultLevel: group.defaultLevel,
            items: group.items.map((item) => toItem(item.value)),
          })),
        } satisfies { groups: SkillGroup[] })
      }}
    >
      <RepeatableSection
        heading={t('groups')}
        count={groups.length}
        max={MAX_GROUPS}
        addLabel={t('addGroup')}
        onAdd={() => setGroups((current) => [...current, newRow({ id: '', title: '', defaultLevel: 'worked-with', items: [] })])}
      >
        {groups.map((group, index) => (
          <RowFrame
            key={group.uid}
            title={t('groupTitle', { n: index + 1 })}
            onRemove={() => setGroups((current) => current.filter((candidate) => candidate.uid !== group.uid))}
          >
            <TextField
              label={t('groupId')}
              value={group.value.id}
              onChange={(id) => patchGroup(group.uid, { id })}
              mono
              required
              maxLength={40}
              hint={t('groupIdHint')}
            />
            <TextField
              label={t('groupHeading')}
              value={group.value.title}
              onChange={(title) => patchGroup(group.uid, { title })}
              required
              maxLength={60}
            />
            <SelectField
              label={t('defaultLevel')}
              value={group.value.defaultLevel}
              onChange={(level) => patchGroup(group.uid, { defaultLevel: level as SkillLevel })}
              options={levelOptions}
            />
            <RepeatableSection
              heading={t('items', { n: index + 1 })}
              count={group.value.items.length}
              max={MAX_ITEMS}
              addLabel={t('addItem')}
              onAdd={() => editItems(group.uid, (items) => [...items, newRow({ name: '', level: '', note: '' })])}
            >
              {group.value.items.map((item, itemIndex) => (
                <RowFrame
                  key={item.uid}
                  title={t('itemTitle', { n: itemIndex + 1 })}
                  onRemove={() => editItems(group.uid, (items) => items.filter((candidate) => candidate.uid !== item.uid))}
                >
                  <TextField
                    label={t('itemName')}
                    value={item.value.name}
                    onChange={(name) => patchItem(group.uid, item.uid, { name })}
                    required
                    maxLength={60}
                  />
                  <SelectField
                    label={t('itemLevel')}
                    value={item.value.level}
                    onChange={(level) => patchItem(group.uid, item.uid, { level: level as SkillLevel | '' })}
                    options={[{ value: '', label: t('levelDefault') }, ...levelOptions]}
                  />
                  <TextField
                    label={t('itemNote')}
                    value={item.value.note}
                    onChange={(note) => patchItem(group.uid, item.uid, { note })}
                    maxLength={120}
                  />
                </RowFrame>
              ))}
            </RepeatableSection>
          </RowFrame>
        ))}
      </RepeatableSection>

      <SaveBar state={save} />
    </form>
  )
}
