import { expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

/**
 * Guards vitest.config.mts itself. Every other test file in this project would
 * still pass if the config silently stopped being applied — none of them touch
 * the DOM. These two do, and between them they exercise all four things the
 * config supplies: jsdom, the React transform, the jest-dom matchers loaded by
 * setupFiles, and globals:true (which is what arms RTL's automatic cleanup).
 *
 * If either of these fails, suspect the config file before suspecting the test.
 */
it('renders JSX into jsdom and matches with jest-dom', () => {
  render(<p data-testid="harness">Hello harness</p>)
  expect(screen.getByTestId('harness')).toBeInTheDocument()
})

it('cleans up the DOM between tests', () => {
  // Empty only because RTL registered an afterEach hook, which it does only when
  // a global afterEach exists — i.e. only when globals:true is in effect.
  expect(document.body.innerHTML).toBe('')
})
