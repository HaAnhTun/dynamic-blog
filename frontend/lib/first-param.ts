/** `?x=a&x=b` arrives as an array: the first value, like the reader's /login page. */
export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}
