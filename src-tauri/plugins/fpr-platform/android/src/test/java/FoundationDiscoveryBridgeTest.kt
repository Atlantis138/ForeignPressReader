package com.local.foreignpressreader.foundation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FoundationDiscoveryBridgeTest {
    @Test
    fun wireV2FingerprintValidationIsStrict() {
        assertTrue(FoundationDiscoveryBridge.isSha256("a".repeat(64)))
        assertTrue(FoundationDiscoveryBridge.isSha256("ABCDEF".repeat(10) + "ABCD"))
        assertFalse(FoundationDiscoveryBridge.isSha256("a".repeat(63)))
        assertFalse(FoundationDiscoveryBridge.isSha256("z".repeat(64)))
    }

    @Test
    fun physicalInterfacesSortAheadOfVirtualInterfaces() {
        assertTrue(
            FoundationDiscoveryBridge.networkScore("wlan0") <
                FoundationDiscoveryBridge.networkScore("tun0"),
        )
        assertTrue(
            FoundationDiscoveryBridge.networkScore("eth0") <
                FoundationDiscoveryBridge.networkScore("rmnet_data0"),
        )
    }

    @Test
    fun onlyWifiAndEthernetWithoutVpnOrCellularAreDiscoveryTransports() {
        assertTrue(isEligiblePhysicalTransport(true, false, false, false))
        assertTrue(isEligiblePhysicalTransport(false, true, false, false))
        assertFalse(isEligiblePhysicalTransport(false, false, false, false))
        assertFalse(isEligiblePhysicalTransport(true, false, true, false))
        assertFalse(isEligiblePhysicalTransport(true, false, false, true))
        assertFalse(isEligiblePhysicalTransport(false, true, true, false))
    }

    @Test
    fun aSuccessfulChannelRetryClearsOnlyThatChannelsStickyFailure() {
        val health = DiscoveryChannelHealth()
        health.failed(DiscoveryChannel.MULTICAST_SEND, "multicast failed")
        health.failed(DiscoveryChannel.DNS_SD_DISCOVERY, "dns-sd failed")

        health.succeeded(DiscoveryChannel.MULTICAST_SEND)

        assertEquals(setOf(DiscoveryChannel.DNS_SD_DISCOVERY), health.failedChannels())
        assertEquals(setOf(DiscoveryChannel.MULTICAST_SEND), health.healthyChannels())
        assertEquals(
            "Local sync automatic discovery is partially limited; an alternate path is active",
            health.diagnostic(hasVerifiedPeer = false),
        )
        health.succeeded(DiscoveryChannel.DNS_SD_DISCOVERY)
        assertNull(health.diagnostic(hasVerifiedPeer = false))
    }

    @Test
    fun aVerifiedFallbackReportsDegradedDiscoveryInsteadOfAnUnavailablePath() {
        val health = DiscoveryChannelHealth()
        health.failed(DiscoveryChannel.MULTICAST_SEND, "multicast failed")

        assertEquals("multicast failed", health.diagnostic(hasVerifiedPeer = false))
        assertEquals(
            "Local sync automatic discovery is partially limited; an alternate path is active",
            health.diagnostic(hasVerifiedPeer = true),
        )
    }

    @Test
    fun verifierConcurrencyIsBoundedForSlash24Fallbacks() {
        assertEquals(12, DISCOVERY_VERIFIER_CONCURRENCY)
    }

    @Test
    fun leavingPageAttemptsEveryResourceReleaseWhenOneReleaseFails() {
        val released = mutableListOf<String>()

        releaseDiscoveryResources(listOf(
            { released += "nsd" },
            {
                released += "socket"
                error("socket already closed")
            },
            { released += "scheduler" },
            { released += "verifier" },
            { released += "multicast-lock" },
        ))

        assertEquals(
            listOf("nsd", "socket", "scheduler", "verifier", "multicast-lock"),
            released,
        )
    }

    @Test
    fun subnetFallbackScansOneSlash24WithoutTheLocalAddress() {
        val hosts = FoundationDiscoveryBridge.subnetHosts("192.168.8.37")
        assertEquals(253, hosts.size)
        assertEquals("192.168.8.1", hosts.first())
        assertEquals("192.168.8.254", hosts.last())
        assertFalse(hosts.contains("192.168.8.37"))
    }
}
