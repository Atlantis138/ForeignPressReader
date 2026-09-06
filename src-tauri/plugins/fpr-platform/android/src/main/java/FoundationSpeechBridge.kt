package com.local.foreignpressreader.foundation

import android.app.Activity
import android.content.Context
import android.media.AudioManager
import android.media.MediaPlayer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import app.tauri.plugin.Invoke
import java.io.File
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

/** Owns audio focus and native player/TTS lifecycles behind the command facade. */
internal class FoundationSpeechBridge(private val activity: Activity) {
    private val audioManager = activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    @Volatile private var activeTts: TextToSpeech? = null
    @Volatile private var activePlayer: MediaPlayer? = null
    @Volatile private var activeInvoke: Invoke? = null
    @Volatile private var activeSettled: AtomicBoolean? = null
    private var ttsEpoch = 0L
    private var ttsReady = false
    private var pendingSpeak: (() -> Unit)? = null
    private var requestGeneration = 0L
    private val audioFocusListener = AudioManager.OnAudioFocusChangeListener { change ->
        if (change == AudioManager.AUDIOFOCUS_LOSS ||
            change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT ||
            change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK
        ) stop()
    }

    fun speak(invoke: Invoke, args: SystemTtsSpeakArgs) = activity.runOnUiThread {
        stop()
        if (!requestFocus(args.usage)) {
            invoke.reject("Audio focus is unavailable", "audioFocusDenied")
            return@runOnUiThread
        }
        val generation = ++requestGeneration
        activeInvoke = invoke
        activeSettled = AtomicBoolean(false)
        val utteranceId = generation.toString()
        pendingSpeak = {
            if (generation == requestGeneration) {
                val current = activeTts
                if (current == null || current.setLanguage(Locale.forLanguageTag(args.locale)) < TextToSpeech.LANG_AVAILABLE) {
                    finish("English system voice is unavailable", "speechUnavailable")
                } else {
                    current.setSpeechRate(args.rate)
                    if (current.speak(args.text.trim(), TextToSpeech.QUEUE_FLUSH, null, utteranceId) == TextToSpeech.ERROR) {
                        finish("System TTS failed", "speechUnavailable")
                    }
                }
            }
        }
        try {
            if (ttsReady) {
                pendingSpeak?.invoke()
                pendingSpeak = null
            } else if (activeTts == null) {
                val epoch = ++ttsEpoch
                activeTts = TextToSpeech(activity.applicationContext) { status ->
                    activity.runOnUiThread initialized@{
                        if (epoch != ttsEpoch) return@initialized
                        if (status != TextToSpeech.SUCCESS) {
                            finish("System TTS is unavailable", "speechUnavailable")
                            release()
                        } else {
                            ttsReady = true
                            activeTts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                                override fun onStart(utteranceId: String?) = Unit
                                override fun onDone(utteranceId: String?) = completeUtterance(utteranceId)
                                override fun onError(utteranceId: String?) = completeUtterance(utteranceId, "System TTS failed")
                                override fun onStop(utteranceId: String?, interrupted: Boolean) = completeUtterance(utteranceId)
                            })
                            pendingSpeak?.invoke()
                            pendingSpeak = null
                        }
                    }
                }
            }
        } catch (_: Throwable) {
            finish("System TTS is unavailable", "speechUnavailable")
            release()
        }
    }

    private fun completeUtterance(id: String?, error: String? = null) = activity.runOnUiThread {
        if (id == requestGeneration.toString()) finish(error)
    }

    fun release() = activity.runOnUiThread {
        ttsEpoch++
        stop()
        try { activeTts?.shutdown() } catch (_: Throwable) {}
        activeTts = null
        ttsReady = false
    }

    fun play(invoke: Invoke, file: File, usage: String) {
        stop()
        if (!requestFocus(usage)) return invoke.reject("Audio focus is unavailable", "audioFocusDenied")
        activeInvoke = invoke
        activeSettled = AtomicBoolean(false)
        val generation = ++requestGeneration
        activity.runOnUiThread {
            if (generation != requestGeneration) return@runOnUiThread
            try {
                val player = MediaPlayer()
                activePlayer = player
                player.setOnCompletionListener { if (generation == requestGeneration) finish() }
                player.setOnErrorListener { _, _, _ ->
                    if (generation == requestGeneration) finish("Speech audio playback failed", "speechUnavailable")
                    true
                }
                player.setDataSource(file.absolutePath)
                player.setOnPreparedListener { if (generation == requestGeneration) it.start() }
                player.prepareAsync()
            } catch (_: Throwable) {
                finish("Speech audio playback failed", "speechUnavailable")
            }
        }
    }

    fun pause(invoke: Invoke) {
        try {
            activePlayer?.takeIf { it.isPlaying }?.pause()
            invoke.resolve()
        } catch (_: Throwable) {
            invoke.reject("Speech pause failed", "speechUnavailable")
        }
    }

    fun resume(invoke: Invoke) {
        try {
            activePlayer?.takeIf { !it.isPlaying }?.start()
            invoke.resolve()
        } catch (_: Throwable) {
            invoke.reject("Speech resume failed", "speechUnavailable")
        }
    }

    @Synchronized
    fun stop() {
        requestGeneration++
        pendingSpeak = null
        try { activeTts?.stop() } catch (_: Throwable) {}
        try { activePlayer?.stop() } catch (_: Throwable) {}
        finish()
    }

    private fun requestFocus(usage: String): Boolean {
        val gain = if (usage == "word") {
            AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK
        } else {
            AudioManager.AUDIOFOCUS_GAIN
        }
        return audioManager.requestAudioFocus(
            audioFocusListener,
            AudioManager.STREAM_MUSIC,
            gain,
        ) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }

    @Synchronized
    private fun finish(message: String? = null, code: String? = null) {
        val settled = activeSettled
        if (settled != null && settled.compareAndSet(false, true)) {
            val pending = activeInvoke
            if (message == null) pending?.resolve() else pending?.reject(message, code ?: "speechUnavailable")
        }
        try { activePlayer?.release() } catch (_: Throwable) {}
        activePlayer = null
        activeInvoke = null
        activeSettled = null
        audioManager.abandonAudioFocus(audioFocusListener)
    }
}
