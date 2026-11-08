import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { canWriteDrafts, clearLocalDrafts, draftKey } from '@/lib/draft-storage'
import { DraftOwner, useDraftOwner } from './DraftOwner'

const OWNER = '11111111-1111-1111-1111-111111111111'
const OTHER = '22222222-2222-2222-2222-222222222222'

function Probe() {
  return <p data-testid="owner">{useDraftOwner() ?? 'none'}</p>
}

afterEach(() => {
  clearLocalDrafts()
  localStorage.clear()
})

describe('DraftOwner', () => {
  it('hands the account to the editors below it', () => {
    render(
      <DraftOwner owner={OWNER}>
        <Probe />
      </DraftOwner>,
    )

    expect(screen.getByTestId('owner')).toHaveTextContent(OWNER)
  })

  it('without a provider, or with no usable account, there is no owner', () => {
    const { unmount } = render(<Probe />)
    expect(screen.getByTestId('owner')).toHaveTextContent('none')
    unmount()

    render(
      <DraftOwner owner={null}>
        <Probe />
      </DraftOwner>,
    )
    expect(screen.getByTestId('owner')).toHaveTextContent('none')
    expect(canWriteDrafts(OWNER)).toBe(false)
  })

  it('binds the account while the shell is open, deletes what other accounts left, and lets go on unmount', () => {
    localStorage.setItem(draftKey(OTHER, 'p1'), '{}')
    localStorage.setItem('bai-viet:nhap:p1', '{}')

    const { unmount } = render(
      <DraftOwner owner={OWNER}>
        <Probe />
      </DraftOwner>,
    )

    expect(canWriteDrafts(OWNER)).toBe(true)
    expect(localStorage.getItem(draftKey(OTHER, 'p1'))).toBeNull()
    expect(localStorage.getItem('bai-viet:nhap:p1')).toBeNull()

    unmount()
    expect(canWriteDrafts(OWNER)).toBe(false)
  })

  it('a new sign-in is a new mount: the account is bound again after a sign-out', () => {
    const first = render(<DraftOwner owner={OWNER}>{null}</DraftOwner>)
    clearLocalDrafts()
    expect(canWriteDrafts(OWNER)).toBe(false)
    first.unmount()

    render(<DraftOwner owner={OWNER}>{null}</DraftOwner>)

    expect(canWriteDrafts(OWNER)).toBe(true)
  })
})
