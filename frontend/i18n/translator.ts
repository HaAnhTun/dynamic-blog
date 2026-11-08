/**
 * What a helper module receives when it must produce user-facing text but is not a component: the function returned by
 * `useTranslations(ns)` (client and sync server code) or `await getTranslations(ns)` (async server code) is assignable to it.
 * Helpers never import next-intl themselves; the caller picks the namespace.
 */
export type Translator = (key: string, values?: Record<string, string | number | Date>) => string
