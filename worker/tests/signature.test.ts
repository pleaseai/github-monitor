import { describe, expect, test } from 'bun:test'
import { signBody, timingSafeEqualStr, verifyGitHubSignature } from '../src/signature.ts'

describe('signBody', () => {
  test('matches a known HMAC-SHA256 vector', async () => {
    // Vector from GitHub's securing-your-webhooks docs
    const signature = await signBody('It\'s a Secret to Everybody', 'Hello, World!')
    expect(signature).toBe('sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17')
  })
})

describe('verifyGitHubSignature', () => {
  const secret = 'test-secret'
  const body = '{"action":"opened"}'

  test('accepts a correctly signed body', async () => {
    const header = await signBody(secret, body)
    expect(await verifyGitHubSignature(secret, body, header)).toBe(true)
  })

  test('rejects a tampered body', async () => {
    const header = await signBody(secret, body)
    expect(await verifyGitHubSignature(secret, '{"action":"closed"}', header)).toBe(false)
  })

  test('rejects a wrong secret', async () => {
    const header = await signBody('other-secret', body)
    expect(await verifyGitHubSignature(secret, body, header)).toBe(false)
  })

  test('rejects missing or malformed headers', async () => {
    expect(await verifyGitHubSignature(secret, body, null)).toBe(false)
    expect(await verifyGitHubSignature(secret, body, '')).toBe(false)
    expect(await verifyGitHubSignature(secret, body, 'sha1=abc')).toBe(false)
  })
})

describe('timingSafeEqualStr', () => {
  test('equal strings', () => {
    expect(timingSafeEqualStr('abc', 'abc')).toBe(true)
  })
  test('different strings and lengths', () => {
    expect(timingSafeEqualStr('abc', 'abd')).toBe(false)
    expect(timingSafeEqualStr('abc', 'abcd')).toBe(false)
    expect(timingSafeEqualStr('', 'a')).toBe(false)
  })
})
