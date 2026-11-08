import type { BlockType } from '@/lib/blocks/registry'
import { Callout } from './Callout'
import { Checklist } from './Checklist'
import { CodeTabs } from './CodeTabs'
import { Compare } from './Compare'
import { Comparison } from './Comparison'
import { Details } from './Details'
import { Diagram } from './Diagram'
import { Event } from './Event'
import { Figure } from './Figure'
import { FileTree } from './FileTree'
import { Gallery } from './Gallery'
import { Metric } from './Metric'
import { Metrics } from './Metrics'
import { Pane } from './Pane'
import { Pullquote } from './Pullquote'
import { Step } from './Step'
import { Steps } from './Steps'
import { Tab } from './Tab'
import { Tabs } from './Tabs'
import { Takeaways } from './Takeaways'
import { Timeline } from './Timeline'
import type { BlockComponent } from './types'

/**
 * One native component per block type of the registry (`lib/blocks/registry.ts`). The mapped type makes a missing or an extra entry a
 * compile error, and `blocks.test.tsx` checks the same at run time, and that every file named after a type exists. An entry never
 * changes when a component is filled in: only the component file does.
 */
export const BLOCK_COMPONENTS: { [T in BlockType]: BlockComponent<T> } = {
  callout: Callout,
  figure: Figure,
  gallery: Gallery,
  compare: Compare,
  pane: Pane,
  comparison: Comparison,
  steps: Steps,
  step: Step,
  details: Details,
  takeaways: Takeaways,
  checklist: Checklist,
  pullquote: Pullquote,
  'code-tabs': CodeTabs,
  diagram: Diagram,
  'file-tree': FileTree,
  timeline: Timeline,
  event: Event,
  metrics: Metrics,
  metric: Metric,
  tabs: Tabs,
  tab: Tab,
}
