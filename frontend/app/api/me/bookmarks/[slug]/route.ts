import type { NextRequest } from 'next/server'
import { forwardPrivateRead, forwardWrite, postApiPath } from '@/lib/bff-route'

/**
 * /api/me/bookmarks/<slug>: GET the caller's own bookmark state, PUT bookmark, DELETE remove the bookmark. All three need
 * a session; PUT/DELETE go through the same-origin gate and drop the body (the bookmarker is always the session owner). Every response is `private, no-store`.
 */

type Context = RouteContext<'/api/me/bookmarks/[slug]'>

async function bookmarkPath(ctx: Context): Promise<string | null> {
  const { slug } = await ctx.params
  // Same slug guard as postApiPath: empty, over 255 characters, "/", "." and "..", lone surrogates.
  return postApiPath(slug) === null ? null : `/api/v1/me/bookmarks/${encodeURIComponent(slug)}`
}

export async function GET(request: NextRequest, ctx: Context): Promise<Response> {
  return forwardPrivateRead(request, await bookmarkPath(ctx))
}

export async function PUT(request: NextRequest, ctx: Context): Promise<Response> {
  return forwardWrite(request, await bookmarkPath(ctx), 'PUT', { forwardBody: false })
}

export async function DELETE(request: NextRequest, ctx: Context): Promise<Response> {
  return forwardWrite(request, await bookmarkPath(ctx), 'DELETE', { forwardBody: false })
}
