package com.aletheia.app

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile

/**
 * AudioRecorderService — the foreground service that records microphone audio.
 *
 * Two modes:
 *   - one-shot: record N seconds to a WAV file, broadcast it, stop the service.
 *   - continuous: keep one AudioRecord open and emit back-to-back N-second WAV
 *     chunks until ACTION_STOP arrives. This is what the auto-listen loop uses.
 *
 * Continuous mode is not a JS loop over the one-shot path for two reasons.
 * The microphone would be closed for the whole transcribe + verify round trip,
 * so most of what is playing would never be recorded; and restarting a
 * foreground service while the user is inside TikTok runs into the Android 12+
 * background-start restriction. Holding one AudioRecord open avoids both.
 *
 * The floating widget display that previously lived here moved out: the
 * bubble + verdict card now live in FloatingWidgetService (WebView-based,
 * porting the extension UI). This service only records — it no longer draws
 * anything over other apps.
 */
class AudioRecorderService : Service() {

    companion object {
        const val CHANNEL_ID = "aletheia_recording"
        const val NOTIFICATION_ID = 1
        const val ACTION_START = "com.aletheia.app.START_RECORDING"
        const val ACTION_STOP = "com.aletheia.app.STOP_RECORDING"
        const val EXTRA_MAX_DURATION_MS = "max_duration_ms"
        const val EXTRA_OUTPUT_PATH = "output_path"
        const val EXTRA_CONTINUOUS = "continuous"

        /** Chunk files are named so stale ones can be swept on the next start. */
        const val CHUNK_PREFIX = "aletheia_chunk_"

        const val SAMPLE_RATE = 16000
        const val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO
        const val AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT
        const val AMPLITUDE_BROADCAST_INTERVAL_MS = 100L
    }

    private var audioRecord: AudioRecord? = null
    private var recordingThread: Thread? = null
    @Volatile private var isRecording = false
    private var outputPath: String? = null
    private var continuous = false
    private var lastAmplitudeBroadcastMs = 0L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                val maxDuration = intent.getLongExtra(EXTRA_MAX_DURATION_MS, 15000L)
                val path = intent.getStringExtra(EXTRA_OUTPUT_PATH)
                    ?: File(cacheDir, "aletheia_recording_${System.currentTimeMillis()}.wav").absolutePath
                startRecording(path, maxDuration, intent.getBooleanExtra(EXTRA_CONTINUOUS, false))
            }
            ACTION_STOP -> {
                stopRecording()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Aletheia Recording",
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply {
                description = "Shows while Aletheia is listening to audio"
                setShowBadge(true)
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        val stopIntent = Intent(this, AudioRecorderService::class.java).apply {
            action = ACTION_STOP
        }
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        val stopPendingIntent = PendingIntent.getService(this, 0, stopIntent, flags)

        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val launchPendingIntent = if (launchIntent != null) {
            PendingIntent.getActivity(this, 0, launchIntent, flags)
        } else null

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Aletheia is listening")
            .setContentText(
                if (continuous) "Auto-checking what is playing. Tap to return to app."
                else "Listening to audio stream... Tap to return to app."
            )
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .addAction(
                android.R.drawable.ic_menu_close_clear_cancel,
                "STOP LISTENING",
                stopPendingIntent
            )

        if (launchPendingIntent != null) {
            builder.setContentIntent(launchPendingIntent)
        }

        return builder.build()
    }

    private fun startRecording(path: String, maxDurationMs: Long, continuousMode: Boolean = false) {
        if (isRecording) {
            broadcastError("Recorder is already running")
            return
        }

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED) {
            broadcastError("Microphone permission not granted")
            stopSelf()
            return
        }

        outputPath = path
        continuous = continuousMode
        if (continuous) sweepStaleChunks()

        // Start as foreground service FIRST
        startForeground(NOTIFICATION_ID, buildNotification())

        try {
            val bufferSize = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT)
            if (bufferSize <= 0) throw IllegalStateException("Unsupported audio recorder configuration")
            audioRecord = AudioRecord(
                MediaRecorder.AudioSource.MIC,
                SAMPLE_RATE,
                CHANNEL_CONFIG,
                AUDIO_FORMAT,
                bufferSize * 2
            )

            if (audioRecord?.state != AudioRecord.STATE_INITIALIZED) {
                throw IllegalStateException("Could not initialize the microphone")
            }

            isRecording = true
            audioRecord?.startRecording()

            recordingThread = Thread {
                if (continuous) recordChunks(bufferSize, maxDurationMs)
                else writeWavFile(path, bufferSize, maxDurationMs)
            }.apply { start() }
        } catch (e: Exception) {
            releaseRecorder()
            broadcastError(e.message ?: "Could not start the microphone")
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private fun writeWavFile(path: String, bufferSize: Int, maxDurationMs: Long) {
        var bytes = 0L
        try {
            bytes = writeChunk(path, bufferSize, maxDurationMs)
            writeWavHeader(path, bytes)
            broadcastComplete(path)
        } catch (e: Exception) {
            File(path).delete()
            broadcastError(e.message ?: "Could not record audio")
        } finally {
            releaseRecorder()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    /**
     * Continuous mode: emit one finished WAV every maxDurationMs while the
     * microphone stays open, so the next window is already being captured
     * while the previous one is still in transcription.
     *
     * The window that is cut short by ACTION_STOP is deleted rather than
     * broadcast — otherwise stopping would kick off one more round trip whose
     * result nobody is waiting for.
     */
    private fun recordChunks(bufferSize: Int, maxDurationMs: Long) {
        try {
            while (isRecording) {
                val path = File(cacheDir, "$CHUNK_PREFIX${System.currentTimeMillis()}.wav").absolutePath
                val bytes = writeChunk(path, bufferSize, maxDurationMs)
                writeWavHeader(path, bytes)

                if (isRecording && bytes > 0) {
                    broadcastComplete(path)
                } else {
                    File(path).delete()
                }
            }
        } catch (e: Exception) {
            broadcastError(e.message ?: "Auto-listen recording failed")
        } finally {
            releaseRecorder()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    /**
     * Write a single window of PCM to [path] behind a placeholder header and
     * return the number of audio bytes written. Leaves the AudioRecord open.
     */
    private fun writeChunk(path: String, bufferSize: Int, maxDurationMs: Long): Long {
        val fos = FileOutputStream(File(path))

        // Write WAV header placeholder (44 bytes)
        fos.write(ByteArray(44))

        val buffer = ShortArray(bufferSize)
        var totalBytesWritten = 0L
        val startTime = System.currentTimeMillis()
        val maxBytes = (SAMPLE_RATE * 2 * maxDurationMs / 1000).toLong() // 16-bit mono

        try {
            while (isRecording && totalBytesWritten < maxBytes) {
                val elapsed = System.currentTimeMillis() - startTime
                if (elapsed >= maxDurationMs) break

                val read = audioRecord?.read(buffer, 0, bufferSize) ?: -1
                if (read > 0) {
                    val byteBuffer = ByteArray(read * 2)
                    for (i in 0 until read) {
                        byteBuffer[i * 2] = (buffer[i].toInt() and 0xFF).toByte()
                        byteBuffer[i * 2 + 1] = (buffer[i].toInt() shr 8 and 0xFF).toByte()
                    }
                    fos.write(byteBuffer)
                    totalBytesWritten += byteBuffer.size

                    // Bridge/UI updates are much slower than AudioRecord reads.
                    // Throttle broadcasts so amplitude animation cannot force a
                    // full React render for every native buffer.
                    val now = System.currentTimeMillis()
                    if (now - lastAmplitudeBroadcastMs >= AMPLITUDE_BROADCAST_INTERVAL_MS) {
                        lastAmplitudeBroadcastMs = now
                        broadcastAmplitude(calculateRms(buffer, read))
                    }
                }
            }
        } finally {
            fos.close()
        }

        return totalBytesWritten
    }

    private fun releaseRecorder() {
        isRecording = false
        try {
            audioRecord?.stop()
        } catch (_: Exception) {}
        audioRecord?.release()
        audioRecord = null
    }

    /** Chunks are ~480 KB each, so a crashed session must not leave them behind. */
    private fun sweepStaleChunks() {
        try {
            cacheDir.listFiles { f -> f.name.startsWith(CHUNK_PREFIX) }?.forEach { it.delete() }
        } catch (_: Exception) {}
    }

    private fun calculateRms(buffer: ShortArray, length: Int): Float {
        var sum = 0.0
        for (i in 0 until length) {
            val normalized = buffer[i].toFloat() / Short.MAX_VALUE
            sum += normalized * normalized
        }
        return Math.sqrt(sum / length).toFloat()
    }

    private fun broadcastAmplitude(amplitude: Float) {
        val intent = Intent("com.aletheia.app.AMPLITUDE")
        intent.setPackage(packageName)
        intent.putExtra("amplitude", amplitude)
        sendBroadcast(intent)
    }

    private fun broadcastComplete(filePath: String) {
        val intent = Intent("com.aletheia.app.RECORDING_COMPLETE")
        intent.setPackage(packageName)
        intent.putExtra("filePath", filePath)
        sendBroadcast(intent)
    }

    private fun broadcastError(message: String) {
        val intent = Intent("com.aletheia.app.RECORDING_ERROR")
        intent.setPackage(packageName)
        intent.putExtra("message", message)
        sendBroadcast(intent)
    }

    private fun writeWavHeader(path: String, dataSize: Long) {
        val raf = RandomAccessFile(File(path), "rw")
        val totalSize = dataSize + 36

        raf.seek(0)
        // RIFF header
        raf.writeBytes("RIFF")
        raf.writeInt(Integer.reverseBytes(totalSize.toInt()))
        raf.writeBytes("WAVE")

        // fmt sub-chunk
        raf.writeBytes("fmt ")
        raf.writeInt(Integer.reverseBytes(16)) // SubChunk1Size (PCM = 16)
        raf.writeShort(java.lang.Short.reverseBytes(1).toInt()) // AudioFormat (PCM = 1)
        raf.writeShort(java.lang.Short.reverseBytes(1).toInt()) // NumChannels (Mono = 1)
        raf.writeInt(Integer.reverseBytes(SAMPLE_RATE)) // SampleRate
        raf.writeInt(Integer.reverseBytes(SAMPLE_RATE * 2)) // ByteRate (SampleRate * NumChannels * BitsPerSample/8)
        raf.writeShort(java.lang.Short.reverseBytes(2).toInt()) // BlockAlign (NumChannels * BitsPerSample/8)
        raf.writeShort(java.lang.Short.reverseBytes(16).toInt()) // BitsPerSample

        // data sub-chunk
        raf.writeBytes("data")
        raf.writeInt(Integer.reverseBytes(dataSize.toInt()))

        raf.close()
    }

    private fun stopRecording() {
        isRecording = false
        recordingThread?.join(2000)
        recordingThread = null
    }

    override fun onDestroy() {
        stopRecording()
        super.onDestroy()
    }
}
