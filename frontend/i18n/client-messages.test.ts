import { describe, expect, it } from 'vitest'
import en from '@/messages/en.json'
import { ADMIN_CLIENT_NAMESPACES, PUBLIC_CLIENT_NAMESPACES, pickMessages } from './client-messages'

describe('pickMessages', () => {
  it('keeps only the named namespaces that exist', () => {
    expect(Object.keys(pickMessages({ Site: { a: 'x' }, Admin: { b: 'y' } }, ['Site', 'Missing']))).toEqual(['Site'])
  })

  it('public pages do not receive the admin copy, admin pages do', () => {
    expect(Object.keys(pickMessages(en, PUBLIC_CLIENT_NAMESPACES))).not.toContain('Admin')
    expect(Object.keys(pickMessages(en, ADMIN_CLIENT_NAMESPACES))).toContain('Admin')
  })
})
