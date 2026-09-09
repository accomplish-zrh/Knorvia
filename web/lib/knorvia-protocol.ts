/** Knorvia Protocol v1 client types and framing. Desktop/Web talk only this. */

export const PROTOCOL_MAJOR = 1
export const PROTOCOL_MINOR = 0

export type ProtocolVersion = { major: number; minor: number }

export type InitializeParams = {
  protocol: ProtocolVersion
  client: { name: string; version: string; platform?: string }
  capabilities?: string[]
  locale?: string
}

export function encodeFrame(body: string): Uint8Array {
  const payload = new TextEncoder().encode(body)
  const header = new TextEncoder().encode(`Content-Length: ${payload.length}\r\n\r\n`)
  const out = new Uint8Array(header.length + payload.length)
  out.set(header, 0)
  out.set(payload, header.length)
  return out
}

export function initializeParams(clientName: string, version: string): InitializeParams {
  return {
    protocol: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
    client: { name: clientName, version, platform: 'web' },
    capabilities: ['thread', 'artifact', 'job', 'approval', 'reconnect', 'workspace', 'model', 'skills'],
  }
}
