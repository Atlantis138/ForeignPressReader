package com.local.foreignpressreader.foundation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

class FoundationPolicyTest {
    @Test
    fun networkAllowlistRequiresExactHttpsHostAndStandardPort() {
        assertTrue(FoundationPolicy.isAllowedNetworkUrl("https://api.openai.com/v1/models"))
        assertTrue(FoundationPolicy.isAllowedNetworkUrl("https://api.openai.com:443/v1/models?limit=1"))
        assertFalse(FoundationPolicy.isAllowedNetworkUrl("http://api.openai.com/v1/models"))
        assertFalse(FoundationPolicy.isAllowedNetworkUrl("https://api.openai.com.evil.test/v1/models"))
        assertFalse(FoundationPolicy.isAllowedNetworkUrl("https://user@api.openai.com/v1/models"))
        assertFalse(FoundationPolicy.isAllowedNetworkUrl("https://api.openai.com:8443/v1/models"))
        assertFalse(FoundationPolicy.isAllowedNetworkUrl("https://api.openai.com/v1/models#secret"))
    }

    @Test
    fun privatePathsUseCanonicalDescendantChecks() {
        val parent = Files.createTempDirectory("fpr-path-policy").toFile()
        try {
            val root = File(parent, "data").also { it.mkdirs() }
            val child = File(root, ".staging/item.bin")
            val sibling = File(parent, "data-evil/item.bin")
            assertTrue(FoundationPolicy.isPrivateDescendant(root, child))
            assertFalse(FoundationPolicy.isPrivateDescendant(root, root))
            assertFalse(FoundationPolicy.isPrivateDescendant(root, sibling))
            assertFalse(FoundationPolicy.isPrivateDescendant(root, File(root, "../outside.bin")))
        } finally {
            parent.deleteRecursively()
        }
    }

    @Test
    fun dictionarySourcesPinUrlSizeAndGitBlobIdentity() {
        val url = "https://raw.githubusercontent.com/skywind3000/ECDICT/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b/ecdict.csv"
        assertTrue(FoundationPolicy.isAllowedDictionarySource(
            url,
            65_933_428L,
            "c4ade63ea08cf39d9c3475e96929036d64d94c94",
        ))
        assertFalse(FoundationPolicy.isAllowedDictionarySource(
            "$url.evil",
            65_933_428L,
            "c4ade63ea08cf39d9c3475e96929036d64d94c94",
        ))
        assertFalse(FoundationPolicy.isAllowedDictionarySource(url, 1, "bad"))
    }

    @Test
    fun transferRegistryMakesCancellationRaceDeterministic() {
        val registry = TransferCancellationRegistry<String>()
        registry.begin("one", "connection")
        assertEquals(TransferState.ACTIVE, registry.state("one"))
        assertEquals("connection", registry.requestCancel("one"))
        assertTrue(registry.isCancelled("one"))
        assertEquals(TransferState.CANCEL_REQUESTED, registry.state("one"))
        registry.finish("one")
        assertEquals(TransferState.IDLE, registry.state("one"))

        assertNull(registry.requestCancel("before-begin"))
        registry.begin("before-begin", "late-connection")
        assertTrue(registry.isCancelled("before-begin"))
        assertEquals("late-connection", registry.requestCancel("before-begin"))
    }

    @Test
    fun networkFailuresHaveStablePublicCodes() {
        assertEquals("networkCancelled", FoundationPolicy.networkFailure(NetworkFailure.CANCELLED).code)
        assertEquals("networkTimeout", FoundationPolicy.networkFailure(NetworkFailure.TIMEOUT).code)
        assertEquals("networkTls", FoundationPolicy.networkFailure(NetworkFailure.TLS).code)
        assertEquals("networkOffline", FoundationPolicy.networkFailure(NetworkFailure.OFFLINE).code)
        assertEquals("networkResponseTooLarge", FoundationPolicy.networkFailure(NetworkFailure.RESPONSE_TOO_LARGE).code)
        assertEquals("networkTransport", FoundationPolicy.networkFailure(NetworkFailure.TRANSPORT).code)
    }

    @Test
    fun nsdResolutionQueueAllowsOnlyOneActiveRequest() {
        val queue = SerialKeyQueue()
        assertEquals("self", queue.enqueue("self"))
        assertNull(queue.enqueue("windows"))
        assertNull(queue.enqueue("windows"))
        assertEquals("windows", queue.complete("self"))
        assertNull(queue.enqueue("windows"))
        assertNull(queue.complete("windows"))

        assertEquals("stale", queue.enqueue("stale"))
        assertNull(queue.enqueue("lost"))
        queue.removePending("lost")
        assertNull(queue.complete("stale"))
    }
}
