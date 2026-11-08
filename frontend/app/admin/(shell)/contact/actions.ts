'use server'

import { revalidatePath } from 'next/cache'
import { runAdminAction } from '@/lib/admin-action'
import { deleteContactMessage, markContactMessageRead } from '@/lib/admin-api'
import { ApiError } from '@/lib/api'

/*
 * The two actions of the Contact inbox: mark a message as read, delete it. The backend is where permission is checked (ADMIN
 * only); an AUTHOR calling these gets its 403 sentence. A message holds a visitor's personal data, so nothing here logs
 * the id's owner, the name or the text.
 *
 * Both revalidate the page: the unread count in the page header and the page size change with every action, and the list
 * is the only place that reads them.
 */

const INBOX = '/admin/contact'

/**
 * Both operations are idempotent for the person pressing the button: a message that is already gone (deleted in another tab) is
 * what a delete wanted, and there is nothing left to mark as read. Only the exact "no such message" answer counts: a
 * 404 from anywhere else (a wrong route after a deploy) stays an error.
 */
async function goneIsFine(call: () => Promise<null>): Promise<null> {
  try {
    return await call()
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && error.code === 'CONTACT_MESSAGE_NOT_FOUND') return null
    throw error
  }
}

/** null means done. */
export async function markContactRead(id: string): Promise<{ error: string } | null> {
  const outcome = await runAdminAction(() => goneIsFine(() => markContactMessageRead(id)))
  if (outcome === null) revalidatePath(INBOX)
  return outcome
}

/** null means deleted. */
export async function removeContactMessage(id: string): Promise<{ error: string } | null> {
  const outcome = await runAdminAction(() => goneIsFine(() => deleteContactMessage(id)))
  if (outcome === null) revalidatePath(INBOX)
  return outcome
}
