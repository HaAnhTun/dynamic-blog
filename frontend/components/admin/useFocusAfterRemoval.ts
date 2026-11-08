import { useEffect, useRef } from 'react'

/** Target "the list is now empty": the empty notice line receives focus. */
const EMPTY = Symbol('empty')

/**
 * Focus after removing a row of a sorted list (the featured posts, the series parts). The remove button
 * holding focus leaves the page with its row; with nothing to catch it focus falls back to <body> and the keyboard
 * user has to Tab again from the top of the page. GalleryManager moves focus to the list heading; here
 * the two lists have no heading of their own, so focus goes to the remove button of the row that took its place (the next row),
 * the previous row if the last row was just removed, or the "nothing yet" line when the list is now empty.
 *
 * Usage: `containerRef` on the element wrapping the list; each remove button carries `data-remove-for={id}`;
 * the empty-list line carries `data-empty-list` and `tabIndex={-1}`. Looked up by attribute in an
 * effect, not through a per-button ref callback: calling a hook function during render to get a ref is something
 * the React Compiler lint (react-hooks/refs) blocks.
 *
 * Focus is set AFTER React draws the new list (an effect on `items`): when `removing` is called the target button may
 * still be locked (`disabled` while the action runs), and focus() on a locked button is a no-op.
 */
export function useFocusAfterRemoval<T extends { id: string }>(items: T[]) {
  const containerRef = useRef<HTMLDivElement>(null)
  const target = useRef<string | typeof EMPTY | null>(null)

  useEffect(() => {
    const next = target.current
    if (next === null) return
    target.current = null
    const root = containerRef.current
    if (root === null) return
    const element =
      next === EMPTY
        ? root.querySelector<HTMLElement>('[data-empty-list]')
        : Array.from(root.querySelectorAll<HTMLElement>('[data-remove-for]')).find((node) => node.dataset.removeFor === next)
    element?.focus()
  }, [items])

  return {
    containerRef,
    /** Called (in a handler) right before removing row `id` from `before`, the list currently shown. */
    removing(before: T[], id: string) {
      const index = before.findIndex((item) => item.id === id)
      const rest = before.filter((item) => item.id !== id)
      target.current = rest.length === 0 ? EMPTY : rest[Math.min(Math.max(index, 0), rest.length - 1)].id
    },
  }
}
