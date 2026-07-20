package com.local.foreignpressreader.foundation

import java.io.File
import java.net.URI
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

internal enum class NetworkFailure {
    CANCELLED,
    TIMEOUT,
    TLS,
    OFFLINE,
    RESPONSE_TOO_LARGE,
    TRANSPORT,
}

internal data class FoundationFailure(val message: String, val code: String)

internal object FoundationPolicy {
    private val networkHosts = setOf(
        "example.com",
        "httpbin.org",
        "api.deepseek.com",
        "api.openai.com",
        "api.moonshot.cn",
        "aip.baidubce.com",
        "texttospeech.googleapis.com",
        "api.minimaxi.com",
    )

    fun isAllowedNetworkUrl(value: String): Boolean {
        val uri = try { URI(value) } catch (_: Throwable) { return false }
        return uri.scheme?.lowercase(Locale.ROOT) == "https"
            && uri.userInfo == null
            && uri.fragment == null
            && uri.port in setOf(-1, 443)
            && uri.host?.lowercase(Locale.ROOT) in networkHosts
    }

    fun isPrivateDescendant(root: File, candidate: File): Boolean = try {
        val canonicalRoot = root.canonicalFile
        val canonicalCandidate = candidate.canonicalFile
        canonicalCandidate.path.startsWith(canonicalRoot.path + File.separator)
    } catch (_: Throwable) {
        false
    }

    fun isAllowedDictionarySource(url: String, expectedBytes: Long, gitBlobSha: String): Boolean {
        val revision = "bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b"
        val dictionaryPath = "skywind3000/ECDICT/$revision/ecdict.csv"
        val lemmaPath = "skywind3000/ECDICT/$revision/lemma.en.txt"
        val rawPrefix = "https://raw.githubusercontent.com/"
        val allowedUrls = setOf(
            rawPrefix + dictionaryPath,
            "https://ghproxy.net/" + rawPrefix + dictionaryPath,
            "https://ghfast.top/" + rawPrefix + dictionaryPath,
            rawPrefix + lemmaPath,
            "https://ghproxy.net/" + rawPrefix + lemmaPath,
            "https://ghfast.top/" + rawPrefix + lemmaPath,
        )
        val expected = when {
            url.endsWith("/ecdict.csv") -> Pair(65_933_428L, "c4ade63ea08cf39d9c3475e96929036d64d94c94")
            url.endsWith("/lemma.en.txt") -> Pair(2_318_694L, "34eabb9f48c5867a91c01c33b206120e275f0418")
            else -> return false
        }
        return url in allowedUrls && expectedBytes == expected.first
            && gitBlobSha.equals(expected.second, ignoreCase = true)
    }

    fun networkFailure(failure: NetworkFailure): FoundationFailure = when (failure) {
        NetworkFailure.CANCELLED -> FoundationFailure("Network request was cancelled", "networkCancelled")
        NetworkFailure.TIMEOUT -> FoundationFailure("Network request timed out", "networkTimeout")
        NetworkFailure.TLS -> FoundationFailure("TLS validation failed", "networkTls")
        NetworkFailure.OFFLINE -> FoundationFailure("Network is offline", "networkOffline")
        NetworkFailure.RESPONSE_TOO_LARGE -> FoundationFailure("Network response is too large", "networkResponseTooLarge")
        NetworkFailure.TRANSPORT -> FoundationFailure("Network request failed", "networkTransport")
    }
}

internal enum class TransferState { IDLE, ACTIVE, CANCEL_REQUESTED }

internal class TransferCancellationRegistry<T> {
    private val active = ConcurrentHashMap<String, T>()
    private val cancelled = ConcurrentHashMap.newKeySet<String>()

    fun begin(id: String, value: T) {
        active[id] = value
    }

    fun requestCancel(id: String): T? {
        cancelled.add(id)
        return active.remove(id)
    }

    fun isCancelled(id: String): Boolean = cancelled.contains(id)

    fun finish(id: String) {
        active.remove(id)
        cancelled.remove(id)
    }

    fun state(id: String): TransferState = when {
        cancelled.contains(id) -> TransferState.CANCEL_REQUESTED
        active.containsKey(id) -> TransferState.ACTIVE
        else -> TransferState.IDLE
    }
}

/** Serializes Android NSD resolution, whose legacy API only permits one active request. */
internal class SerialKeyQueue {
    private val pending = LinkedHashSet<String>()
    private var active: String? = null

    @Synchronized
    fun enqueue(key: String): String? {
        if (key != active) pending.add(key)
        return takeNext()
    }

    @Synchronized
    fun complete(key: String): String? {
        if (active == key) active = null else pending.remove(key)
        return takeNext()
    }

    @Synchronized
    fun removePending(key: String) {
        pending.remove(key)
    }

    @Synchronized
    fun clear() {
        pending.clear()
        active = null
    }

    private fun takeNext(): String? {
        if (active != null) return null
        val next = pending.firstOrNull() ?: return null
        pending.remove(next)
        active = next
        return next
    }
}
