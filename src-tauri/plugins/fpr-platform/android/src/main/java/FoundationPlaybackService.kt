package com.local.foreignpressreader.foundation

import android.app.*
import android.content.*
import android.content.pm.ServiceInfo
import android.media.*
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.*
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import app.tauri.annotation.InvokeArg
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import org.json.JSONObject
import java.io.File
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

@InvokeArg class SpeechQueueItemArgs { lateinit var id: String; lateinit var blockId: String; lateinit var text: String }
@InvokeArg class SpeechQueueArgs {
    lateinit var sessionId: String; lateinit var sourceId: String; lateinit var title: String
    lateinit var providerId: String; lateinit var items: List<SpeechQueueItemArgs>
    var locale = "en-US"; var rate = 1.0f; var startIndex = 0
}
@InvokeArg class SpeechQueueAudioArgs { lateinit var sessionId: String; lateinit var path: String; var index = 0 }
@InvokeArg class SpeechQueueControlArgs { lateinit var action: String; var index = 0; var sessionId = "" }

/** Playback and advancement live outside the WebView, including when the screen is locked. */
class FoundationPlaybackService : Service() {
    companion object {
        private const val CHANNEL = "reader-playback"
        private const val NOTIFICATION = 3104
        private val pending = ConcurrentHashMap<String, Pair<SpeechQueueArgs, Invoke>>()
        @Volatile internal var active: FoundationPlaybackService? = null
        @Volatile internal var lastState = state("idle", null, null, null, 0, 0, null, false)
        private fun state(status: String, session: String?, source: String?, item: String?, index: Int, total: Int, error: String?, buffering: Boolean) = JSObject().apply {
            put("status", status); put("sessionId", session ?: JSONObject.NULL); put("sourceId", source ?: JSONObject.NULL)
            put("itemId", item ?: JSONObject.NULL); put("index", index); put("total", total)
            put("error", error ?: JSONObject.NULL); put("buffering", buffering)
        }
        internal fun start(context: Context, args: SpeechQueueArgs, invoke: Invoke) {
            pending[args.sessionId] = Pair(args, invoke)
            try {
                val intent = Intent(context, FoundationPlaybackService::class.java).setAction("start").putExtra("sessionId", args.sessionId)
                if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
                Handler(Looper.getMainLooper()).postDelayed({ pending.remove(args.sessionId)?.second?.reject("Playback service did not start", "speechUnavailable") }, 10_000)
            } catch (_: Throwable) { pending.remove(args.sessionId); invoke.reject("Cannot start background playback", "speechUnavailable") }
        }
    }
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var session: MediaSession
    private lateinit var manager: AudioManager
    private lateinit var wakeLock: PowerManager.WakeLock
    private var focusRequest: AudioFocusRequest? = null
    private var queue: SpeechQueueArgs? = null
    private var index = 0
    private var paused = false
    private var pausedForFocus = false
    private var buffering = false
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var generation = 0L
    private var systemAudioDirectory: File? = null
    private var pendingSystemAudio: File? = null
    private var player: MediaPlayer? = null
    private val files = mutableMapOf<Int, File>()
    private val focusListener = AudioManager.OnAudioFocusChangeListener { change -> handler.post {
        when (change) {
            AudioManager.AUDIOFOCUS_LOSS -> finish()
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> { pausedForFocus = !paused; pause() }
            AudioManager.AUDIOFOCUS_GAIN -> if (pausedForFocus) { pausedForFocus = false; resume() }
        }
    } }
    private val noisy = object : BroadcastReceiver() { override fun onReceive(context: Context?, intent: Intent?) { pausedForFocus = false; pause() } }
    override fun onCreate() {
        super.onCreate(); active = this
        manager = getSystemService(AUDIO_SERVICE) as AudioManager
        wakeLock = (getSystemService(POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:reader-playback")
        session = MediaSession(this, "ReaderPlayback").apply {
            @Suppress("DEPRECATION")
            setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS or MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS)
            setPlaybackToLocal(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            setCallback(object : MediaSession.Callback() {
                override fun onPlay() = resume()
                override fun onPause() { pausedForFocus = false; pause() }
                override fun onStop() = finish()
                override fun onSkipToNext() = neighbor(1)
                override fun onSkipToPrevious() = neighbor(-1)
            }, handler)
            isActive = true
        }
        if (Build.VERSION.SDK_INT >= 26) (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(NotificationChannel(CHANNEL, "文章朗读", NotificationManager.IMPORTANCE_LOW))
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(noisy, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY), RECEIVER_NOT_EXPORTED)
        else @Suppress("DEPRECATION") registerReceiver(noisy, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY))
    }
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            "start" -> {
                val next = pending.remove(intent.getStringExtra("sessionId"))
                if (next == null) { if (queue == null) stopSelf(); return START_NOT_STICKY }
                generation++; releasePlayer(); tts?.stop(); files.clear(); clearSystemAudio()
                session.isActive = true
                queue = next.first; index = next.first.startIndex; paused = false; pausedForFocus = false
                try {
                    publish()
                    if (!requestFocus()) throw IllegalStateException()
                    next.second.resolve(); playCurrent()
                } catch (_: Throwable) { next.second.reject("Audio focus is unavailable", "audioFocusDenied"); finish("无法启动朗读") }
            }
            "pause" -> { pausedForFocus = false; pause() }
            "play" -> resume()
            "next" -> neighbor(1)
            "previous" -> neighbor(-1)
            "stop" -> finish()
        }
        return START_NOT_STICKY
    }
    private fun requestFocus(): Boolean {
        return if (Build.VERSION.SDK_INT >= 26) {
            val request = focusRequest ?: AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                .setWillPauseWhenDucked(true).setOnAudioFocusChangeListener(focusListener, handler).build().also { focusRequest = it }
            manager.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        } else @Suppress("DEPRECATION") (manager.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED)
    }
    internal fun supply(args: SpeechQueueAudioArgs) {
        if (queue?.sessionId != args.sessionId || args.index !in queue!!.items.indices) return
        files[args.index] = File(args.path)
        if (args.index == index && !paused && buffering) playCurrent()
    }
    internal fun control(args: SpeechQueueControlArgs) {
        when (args.action) {
            "pause" -> { pausedForFocus = false; pause() }
            "resume" -> resume()
            "stop" -> finish()
            "seek" -> seek(args.index)
            "error" -> if (args.sessionId == queue?.sessionId) finish("语音准备失败，请检查语音设置或网络后重试")
        }
    }
    private fun playCurrent() {
        val current = queue ?: return
        if (paused) return
        if (index !in current.items.indices) { finish(); return }
        generation++; val run = generation
        releasePlayer()
        if (!wakeLock.isHeld) wakeLock.acquire(2 * 60 * 60 * 1000L)
        val available = files[index]?.takeIf { it.isFile }
        if (available != null) { playAudio(available, run); return }
        files.remove(index)
        buffering = true; publish()
        if (current.providerId != "system") return
        if (!ttsReady) {
            if (tts == null) tts = TextToSpeech(applicationContext) { result -> handler.post {
                if (queue == null) return@post
                if (result != TextToSpeech.SUCCESS) { finish("系统英语语音不可用"); return@post }
                ttsReady = true
                tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(id: String?) = Unit
                    override fun onDone(id: String?) { handler.post {
                        if (id != generation.toString()) return@post
                        val audio = pendingSystemAudio ?: return@post
                        pendingSystemAudio = null
                        files[index] = audio
                        if (!paused) playAudio(audio, generation)
                    } }
                    @Deprecated("Required legacy TTS callback")
                    override fun onError(id: String?) { handler.post { if (id == generation.toString()) finish("系统语音合成失败") } }
                })
                playCurrent()
            } }
            return
        }
        if ((tts?.setLanguage(Locale.forLanguageTag(current.locale)) ?: TextToSpeech.LANG_NOT_SUPPORTED) < TextToSpeech.LANG_AVAILABLE) { finish("系统英语语音不可用"); return }
        tts?.setSpeechRate(current.rate.toFloat())
        val directory = systemAudioDirectory ?: File(cacheDir, "speech-queue-" + current.sessionId).also { it.mkdirs(); systemAudioDirectory = it }
        // Keep just the current/previous chunks; a backward jump can regenerate older audio.
        files.keys.filter { it < index - 1 || it > index }.toList().forEach { old -> files.remove(old)?.delete() }
        val file = File(directory, "$index-$run.wav")
        pendingSystemAudio = file
        if (tts?.synthesizeToFile(current.items[index].text, Bundle(), file, run.toString()) == TextToSpeech.ERROR) finish("系统语音合成失败")
    }
    private fun playAudio(file: File, run: Long) {
        buffering = true; publish()
        try {
            player = MediaPlayer().also { audio ->
                audio.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                audio.setDataSource(file.absolutePath)
                audio.setOnPreparedListener { if (run == generation && queue != null) { buffering = false; if (!paused) it.start(); publish() } }
                audio.setOnCompletionListener { if (run == generation && !paused) { index++; playCurrent() } }
                audio.setOnErrorListener { _, _, _ -> if (run == generation) finish("语音音频无法播放"); true }
                audio.prepareAsync()
            }
        } catch (_: Throwable) { finish("语音音频无法播放") }
    }
    private fun clearSystemAudio() {
        pendingSystemAudio = null
        systemAudioDirectory?.deleteRecursively()
        systemAudioDirectory = null
    }
    private fun pause() {
        if (queue == null || paused) return
        paused = true
        try { if (!buffering) player?.pause() } catch (_: Throwable) {}
        if (wakeLock.isHeld) wakeLock.release()
        publish()
    }
    private fun resume() {
        if (queue == null || !paused) return
        paused = false; pausedForFocus = false
        publish()
        if (!requestFocus()) { finish("音频焦点不可用"); return }
        if (player != null && !buffering) {
            if (!wakeLock.isHeld) wakeLock.acquire(2 * 60 * 60 * 1000L)
            try { player?.start(); publish() } catch (_: Throwable) { finish("语音音频无法播放") }
        } else playCurrent()
    }
    private fun neighbor(direction: Int) {
        val items = queue?.items ?: return
        val block = items.getOrNull(index)?.blockId
        var next = index + direction
        while (next in items.indices && items[next].blockId == block) next += direction
        if (direction < 0 && next in items.indices) { val previous = items[next].blockId; while (next > 0 && items[next - 1].blockId == previous) next-- }
        if (next in items.indices) seek(next)
    }
    private fun seek(next: Int) {
        if (next !in (queue?.items?.indices ?: return)) return
        generation++; tts?.stop(); releasePlayer(); index = next;
        if (!paused) playCurrent() else publish()
    }
    private fun releasePlayer() { try { player?.release() } catch (_: Throwable) {}; player = null }
    private fun action(name: String): PendingIntent = PendingIntent.getService(this, name.hashCode(), Intent(this, FoundationPlaybackService::class.java).setAction(name), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    private fun publish() {
        val current = queue ?: return
        val item = current.items.getOrNull(index)
        lastState = state(if (paused) "paused" else "playing", current.sessionId, current.sourceId, item?.id, index, current.items.size, null, buffering)
        session.setMetadata(MediaMetadata.Builder().putString(MediaMetadata.METADATA_KEY_TITLE, current.title).putString(MediaMetadata.METADATA_KEY_ARTIST, "${index + 1} / ${current.items.size} 段").build())
        session.setPlaybackState(PlaybackState.Builder().setActions(PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_STOP or PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS)
            .setState(if (paused) PlaybackState.STATE_PAUSED else if (buffering) PlaybackState.STATE_BUFFERING else PlaybackState.STATE_PLAYING, PlaybackState.PLAYBACK_POSITION_UNKNOWN, if (paused) 0f else 1f).build())
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(this)
        packageManager.getLaunchIntentForPackage(packageName)?.let { launch -> builder.setContentIntent(PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)) }
        val notification = builder.setSmallIcon(android.R.drawable.ic_media_play).setContentTitle(current.title).setContentText(if (paused) "朗读已暂停" else if (buffering) "正在准备语音…" else "${index + 1} / ${current.items.size} 段")
            .setOnlyAlertOnce(true).setOngoing(!paused).setVisibility(Notification.VISIBILITY_PRIVATE)
            .addAction(android.R.drawable.ic_media_previous, "上一段", action("previous"))
            .addAction(if (paused) android.R.drawable.ic_media_play else android.R.drawable.ic_media_pause, if (paused) "继续" else "暂停", action(if (paused) "play" else "pause"))
            .addAction(android.R.drawable.ic_media_next, "下一段", action("next"))
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "停止", action("stop"))
            .setDeleteIntent(action("stop"))
            .setStyle(Notification.MediaStyle().setMediaSession(session.sessionToken).setShowActionsInCompactView(0,1,2)).build()
        if (paused) { stopForeground(STOP_FOREGROUND_DETACH); (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIFICATION, notification) }
        else if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        else startForeground(NOTIFICATION, notification)
    }
    private fun finish(error: String? = null) {
        val old = queue
        generation++; queue = null; files.clear(); releasePlayer(); tts?.stop(); clearSystemAudio()
        if (wakeLock.isHeld) wakeLock.release()
        if (Build.VERSION.SDK_INT >= 26) focusRequest?.let { manager.abandonAudioFocusRequest(it) }
        else @Suppress("DEPRECATION") manager.abandonAudioFocus(focusListener)
        lastState = state(if (error == null) "idle" else "error", old?.sessionId, if (error == null) null else old?.sourceId, null, 0, 0, error, false)
        stopForeground(STOP_FOREGROUND_REMOVE); session.isActive = false; stopSelf()
    }
    override fun onTaskRemoved(rootIntent: Intent?) { finish(); super.onTaskRemoved(rootIntent) }
    override fun onDestroy() {
        generation++; queue = null; releasePlayer(); tts?.shutdown(); tts = null; clearSystemAudio()
        if (wakeLock.isHeld) wakeLock.release()
        try { unregisterReceiver(noisy) } catch (_: Throwable) {}
        session.release()
        if (active === this) { active = null; if (lastState.optString("status") != "error") lastState = state("idle", null, null, null, 0, 0, null, false) }
        super.onDestroy()
    }
}
