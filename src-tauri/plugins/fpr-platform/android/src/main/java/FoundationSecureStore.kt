package com.local.foreignpressreader.foundation

import android.app.Activity
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.system.Os
import android.util.Base64
import app.tauri.plugin.JSObject
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private const val KEY_ALIAS = "foreign-press-reader.credentials.v1"
private const val TRANSFORMATION = "AES/GCM/NoPadding"
private const val MAX_SECRET_BYTES = 16 * 1024
private val SLOT_PATTERN = Regex("^[a-z0-9][a-z0-9-]{0,63}$", RegexOption.IGNORE_CASE)

/** Keystore-backed credential adapter. The plugin facade never handles plaintext persistence. */
internal class FoundationSecureStore(private val activity: Activity) {
    fun save(slot: String, value: String) {
        requireSlot(slot)
        val plaintext = value.toByteArray(Charsets.UTF_8)
        require(plaintext.isNotEmpty() && plaintext.size <= MAX_SECRET_BYTES)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val envelope = JSObject().apply {
            put("version", 1)
            put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            put("ciphertext", Base64.encodeToString(cipher.doFinal(plaintext), Base64.NO_WRAP))
        }
        atomicWrite(secretFile(slot), envelope.toString().toByteArray(Charsets.UTF_8))
    }

    fun load(slot: String): String? {
        requireSlot(slot)
        val file = secretFile(slot)
        if (!file.exists()) return null
        val envelope = JSObject(String(file.readBytes(), Charsets.UTF_8))
        require(envelope.getInt("version") == 1)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        val iv = Base64.decode(envelope.getString("iv"), Base64.NO_WRAP)
        val encrypted = Base64.decode(envelope.getString("ciphertext"), Base64.NO_WRAP)
        cipher.init(Cipher.DECRYPT_MODE, loadKey(), GCMParameterSpec(128, iv))
        return String(cipher.doFinal(encrypted), Charsets.UTF_8)
    }

    fun configured(slot: String): Boolean {
        requireSlot(slot)
        return secretFile(slot).exists()
    }

    fun delete(slot: String) {
        requireSlot(slot)
        secretFile(slot).delete()
        if (secretDirectory().listFiles()?.none { it.isFile } != false) deleteKey()
    }

    fun clearAll() {
        secretDirectory().listFiles()?.forEach { it.delete() }
        deleteKey()
    }

    fun storageBytes(): Long = secretDirectory().walkTopDown()
        .filter { it.isFile && !java.nio.file.Files.isSymbolicLink(it.toPath()) }
        .sumOf { it.length() }

    private fun requireSlot(slot: String) {
        require(SLOT_PATTERN.matches(slot))
    }

    private fun secretDirectory(): File =
        File(activity.noBackupFilesDir, "credentials-v1").also { it.mkdirs() }

    private fun secretFile(slot: String): File {
        val digest = MessageDigest.getInstance("SHA-256").digest(slot.toByteArray(Charsets.UTF_8))
        return File(secretDirectory(), digest.joinToString("") { "%02x".format(it) } + ".json")
    }

    private fun getOrCreateKey(): SecretKey {
        val existing = runCatching { loadKey() }.getOrNull()
        if (existing != null) return existing
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private fun loadKey(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore")
        store.load(null)
        return store.getKey(KEY_ALIAS, null) as? SecretKey ?: error("missing key")
    }

    private fun deleteKey() {
        val store = KeyStore.getInstance("AndroidKeyStore")
        store.load(null)
        if (store.containsAlias(KEY_ALIAS)) store.deleteEntry(KEY_ALIAS)
    }

    private fun atomicWrite(destination: File, bytes: ByteArray) {
        destination.parentFile?.mkdirs()
        val temporary = File(destination.parentFile, ".${destination.name}.${SecureRandom().nextLong()}.partial")
        try {
            temporary.outputStream().use { stream ->
                stream.write(bytes)
                stream.flush()
                stream.fd.sync()
            }
            Os.rename(temporary.absolutePath, destination.absolutePath)
        } finally {
            temporary.delete()
        }
    }
}
