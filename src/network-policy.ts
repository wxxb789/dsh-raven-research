import { lookup as lookupDns } from 'node:dns/promises'
import { isIP } from 'node:net'

import { settleWithAbort } from './abort.js'

export const SOURCE_NETWORK_POLICIES = ['public-only', 'unrestricted'] as const

export type SourceNetworkPolicy = typeof SOURCE_NETWORK_POLICIES[number]

type AddressClassification = 'public' | 'blocked' | 'hostname'

interface NetworkLookupAddress {
  readonly address: string
  readonly family: number
}

type NetworkLookup = (hostname: string) => Promise<readonly NetworkLookupAddress[]>

export class SourceNetworkPolicyError extends Error {
  override readonly name = 'SourceNetworkPolicyError'
}

function normalizedHostname(value: string): string {
  const withoutBrackets = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
  return withoutBrackets.replace(/%[^%]+$/, '').toLowerCase().replace(/\.$/, '')
}

function ipv4Bytes(address: string): readonly number[] | undefined {
  const parts = address.split('.')
  if (parts.length !== 4) return undefined
  const bytes = parts.map(part => Number.parseInt(part, 10))
  return bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255) ? bytes : undefined
}

function publicIpv4(address: string): boolean {
  const bytes = ipv4Bytes(address)
  if (bytes === undefined) return false
  const [a = 0, b = 0, c = 0] = bytes
  if (a === 0 || a === 10 || a === 127) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false
  if (a === 192 && b === 168) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a === 198 && b === 51 && c === 100) return false
  if (a === 203 && b === 0 && c === 113) return false
  return a < 224
}

function ipv6Bytes(address: string): readonly number[] | undefined {
  let value = normalizedHostname(address)
  if (value.includes('.')) {
    const separator = value.lastIndexOf(':')
    const embedded = ipv4Bytes(value.slice(separator + 1))
    if (separator === -1 || embedded === undefined) return undefined
    value = value.slice(0, separator + 1)
      + ((embedded[0] ?? 0) * 256 + (embedded[1] ?? 0)).toString(16)
      + ':'
      + ((embedded[2] ?? 0) * 256 + (embedded[3] ?? 0)).toString(16)
  }
  const halves = value.split('::')
  if (halves.length > 2) return undefined
  const read = (half: string): number[] => half.length === 0
    ? []
    : half.split(':').map(part => Number.parseInt(part, 16))
  const left = read(halves[0] ?? '')
  const right = read(halves[1] ?? '')
  if ([...left, ...right].some(part => !Number.isInteger(part) || part < 0 || part > 0xFFFF)) return undefined
  const missing = 8 - left.length - right.length
  if ((halves.length === 1 && missing !== 0) || missing < 0) return undefined
  const groups = halves.length === 1 ? left : [...left, ...Array.from({ length: missing }, () => 0), ...right]
  if (groups.length !== 8) return undefined
  return groups.flatMap(group => [group >> 8, group & 0xFF])
}

function embeddedIpv4IsPublic(bytes: readonly number[], offset: number): boolean {
  return publicIpv4(bytes.slice(offset, offset + 4).join('.'))
}

function publicIpv6(address: string): boolean {
  const bytes = ipv6Bytes(address)
  if (bytes === undefined) return false
  const allZero = bytes.every(byte => byte === 0)
  const loopback = bytes.slice(0, 15).every(byte => byte === 0) && bytes[15] === 1
  if (allZero || loopback) return false
  if ((bytes[0] ?? 0) >= 0xFC && (bytes[0] ?? 0) <= 0xFD) return false
  if (bytes[0] === 0xFE && ((bytes[1] ?? 0) & 0xC0) === 0x80) return false
  if (bytes[0] === 0xFF) return false
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0D && bytes[3] === 0xB8) return false
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x02) return false
  if (bytes[0] === 0x01 && bytes.slice(1, 8).every(byte => byte === 0)) return false

  const mapped = bytes.slice(0, 10).every(byte => byte === 0) && bytes[10] === 0xFF && bytes[11] === 0xFF
  if (mapped) return embeddedIpv4IsPublic(bytes, 12)
  const compatible = bytes.slice(0, 12).every(byte => byte === 0)
  if (compatible) return embeddedIpv4IsPublic(bytes, 12)
  const nat64 = bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xFF && bytes[3] === 0x9B
    && bytes.slice(4, 12).every(byte => byte === 0)
  if (nat64) return embeddedIpv4IsPublic(bytes, 12)
  const sixToFour = bytes[0] === 0x20 && bytes[1] === 0x02
  if (sixToFour) return embeddedIpv4IsPublic(bytes, 2)
  return true
}

/** Classify an already-parsed URL hostname or one DNS answer. */
export function classifyAddressLiteral(hostname: string): AddressClassification {
  const normalized = normalizedHostname(hostname)
  const family = isIP(normalized)
  if (family === 4) return publicIpv4(normalized) ? 'public' : 'blocked'
  if (family === 6) return publicIpv6(normalized) ? 'public' : 'blocked'
  return 'hostname'
}

function blockedHostname(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || hostname.endsWith('.home.arpa')
}

const systemLookup: NetworkLookup = async hostname => lookupDns(hostname, { all: true, verbatim: true })

/**
 * Refuse a Source destination that is visibly local or resolves to any non-public
 * address before Raven delegates the actual connection to the Harness web provider.
 * This is a pre-flight filter, not a DNS-rebinding sandbox: the provider resolves the
 * name again when it connects, because the current web seam exposes no pinned-address
 * or dispatcher hook.
 */
export async function assertPublicDestination(
  value: string,
  options: { readonly lookup?: NetworkLookup; readonly signal?: AbortSignal } = {},
): Promise<void> {
  const url = new URL(value)
  const hostname = normalizedHostname(url.hostname)
  if (blockedHostname(hostname)) {
    throw new SourceNetworkPolicyError(`Source destination ${hostname} is a local or private hostname`)
  }
  const literal = classifyAddressLiteral(hostname)
  if (literal === 'blocked') {
    throw new SourceNetworkPolicyError(`Source destination ${hostname} is a non-public network address`)
  }
  if (literal === 'public') return

  let addresses: readonly NetworkLookupAddress[]
  try {
    addresses = await settleWithAbort((options.lookup ?? systemLookup)(hostname), options.signal)
  } catch (error) {
    if (options.signal?.aborted === true) options.signal.throwIfAborted()
    const detail = error instanceof Error ? error.message : String(error)
    throw new SourceNetworkPolicyError(`Source destination ${hostname} could not be resolved for public-network verification: ${detail}`)
  }
  if (addresses.length === 0) {
    throw new SourceNetworkPolicyError(`Source destination ${hostname} resolved to no addresses`)
  }
  const blocked = addresses.find(answer => classifyAddressLiteral(answer.address) !== 'public')
  if (blocked !== undefined) {
    throw new SourceNetworkPolicyError(
      `Source destination ${hostname} resolved to non-public address ${blocked.address}; Raven refused the fetch`,
    )
  }
}
