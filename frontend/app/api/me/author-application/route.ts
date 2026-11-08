import type { NextRequest } from 'next/server'
import { forwardPrivateRead, forwardWrite } from '@/lib/bff-route'

/**
 * /api/me/author-application: the logged-in user's application to become an author, for /profile.
 *
 * - GET (auth required): the caller's own latest application, whether they can submit, and when they may resubmit. No parameter
 *   is forwarded: the backend only reads the application of the Bearer owner, so there is no id to turn into someone else's application.
 * - POST (auth required, same origin, JSON, body up to 16 KB): submit an application. The `{ motivation }` body goes verbatim to the
 *   backend, which trims whitespace, checks the length (500 characters) and every submission rule; the applicant is always the session owner.
 *
 * Every response is `private, no-store`; the backend status and error envelope pass through intact.
 */

const API_PATH = '/api/v1/me/author-application'

export async function GET(request: NextRequest): Promise<Response> {
  return forwardPrivateRead(request, API_PATH)
}

export async function POST(request: NextRequest): Promise<Response> {
  return forwardWrite(request, API_PATH, 'POST', { forwardBody: true })
}
