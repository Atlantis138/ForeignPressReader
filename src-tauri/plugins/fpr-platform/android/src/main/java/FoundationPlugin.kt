package com.local.foreignpressreader.foundation

import android.Manifest
import android.app.Activity
import android.app.ActivityManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.content.Context
import android.speech.tts.TextToSpeech
import android.util.Base64
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.PermissionState
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import androidx.activity.result.ActivityResult
import androidx.core.content.FileProvider
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.ProxySelector
import java.net.URI
import java.net.URL
import java.net.UnknownHostException
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.Locale
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLException
import java.net.SocketTimeoutException

private const val MAX_EPUB_BYTES = 500L * 1024 * 1024
private const val MAX_DICTIONARY_PACK_BYTES = 512L * 1024 * 1024
private const val MAX_PORTABLE_BACKUP_BYTES = 20L * 1024 * 1024 * 1024
private const val MAX_NETWORK_REQUEST_BYTES = 512 * 1024
private const val MAX_NETWORK_RESPONSE_BYTES = 34 * 1024 * 1024
private val NETWORK_HEADERS = setOf("accept", "authorization", "content-type", "x-goog-api-key")

@InvokeArg
class SecretSaveArgs {
    lateinit var slot: String
    lateinit var value: String
}

@InvokeArg
class SecretSlotArgs {
    lateinit var slot: String
}

@InvokeArg
class NetworkArgs {
    lateinit var requestId: String
    lateinit var url: String
    var method: String = "GET"
    var timeoutMs: Int = 10_000
    var maxBytes: Int = 4 * 1024 * 1024
    var headersJson: String = "{}"
    var bodyBase64: String? = null
}

@InvokeArg
class CancelArgs {
    lateinit var requestId: String
}

@InvokeArg
class SelectEpubArgs {
    lateinit var requestId: String
    lateinit var destination: String
}

@InvokeArg
class SelectDictionaryPackArgs {
    lateinit var requestId: String
    lateinit var destination: String
}

@InvokeArg
class SelectPortableBackupArgs {
    lateinit var requestId: String
    lateinit var destination: String
}

@InvokeArg
class SavePortableBackupArgs {
    lateinit var requestId: String
    lateinit var source: String
    lateinit var suggestedName: String
}

@InvokeArg
class DownloadDictionarySourceArgs {
    lateinit var requestId: String
    lateinit var url: String
    lateinit var destination: String
    var expectedBytes: Long = 0
    lateinit var gitBlobSha: String
}

@InvokeArg
class SystemTtsSpeakArgs {
    lateinit var requestId: String
    lateinit var text: String
    var locale: String = "en-US"
    var rate: Float = 1.0f
    var usage: String = "word"
}

@InvokeArg
class SpeechAudioArgs {
    lateinit var requestId: String
    lateinit var path: String
    var usage: String = "article"
}

@InvokeArg
class ShareDiagnosticBundleArgs {
    lateinit var path: String
}

@InvokeArg
class SyncDiscoveryStartArgs {
    var port: Int = 0
    lateinit var serviceName: String
    var attributesJson: String = "{}"
}

@TauriPlugin(permissions = [
    Permission(strings = [Manifest.permission.NEARBY_WIFI_DEVICES], alias = "nearbyWifi")
])
class FoundationPlugin(private val activity: Activity) : Plugin(activity) {
    private val executor = Executors.newCachedThreadPool()
    private val secureStore = FoundationSecureStore(activity)
    private val speechBridge = FoundationSpeechBridge(activity)
    private val discoveryBridge = FoundationDiscoveryBridge(activity)
    private val networkTransfers = TransferCancellationRegistry<HttpURLConnection>()
    private val cancelledImports = ConcurrentHashMap<String, AtomicBoolean>()
    private val safBridge = FoundationSafBridge(activity, executor, cancelledImports)
    private val activeDictionaryDownloads = ConcurrentHashMap<String, HttpsURLConnection>()
    private val cancelledDictionaryDownloads = ConcurrentHashMap.newKeySet<String>()
    @Volatile private var appWebView: WebView? = null

    override fun load(webView: WebView) {
        appWebView = webView
    }

    @Command
    fun syncDiscoveryStart(invoke: Invoke) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && getPermissionState("nearbyWifi") != PermissionState.GRANTED) {
            requestPermissionForAlias("nearbyWifi", invoke, "syncDiscoveryPermissionResult")
            return
        }
        startSyncDiscovery(invoke)
    }

    @PermissionCallback
    fun syncDiscoveryPermissionResult(invoke: Invoke) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && getPermissionState("nearbyWifi") != PermissionState.GRANTED) {
            invoke.reject("Nearby devices permission is required for local sync", "localNetworkPermissionDenied")
            return
        }
        startSyncDiscovery(invoke)
    }

    private fun startSyncDiscovery(invoke: Invoke) {
        discoveryBridge.start(invoke)
    }
    @Command
    fun syncDiscoverySnapshot(invoke: Invoke) {
        discoveryBridge.snapshot(invoke)
    }
    @Command
    fun syncDiscoveryRefresh(invoke: Invoke) {
        discoveryBridge.refresh(invoke)
    }
    @Command
    fun syncDiscoveryStop(invoke: Invoke) {
        discoveryBridge.stop()
        invoke.resolve()
    }
    @Command
    fun clearWebViewCache(invoke: Invoke) {
        activity.runOnUiThread {
            try {
                val webView = appWebView ?: return@runOnUiThread invoke.reject(
                    "WebView cache is unavailable", "storageUnavailable"
                )
                webView.clearCache(true)
                invoke.resolve()
            } catch (_: Throwable) {
                invoke.reject("WebView cache could not be cleared", "storageUnavailable")
            }
        }
    }

    @Command
    fun secretSave(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SecretSaveArgs::class.java)
            secureStore.save(args.slot, args.value)
            invoke.resolve()
        } catch (_: IllegalArgumentException) {
            invoke.reject("Secret value is invalid", "invalidInput")
        } catch (_: Throwable) {
            invoke.reject("Secure storage is unavailable", "secretUnavailable")
        }
    }

    @Command
    fun secretLoad(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SecretSlotArgs::class.java)
            val result = JSObject()
            result.put("value", secureStore.load(args.slot))
            invoke.resolve(result)
        } catch (_: Throwable) {
            invoke.reject("Saved secret cannot be read", "secretCorrupt")
        }
    }

    @Command
    fun secretStatus(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SecretSlotArgs::class.java)
            val result = JSObject()
            result.put("configured", secureStore.configured(args.slot))
            invoke.resolve(result)
        } catch (_: Throwable) {
            invoke.reject("Secure storage status is unavailable", "secretUnavailable")
        }
    }

    @Command
    fun secretDelete(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SecretSlotArgs::class.java)
            secureStore.delete(args.slot)
            invoke.resolve()
        } catch (_: Throwable) {
            invoke.reject("Saved secret cannot be deleted", "secretUnavailable")
        }
    }

    @Command
    fun networkExecute(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(NetworkArgs::class.java)
        } catch (_: Throwable) {
            return invoke.reject("Network request is invalid", "invalidInput")
        }
        val method = args.method.uppercase(Locale.ROOT)
        if (!Regex("^[a-f0-9-]{36}$", RegexOption.IGNORE_CASE).matches(args.requestId)
            || method !in setOf("GET", "POST") || args.timeoutMs !in 100..60_000
            || args.maxBytes !in 1..MAX_NETWORK_RESPONSE_BYTES) {
            return invoke.reject("Network request is invalid", "invalidInput")
        }
        if (!FoundationPolicy.isAllowedNetworkUrl(args.url)) {
            return invoke.reject("Only HTTPS requests are allowed", "invalidInput")
        }
        val uri = URI(args.url)
        val headers = try { JSObject(args.headersJson) } catch (_: Throwable) { null }
            ?: return invoke.reject("Network headers are invalid", "invalidInput")
        val headerValues = mutableMapOf<String, String>()
        val headerNames = headers.keys()
        while (headerNames.hasNext()) {
            val name = headerNames.next()
            val normalized = name.lowercase(Locale.ROOT)
            if (normalized !in NETWORK_HEADERS) {
                return invoke.reject("Network header is not allowed", "invalidInput")
            }
            val value = headers.optString(name, "")
            if (value.isEmpty() || value.length > 16 * 1024 || value.contains('\r') || value.contains('\n')) {
                return invoke.reject("Network header is invalid", "invalidInput")
            }
            headerValues[name] = value
        }
        val requestBody = try {
            args.bodyBase64?.let { Base64.decode(it, Base64.NO_WRAP) }
        } catch (_: Throwable) { null }
        if ((args.bodyBase64 != null && requestBody == null)
            || (requestBody?.size ?: 0) > MAX_NETWORK_REQUEST_BYTES
            || (method == "GET" && requestBody != null)) {
            return invoke.reject("Network request body is invalid", "invalidInput")
        }
        executor.execute {
            var connection: HttpsURLConnection? = null
            try {
                val proxy = ProxySelector.getDefault()?.select(uri)?.firstOrNull() ?: Proxy.NO_PROXY
                connection = URL(args.url).openConnection(proxy) as HttpsURLConnection
                networkTransfers.begin(args.requestId, connection)
                if (networkTransfers.isCancelled(args.requestId)) throw RequestCancelledException()
                connection.requestMethod = method
                connection.connectTimeout = args.timeoutMs
                connection.readTimeout = args.timeoutMs
                connection.instanceFollowRedirects = false
                connection.useCaches = false
                for ((name, value) in headerValues) connection.setRequestProperty(name, value)
                if (requestBody != null) {
                    connection.doOutput = true
                    connection.outputStream.use { output ->
                        output.write(requestBody)
                        output.flush()
                    }
                }
                connection.connect()
                val stream = if (connection.responseCode >= 400) connection.errorStream else connection.inputStream
                val buffer = ByteArray(8192)
                val output = ByteArrayOutputStream()
                while (stream != null) {
                    val read = stream.read(buffer)
                    if (read < 0) break
                    if (output.size() + read > args.maxBytes) {
                        throw ResponseTooLargeException()
                    }
                    output.write(buffer, 0, read)
                    if (networkTransfers.isCancelled(args.requestId)) throw RequestCancelledException()
                }
                val result = JSObject()
                result.put("status", connection.responseCode)
                result.put("bodyBytes", output.size())
                result.put("usedProxy", proxy != Proxy.NO_PROXY)
                result.put("bodyBase64", Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP))
                result.put("contentType", connection.contentType)
                invoke.resolve(result)
            } catch (_: RequestCancelledException) {
                rejectNetwork(invoke, NetworkFailure.CANCELLED)
            } catch (_: SocketTimeoutException) {
                rejectNetwork(invoke, NetworkFailure.TIMEOUT)
            } catch (_: SSLException) {
                rejectNetwork(invoke, NetworkFailure.TLS)
            } catch (_: UnknownHostException) {
                rejectNetwork(invoke, NetworkFailure.OFFLINE)
            } catch (_: ResponseTooLargeException) {
                rejectNetwork(invoke, NetworkFailure.RESPONSE_TOO_LARGE)
            } catch (_: Throwable) {
                rejectNetwork(invoke, if (networkTransfers.isCancelled(args.requestId)) NetworkFailure.CANCELLED else NetworkFailure.TRANSPORT)
            } finally {
                networkTransfers.finish(args.requestId)
                connection?.disconnect()
            }
        }
    }

    @Command
    fun networkCancel(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(CancelArgs::class.java)
            networkTransfers.requestCancel(args.requestId)?.disconnect()
            invoke.resolve()
        } catch (_: Throwable) {
            invoke.reject("Network cancellation failed", "networkTransport")
        }
    }

    @Command
    fun selectEpub(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(SelectEpubArgs::class.java)
        } catch (_: Throwable) {
            return invoke.reject("EPUB selection request is invalid", "invalidInput")
        }
        if (!Regex("^[a-f0-9-]{36}$", RegexOption.IGNORE_CASE).matches(args.requestId)
            || !isPrivateStagingPath(args.destination)) {
            return invoke.reject("EPUB selection request is invalid", "invalidInput")
        }
        cancelledImports[args.requestId] = AtomicBoolean(false)
        val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "application/epub+zip"
            putExtra(Intent.EXTRA_MIME_TYPES, arrayOf(
                "application/epub+zip",
                "application/zip",
                "application/octet-stream"
            ))
        }
        startActivityForResult(invoke, intent, "onEpubSelected")
    }

    @ActivityCallback
    fun onEpubSelected(invoke: Invoke, result: ActivityResult) {
        val args = try {
            invoke.parseArgs(SelectEpubArgs::class.java)
        } catch (_: Throwable) {
            return invoke.reject("EPUB selection request is invalid", "invalidInput")
        }
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            cancelledImports.remove(args.requestId)
            val response = JSObject()
            response.put("cancelled", true)
            return invoke.resolve(response)
        }
        safBridge.copySelectedDocument(
            invoke = invoke,
            uri = uri,
            requestId = args.requestId,
            destinationPath = args.destination,
            maxBytes = MAX_EPUB_BYTES,
            fallbackName = "publication.epub",
            errors = SafCopyErrors(
                cancelledCode = "importCancelled",
                cancelledMessage = "EPUB import was cancelled",
                tooLargeCode = "epubTooLarge",
                tooLargeMessage = "EPUB exceeds the size limit",
                readFailedCode = "importReadFailed",
                readFailedMessage = "EPUB could not be copied",
            ),
        )
    }
    @Command
    fun cancelEpubImport(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(CancelArgs::class.java)
            cancelledImports[args.requestId]?.set(true)
            invoke.resolve()
        } catch (_: Throwable) {
            invoke.reject("EPUB cancellation failed", "importCancelFailed")
        }
    }

    @Command
    fun selectPortableBackup(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(SelectPortableBackupArgs::class.java)
        } catch (_: Throwable) {
            return invoke.reject("Portable backup selection request is invalid", "invalidInput")
        }
        if (!isRequestId(args.requestId) || !isPrivateStagingPath(args.destination)) {
            return invoke.reject("Portable backup selection request is invalid", "invalidInput")
        }
        cancelledImports[args.requestId] = AtomicBoolean(false)
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "application/octet-stream"
            putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/octet-stream", "application/zip"))
        }
        startActivityForResult(invoke, intent, "onPortableBackupSelected")
    }

    @ActivityCallback
    fun onPortableBackupSelected(invoke: Invoke, result: ActivityResult) {
        val args = try {
            invoke.parseArgs(SelectPortableBackupArgs::class.java)
        } catch (_: Throwable) {
            return invoke.reject("Portable backup selection request is invalid", "invalidInput")
        }
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            cancelledImports.remove(args.requestId)
            val response = JSObject()
            response.put("cancelled", true)
            return invoke.resolve(response)
        }
        safBridge.copySelectedDocument(
            invoke, uri, args.requestId, args.destination, MAX_PORTABLE_BACKUP_BYTES,
            "portable.fprbackup",
            SafCopyErrors(
                "portableTransferCancelled", "Portable backup transfer was cancelled",
                "portableBackupTooLarge", "Portable backup exceeds the size limit",
                "portableBackupReadFailed", "Portable backup could not be copied",
            ),
        )
    }

    @Command
    fun savePortableBackup(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(SavePortableBackupArgs::class.java)
        } catch (_: Throwable) {
            return invoke.reject("Portable backup save request is invalid", "invalidInput")
        }
        val source = try { File(args.source).canonicalFile } catch (_: Throwable) { null }
        if (!isRequestId(args.requestId) || source == null || !isPrivateAppFile(source)
            || !source.isFile || source.length() !in 1..MAX_PORTABLE_BACKUP_BYTES
            || !Regex("^[^/\\\\]{1,180}\\.fprbackup$", RegexOption.IGNORE_CASE).matches(args.suggestedName)) {
            return invoke.reject("Portable backup save request is invalid", "invalidInput")
        }
        cancelledImports[args.requestId] = AtomicBoolean(false)
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "application/octet-stream"
            putExtra(Intent.EXTRA_TITLE, args.suggestedName)
        }
        startActivityForResult(invoke, intent, "onPortableBackupDestinationSelected")
    }

    @ActivityCallback
    fun onPortableBackupDestinationSelected(invoke: Invoke, result: ActivityResult) {
        val args = try {
            invoke.parseArgs(SavePortableBackupArgs::class.java)
        } catch (_: Throwable) {
            return invoke.reject("Portable backup save request is invalid", "invalidInput")
        }
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            cancelledImports.remove(args.requestId)
            val response = JSObject()
            response.put("cancelled", true)
            return invoke.resolve(response)
        }
        val cancellation = cancelledImports[args.requestId] ?: AtomicBoolean(true)
        executor.execute {
            try {
                val source = File(args.source).canonicalFile
                if (!isPrivateAppFile(source) || !source.isFile) throw IllegalArgumentException("invalid source")
                var copied = 0L
                source.inputStream().use { input ->
                    activity.contentResolver.openOutputStream(uri, "w").use { output ->
                        if (output == null) throw IllegalStateException("missing output stream")
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            if (cancellation.get()) throw ImportCancelledException()
                            val read = input.read(buffer)
                            if (read < 0) break
                            copied += read
                            if (copied > MAX_PORTABLE_BACKUP_BYTES) throw EpubTooLargeException()
                            output.write(buffer, 0, read)
                        }
                        output.flush()
                    }
                }
                val response = JSObject()
                response.put("cancelled", false)
                response.put("displayName", args.suggestedName)
                response.put("bytes", copied)
                invoke.resolve(response)
            } catch (_: ImportCancelledException) {
                try { activity.contentResolver.delete(uri, null, null) } catch (_: Throwable) {}
                invoke.reject("Portable backup save was cancelled", "portableTransferCancelled")
            } catch (_: Throwable) {
                try { activity.contentResolver.delete(uri, null, null) } catch (_: Throwable) {}
                invoke.reject("Portable backup could not be saved", "portableBackupWriteFailed")
            } finally {
                cancelledImports.remove(args.requestId)
            }
        }
    }

    @Command
    fun cancelPortableTransfer(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(CancelArgs::class.java)
            cancelledImports[args.requestId]?.set(true)
            invoke.resolve()
        } catch (_: Throwable) {
            invoke.reject("Portable transfer cancellation failed", "portableTransferCancelled")
        }
    }

    @Command
    fun openAppStorageSettings(invoke: Invoke) {
        try {
            val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.parse("package:${activity.packageName}")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            activity.startActivity(intent)
            invoke.resolve()
        } catch (_: Throwable) {
            invoke.reject("Application storage settings are unavailable", "storageSettingsUnavailable")
        }
    }

    @Command
    fun getPackageStorageInfo(invoke: Invoke) {
        try {
            val application = activity.applicationInfo
            val packageFiles = mutableListOf(File(application.sourceDir))
            application.splitSourceDirs?.forEach { packageFiles.add(File(it)) }
            application.nativeLibraryDir?.let { packageFiles.add(File(it)) }
            val response = JSObject()
            response.put("applicationBytes", packageFiles.distinctBy { it.absolutePath }.sumOf { pathBytes(it) })
            response.put("secretBytes", secureStore.storageBytes())
            invoke.resolve(response)
        } catch (_: Throwable) {
            invoke.reject("Package storage information is unavailable", "storageScanUnavailable")
        }
    }

    @Command
    fun selectDictionaryPack(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(SelectDictionaryPackArgs::class.java)
        } catch (_: Throwable) {
            return invoke.reject("Dictionary selection request is invalid", "invalidInput")
        }
        if (!Regex("^[a-f0-9-]{36}$", RegexOption.IGNORE_CASE).matches(args.requestId)
            || !isPrivateStagingPath(args.destination)) {
            return invoke.reject("Dictionary selection request is invalid", "invalidInput")
        }
        cancelledImports[args.requestId] = AtomicBoolean(false)
        val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "application/zip"
            putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/zip", "application/octet-stream"))
        }
        startActivityForResult(invoke, intent, "onDictionaryPackSelected")
    }

    @ActivityCallback
    fun onDictionaryPackSelected(invoke: Invoke, result: ActivityResult) {
        val args = try {
            invoke.parseArgs(SelectDictionaryPackArgs::class.java)
        } catch (_: Throwable) {
            return invoke.reject("Dictionary selection request is invalid", "invalidInput")
        }
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            cancelledImports.remove(args.requestId)
            val response = JSObject()
            response.put("cancelled", true)
            return invoke.resolve(response)
        }
        safBridge.copySelectedDocument(
            invoke, uri, args.requestId, args.destination, MAX_DICTIONARY_PACK_BYTES,
            "dictionary.fprdict",
            SafCopyErrors(
                "dictionaryInstallCancelled", "Dictionary pack copy was cancelled",
                "dictionaryPackTooLarge", "Dictionary pack exceeds the size limit",
                "dictionaryPackReadFailed", "Dictionary pack could not be copied",
            ),
        )
    }

    @Command
    fun cancelDictionaryPackInstall(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(CancelArgs::class.java)
            cancelledImports[args.requestId]?.set(true)
            invoke.resolve()
        } catch (_: Throwable) {
            invoke.reject("Dictionary cancellation failed", "dictionaryInstallCancelled")
        }
    }

    @Command
    fun downloadDictionarySource(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(DownloadDictionarySourceArgs::class.java)
        } catch (_: Throwable) {
            return invoke.reject("Dictionary download request is invalid", "invalidInput")
        }
        if (!Regex("^[a-f0-9-]{36}$", RegexOption.IGNORE_CASE).matches(args.requestId)
            || !isPrivateStagingPath(args.destination)
            || !isAllowedDictionarySource(args.url, args.expectedBytes, args.gitBlobSha)) {
            return invoke.reject("Dictionary download request is invalid", "invalidInput")
        }
        cancelledDictionaryDownloads.remove(args.requestId)
        executor.execute {
            val destination = File(args.destination)
            var connection: HttpsURLConnection? = null
            try {
                val uri = URI(args.url)
                val proxy = ProxySelector.getDefault()?.select(uri)?.firstOrNull() ?: Proxy.NO_PROXY
                connection = URL(args.url).openConnection(proxy) as HttpsURLConnection
                activeDictionaryDownloads[args.requestId] = connection
                connection.connectTimeout = 20_000
                connection.readTimeout = 30_000
                connection.instanceFollowRedirects = true
                connection.useCaches = false
                connection.connect()
                if (connection.responseCode !in 200..299) throw DictionaryDownloadException()
                if (connection.contentLengthLong >= 0 && connection.contentLengthLong != args.expectedBytes) {
                    throw DictionaryIntegrityException()
                }
                destination.parentFile?.mkdirs()
                val digest = MessageDigest.getInstance("SHA-1")
                digest.update("blob ${args.expectedBytes}\u0000".toByteArray(Charsets.UTF_8))
                var copied = 0L
                connection.inputStream.use { input ->
                    FileOutputStream(destination).use { output ->
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            if (cancelledDictionaryDownloads.contains(args.requestId)) {
                                throw ImportCancelledException()
                            }
                            val read = input.read(buffer)
                            if (read < 0) break
                            copied += read
                            if (copied > args.expectedBytes) throw DictionaryIntegrityException()
                            digest.update(buffer, 0, read)
                            output.write(buffer, 0, read)
                        }
                        output.flush()
                        output.fd.sync()
                    }
                }
                val actualSha = digest.digest().joinToString("") { "%02x".format(it) }
                if (copied != args.expectedBytes || actualSha != args.gitBlobSha.lowercase(Locale.ROOT)) {
                    throw DictionaryIntegrityException()
                }
                val response = JSObject()
                response.put("bytes", copied)
                response.put("usedProxy", proxy != Proxy.NO_PROXY)
                invoke.resolve(response)
            } catch (_: ImportCancelledException) {
                destination.delete()
                invoke.reject("Dictionary download was cancelled", "dictionaryInstallCancelled")
            } catch (_: DictionaryIntegrityException) {
                destination.delete()
                invoke.reject("Dictionary source integrity check failed", "dictionarySourceInvalid")
            } catch (_: Throwable) {
                destination.delete()
                if (cancelledDictionaryDownloads.contains(args.requestId)) {
                    invoke.reject("Dictionary download was cancelled", "dictionaryInstallCancelled")
                } else {
                    invoke.reject("Dictionary source download failed", "dictionaryDownloadFailed")
                }
            } finally {
                activeDictionaryDownloads.remove(args.requestId)
                cancelledDictionaryDownloads.remove(args.requestId)
                connection?.disconnect()
            }
        }
    }

    @Command
    fun cancelDictionarySourceDownload(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(CancelArgs::class.java)
            cancelledDictionaryDownloads.add(args.requestId)
            activeDictionaryDownloads.remove(args.requestId)?.disconnect()
            invoke.resolve()
        } catch (_: Throwable) {
            invoke.reject("Dictionary download cancellation failed", "dictionaryDownloadFailed")
        }
    }

    @Command
    fun systemTtsCapability(invoke: Invoke) {
        try {
            var engine: TextToSpeech? = null
            engine = TextToSpeech(activity) { status ->
                try {
                    val current = engine
                    val languages = if (status == TextToSpeech.SUCCESS) {
                        current?.availableLanguages ?: emptySet()
                    } else emptySet()
                    val response = JSObject()
                    response.put("available", status == TextToSpeech.SUCCESS)
                    response.put("defaultEngine", current?.defaultEngine)
                    response.put("englishAvailable", languages.any { it.language == Locale.ENGLISH.language })
                    response.put("languageCount", languages.size)
                    invoke.resolve(response)
                    current?.shutdown()
                } catch (_: Throwable) {
                    engine?.shutdown()
                    invoke.reject("System TTS capability is unavailable", "ttsUnavailable")
                }
            }
        } catch (_: Throwable) {
            invoke.reject("System TTS capability is unavailable", "ttsUnavailable")
        }
    }

    @Command
    fun systemTtsSpeak(invoke: Invoke) {
        val args = try { invoke.parseArgs(SystemTtsSpeakArgs::class.java) } catch (_: Throwable) {
            return invoke.reject("Speech request is invalid", "invalidInput")
        }
        if (!Regex("^[a-f0-9-]{36}$", RegexOption.IGNORE_CASE).matches(args.requestId)
            || args.text.isBlank() || args.text.length > 4_000 || args.rate !in 0.5f..2.0f
            || args.locale !in setOf("en-US", "en-GB") || args.usage !in setOf("word", "article")) {
            return invoke.reject("Speech request is invalid", "invalidInput")
        }
        speechBridge.speak(invoke, args)
    }

    @Command
    fun playSpeechAudio(invoke: Invoke) {
        val args = try { invoke.parseArgs(SpeechAudioArgs::class.java) } catch (_: Throwable) {
            return invoke.reject("Speech audio request is invalid", "invalidInput")
        }
        val file = try { File(args.path).canonicalFile } catch (_: Throwable) { null }
        val cache = activity.cacheDir.canonicalFile
        if (file == null || !file.isFile || !file.path.startsWith(cache.path + File.separator)
            || file.length() !in 1..(16L * 1024 * 1024) || args.usage !in setOf("word", "article")) {
            return invoke.reject("Speech audio request is invalid", "invalidInput")
        }
        speechBridge.play(invoke, file, args.usage)
    }

    @Command
    fun pauseSpeech(invoke: Invoke) {
        speechBridge.pause(invoke)
    }

    @Command
    fun resumeSpeech(invoke: Invoke) {
        speechBridge.resume(invoke)
    }

    @Command
    fun stopSpeech(invoke: Invoke) {
        speechBridge.stop()
        invoke.resolve()
    }

    @Command
    fun shareDiagnosticBundle(invoke: Invoke) {
        val args = try { invoke.parseArgs(ShareDiagnosticBundleArgs::class.java) } catch (_: Throwable) {
            return invoke.reject("Diagnostic bundle request is invalid", "invalidInput")
        }
        try {
            val root = File(activity.cacheDir, "diagnostics").canonicalFile
            val file = File(args.path).canonicalFile
            if (!file.path.startsWith(root.path + File.separator) || !file.isFile || file.extension.lowercase() != "zip" || file.length() > 32L * 1024 * 1024) {
                return invoke.reject("Diagnostic bundle is invalid", "invalidInput")
            }
            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = "application/zip"
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            activity.startActivity(Intent.createChooser(intent, "分享诊断包"))
            invoke.resolve()
        } catch (_: Throwable) {
            invoke.reject("Diagnostic bundle could not be shared", "shareUnavailable")
        }
    }

    override fun onStop() {
        speechBridge.stop()
        discoveryBridge.stop()
    }

    @Command
    fun factoryReset(invoke: Invoke) {
        try {
            secureStore.clearAll()
            invoke.resolve()
            val manager = activity.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            manager.clearApplicationUserData()
        } catch (_: Throwable) {
            invoke.reject("Factory reset could not start", "resetFailed")
        }
    }


    private fun isPrivateStagingPath(value: String): Boolean {
        return FoundationPolicy.isPrivateDescendant(File(activity.dataDir, ".staging"), File(value))
    }

    private fun isRequestId(value: String): Boolean =
        Regex("^[a-f0-9-]{36}$", RegexOption.IGNORE_CASE).matches(value)

    private fun rejectNetwork(invoke: Invoke, failure: NetworkFailure) {
        val mapped = FoundationPolicy.networkFailure(failure)
        invoke.reject(mapped.message, mapped.code)
    }

    private fun isPrivateAppFile(file: File): Boolean {
        return FoundationPolicy.isPrivateDescendant(activity.dataDir, file)
    }

    private fun pathBytes(file: File): Long {
        if (!file.exists() || java.nio.file.Files.isSymbolicLink(file.toPath())) return 0
        if (file.isFile) return file.length()
        return file.listFiles()?.sumOf { pathBytes(it) } ?: 0
    }

    private fun isAllowedDictionarySource(url: String, expectedBytes: Long, gitBlobSha: String): Boolean {
        return FoundationPolicy.isAllowedDictionarySource(url, expectedBytes, gitBlobSha)
    }


    private class RequestCancelledException : Exception()
private class ResponseTooLargeException : Exception()
private class DictionaryDownloadException : Exception()
private class DictionaryIntegrityException : Exception()
    private class ImportCancelledException : Exception()
    private class EpubTooLargeException : Exception()
}
