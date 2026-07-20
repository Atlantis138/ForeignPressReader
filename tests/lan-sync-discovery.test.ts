import type os from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  LanSyncDiscoveryMessageCache,
  lanSyncScanHosts,
  listLanSyncIpv4Interfaces,
} from '../src/main/lan-sync-discovery'

const ipv4 = (
  address: string,
  netmask: string,
  internal = false,
): os.NetworkInterfaceInfo => ({
  address,
  netmask,
  family: 'IPv4',
  mac: '00:11:22:33:44:55',
  internal,
  cidr: `${address}/24`,
})

describe('LAN sync active discovery policy', () => {
  it('filters unusable IPv4 addresses, computes broadcasts and prioritizes physical adapters', () => {
    const interfaces = listLanSyncIpv4Interfaces({
      'vEthernet (WSL)': [ipv4('172.24.16.1', '255.255.240.0')],
      'Wi-Fi': [ipv4('192.168.50.37', '255.255.255.0')],
      Loopback: [ipv4('127.0.0.1', '255.0.0.0', true)],
      LinkLocal: [ipv4('169.254.8.9', '255.255.0.0')],
    })

    expect(interfaces.map((item) => item.name)).toEqual(['Wi-Fi', 'vEthernet (WSL)'])
    expect(interfaces[0]).toMatchObject({
      address: '192.168.50.37',
      broadcast: '192.168.50.255',
    })
    expect(interfaces[1].broadcast).toBe('172.24.31.255')
  })

  it('scans at most one /24 and never probes the local address', () => {
    const hosts = lanSyncScanHosts([{
      name: 'Wi-Fi',
      address: '192.168.50.37',
      netmask: '255.255.255.0',
      broadcast: '192.168.50.255',
    }])
    expect(hosts).toHaveLength(253)
    expect(hosts).toContain('192.168.50.1')
    expect(hosts).toContain('192.168.50.254')
    expect(hosts).not.toContain('192.168.50.37')
    expect(hosts).not.toContain('192.168.50.255')
  })

  it('deduplicates message IDs until the 30 second retention window expires', () => {
    const cache = new LanSyncDiscoveryMessageCache()
    expect(cache.accept('message-1', 1_000)).toBe(true)
    expect(cache.accept('message-1', 30_999)).toBe(false)
    expect(cache.accept('message-1', 31_000)).toBe(true)
    cache.clear()
    expect(cache.accept('message-1', 31_001)).toBe(true)
  })
})
