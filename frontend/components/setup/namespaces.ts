/** The only catalog namespaces the first-run setup page sends to the browser. */
export const SETUP_CLIENT_NAMESPACES = ['Setup', 'Errors', 'Language'] as const

/** Where SetupForm posts: a route handler next to the page, because one segment cannot serve both (see app/admin/login/page.tsx). */
export const SETUP_ENDPOINT = '/setup/submit'
