/**
 * How far a reader is through the post body, from 0 (the top of the body is at or below the top of the viewport) to 1
 * (the bottom of the body is at the bottom of the viewport). Pure: the caller passes the body's bounding rect and the
 * viewport height, so the formula is testable without a DOM.
 *
 * The scrollable distance is the body height minus one viewport (the last screen of the body cannot scroll further than
 * its own bottom), never less than 1 so a body shorter than the viewport divides by a positive number instead of 0.
 * Non-finite input (NaN, Infinity from a detached element) counts as "not started".
 */
export function readingProgress(rect: { top: number; height: number }, viewportHeight: number): number {
  const scrollable = Math.max(rect.height - viewportHeight, 1)
  const ratio = -rect.top / scrollable
  if (!Number.isFinite(ratio)) return 0
  return Math.min(1, Math.max(0, ratio))
}
