package com.aletheia.app

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File

/**
 * React Native native module that bridges the AudioRecorderService to JavaScript.
 *
 * Exposes:
 *   - startRecording(options): starts the foreground service + recording
 *   - stopRecording(): stops recording, returns file path
 *   - isHeadphonesConnected(): checks wired/Bluetooth audio output
 *
 * Overlay/permission responsibilities (SYSTEM_ALERT_WINDOW flow, floating
 * widget start/stop, vendor auto-start) live in OverlayPermissionModule.
 */
class AudioRecorderModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "AudioRecorderModule"

    private var recordingPromise: Promise? = null
    private var outputPath: String? = null

    private val amplitudeReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val amplitude = intent?.getFloatExtra("amplitude", 0f) ?: 0f
            sendEvent("onAmplitude", Arguments.createMap().apply {
                putDouble("amplitude", amplitude.toDouble())
            })
        }
    }

    private val completeReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val filePath = intent?.getStringExtra("filePath") ?: ""
            recordingPromise?.resolve(filePath)
            recordingPromise = null
            unregisterReceivers()
        }
    }

    private var receiversRegistered = false

    private fun registerReceivers() {
        if (receiversRegistered) return
        val context = reactApplicationContext
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(
                amplitudeReceiver,
                IntentFilter("com.aletheia.app.AMPLITUDE"),
                Context.RECEIVER_NOT_EXPORTED
            )
            context.registerReceiver(
                completeReceiver,
                IntentFilter("com.aletheia.app.RECORDING_COMPLETE"),
                Context.RECEIVER_NOT_EXPORTED
            )
        } else {
            context.registerReceiver(
                amplitudeReceiver,
                IntentFilter("com.aletheia.app.AMPLITUDE")
            )
            context.registerReceiver(
                completeReceiver,
                IntentFilter("com.aletheia.app.RECORDING_COMPLETE")
            )
        }
        receiversRegistered = true
    }

    private fun unregisterReceivers() {
        if (!receiversRegistered) return
        try {
            reactApplicationContext.unregisterReceiver(amplitudeReceiver)
            reactApplicationContext.unregisterReceiver(completeReceiver)
        } catch (_: Exception) {}
        receiversRegistered = false
    }

    private fun sendEvent(eventName: String, params: WritableMap) {
        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(eventName, params)
    }

    @ReactMethod
    fun startRecording(options: ReadableMap, promise: Promise) {
        val context = reactApplicationContext

        // Check permission
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED) {
            promise.reject("PERMISSION_DENIED", "Microphone permission not granted")
            return
        }

        val maxDurationMs = if (options.hasKey("maxDurationMs"))
            options.getInt("maxDurationMs").toLong() else 15000L

        val path = File(context.cacheDir,
            "aletheia_recording_${System.currentTimeMillis()}.wav").absolutePath
        outputPath = path

        // Store promise to resolve when recording completes
        recordingPromise = promise

        // Register broadcast receivers
        registerReceivers()

        // Start the foreground service
        val intent = Intent(context, AudioRecorderService::class.java).apply {
            action = AudioRecorderService.ACTION_START
            putExtra(AudioRecorderService.EXTRA_MAX_DURATION_MS, maxDurationMs)
            putExtra(AudioRecorderService.EXTRA_OUTPUT_PATH, path)
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent)
        } else {
            context.startService(intent)
        }
    }

    @ReactMethod
    fun stopRecording(promise: Promise) {
        val context = reactApplicationContext
        val intent = Intent(context, AudioRecorderService::class.java).apply {
            action = AudioRecorderService.ACTION_STOP
        }
        context.startService(intent)

        // The completion will come through the broadcast receiver
        // If we already have a path and want immediate resolution:
        outputPath?.let {
            // Give the service a moment to finalize the file
            android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                promise.resolve(it)
            }, 500)
        } ?: promise.resolve("")
    }

    @ReactMethod
    fun isHeadphonesConnected(promise: Promise) {
        val audioManager = reactApplicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val devices = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
            val hasHeadphones = devices.any { device ->
                device.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES ||
                device.type == AudioDeviceInfo.TYPE_WIRED_HEADSET ||
                device.type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP ||
                device.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
                device.type == AudioDeviceInfo.TYPE_USB_HEADSET ||
                (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
                    device.type == AudioDeviceInfo.TYPE_USB_HEADSET) ||
                (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
                    device.type == AudioDeviceInfo.TYPE_BLE_HEADSET)
            }
            promise.resolve(hasHeadphones)
        } else {
            @Suppress("DEPRECATION")
            promise.resolve(audioManager.isWiredHeadsetOn || audioManager.isBluetoothA2dpOn)
        }
    }

    @ReactMethod
    fun addListener(eventName: String) {
        // Required for NativeEventEmitter
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        // Required for NativeEventEmitter
    }
}
