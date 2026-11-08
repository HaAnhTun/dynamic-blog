/**
 * UUID in 8-4-4-4-12 form. The backend reads it with `UUID.fromString`, case-insensitively. The one place the frontend decides what an
 * identifier is, before the value goes into a backend path or a request body.
 */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}
