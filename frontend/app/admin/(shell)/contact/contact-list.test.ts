import { describe, expect, it } from 'vitest'
import { CONTACT_PAGE_SIZE, contactListHref, parsePage } from './contact-list'

describe('contact inbox URL', () => {
  it('the first page is the bare path, later pages carry ?page=', () => {
    expect(contactListHref()).toBe('/admin/contact')
    expect(contactListHref(0)).toBe('/admin/contact')
    expect(contactListHref(2)).toBe('/admin/contact?page=2')
  })

  it('reads ?page= safely: digits only, anything else is the first page', () => {
    expect(parsePage('3')).toBe(3)
    expect(parsePage(['4', '5'])).toBe(4)
    expect(parsePage(undefined)).toBe(0)
    for (const hostile of ['-1', '1e9', 'abc', '', '99999999999999999999']) expect(parsePage(hostile)).toBe(0)
  })

  it('asks for 20 messages at a time, the backend default', () => {
    expect(CONTACT_PAGE_SIZE).toBe(20)
  })
})
