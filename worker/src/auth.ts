/**
 * Per-channel WebSocket auth.
 *
 * Two stateless token forms, both HMAC-derived from TOKEN_SECRET (no token
 * storage — rotate TOKEN_SECRET to revoke everything):
 *
 *   static:    base64url(HMAC(TOKEN_SECRET, "ws:" + channel))
 *              long-lived, for operators holding TOKEN_SECRET
 *   expiring:  "<exp>." + base64url(HMAC(TOKEN_SECRET, "ws:" + channel + ":" + exp))
 *              short-lived, issued by POST /auth/<channel> after a GitHub
 *              token proves repo/org access (see github-access.ts)
 *
 * Claude Code's Monitor ws source cannot send custom headers, so the token
 * rides in either:
 *   - the query string:            wss://…/ws/<channel>?token=<token>
 *   - a WebSocket subprotocol:     protocols: ["github-relay.v1", "<token>"]
 *     (the worker echoes "github-relay.v1" back so handshakes succeed)
 */

import { hmacSha256, timingSafeEqualStr } from './signature.ts'

export const RELAY_SUBPROTOCOL = 'github-relay.v1'

export function toBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const b of bytes) {
    binary += String.fromCharCode(b)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function deriveChannelToken(
  tokenSecret: string,
  channel: string,
): Promise<string> {
  return toBase64Url(await hmacSha256(tokenSecret, `ws:${channel}`))
}

export interface PresentedAuth {
  token: string | null
  /** True when the token came from the Sec-WebSocket-Protocol header. */
  viaSubprotocol: boolean
}

/**
 * Extract the presented token from a WS upgrade request. Query `?token=`
 * wins; otherwise any Sec-WebSocket-Protocol entry that isn't the named
 * relay subprotocol is treated as the token.
 */
export function extractPresentedAuth(url: URL, protocolHeader: string | null): PresentedAuth {
  const queryToken = url.searchParams.get('token')
  if (queryToken) {
    return { token: queryToken, viaSubprotocol: false }
  }

  if (protocolHeader) {
    const entries = protocolHeader.split(',').map(p => p.trim()).filter(Boolean)
    const token = entries.find(p => p !== RELAY_SUBPROTOCOL)
    if (token) {
      return { token, viaSubprotocol: true }
    }
  }
  return { token: null, viaSubprotocol: false }
}

/** Expiring token: "<exp-epoch-seconds>.<sig>" — self-describing, stateless. */
export async function deriveExpiringToken(
  tokenSecret: string,
  channel: string,
  expiresAtEpochSeconds: number,
): Promise<string> {
  const exp = Math.floor(expiresAtEpochSeconds)
  const sig = toBase64Url(await hmacSha256(tokenSecret, `ws:${channel}:${exp}`))
  return `${exp}.${sig}`
}

export async function isAuthorized(
  tokenSecret: string,
  channel: string,
  presented: string | null,
  nowEpochSeconds: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!presented) {
    return false
  }

  const dot = presented.indexOf('.')
  if (dot > 0) {
    const exp = Number(presented.slice(0, dot))
    if (!Number.isInteger(exp) || exp <= nowEpochSeconds) {
      return false
    }
    const expected = await deriveExpiringToken(tokenSecret, channel, exp)
    return timingSafeEqualStr(expected, presented)
  }

  const expected = await deriveChannelToken(tokenSecret, channel)
  return timingSafeEqualStr(expected, presented)
}
