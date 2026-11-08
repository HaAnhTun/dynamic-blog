'use client'

import { useEffect } from 'react'
import { watchScrollCue } from './blocks/use-scroll-cue'

/**
 * The scroll cue of the code blocks of an article. A code line longer than the block is cut at its edge, and a phone shows no scrollbar,
 * so the cut reads as the end of the line; while there is more code to the right, app/globals.css fades the right edge of the block below
 * `sm` (`pre[data-more="true"]`). The blocks are drawn on the server by the Markdown pipeline, so this island, rendered once inside the
 * body (`ArticleBody`), finds every `pre` of the body after hydration and watches it. It draws nothing itself.
 */
export function CodeScrollCue() {
  useEffect(() => {
    const stops = Array.from(document.querySelectorAll<HTMLElement>('[data-post-body] pre')).map(watchScrollCue)
    return () => {
      for (const stop of stops) stop()
    }
  }, [])
  return null
}
