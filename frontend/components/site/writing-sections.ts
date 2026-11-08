import type { ComponentType } from 'react'
import { ArchiveIcon, LayersIcon, NewspaperIcon, TagsIcon, type IconProps } from '@/components/icons'

/** The four ways to view posts. The page placing this nav says which one it is. */
export type WritingSection = 'latest' | 'series' | 'topics' | 'archive'

export const WRITING_SECTIONS: readonly {
  key: WritingSection
  href: string
  labelKey: string
  Icon: ComponentType<IconProps>
}[] = [
  { key: 'latest', href: '/writing', labelKey: 'sectionNav.latest', Icon: NewspaperIcon },
  { key: 'series', href: '/series', labelKey: 'sectionNav.series', Icon: LayersIcon },
  { key: 'topics', href: '/topics', labelKey: 'sectionNav.topics', Icon: TagsIcon },
  { key: 'archive', href: '/archive', labelKey: 'sectionNav.archive', Icon: ArchiveIcon },
]
