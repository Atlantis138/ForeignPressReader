package com.local.foreignpressreader.foundation

import android.app.Activity
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.DatagramPacket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.MulticastSocket
import java.net.NetworkInterface
import java.net.URL
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

private const val SYNC_PORT = 53318
private const val MULTICAST_GROUP = "239.255.70.80"
private const val PROTOCOL = "foreign-press-reader-sync"
private const val WIRE_VERSION = 2
private const val MAX_DISCOVERY_BYTES = 4 * 1024
private const val MAX_INFO_BYTES = 1024 * 1024
internal const val DISCOVERY_VERIFIER_CONCURRENCY = 12

internal enum class DiscoveryChannel {
    MULTICAST_SEND,
    BROADCAST_SEND,
    UDP_RECEIVE,
    DNS_SD_REGISTRATION,
    DNS_SD_DISCOVERY,
    SUBNET_SCAN,
}

/** Keeps transient discovery failures isolated so one successful retry clears only its own channel. */
internal class DiscoveryChannelHealth {
    private val failures = ConcurrentHashMap<DiscoveryChannel, String>()
    private val successes = ConcurrentHashMap.newKeySet<DiscoveryChannel>()

    fun failed(channel: DiscoveryChannel, diagnostic: String) {
        successes.remove(channel)
        failures[channel] = diagnostic
    }

    fun succeeded(channel: DiscoveryChannel) {
        failures.remove(channel)
        successes.add(channel)
    }

    fun clear() {
        failures.clear()
        successes.clear()
    }

    fun failedChannels(): Set<DiscoveryChannel> = failures.keys.toSet()
    fun healthyChannels(): Set<DiscoveryChannel> = successes.toSet()

    fun diagnostic(hasVerifiedPeer: Boolean): String? {
        if (failures.isEmpty()) return null
        if (hasVerifiedPeer || successes.isNotEmpty()) {
            return "Local sync automatic discovery is partially limited; an alternate path is active"
        }
        return DiscoveryChannel.entries.firstNotNullOfOrNull { failures[it] }
    }
}

/** Cleanup must be best-effort: one Android service failure must not retain the remaining resources. */
internal fun releaseDiscoveryResources(actions: Iterable<() -> Unit>) {
    actions.forEach { action -> runCatching(action) }
}

internal fun isEligiblePhysicalTransport(
    hasWifi: Boolean,
    hasEthernet: Boolean,
    hasVpn: Boolean,
    hasCellular: Boolean,
): Boolean = (hasWifi || hasEthernet) && !hasVpn && !hasCellular

private data class LocalAnnouncement(
    val deviceId: String,
    val name: String,
    val platform: String,
    val certificateSha256: String,
)

private data class VerifiedPeer(
    val serviceName: String,
    val host: String,
    val deviceId: String,
    val name: String,
    val platform: String,
    val certificateSha256: String,
    val certificateDerBase64: String,
    val lastVerifiedAt: Long,
)

private data class PhysicalIpv4Network(
    val network: Network,
    val networkInterface: NetworkInterface,
    val broadcast: InetAddress?,
    val address: Inet4Address,
)

/** Page-scoped active UDP discovery, subnet scan, DNS-SD fallback and MulticastLock owner. */
internal class FoundationDiscoveryBridge(activity: Activity) {
    private val context = activity.applicationContext
    private val connectivityManager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    private val nsdManager = context.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val wifiManager = context.getSystemService(Context.WIFI_SERVICE) as WifiManager
    private val mainHandler = Handler(Looper.getMainLooper())
    private val verified = ConcurrentHashMap<String, VerifiedPeer>()
    private val verifying = ConcurrentHashMap.newKeySet<String>()
    private val activeVerifierConnections = ConcurrentHashMap.newKeySet<HttpsURLConnection>()
    private val activeOutboundSockets = ConcurrentHashMap.newKeySet<MulticastSocket>()
    private val channelHealth = DiscoveryChannelHealth()
    @Volatile private var generation = 0L
    @Volatile private var local: LocalAnnouncement? = null
    @Volatile private var socket: MulticastSocket? = null
    @Volatile private var receiverThread: Thread? = null
    @Volatile private var scheduler: ScheduledExecutorService? = null
    @Volatile private var verifier = Executors.newFixedThreadPool(DISCOVERY_VERIFIER_CONCURRENCY)
    @Volatile private var discoveryListener: NsdManager.DiscoveryListener? = null
    @Volatile private var registrationListener: NsdManager.RegistrationListener? = null
    @Volatile private var multicastLock: WifiManager.MulticastLock? = null

    fun start(invoke: Invoke) {
        val args = try { invoke.parseArgs(SyncDiscoveryStartArgs::class.java) }
        catch (_: Throwable) { return invoke.reject("Sync discovery request is invalid", "invalidInput") }
        if (args.port != SYNC_PORT || args.serviceName.isBlank() || args.serviceName.length > 48) {
            return invoke.reject("Wire v2 requires TCP/UDP port 53318", "invalidInput")
        }
        val attributes = try { JSONObject(args.attributesJson) }
        catch (_: Throwable) { return invoke.reject("Sync discovery attributes are invalid", "invalidInput") }
        val announcement = LocalAnnouncement(
            attributes.optString("id"),
            attributes.optString("n"),
            attributes.optString("os"),
            attributes.optString("fp"),
        )
        if (announcement.deviceId.isBlank() || announcement.name.isBlank()
            || announcement.platform != "android" || !isSha256(announcement.certificateSha256)) {
            return invoke.reject("Sync discovery attributes are invalid", "invalidInput")
        }
        try {
            stop()
            val currentGeneration = generation
            local = announcement
            channelHealth.clear()
            multicastLock = wifiManager.createMulticastLock("fpr-local-sync-v2").apply {
                setReferenceCounted(false)
                acquire()
            }
            verifier = Executors.newFixedThreadPool(DISCOVERY_VERIFIER_CONCURRENCY)
            val multicast = MulticastSocket(null).apply {
                reuseAddress = true
                bind(InetSocketAddress(SYNC_PORT))
                broadcast = true
                timeToLive = 1
                loopbackMode = true
                soTimeout = 1_000
            }
            socket = multicast
            val joinedInterfaces = physicalIpv4Networks().map { it.networkInterface }.distinctBy { it.name }
                .count { networkInterface ->
                    runCatching {
                        multicast.joinGroup(
                            InetSocketAddress(MULTICAST_GROUP, SYNC_PORT),
                            networkInterface,
                        )
                    }.isSuccess
                }
            if (joinedInterfaces > 0) {
                channelHealth.succeeded(DiscoveryChannel.UDP_RECEIVE)
            } else {
                channelHealth.failed(
                    DiscoveryChannel.UDP_RECEIVE,
                    "Local sync multicast receive is unavailable",
                )
            }
            receiverThread = Thread({ receiveLoop(currentGeneration, multicast) }, "fpr-sync-discovery").apply {
                isDaemon = true
                start()
            }
            val scheduled = Executors.newSingleThreadScheduledExecutor()
            scheduler = scheduled
            sendAnnouncement("probe")
            scheduled.schedule({ sendAnnouncement("probe") }, 500, TimeUnit.MILLISECONDS)
            scheduled.schedule({ sendAnnouncement("probe") }, 2_000, TimeUnit.MILLISECONDS)
            scheduled.schedule({ if (generation == currentGeneration && verified.isEmpty()) scanSubnet(currentGeneration) }, 3_000, TimeUnit.MILLISECONDS)
            scheduled.scheduleAtFixedRate({ sendAnnouncement("announce") }, 5_000, 5_000, TimeUnit.MILLISECONDS)
            startNsd(args, attributes, currentGeneration)
            invoke.resolve()
        } catch (error: Throwable) {
            stop()
            Log.w("FprLocalSync", "Active discovery could not start", error)
            invoke.reject("Local network discovery is unavailable", "localNetworkUnavailable")
        }
    }

    fun refresh(invoke: Invoke) {
        val currentGeneration = generation
        if (socket == null || local == null) return invoke.reject(
            "Local network discovery is not active", "localNetworkUnavailable"
        )
        sendAnnouncement("probe")
        scheduler?.schedule({ sendAnnouncement("probe") }, 500, TimeUnit.MILLISECONDS)
        scheduler?.schedule({ sendAnnouncement("probe") }, 2_000, TimeUnit.MILLISECONDS)
        scanSubnet(currentGeneration)
        invoke.resolve()
    }

    fun snapshot(invoke: Invoke) {
        try {
            if (socket == null) return invoke.reject(
                "Local network discovery is not active", "localNetworkUnavailable"
            )
            val peers = org.json.JSONArray()
            val now = System.currentTimeMillis()
            verified.values.filter { now - it.lastVerifiedAt <= 30_000L }
                .sortedBy { it.deviceId }.forEach { peer ->
                    val chunks = peer.certificateDerBase64.chunked(180)
                    val attributes = JSObject().apply {
                        put("p", PROTOCOL); put("w", WIRE_VERSION.toString()); put("m", "2")
                        put("id", peer.deviceId); put("n", peer.name); put("os", peer.platform)
                        put("fp", peer.certificateSha256); put("cc", chunks.size.toString())
                        put("seen", peer.lastVerifiedAt.toString())
                        chunks.forEachIndexed { index, chunk -> put("c$index", chunk) }
                    }
                    peers.put(JSObject().apply {
                        put("serviceName", peer.serviceName)
                        put("host", peer.host)
                        put("port", SYNC_PORT)
                        put("attributes", attributes)
                    })
                }
            invoke.resolve(JSObject().apply {
                put("peers", peers)
                channelHealth.diagnostic(peers.length() > 0)?.let { put("diagnostic", it) }
            })
        } catch (_: Throwable) {
            invoke.reject("Local network discovery snapshot is unavailable", "localNetworkUnavailable")
        }
    }

    fun stop(clearError: Boolean = true) {
        generation += 1
        val previousDiscoveryListener = discoveryListener
        val previousRegistrationListener = registrationListener
        val previousScheduler = scheduler
        val previousSocket = socket
        val previousReceiverThread = receiverThread
        val previousVerifier = verifier
        val previousMulticastLock = multicastLock
        discoveryListener = null
        registrationListener = null
        scheduler = null
        socket = null
        receiverThread = null
        multicastLock = null
        local = null
        verifying.clear()
        verified.clear()
        releaseDiscoveryResources(listOf(
            { previousDiscoveryListener?.let { nsdManager.stopServiceDiscovery(it) } },
            { previousRegistrationListener?.let { nsdManager.unregisterService(it) } },
            { previousScheduler?.shutdownNow() },
            { previousSocket?.close() },
            {
                activeOutboundSockets.toList().forEach { outbound ->
                    runCatching { outbound.close() }
                }
                activeOutboundSockets.clear()
            },
            { previousReceiverThread?.interrupt() },
            { previousVerifier.shutdownNow() },
            {
                activeVerifierConnections.toList().forEach { connection ->
                    runCatching { connection.disconnect() }
                }
                activeVerifierConnections.clear()
            },
            { previousMulticastLock?.let { if (it.isHeld) it.release() } },
        ))
        if (clearError) channelHealth.clear()
    }

    private fun receiveLoop(currentGeneration: Long, multicast: MulticastSocket) {
        val buffer = ByteArray(MAX_DISCOVERY_BYTES + 1)
        while (generation == currentGeneration && !multicast.isClosed) {
            try {
                val packet = DatagramPacket(buffer, buffer.size)
                multicast.receive(packet)
                channelHealth.succeeded(DiscoveryChannel.UDP_RECEIVE)
                if (packet.length !in 1..MAX_DISCOVERY_BYTES) continue
                val json = JSONObject(String(packet.data, packet.offset, packet.length, Charsets.UTF_8))
                val own = local ?: continue
                if (json.optString("protocol") != PROTOCOL || json.optInt("discoveryVersion") != WIRE_VERSION
                    || json.optInt("port") != SYNC_PORT || json.optInt("modelVersion") != 2
                    || json.optString("deviceId") == own.deviceId || !isSha256(json.optString("certificateSha256"))) continue
                val host = packet.address.hostAddress?.substringBefore('%') ?: continue
                verifyHost(
                    currentGeneration, host, json.optString("certificateSha256"),
                    json.optString("deviceId"), json.optString("name"), json.optString("platform"),
                )
                if (json.optString("kind") == "probe") sendAnnouncement("announce", packet.address, packet.port)
            } catch (_: java.net.SocketTimeoutException) {
                // Allows stop generation checks.
            } catch (error: Throwable) {
                if (!multicast.isClosed) {
                    channelHealth.failed(
                        DiscoveryChannel.UDP_RECEIVE,
                        "Local sync UDP receive failed",
                    )
                    Log.w("FprLocalSync", "UDP discovery receive failed", error)
                }
            }
        }
    }

    private fun sendAnnouncement(kind: String, address: InetAddress? = null, port: Int = SYNC_PORT) {
        val currentGeneration = generation
        val own = local ?: return
        val multicast = socket ?: return
        val payload = JSONObject().apply {
            put("protocol", PROTOCOL); put("discoveryVersion", WIRE_VERSION)
            put("messageId", UUID.randomUUID().toString()); put("kind", kind)
            put("deviceId", own.deviceId); put("name", own.name); put("platform", own.platform)
            put("port", SYNC_PORT); put("wireVersions", org.json.JSONArray().put(WIRE_VERSION))
            put("modelVersion", 2); put("certificateSha256", own.certificateSha256)
        }.toString().toByteArray(Charsets.UTF_8)
        if (payload.size > MAX_DISCOVERY_BYTES) return
        if (address != null) {
            synchronized(multicast) {
                runCatching {
                    multicast.send(DatagramPacket(payload, payload.size, address, port))
                }
            }
            return
        }

        val networks = physicalIpv4Networks()
        if (generation != currentGeneration || socket !== multicast || multicast.isClosed) return
        if (networks.isEmpty()) {
            channelHealth.failed(
                DiscoveryChannel.MULTICAST_SEND,
                "Local sync has no active Wi-Fi or Ethernet multicast path",
            )
            channelHealth.failed(
                DiscoveryChannel.BROADCAST_SEND,
                "Local sync has no active Wi-Fi or Ethernet broadcast path",
            )
            return
        }
        val multicastAddress = InetAddress.getByName(MULTICAST_GROUP)
        var multicastSucceeded = false
        var broadcastAttempted = false
        var broadcastSucceeded = false
        for (network in networks) {
            if (generation != currentGeneration || socket !== multicast || multicast.isClosed) return
            multicastSucceeded = sendFromPhysicalNetwork(
                network,
                payload,
                multicastAddress,
                SYNC_PORT,
                currentGeneration,
            ) || multicastSucceeded
            network.broadcast?.let { broadcast ->
                broadcastAttempted = true
                broadcastSucceeded = sendFromPhysicalNetwork(
                    network,
                    payload,
                    broadcast,
                    SYNC_PORT,
                    currentGeneration,
                ) || broadcastSucceeded
            }
        }
        if (generation != currentGeneration) return
        if (multicastSucceeded) {
            channelHealth.succeeded(DiscoveryChannel.MULTICAST_SEND)
        } else {
            channelHealth.failed(
                DiscoveryChannel.MULTICAST_SEND,
                "Local sync multicast send failed",
            )
        }
        if (broadcastSucceeded) {
            channelHealth.succeeded(DiscoveryChannel.BROADCAST_SEND)
        } else {
            channelHealth.failed(
                DiscoveryChannel.BROADCAST_SEND,
                if (broadcastAttempted) {
                    "Local sync directed broadcast send failed"
                } else {
                    "Local sync directed broadcast is unavailable"
                },
            )
        }
    }

    private fun sendFromPhysicalNetwork(
        network: PhysicalIpv4Network,
        payload: ByteArray,
        address: InetAddress,
        port: Int,
        currentGeneration: Long,
    ): Boolean = runCatching {
        val outbound = MulticastSocket(null)
        activeOutboundSockets.add(outbound)
        try {
            if (generation != currentGeneration) {
                throw IllegalStateException("Discovery generation ended")
            }
            outbound.reuseAddress = true
            outbound.broadcast = true
            outbound.timeToLive = 1
            outbound.loopbackMode = true
            network.network.bindSocket(outbound)
            outbound.networkInterface = network.networkInterface
            outbound.bind(InetSocketAddress(0))
            outbound.send(DatagramPacket(payload, payload.size, address, port))
        } finally {
            activeOutboundSockets.remove(outbound)
            outbound.close()
        }
    }.isSuccess

    private fun scanSubnet(currentGeneration: Long) {
        if (generation != currentGeneration) return
        val network = physicalIpv4Networks().firstOrNull()
        if (generation != currentGeneration) return
        if (network == null) {
            channelHealth.failed(
                DiscoveryChannel.SUBNET_SCAN,
                "Local sync subnet scan has no active Wi-Fi or Ethernet path",
            )
            return
        }
        channelHealth.succeeded(DiscoveryChannel.SUBNET_SCAN)
        for (candidate in subnetHosts(network.address.hostAddress ?: return)) {
            if (generation != currentGeneration) return
            verifyHost(currentGeneration, candidate, null, null, null, null, 750)
        }
    }

    private fun verifyHost(
        currentGeneration: Long,
        host: String,
        expectedFingerprint: String?,
        expectedDeviceId: String?,
        expectedName: String?,
        expectedPlatform: String?,
        timeoutMs: Int = 1_500,
    ) {
        val key = "$currentGeneration:$host:${expectedFingerprint.orEmpty()}"
        if (!verifying.add(key)) return
        val currentVerifier = verifier
        try {
            currentVerifier.execute {
                var connection: HttpsURLConnection? = null
                try {
                    if (generation != currentGeneration) return@execute
                    val opened = URL("https://$host:$SYNC_PORT/fprsync/v2/info")
                        .openConnection() as HttpsURLConnection
                    connection = opened
                    activeVerifierConnections.add(opened)
                    if (generation != currentGeneration) return@execute
                    opened.sslSocketFactory = permissiveSslContext.socketFactory
                    opened.hostnameVerifier = HostnameVerifier { _, _ -> true }
                    opened.requestMethod = "GET"
                    opened.connectTimeout = timeoutMs
                    opened.readTimeout = timeoutMs
                    opened.setRequestProperty("Accept", "application/json")
                    opened.useCaches = false
                    opened.connect()
                    if (opened.responseCode != 200) {
                        throw IllegalStateException("info status ${opened.responseCode}")
                    }
                    val certificate = opened.serverCertificates.firstOrNull() as? X509Certificate
                        ?: throw IllegalStateException("missing TLS certificate")
                    val tlsFingerprint = sha256(certificate.encoded)
                    if (expectedFingerprint != null && tlsFingerprint != expectedFingerprint) {
                        throw IllegalStateException("TLS fingerprint changed")
                    }
                    val output = ByteArrayOutputStream()
                    opened.inputStream.use { input ->
                        val buffer = ByteArray(8 * 1024)
                        while (true) {
                            val read = input.read(buffer)
                            if (read < 0) break
                            if (output.size() + read > MAX_INFO_BYTES) {
                                throw IllegalStateException("info response too large")
                            }
                            output.write(buffer, 0, read)
                        }
                    }
                    val info = JSONObject(output.toString(Charsets.UTF_8.name()))
                    val deviceId = info.optString("deviceId")
                    val name = info.optString("name")
                    val platform = info.optString("platform")
                    val fingerprint = info.optString("certificateSha256")
                    if (info.optString("protocol") != PROTOCOL || info.optInt("wireVersion") != WIRE_VERSION
                        || info.optInt("modelVersion") != 2 || info.optInt("port") != SYNC_PORT
                        || deviceId.isBlank() || name.isBlank() || platform !in setOf("windows", "android")
                        || fingerprint != tlsFingerprint || expectedDeviceId?.let { it != deviceId } == true
                        || expectedName?.let { it != name } == true
                        || expectedPlatform?.let { it != platform } == true) {
                        throw IllegalStateException("invalid info identity")
                    }
                    val certificateBody = info.optString("certificateDerBase64")
                    if (!MessageDigest.isEqual(
                            Base64.decode(certificateBody, Base64.DEFAULT),
                            certificate.encoded,
                        )) {
                        throw IllegalStateException("info certificate mismatch")
                    }
                    if (generation == currentGeneration && local?.deviceId != deviceId) {
                        verified[deviceId] = VerifiedPeer(
                            "FPR-${deviceId.take(8)}", host, deviceId, name, platform,
                            fingerprint, Base64.encodeToString(certificate.encoded, Base64.NO_WRAP),
                            System.currentTimeMillis(),
                        )
                    }
                } catch (_: Throwable) {
                    // Closed hosts and transient packets are expected; expiry is time based.
                } finally {
                    connection?.let { opened ->
                        activeVerifierConnections.remove(opened)
                        runCatching { opened.disconnect() }
                    }
                    verifying.remove(key)
                }
            }
        } catch (_: Throwable) {
            verifying.remove(key)
        }
    }

    private fun startNsd(
        args: SyncDiscoveryStartArgs,
        attributes: JSONObject,
        currentGeneration: Long,
    ) {
        val serviceInfo = NsdServiceInfo().apply {
            serviceName = args.serviceName
            serviceType = "_fprsync._tcp."
            port = SYNC_PORT
            for (key in listOf("p", "w", "m", "id", "n", "os", "fp")) {
                val value = attributes.optString(key)
                if (value.isNotEmpty()) setAttribute(key, value)
            }
        }
        val registration = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(service: NsdServiceInfo) {
                if (generation == currentGeneration) {
                    channelHealth.succeeded(DiscoveryChannel.DNS_SD_REGISTRATION)
                }
            }
            override fun onRegistrationFailed(service: NsdServiceInfo, errorCode: Int) {
                if (generation == currentGeneration) {
                    channelHealth.failed(
                        DiscoveryChannel.DNS_SD_REGISTRATION,
                        "Local sync registration failed ($errorCode)",
                    )
                }
            }
            override fun onServiceUnregistered(service: NsdServiceInfo) = Unit
            override fun onUnregistrationFailed(service: NsdServiceInfo, errorCode: Int) = Unit
        }
        val discovery = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {
                if (generation == currentGeneration) {
                    channelHealth.succeeded(DiscoveryChannel.DNS_SD_DISCOVERY)
                }
            }
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                if (generation == currentGeneration) {
                    channelHealth.failed(
                        DiscoveryChannel.DNS_SD_DISCOVERY,
                        "Local sync DNS-SD failed ($errorCode)",
                    )
                }
            }
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = Unit
            override fun onDiscoveryStopped(serviceType: String) = Unit
            override fun onServiceLost(service: NsdServiceInfo) = Unit
            @Suppress("DEPRECATION")
            override fun onServiceFound(service: NsdServiceInfo) {
                mainHandler.post {
                    if (generation != currentGeneration) return@post
                    runCatching {
                        nsdManager.resolveService(service, object : NsdManager.ResolveListener {
                            override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                                if (generation == currentGeneration) {
                                    channelHealth.failed(
                                        DiscoveryChannel.DNS_SD_DISCOVERY,
                                        "Local sync DNS-SD resolve failed ($errorCode)",
                                    )
                                }
                            }
                            override fun onServiceResolved(resolved: NsdServiceInfo) {
                                if (generation != currentGeneration) return
                                channelHealth.succeeded(DiscoveryChannel.DNS_SD_DISCOVERY)
                                val host = resolved.host?.hostAddress?.substringBefore('%') ?: return
                                val attrs = resolved.attributes.mapValues { String(it.value, Charsets.UTF_8) }
                                verifyHost(
                                    currentGeneration,
                                    host,
                                    attrs["fp"],
                                    attrs["id"],
                                    attrs["n"],
                                    attrs["os"],
                                )
                            }
                        })
                    }.onFailure {
                        if (generation == currentGeneration) {
                            channelHealth.failed(
                                DiscoveryChannel.DNS_SD_DISCOVERY,
                                "Local sync DNS-SD resolve could not start",
                            )
                        }
                    }
                }
            }
        }
        registrationListener = registration
        discoveryListener = discovery
        nsdManager.registerService(serviceInfo, NsdManager.PROTOCOL_DNS_SD, registration)
        nsdManager.discoverServices("_fprsync._tcp.", NsdManager.PROTOCOL_DNS_SD, discovery)
    }

    @Suppress("DEPRECATION")
    private fun physicalIpv4Networks(): List<PhysicalIpv4Network> {
        val androidNetworks = runCatching { connectivityManager.allNetworks.toList() }
            .getOrElse { emptyList() }
        return androidNetworks.flatMap { network ->
            val capabilities = runCatching { connectivityManager.getNetworkCapabilities(network) }
                .getOrNull() ?: return@flatMap emptyList()
            if (!isEligiblePhysicalTransport(
                    capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI),
                    capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET),
                    capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN),
                    capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR),
                )) {
                return@flatMap emptyList()
            }
            val interfaceName = runCatching {
                connectivityManager.getLinkProperties(network)?.interfaceName
            }.getOrNull() ?: return@flatMap emptyList()
            val networkInterface = runCatching { NetworkInterface.getByName(interfaceName) }
                .getOrNull() ?: return@flatMap emptyList()
            val isUsable = runCatching { networkInterface.isUp && !networkInterface.isLoopback }
                .getOrDefault(false)
            if (!isUsable) return@flatMap emptyList()
            networkInterface.interfaceAddresses.mapNotNull { entry ->
                val address = entry.address
                if (address is Inet4Address && !address.isLoopbackAddress && !address.isLinkLocalAddress) {
                    PhysicalIpv4Network(
                        network,
                        networkInterface,
                        entry.broadcast,
                        address,
                    )
                } else {
                    null
                }
            }
        }.distinctBy { network ->
            "${network.network}-${network.networkInterface.name}-${network.address.hostAddress}"
        }.sortedBy { networkScore(it.networkInterface.name) }
    }

    companion object {
        private val permissiveSslContext: SSLContext by lazy {
            SSLContext.getInstance("TLS").apply {
                init(null, arrayOf<TrustManager>(object : X509TrustManager {
                    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
                    override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = Unit
                    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) = Unit
                }), SecureRandom())
            }
        }

        internal fun isSha256(value: String): Boolean = value.matches(Regex("^[a-fA-F0-9]{64}$"))
        internal fun networkScore(name: String): Int {
            val lower = name.lowercase()
            return when {
                lower.contains("wlan") || lower.contains("wifi") || lower.contains("eth") -> 0
                lower.contains("virtual") || lower.contains("tun") || lower.contains("docker") -> 20
                else -> 10
            }
        }
        internal fun subnetHosts(address: String): List<String> {
            val bytes = (InetAddress.getByName(address) as? Inet4Address)?.address ?: return emptyList()
            val own = bytes[3].toInt() and 0xff
            return (1..254).filter { it != own }
                .map { suffix -> "${bytes[0].toInt() and 0xff}.${bytes[1].toInt() and 0xff}.${bytes[2].toInt() and 0xff}.$suffix" }
        }
        private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
            .digest(bytes).joinToString("") { "%02x".format(it) }
    }
}
