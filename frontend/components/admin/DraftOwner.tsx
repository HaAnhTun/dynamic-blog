'use client'

import { createContext, useContext, useEffect, type ReactNode } from 'react'
import { bindDraftOwner } from '@/lib/draft-storage'

/**
 * Tells the editor whose local drafts it may read and write: the account the admin shell was rendered for (the id in the session token,
 * read by the layout). On mount it binds that account in the browser (`bindDraftOwner`: deletes the drafts of every other account and the
 * expired ones, listens for a sign-out in another tab) and lets go when the shell leaves. The shell mounts again after every sign-in,
 * which is what lets the writes start again after a sign-out. A null owner (a token without a usable id) means no drafts at all.
 */
const DraftOwnerContext = createContext<string | null>(null)

export function DraftOwner({ owner, children }: { owner: string | null; children: ReactNode }) {
  useEffect(() => (owner === null ? undefined : bindDraftOwner(owner)), [owner])
  return <DraftOwnerContext.Provider value={owner}>{children}</DraftOwnerContext.Provider>
}

/** The account the editor's drafts belong to, or null. */
export function useDraftOwner(): string | null {
  return useContext(DraftOwnerContext)
}
