import { describe, expect, test } from 'bun:test'
import { deriveChannelToken, deriveExpiringToken, extractPresentedAuth, isAuthorized, RELAY_SUBPROTOCOL } from '../src/auth.ts'

const SECRET = 'master-secret'

describe('deriveChannelToken', () => {
  test('is deterministic per channel and url-safe', async () => {
    const a = await deriveChannelToken(SECRET, 'owner--repo')
    const b = await deriveChannelToken(SECRET, 'owner--repo')
    expect(a).toBe(b)
    expect(a).toMatch(/^[\w-]+$/)
  })

  test('differs across channels and secrets', async () => {
    const a = await deriveChannelToken(SECRET, 'chan-a')
    const b = await deriveChannelToken(SECRET, 'chan-b')
    const c = await deriveChannelToken('other', 'chan-a')
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
  })
})

describe('extractPresentedAuth', () => {
  test('prefers the query token', () => {
    const url = new URL('wss://relay.test/ws/chan?token=q-token')
    const auth = extractPresentedAuth(url, `${RELAY_SUBPROTOCOL}, p-token`)
    expect(auth).toEqual({ token: 'q-token', viaSubprotocol: false })
  })

  test('falls back to a subprotocol entry that is not the relay protocol', () => {
    const url = new URL('wss://relay.test/ws/chan')
    const auth = extractPresentedAuth(url, `${RELAY_SUBPROTOCOL}, p-token`)
    expect(auth).toEqual({ token: 'p-token', viaSubprotocol: true })
  })

  test('returns null when only the relay protocol is offered', () => {
    const url = new URL('wss://relay.test/ws/chan')
    expect(extractPresentedAuth(url, RELAY_SUBPROTOCOL).token).toBeNull()
    expect(extractPresentedAuth(url, null).token).toBeNull()
  })
})

describe('isAuthorized', () => {
  test('accepts the derived token and rejects others', async () => {
    const token = await deriveChannelToken(SECRET, 'chan')
    expect(await isAuthorized(SECRET, 'chan', token)).toBe(true)
    expect(await isAuthorized(SECRET, 'chan', `${token}x`)).toBe(false)
    expect(await isAuthorized(SECRET, 'other-chan', token)).toBe(false)
    expect(await isAuthorized(SECRET, 'chan', null)).toBe(false)
  })

  test('accepts a valid expiring token until it expires', async () => {
    const now = 1_800_000_000
    const token = await deriveExpiringToken(SECRET, 'chan', now + 3600)
    expect(token).toMatch(/^\d+\.[\w-]+$/)
    expect(await isAuthorized(SECRET, 'chan', token, now)).toBe(true)
    expect(await isAuthorized(SECRET, 'chan', token, now + 3600)).toBe(false)
    expect(await isAuthorized(SECRET, 'other-chan', token, now)).toBe(false)
  })

  test('rejects tampered expiring tokens', async () => {
    const now = 1_800_000_000
    const token = await deriveExpiringToken(SECRET, 'chan', now + 60)
    const [, sig] = token.split('.')
    // Extending the expiry without re-signing must fail.
    expect(await isAuthorized(SECRET, 'chan', `${now + 999_999}.${sig}`, now)).toBe(false)
    expect(await isAuthorized(SECRET, 'chan', `${now + 60}.AAAA`, now)).toBe(false)
    expect(await isAuthorized(SECRET, 'chan', `abc.${sig}`, now)).toBe(false)
  })
})
