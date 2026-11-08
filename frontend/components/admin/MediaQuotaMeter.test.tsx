import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MediaQuotaMeter, formatBytes, quotaLevel } from './MediaQuotaMeter'
import { msg } from '@/test/render-intl'

const GB = 1024 ** 3
const MB = 1024 ** 2

describe('formatBytes', () => {
  // The backend quota is a Spring DataSize (1GB = 1024³ bytes): the same binary unit, so a configured "1 GB"
  // shows as exactly "1 GB" on screen and not "1,1 GB".
  it.each([
    [0, '0 B'],
    [900, '900 B'],
    [1024, '1 KB'],
    [1536, '1,5 KB'],
    [7_000_000, '6,7 MB'],
    [400 * MB, '400 MB'],
    [GB, '1 GB'],
    [2.25 * GB, '2,3 GB'],
  ])('%i byte → %s', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text)
  })
})

describe('quotaLevel', () => {
  it.each([
    [0, 'ok'],
    [0.799, 'ok'],
    [0.8, 'warn'],
    [0.949, 'warn'],
    [0.95, 'danger'],
    [1.2, 'danger'],
  ])('%f → %s', (ratio, level) => {
    expect(quotaLevel(ratio)).toBe(level)
  })
})

describe('MediaQuotaMeter', () => {
  it('the meter has a name, a percentage value and a readable sentence; image count and the source of the figure', () => {
    render(<MediaQuotaMeter usage={{ usedBytes: 512 * MB, maxBytes: GB, count: 8 }} />)

    const meter = screen.getByRole('meter', { name: msg('Admin.common.quota.title') })
    expect(meter).toHaveAttribute('aria-valuemin', '0')
    expect(meter).toHaveAttribute('aria-valuemax', '100')
    expect(meter).toHaveAttribute('aria-valuenow', '50')
    expect(meter).toHaveAttribute(
      'aria-valuetext',
      msg('Admin.common.quota.valueText', { used: '512 MB', max: '1 GB', percent: '50%' }),
    )
    // The visible text says the same thing: color and bar length are never the only information.
    expect(
      screen.getByText(msg('Admin.common.quota.usage', { used: '512 MB', max: '1 GB', percent: '50%', count: 8 })),
    ).toBeInTheDocument()
    expect(screen.getByRole('region', { name: msg('Admin.common.quota.title') })).toHaveTextContent(
      msg('Admin.common.quota.scope'),
    )
    expect(screen.queryByText(msg('Admin.common.quota.warn'))).toBeNull()
    expect(screen.queryByText(msg('Admin.common.quota.danger'))).toBeNull()
  })

  it('from 80%: amber color and a reminder sentence; from 95%: red and a stronger sentence', () => {
    const { rerender } = render(<MediaQuotaMeter usage={{ usedBytes: 0.8 * GB, maxBytes: GB, count: 40 }} />)
    expect(screen.getByText(msg('Admin.common.quota.warn'))).toBeInTheDocument()
    expect(screen.getByTestId('quota-bar')).toHaveClass('bg-amber-500')

    rerender(<MediaQuotaMeter usage={{ usedBytes: 0.96 * GB, maxBytes: GB, count: 50 }} />)
    expect(screen.getByText(msg('Admin.common.quota.danger'))).toBeInTheDocument()
    expect(screen.getByTestId('quota-bar')).toHaveClass('bg-red-600')
  })

  it('the percentage rounds DOWN, the same side as the color threshold: 79,9% does not show "80%" on a bar that has not changed color', () => {
    render(<MediaQuotaMeter usage={{ usedBytes: 0.799 * GB, maxBytes: GB, count: 1 }} />)

    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '79')
    expect(screen.getByTestId('quota-bar')).not.toHaveClass('bg-amber-500')
  })

  it('a little used but under 1%: "under 1%", not "0%"', () => {
    render(<MediaQuotaMeter usage={{ usedBytes: 7_000_000, maxBytes: GB, count: 8 }} />)

    expect(
      screen.getByText(
        msg('Admin.common.quota.usage', {
          used: '6,7 MB',
          max: '1 GB',
          percent: msg('Admin.common.quota.underOnePercent'),
          count: 8,
        }),
      ),
    ).toBeInTheDocument()
  })

  it('over the quota (quota was just lowered): the bar is full, not overflowing; the real figure is still stated', () => {
    render(<MediaQuotaMeter usage={{ usedBytes: 1.5 * GB, maxBytes: GB, count: 99 }} />)

    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '100')
    expect(screen.getByTestId('quota-bar')).toHaveStyle({ width: '100%' })
    expect(
      screen.getByText(msg('Admin.common.quota.usage', { used: '1,5 GB', max: '1 GB', percent: '150%', count: 99 })),
    ).toBeInTheDocument()
  })

  it('invalid quota (0, negative): draws nothing instead of dividing by 0', () => {
    const { container } = render(<MediaQuotaMeter usage={{ usedBytes: 10, maxBytes: 0, count: 1 }} />)

    expect(container).toBeEmptyDOMElement()
  })
})
