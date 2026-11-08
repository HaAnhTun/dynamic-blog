import type { ReactNode } from 'react'
import { afterEach, beforeEach, vi } from 'vitest'
import { BLOCK_COMPONENTS } from '@/components/site/blocks'
import { BLOCK_TYPES } from '@/lib/blocks/registry'

type DoubleProps = { children?: ReactNode; source?: string }

/**
 * For tests of the Markdown pipeline (`lib/markdown`, the admin preview): replaces every block component with a plain double for the
 * length of each test, so what the test checks is which block the pipeline built and with what content, not how a component draws it.
 * A component changing its markup, or being replaced by a real design, cannot break such a test. The double marks its root with
 * `data-block`, shows the children, and shows the raw source of a diagram in a `pre`.
 */
export function useBlockDoubles() {
  beforeEach(() => {
    for (const type of BLOCK_TYPES) {
      vi.spyOn(BLOCK_COMPONENTS, type).mockImplementation(((props: DoubleProps) => (
        <div data-block={type}>{props.source === undefined ? props.children : <pre>{props.source}</pre>}</div>
      )) as never)
    }
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })
}
