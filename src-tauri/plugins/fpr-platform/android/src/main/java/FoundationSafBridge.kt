package com.local.foreignpressreader.foundation

import android.app.Activity
import android.database.Cursor
import android.net.Uri
import android.provider.OpenableColumns
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicBoolean

internal data class SafCopyErrors(
    val cancelledCode: String,
    val cancelledMessage: String,
    val tooLargeCode: String,
    val tooLargeMessage: String,
    val readFailedCode: String,
    val readFailedMessage: String,
)

/** Streams Storage Access Framework documents into private staging with bounded cleanup. */
internal class FoundationSafBridge(
    private val activity: Activity,
    private val executor: Executor,
    private val cancellations: ConcurrentHashMap<String, AtomicBoolean>,
) {
    fun copySelectedDocument(
        invoke: Invoke,
        uri: Uri,
        requestId: String,
        destinationPath: String,
        maxBytes: Long,
        fallbackName: String,
        errors: SafCopyErrors,
    ) {
        val cancellation = cancellations[requestId] ?: AtomicBoolean(true)
        executor.execute {
            val destination = File(destinationPath)
            try {
                destination.parentFile?.mkdirs()
                val metadata = queryMetadata(uri, fallbackName)
                if (metadata.second != null && metadata.second!! > maxBytes) throw TooLargeException()
                var copied = 0L
                activity.contentResolver.openInputStream(uri).use { input ->
                    if (input == null) error("missing input stream")
                    FileOutputStream(destination).use { output ->
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            if (cancellation.get()) throw CancelledException()
                            val read = input.read(buffer)
                            if (read < 0) break
                            copied += read
                            if (copied > maxBytes) throw TooLargeException()
                            output.write(buffer, 0, read)
                        }
                        output.flush()
                        output.fd.sync()
                    }
                }
                if (copied == 0L) error("empty selected document")
                invoke.resolve(JSObject().apply {
                    put("cancelled", false)
                    put("displayName", metadata.first)
                    put("bytes", copied)
                })
            } catch (_: CancelledException) {
                destination.delete()
                invoke.reject(errors.cancelledMessage, errors.cancelledCode)
            } catch (_: TooLargeException) {
                destination.delete()
                invoke.reject(errors.tooLargeMessage, errors.tooLargeCode)
            } catch (_: Throwable) {
                destination.delete()
                invoke.reject(errors.readFailedMessage, errors.readFailedCode)
            } finally {
                cancellations.remove(requestId)
            }
        }
    }

    private fun queryMetadata(uri: Uri, fallbackName: String): Pair<String, Long?> {
        var cursor: Cursor? = null
        return try {
            cursor = activity.contentResolver.query(
                uri,
                arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),
                null,
                null,
                null,
            )
            if (cursor != null && cursor.moveToFirst()) {
                val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                val name = if (nameIndex >= 0) cursor.getString(nameIndex) else null
                val size = if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) cursor.getLong(sizeIndex) else null
                Pair(name?.take(240) ?: fallbackName, size)
            } else {
                Pair(fallbackName, null)
            }
        } finally {
            cursor?.close()
        }
    }

    private class CancelledException : Exception()
    private class TooLargeException : Exception()
}
