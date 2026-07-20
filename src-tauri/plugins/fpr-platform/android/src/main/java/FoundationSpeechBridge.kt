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
    private val audioFocusListener = AudioManager.OnAudioFocusChangeListener { change ->
        if (change == AudioManager.AUDIOFOCUS_LOSS ||
            change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT ||
            change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK
        ) stop()
    }

    fun speak(invoke: Invoke, args: SystemTtsSpeakArgs) {
        stop()
        if (!requestFocus(args.usage)) return invoke.reject("Audio focus is unavailable", "audioFocusDenied")
        activeInvoke = invoke
        activeSettled = AtomicBoolean(false)
        activity.runOnUiThread {
            try {
                var engine: TextToSpeech? = null
                engine = TextToSpeech(activity) { status ->
                    val current = engine
                    if (status != TextToSpeech.SUCCESS || current == null) {
                        finish("System TTS is unavailable", "speechUnavailable")
                        return@TextToSpeech
                    }
                    activeTts = current
                    current.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                        override fun onStart(utteranceId: String?) = Unit
                        override fun onDone(utteranceId: String?) = finish()
                        override fun onError(utteranceId: String?) =
                            finish("System TTS failed", "speechUnavailable")
                        override fun onStop(utteranceId: String?, interrupted: Boolean) = finish()
                    })
                    if (current.setLanguage(Locale.forLanguageTag(args.locale)) < TextToSpeech.LANG_AVAILABLE) {
                        finish("English system voice is unavailable", "speechUnavailable")
                        return@TextToSpeech
                    }
                    current.setSpeechRate(args.rate)
                    if (current.speak(args.text.trim(), TextToSpeech.QUEUE_FLUSH, null, args.requestId) == TextToSpeech.ERROR) {
                        finish("System TTS failed", "speechUnavailable")
                    }
                }
            } catch (_: Throwable) {
                finish("System TTS is unavailable", "speechUnavailable")
            }
        }
    }

    fun play(invoke: Invoke, file: File, usage: String) {
        stop()
        if (!requestFocus(usage)) return invoke.reject("Audio focus is unavailable", "audioFocusDenied")
        activeInvoke = invoke
        activeSettled = AtomicBoolean(false)
        activity.runOnUiThread {
            try {
                val player = MediaPlayer()
                activePlayer = player
                player.setOnCompletionListener { finish() }
                player.setOnErrorListener { _, _, _ ->
                    finish("Speech audio playback failed", "speechUnavailable")
                    true
                }
                player.setDataSource(file.absolutePath)
                player.setOnPreparedListener { it.start() }
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
        try { activeTts?.shutdown() } catch (_: Throwable) {}
        try { activePlayer?.release() } catch (_: Throwable) {}
        activeTts = null
        activePlayer = null
        activeInvoke = null
        activeSettled = null
        audioManager.abandonAudioFocus(audioFocusListener)
    }
}
