import { act, render, screen } from '@testing-library/react'
import { IntlWrapper } from '@/test/intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodeBlock } from './CodeBlock'
import { COPY_FEEDBACK_MS, CopyCodeButton } from './CopyCodeButton'
import { msg } from '@/test/render-intl'
import { VIETNAMESE_WORD } from '@/test/fixtures/vi/copy-code-button'

/* ------------------------------------------------------------------ *
 * Harness — the same way as CopyLink.test.tsx
 * ------------------------------------------------------------------ */

/**
 * jsdom has no Clipboard API: `navigator.clipboard` is undefined, exactly the state of an insecure
 * origin (http over a LAN IP). The stub must be installed through `defineProperty`: `navigator.clipboard` is a
 * getter, assigning to it directly throws in strict mode.
 */
function installClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(writeText) },
    configurable: true,
    writable: true,
  })
  return navigator.clipboard.writeText as unknown as ReturnType<typeof vi.fn>
}

function removeClipboard() {
  Reflect.deleteProperty(navigator, 'clipboard')
}

const NAME = msg('Site.code.copy')
const COPIED = msg('Site.code.copied')
const FAILED = msg('Site.code.copyFailed')

const button = () => screen.getByRole('button', { name: NAME })
const status = () => screen.getByRole('status')

/** A code block as lib/markdown.tsx builds it: Shiki's `<pre>` inside CodeBlock. */
function renderBlock(code: string) {
  return render(
    <CodeBlock className="shiki" tabIndex={0}>
      <code>{code}</code>
    </CodeBlock>,
  )
}

async function click() {
  // `await act(async …)`: the handler is async, the state changes in a microtask after the press.
  await act(async () => {
    button().click()
  })
}

afterEach(() => {
  removeClipboard()
  vi.useRealTimers()
})

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

describe('CopyCodeButton: what it copies', () => {
  it('copies every byte of the <pre> text: indentation, tabs, newlines, NFD, text that looks like HTML', async () => {
    const writeText = installClipboard(async () => {})
    const code = ['if (x) {', `\treturn "${VIETNAMESE_WORD}"`.normalize('NFD'), '    <script>alert(1)</script>   ', '}'].join(
      '\n',
    )
    renderBlock(code)

    await click()

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith(code)
    // NFD stays NFD: a code sample is the one place where every byte may be what the author means.
    expect(String(writeText.mock.calls[0]![0])).toContain(VIETNAMESE_WORD.normalize('NFD'))
  })

  it('reads the text at press time, from the <pre> of the same block — receives no code through props', async () => {
    // This is why the code is not in the RSC payload: the button has no props, it reads the DOM at press time.
    const writeText = installClipboard(async () => {})
    const { container } = renderBlock('first version')
    container.querySelector('pre code')!.textContent = 'second version'

    await click()

    expect(writeText).toHaveBeenCalledWith('second version')
  })

  it('each button copies its own block when the page has several blocks', async () => {
    const writeText = installClipboard(async () => {})
    render(
      <>
        <CodeBlock>
          <code>block one</code>
        </CodeBlock>
        <CodeBlock>
          <code>block two</code>
        </CodeBlock>
      </>,
    )

    await act(async () => {
      screen.getAllByRole('button', { name: NAME })[1]!.click()
    })

    expect(writeText).toHaveBeenCalledWith('block two')
  })

  it('does not copy the text of the button itself or of the notice region', async () => {
    const writeText = installClipboard(async () => {})
    renderBlock('echo 1')

    await click()
    await click()

    expect(writeText).toHaveBeenLastCalledWith('echo 1')
  })
})

describe('CopyCodeButton: reporting the result', () => {
  it('the status region exists and is empty before the press, for screen readers only; after copying it announces "Code copied."', async () => {
    installClipboard(async () => {})
    renderBlock('ls -la')

    // Empty and PRESENT: a live region inserted when it already has text is read immediately at page load.
    expect(status()).toBeInTheDocument()
    expect(status()).toHaveTextContent(/^$/)
    expect(status()).toHaveAttribute('aria-live', 'polite')
    expect(status()).toHaveClass('sr-only')

    await click()

    expect(status()).toHaveTextContent(new RegExp(`^${COPIED.replace('.', '\\.')}$`))
    expect(button()).toHaveAttribute('data-state', 'copied')
  })

  it('one fixed accessible name across all states, the icon switches to a check mark', async () => {
    installClipboard(async () => {})
    renderBlock('ls -la')
    const iconPath = () => button().querySelector('svg path')!.getAttribute('d')
    const idleIcon = iconPath()

    expect(button()).toHaveAttribute('aria-label', NAME)
    await click()

    // A button renamed to "copied" is a different button to a screen reader; the result goes through status.
    expect(screen.getByRole('button', { name: NAME })).toBe(button())
    expect(iconPath()).not.toBe(idleIcon)
    // The check mark of CheckIcon (lucide `check`).
    expect(iconPath()).toBe('M20 6 9 17l-5-5')
    for (const svg of button().querySelectorAll('svg')) {
      expect(svg).toHaveAttribute('aria-hidden', 'true')
    }
  })

  it(`returns to the initial state after ${COPY_FEEDBACK_MS} ms: copy icon, empty status`, async () => {
    // Fake only the timers: the Promise of writeText still runs for real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    installClipboard(async () => {})
    renderBlock('ls -la')

    await click()
    act(() => vi.advanceTimersByTime(COPY_FEEDBACK_MS - 1))
    expect(button()).toHaveAttribute('data-state', 'copied')
    expect(status()).toHaveTextContent(COPIED)

    act(() => vi.advanceTimersByTime(1))
    expect(button()).toHaveAttribute('data-state', 'idle')
    expect(status()).toHaveTextContent(/^$/)
  })

  it('pressing again while "copied": counts again from the new press, does not switch off midway', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const writeText = installClipboard(async () => {})
    renderBlock('ls -la')

    await click()
    act(() => vi.advanceTimersByTime(1500))
    await click()
    act(() => vi.advanceTimersByTime(1500))

    // 3000 ms after the first press, 1500 ms after the second: still reporting copied.
    expect(writeText).toHaveBeenCalledTimes(2)
    expect(button()).toHaveAttribute('data-state', 'copied')
    act(() => vi.advanceTimersByTime(500))
    expect(button()).toHaveAttribute('data-state', 'idle')
  })

  it('a new press clears the old sentence before copying, so the "Code copied." sentence is read again', async () => {
    let finish: () => void = () => {}
    installClipboard(() => new Promise<void>((resolve) => (finish = resolve)))
    renderBlock('ls -la')
    await act(async () => {
      button().click()
      finish()
    })
    expect(status()).toHaveTextContent(COPIED)

    // The second time is still waiting for the clipboard: the old sentence is gone, no new one yet.
    await act(async () => {
      button().click()
    })
    expect(status()).toHaveTextContent(/^$/)

    await act(async () => finish())
    expect(status()).toHaveTextContent(COPIED)
  })
})

describe('CopyCodeButton: cannot copy', () => {
  it('without a Clipboard API (insecure origin): reports an error in text, not silently', async () => {
    removeClipboard()
    renderBlock('ls -la')

    await click()

    expect(status()).toHaveTextContent(FAILED)
    expect(button()).toHaveAttribute('data-state', 'failed')
    // Someone looking at the screen sees it too: a short sentence next to the button, hidden from screen readers because status already reads it.
    const hint = screen.getByText(msg('Site.code.copyFailedShort'))
    expect(hint).toHaveAttribute('aria-hidden', 'true')
    expect(hint).toHaveClass('print:hidden')
  })

  it('writeText is rejected (no permission, document without focus): reports an error, no rejection escapes', async () => {
    installClipboard(async () => {
      throw new DOMException('Write permission denied.', 'NotAllowedError')
    })
    renderBlock('ls -la')

    const unhandled: unknown[] = []
    const onUnhandled = (event: PromiseRejectionEvent) => unhandled.push(event.reason)
    window.addEventListener('unhandledrejection', onUnhandled)
    try {
      await click()
    } finally {
      window.removeEventListener('unhandledrejection', onUnhandled)
    }

    expect(status()).toHaveTextContent(FAILED)
    expect(unhandled).toEqual([])
  })

  it('writeText throws synchronously (polyfill, old WebView): still just one error sentence', async () => {
    installClipboard((() => {
      throw new TypeError('Illegal invocation')
    }) as unknown as (text: string) => Promise<void>)
    renderBlock('ls -la')

    await expect(click()).resolves.toBeUndefined()
    expect(status()).toHaveTextContent(FAILED)
  })

  it('clipboard exists but writeText is not a function: reports an error instead of throwing at press time', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: {}, configurable: true, writable: true })
    renderBlock('ls -la')

    await click()

    expect(status()).toHaveTextContent(FAILED)
  })

  it('the button sits outside a code block: reports an error, copies nothing else on the page', async () => {
    const writeText = installClipboard(async () => {})
    render(
      <div>
        <pre>not in any block</pre>
        <CopyCodeButton />
      </div>,
    )

    await click()

    expect(writeText).not.toHaveBeenCalled()
    expect(status()).toHaveTextContent(FAILED)
  })

  it('the error sentence stays past the "copied" duration; a later successful press removes it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    removeClipboard()
    renderBlock('ls -la')

    await click()
    act(() => vi.advanceTimersByTime(COPY_FEEDBACK_MS * 3))
    // It does not switch off by itself: an error sentence that disappears after two seconds is one the reader may miss.
    expect(status()).toHaveTextContent(FAILED)
    expect(screen.getByText(msg('Site.code.copyFailedShort'))).toBeInTheDocument()

    installClipboard(async () => {})
    await click()

    expect(status()).toHaveTextContent(COPIED)
    expect(screen.queryByText(msg('Site.code.copyFailedShort'))).toBeNull()
  })
})

describe('CopyCodeButton: shape and place', () => {
  it('is a <button type="button">: reachable by Tab, Enter and Space press it like any button', () => {
    renderBlock('ls -la')

    expect(button().tagName).toBe('BUTTON')
    expect(button()).toHaveAttribute('type', 'button')
    button().focus()
    expect(button()).toHaveFocus()
  })

  it('sits after the <pre> in the same block: Tab goes into the code scroll frame first, then to the button', () => {
    const { container } = renderBlock('ls -la')
    const block = container.querySelector('[data-code-block]')!

    expect(block.firstElementChild!.tagName).toBe('PRE')
    expect(block.contains(button())).toBe(true)
    expect(block.querySelector('pre')!.compareDocumentPosition(button()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // It is NOT inside the <pre>: it does not scroll with the code, and does not get into text the reader selects.
    expect(block.querySelector('pre')!.contains(button())).toBe(false)
  })

  it('40px touch area on a phone, 32px from 640px; anchored top right; the site focus ring; not printed', () => {
    renderBlock('ls -la')
    const classes = button().className.split(/\s+/)

    // globals.css reserves exactly this strip at the top of the <pre> (2.75rem / 2.25rem from 40rem): the button never covers
    // the first line of code, even when that line scrolls horizontally underneath.
    expect(classes).toEqual(
      expect.arrayContaining(['absolute', 'top-0', 'right-0', 'h-11', 'w-11', 'sm:h-8', 'sm:w-8', 'print:hidden']),
    )
    expect(classes).toEqual(
      expect.arrayContaining([
        'focus-visible:outline-2',
        'focus-visible:outline-offset-2',
        'focus-visible:outline-brand',
        'motion-reduce:transition-none',
      ]),
    )
  })

  it('server render touches neither navigator nor window, and carries no text at first', () => {
    removeClipboard()
    const html = renderToStaticMarkup(
      <IntlWrapper>
        <CodeBlock>
          <code>echo 1</code>
        </CodeBlock>
      </IntlWrapper>,
    )

    expect(html).toContain(`aria-label="${NAME}"`)
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
    // Only the code text: the status region is empty, no sentence is read at page load.
    const host = document.createElement('div')
    host.innerHTML = html
    expect(host.textContent).toBe('echo 1')
  })
})
