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
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.graphics.Typeface
import android.os.Handler
import android.os.Looper
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile

object FloatingWidgetController {
    private var serviceRef: AudioRecorderService? = null

    fun attachService(service: AudioRecorderService) {
        serviceRef = service
    }

    fun detachService() {
        serviceRef = null
    }

    fun updateText(text: String) {
        serviceRef?.updateWidgetStatus(text)
    }

    fun updateVerdict(verdict: String, claim: String, explanation: String) {
        serviceRef?.showVerdictCard(verdict, claim, explanation)
    }

    fun closeWidget() {
        serviceRef?.removeFloatingWidget()
    }
}

class AudioRecorderService : Service() {

    companion object {
        const val CHANNEL_ID = "aletheia_recording"
        const val NOTIFICATION_ID = 1
        const val ACTION_START = "com.aletheia.app.START_RECORDING"
        const val ACTION_STOP = "com.aletheia.app.STOP_RECORDING"
        const val EXTRA_MAX_DURATION_MS = "max_duration_ms"
        const val EXTRA_OUTPUT_PATH = "output_path"

        const val SAMPLE_RATE = 16000
        const val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO
        const val AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT
    }

    private var audioRecord: AudioRecord? = null
    private var recordingThread: Thread? = null
    private var isRecording = false
    private var outputPath: String? = null

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
                startRecording(path, maxDuration)
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
            .setContentText("Listening to audio stream... Tap to return to app.")
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

    private var windowManager: WindowManager? = null
    private var floatingContainer: FrameLayout? = null
    private var compactPillView: LinearLayout? = null
    private var verdictCardView: LinearLayout? = null
    private var statusTextView: TextView? = null
    private var verdictBadgeTextView: TextView? = null
    private var verdictClaimTextView: TextView? = null
    private var verdictExplanationTextView: TextView? = null

    fun updateWidgetStatus(text: String) {
        Handler(Looper.getMainLooper()).post {
            statusTextView?.text = text
        }
    }

    fun showVerdictCard(verdict: String, claim: String, explanation: String) {
        Handler(Looper.getMainLooper()).post {
            statusTextView?.text = "Klaim: $verdict"

            val badgeText = when (verdict) {
                "True" -> "BENAR"
                "False" -> "SALAH"
                "Misleading" -> "MENYESATKAN"
                else -> "BELUM DIVERIFIKASI"
            }
            val badgeBgColor = when (verdict) {
                "True" -> "#059669"
                "False" -> "#DC2626"
                "Misleading" -> "#D97706"
                else -> "#71717A"
            }

            verdictBadgeTextView?.text = badgeText
            (verdictBadgeTextView?.background as? GradientDrawable)?.setColor(Color.parseColor(badgeBgColor))

            verdictClaimTextView?.text = "Klaim: \"$claim\""
            verdictExplanationTextView?.text = explanation

            compactPillView?.visibility = View.GONE
            verdictCardView?.visibility = View.VISIBLE
        }
    }

    fun removeFloatingWidget() {
        FloatingWidgetController.detachService()
        floatingContainer?.let { view ->
            try {
                windowManager?.removeView(view)
            } catch (_: Exception) {}
            floatingContainer = null
        }
    }

    private fun showFloatingWidget() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(this)) {
            return
        }

        try {
            FloatingWidgetController.attachService(this)
            windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager

            val wmParams = WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                else
                    @Suppress("DEPRECATION")
                    WindowManager.LayoutParams.TYPE_PHONE,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT
            ).apply {
                gravity = Gravity.TOP or Gravity.END
                x = 30
                y = 220
            }

            val container = FrameLayout(this)

            // 1. Compact Pill View
            val pill = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                setPadding(32, 20, 32, 20)

                val background = GradientDrawable().apply {
                    setColor(Color.parseColor("#121216"))
                    cornerRadius = 48f
                    setStroke(2, Color.parseColor("#2A2A32"))
                }
                setBackground(background)
            }

            val dotView = View(this).apply {
                layoutParams = LinearLayout.LayoutParams(24, 24).apply {
                    gravity = Gravity.CENTER_VERTICAL
                    rightMargin = 16
                }
                val dotBg = GradientDrawable().apply {
                    setColor(Color.parseColor("#FF3B30"))
                    shape = GradientDrawable.OVAL
                }
                setBackground(dotBg)
            }

            val statusTv = TextView(this).apply {
                text = "Aletheia • Mendengarkan…"
                setTextColor(Color.WHITE)
                textSize = 13f
                gravity = Gravity.CENTER_VERTICAL
            }
            statusTextView = statusTv

            val closePillBtn = TextView(this).apply {
                text = " ✕ "
                setTextColor(Color.parseColor("#9CA3AF"))
                textSize = 14f
                setPadding(16, 0, 0, 0)
                gravity = Gravity.CENTER_VERTICAL
                setOnClickListener {
                    removeFloatingWidget()
                }
            }

            pill.addView(dotView)
            pill.addView(statusTv)
            pill.addView(closePillBtn)

            // 2. Expanded Verdict Card View (Extension UI style)
            val card = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(32, 28, 32, 28)
                visibility = View.GONE

                val cardBg = GradientDrawable().apply {
                    setColor(Color.parseColor("#121216"))
                    cornerRadius = 32f
                    setStroke(3, Color.parseColor("#2A2A32"))
                }
                setBackground(cardBg)
                layoutParams = LinearLayout.LayoutParams(650, LinearLayout.LayoutParams.WRAP_CONTENT)
            }

            // Header row: Brand + Close
            val headerRow = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            val brandTv = TextView(this).apply {
                text = "Aletheia Fact Check"
                setTextColor(Color.parseColor("#9CA3AF"))
                textSize = 12f
                typeface = Typeface.DEFAULT_BOLD
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            }
            val closeCardBtn = TextView(this).apply {
                text = "✕"
                setTextColor(Color.WHITE)
                textSize = 16f
                setPadding(16, 8, 8, 8)
                setOnClickListener {
                    removeFloatingWidget()
                }
            }
            headerRow.addView(brandTv)
            headerRow.addView(closeCardBtn)

            // Verdict Badge
            val badgeTv = TextView(this).apply {
                text = "BELUM DIVERIFIKASI"
                setTextColor(Color.WHITE)
                textSize = 11f
                typeface = Typeface.DEFAULT_BOLD
                setPadding(20, 8, 20, 8)
                val badgeBg = GradientDrawable().apply {
                    setColor(Color.parseColor("#71717A"))
                    cornerRadius = 16f
                }
                setBackground(badgeBg)
                val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
                lp.topMargin = 16
                lp.bottomMargin = 16
                layoutParams = lp
            }
            verdictBadgeTextView = badgeTv

            // Claim Text
            val claimTv = TextView(this).apply {
                text = ""
                setTextColor(Color.WHITE)
                textSize = 13f
                typeface = Typeface.DEFAULT_BOLD
                val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
                lp.bottomMargin = 12
                layoutParams = lp
            }
            verdictClaimTextView = claimTv

            // Explanation Text
            val explanationTv = TextView(this).apply {
                text = ""
                setTextColor(Color.parseColor("#D1D5DB"))
                textSize = 12f
                val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
                layoutParams = lp
            }
            verdictExplanationTextView = explanationTv

            card.addView(headerRow)
            card.addView(badgeTv)
            card.addView(claimTv)
            card.addView(explanationTv)

            container.addView(pill)
            container.addView(card)

            compactPillView = pill
            verdictCardView = card
            floatingContainer = container

            // Touch and Drag listener on root container
            var initialX = 0
            var initialY = 0
            var initialTouchX = 0f
            var initialTouchY = 0f
            var isClick = true

            container.setOnTouchListener { _, event ->
                when (event.action) {
                    MotionEvent.ACTION_DOWN -> {
                        initialX = wmParams.x
                        initialY = wmParams.y
                        initialTouchX = event.rawX
                        initialTouchY = event.rawY
                        isClick = true
                        true
                    }
                    MotionEvent.ACTION_MOVE -> {
                        val dx = (event.rawX - initialTouchX).toInt()
                        val dy = (event.rawY - initialTouchY).toInt()
                        if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
                            isClick = false
                        }
                        wmParams.x = initialX - dx
                        wmParams.y = initialY + dy
                        windowManager?.updateViewLayout(container, wmParams)
                        true
                    }
                    MotionEvent.ACTION_UP -> {
                        if (isClick) {
                            if (verdictCardView?.visibility == View.VISIBLE) {
                                verdictCardView?.visibility = View.GONE
                                compactPillView?.visibility = View.VISIBLE
                            } else if (verdictClaimTextView?.text?.isNotEmpty() == true) {
                                compactPillView?.visibility = View.GONE
                                verdictCardView?.visibility = View.VISIBLE
                            }
                        }
                        true
                    }
                    else -> false
                }
            }

            windowManager?.addView(floatingContainer, wmParams)
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun startRecording(path: String, maxDurationMs: Long) {
        if (isRecording) return

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED) {
            stopSelf()
            return
        }

        outputPath = path

        // Start as foreground service FIRST
        startForeground(NOTIFICATION_ID, buildNotification())
        showFloatingWidget()

        val bufferSize = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT)
        audioRecord = AudioRecord(
            MediaRecorder.AudioSource.MIC,
            SAMPLE_RATE,
            CHANNEL_CONFIG,
            AUDIO_FORMAT,
            bufferSize * 2
        )

        if (audioRecord?.state != AudioRecord.STATE_INITIALIZED) {
            removeFloatingWidget()
            stopSelf()
            return
        }

        isRecording = true
        audioRecord?.startRecording()

        recordingThread = Thread {
            writeWavFile(path, bufferSize, maxDurationMs)
        }.apply { start() }
    }

    private fun writeWavFile(path: String, bufferSize: Int, maxDurationMs: Long) {
        val file = File(path)
        val fos = FileOutputStream(file)

        // Write WAV header placeholder (44 bytes)
        val header = ByteArray(44)
        fos.write(header)

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

                    // Calculate RMS amplitude and broadcast it
                    val rms = calculateRms(buffer, read)
                    broadcastAmplitude(rms)
                }
            }
        } finally {
            fos.close()

            // Go back and write the proper WAV header
            writeWavHeader(path, totalBytesWritten)

            // Auto-stop the service
            isRecording = false
            audioRecord?.stop()
            audioRecord?.release()
            audioRecord = null

            // Broadcast completion
            broadcastComplete(path)

            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
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
        intent.putExtra("amplitude", amplitude)
        sendBroadcast(intent)
    }

    private fun broadcastComplete(filePath: String) {
        val intent = Intent("com.aletheia.app.RECORDING_COMPLETE")
        intent.putExtra("filePath", filePath)
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
