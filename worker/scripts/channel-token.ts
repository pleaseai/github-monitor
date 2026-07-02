#!/usr/bin/env bun
/**
 * Derive the WebSocket token for a channel locally (no server round-trip).
 *
 * Usage:
 *   TOKEN_SECRET=… bun run scripts/channel-token.ts <channel>
 *   bun run scripts/channel-token.ts <channel> --secret <secret>
 *
 * Prints the wss URL to use with Claude Code's Monitor ws source when
 * RELAY_BASE_URL is set (e.g. https://github-relay.<acct>.workers.dev).
 */

import process from 'node:process'
import { deriveChannelToken } from '../src/auth.ts'

function fail(message: string): never {
  console.error(`channel-token: ${message}`)
  process.exit(1)
}

const args = process.argv.slice(2)
const secretFlag = args.indexOf('--secret')
let secret = process.env.TOKEN_SECRET ?? ''
if (secretFlag !== -1) {
  secret = args[secretFlag + 1] ?? ''
  args.splice(secretFlag, 2)
}
const channel = args[0]

if (!channel) {
  fail('usage: channel-token.ts <channel> [--secret <secret>]')
}
if (!secret) {
  fail('missing secret — set TOKEN_SECRET or pass --secret')
}

const token = await deriveChannelToken(secret, channel)
console.log(token)

const base = process.env.RELAY_BASE_URL
if (base) {
  const wsBase = base.replace(/^http/, 'ws').replace(/\/$/, '')
  console.error(`ws url: ${wsBase}/ws/${encodeURIComponent(channel)}?token=${token}`)
}
