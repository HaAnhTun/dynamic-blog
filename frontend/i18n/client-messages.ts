import type { AbstractIntlMessages } from 'next-intl'

/**
 * The messages a layout hands to the client provider. Without this the provider inherits the whole catalog and every page ships
 * the text of screens it never shows (the admin copy is more than half of it). Server components read the full catalog on their own.
 */
export function pickMessages(messages: AbstractIntlMessages, namespaces: readonly string[]): AbstractIntlMessages {
  return Object.fromEntries(namespaces.flatMap((namespace) => (namespace in messages ? [[namespace, messages[namespace]]] : [])))
}

/** Public pages: the site, the shared errors and the language names. */
export const PUBLIC_CLIENT_NAMESPACES = ['Site', 'Errors', 'Language'] as const

/** Admin pages: the admin, the shared errors, and the site namespace the post preview renders (code blocks, article parts). */
export const ADMIN_CLIENT_NAMESPACES = ['Admin', 'Errors', 'Language', 'Site'] as const

/** The 404 page renders the public chrome. */
export const NOT_FOUND_CLIENT_NAMESPACES = PUBLIC_CLIENT_NAMESPACES
