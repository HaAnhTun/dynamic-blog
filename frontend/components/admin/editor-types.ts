import type { MediaRef, PostRevision } from '@/lib/types'

/*
 * Results of the actions the post editor calls (app/admin/(shell)/posts/actions.ts, editor-actions.ts). A plain
 * module with only types: both 'use server' files and client components can import it without pulling anything in.
 */

/** Like PostActionError in posts/actions.ts: with `sessionExpired` it comes with a login link in a new tab. */
export type ActionError = { error: string; sessionExpired?: boolean }

/** Uploading an image for the post body: the image just saved, so the editor can insert `/media/<fileName>`. */
export type ImageUploadOutcome = ActionError | { image: MediaRef }

/** Deleting an image of the post body: the images that remain. */
export type ImageListOutcome = ActionError | { images: MediaRef[] }

/** One version in a post's history. */
export type RevisionOutcome = ActionError | { revision: PostRevision }
