import { describe, expect, it } from 'vitest'
import { getSyncDiscoveryNotice, syncCompletionIdentity } from '../src/renderer/sync-settings'
import type { SyncDeviceSummary, SyncPageState } from '../src/shared/types'

describe('sync discovery diagnostics', () => {
  it('shows an active alternate path as a localized partial limitation', () => {
    const notice = getSyncDiscoveryNotice(discoveryState(
      'Local sync automatic discovery is partially limited; an alternate path is active',
    ))

    expect(notice).toEqual({
      severity: 'degraded',
      title: '部分发现方式受限',
      message: '部分自动发现方式暂时受限，但替代发现路径已经启用，可以继续同步。',
    })
  })

  it('keeps a channel failure partial when a verified device remains online', () => {
    const notice = getSyncDiscoveryNotice(discoveryState(
      'Local sync multicast send failed',
      [onlinePeer()],
    ))

    expect(notice?.severity).toBe('degraded')
    expect(notice?.title).toBe('部分发现方式受限')
    expect(notice?.message).toContain('多播发现暂时无法发送设备消息')
    expect(notice?.message).toContain('已验证设备仍然可用')
    expect(notice?.message).not.toContain('Local sync')
  })

  it('shows a localized unavailable state when no discovery path is usable', () => {
    const notice = getSyncDiscoveryNotice(discoveryState('Local sync DNS-SD failed (3)'))

    expect(notice?.severity).toBe('unavailable')
    expect(notice?.title).toBe('局域网设备发现不可用')
    expect(notice?.message).toContain('系统设备发现服务暂时不可用')
    expect(notice?.message).toContain('暂未找到可用的替代路径')
    expect(notice?.message).not.toContain('Local sync')
  })

  it('does not expose unknown Android bridge diagnostics in English', () => {
    const notice = getSyncDiscoveryNotice(discoveryState('Local sync unexpected bridge failure'))

    expect(notice?.message).toContain('局域网设备发现暂时不可用')
    expect(notice?.message).not.toContain('unexpected bridge failure')
  })

  it('preserves an already localized diagnostic and omits empty notices', () => {
    expect(getSyncDiscoveryNotice(discoveryState(null))).toBeNull()
    expect(getSyncDiscoveryNotice(discoveryState('请允许访问本地网络。'))?.message)
      .toContain('请允许访问本地网络。')
  })

  it('gives each completed transfer a stable UI refresh identity', () => {
    const result = {
      direction: 'receiving' as const,
      peerName: 'Windows',
      completedAt: '2026-07-31T10:00:00.000Z',
      appliedRecords: 3,
      unchangedRecords: 1,
      importedPublications: 0,
    }
    expect(syncCompletionIdentity(result)).toBe(syncCompletionIdentity({ ...result }))
    expect(syncCompletionIdentity({ ...result, appliedRecords: 4 })).not.toBe(syncCompletionIdentity(result))
    expect(syncCompletionIdentity(null)).toBeNull()
  })
})

function discoveryState(
  diagnostic: string | null,
  nearbyDevices: SyncDeviceSummary[] = [],
): Pick<SyncPageState, 'diagnostic' | 'nearbyDevices' | 'trustedDevices'> {
  return { diagnostic, nearbyDevices, trustedDevices: [] }
}

function onlinePeer(): SyncDeviceSummary {
  return {
    deviceId: 'peer-1',
    name: 'Windows',
    platform: 'windows',
    trusted: true,
    online: true,
    reachability: 'online',
    diagnostic: null,
    lastSeenAt: '2026-07-20T00:00:00.000Z',
    certificateSha256: 'a'.repeat(64),
  }
}
