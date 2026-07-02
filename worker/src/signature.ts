/**
 * GitHub webhook signature verification (X-Hub-Signature-256).
 * HMAC-SHA256 over the raw request body, hex-encoded, prefixed "sha256=".
 */

const encoder = new TextEncoder()

async function hmacSha256(secret: string, data: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return crypto.subtle.sign('HMAC', key, encoder.encode(data))
}

export function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Constant-time string comparison (length leak is acceptable — lengths are public). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false
  }
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/** Compute the expected X-Hub-Signature-256 header value for a body. */
export async function signBody(secret: string, body: string): Promise<string> {
  return `sha256=${toHex(await hmacSha256(secret, body))}`
}

/** Verify an incoming webhook body against its X-Hub-Signature-256 header. */
export async function verifyGitHubSignature(
  secret: string,
  body: string,
  signatureHeader: string | null,
): Promise<boolean> {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false
  }
  const expected = await signBody(secret, body)
  return timingSafeEqualStr(expected, signatureHeader)
}

export { hmacSha256 }
