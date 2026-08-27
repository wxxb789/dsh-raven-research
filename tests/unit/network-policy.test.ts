import { describe, expect, it } from 'vitest'

import {
  assertPublicDestination,
  classifyAddressLiteral,
  SourceNetworkPolicyError,
} from '../../src/network-policy.js'

type NetworkLookup = NonNullable<NonNullable<Parameters<typeof assertPublicDestination>[1]>['lookup']>

describe('Source public-network pre-flight policy', () => {
  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '198.18.0.1',
    '::',
    '::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '64:ff9b::7f00:1',
    '2002:7f00:1::',
  ])('classifies %s as blocked', (address) => {
    expect(classifyAddressLiteral(address)).toBe('blocked')
  })

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('classifies %s as public', (address) => {
    expect(classifyAddressLiteral(address)).toBe('public')
  })

  it('classifies a DNS name separately from an address literal', () => {
    expect(classifyAddressLiteral('example.com')).toBe('hostname')
  })

  it('rejects alternate loopback spellings after WHATWG URL normalization', async () => {
    for (const value of ['http://2130706433/a', 'http://0x7f000001/a']) {
      await expect(assertPublicDestination(value)).rejects.toThrow(/non-public network address/)
    }
  })

  it('requires every DNS answer to be public', async () => {
    const mixed: NetworkLookup = async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.8', family: 4 },
    ]
    await expect(assertPublicDestination('https://records.example/a', { lookup: mixed }))
      .rejects.toThrow(/non-public address 10\.0\.0\.8/)
  })

  it('accepts a DNS name only when all answers are public', async () => {
    const publicOnly: NetworkLookup = async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ]
    await expect(assertPublicDestination('https://records.example/a', { lookup: publicOnly }))
      .resolves.toBeUndefined()
  })

  it('reports DNS failure as a policy refusal rather than allowing the fetch', async () => {
    const unavailable: NetworkLookup = async () => { throw new Error('ENOTFOUND') }
    await expect(assertPublicDestination('https://missing.example/a', { lookup: unavailable }))
      .rejects.toMatchObject({ name: SourceNetworkPolicyError.name })
  })

  it.each([
    'http://localhost/a',
    'http://service.local/a',
    'http://metadata.internal/a',
    'http://router.home.arpa/a',
  ])('rejects local hostname %s without DNS', async (value) => {
    let lookedUp = false
    await expect(assertPublicDestination(value, {
      lookup: async () => { lookedUp = true; return [{ address: '8.8.8.8', family: 4 }] },
    })).rejects.toThrow(/local or private hostname/)
    expect(lookedUp).toBe(false)
  })
})
