package com.aletheia.app

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * OverlayPermissionModule — native bridge for the floating widget.
 *
 * Exposes the SYSTEM_ALERT_WINDOW permission flow, start/stop of the
 * FloatingWidgetService, live status/verdict pushes into the widget's WebView
 * (reusing the extension's render functions), and best-effort vendor
 * auto-start / battery-optimization helpers for Chinese OEMs.
 *
 * The widget and the RN app share a process, so state flows through the
 * FloatingWidgetController singleton — no broadcast/messaging system.
 */
class OverlayPermissionModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "OverlayPermissionModule"

    init {
        // Bubble tap → notify JS so the existing Listen flow (useListenSession)
        // runs. Registered once; the controller holds it for the app lifetime.
        FloatingWidgetController.setTapCallback {
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("onFloatingWidgetTap", Arguments.createMap())
        }
    }

    /**
     * Opens Settings.ACTION_MANAGE_OVERLAY_PERMISSION. Resolves false when
     * the settings screen was opened (the AppState listener picks up the
     * grant on return), true when already granted.
     */
    @ReactMethod
    fun requestOverlayPermission(promise: Promise) {
        val context = reactApplicationContext
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            if (!Settings.canDrawOverlays(context)) {
                try {
                    val intent = Intent(
                        Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        Uri.parse("package:" + context.packageName)
                    ).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    context.startActivity(intent)
                } catch (e: Exception) {
                    promise.reject("OVERLAY_SETTINGS_UNAVAILABLE", e.message)
                    return
                }
                promise.resolve(false)
                return
            }
        }
        promise.resolve(true)
    }

    @ReactMethod
    fun checkOverlayPermission(promise: Promise) {
        val granted = Build.VERSION.SDK_INT < Build.VERSION_CODES.M ||
            Settings.canDrawOverlays(reactApplicationContext)
        promise.resolve(granted)
    }

    /** Start the floating widget foreground service (idempotent). */
    @ReactMethod
    fun startFloatingWidget() {
        val context = reactApplicationContext
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(context)) {
            return
        }
        if (FloatingWidgetController.isWidgetActive()) return
        val intent = Intent(context, FloatingWidgetService::class.java).apply {
            action = FloatingWidgetService.ACTION_START
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent)
        } else {
            context.startService(intent)
        }
    }

    /** Stop and remove the floating widget. */
    @ReactMethod
    fun stopFloatingWidget() {
        val intent = Intent(reactApplicationContext, FloatingWidgetService::class.java).apply {
            action = FloatingWidgetService.ACTION_STOP
        }
        reactApplicationContext.startService(intent)
    }

    /** Live status text ("Mendengarkan…", "Memeriksa klaim…"). */
    @ReactMethod
    fun updateWidgetStatus(text: String) {
        FloatingWidgetController.updateStatus(text)
    }

    /** Verdict JSON pushed straight into the WebView's renderVerdict(). */
    @ReactMethod
    fun updateWidgetVerdict(verdictJson: String) {
        FloatingWidgetController.updateVerdict(verdictJson)
    }

    /** Force the card open (used whenever a Listen session starts). */
    @ReactMethod
    fun expandWidget() {
        FloatingWidgetController.expandCard()
    }

    /** Dismiss the widget entirely. */
    @ReactMethod
    fun closeWidget() {
        FloatingWidgetController.closeWidget()
    }

    // ── Vendor-specific background reliability (best-effort) ────────────────

    /**
     * Attempts to open the manufacturer's auto-start / background-permission
     * settings screen (Xiaomi, Oppo, Vivo), falling back to the standard
     * battery-optimization exemption request if the vendor intent fails.
     * Package/activity names vary across OS versions, so this must never
     * crash — everything is wrapped in a try/catch.
     */
    @ReactMethod
    fun openVendorAutoStartSettings() {
        val context = reactApplicationContext
        val manufacturer = Build.MANUFACTURER.lowercase()
        val intent = Intent()
        try {
            when {
                manufacturer.contains("xiaomi") -> intent.component = ComponentName(
                    "com.miui.securitycenter",
                    "com.miui.permcenter.autostart.AutoStartManagementActivity"
                )
                manufacturer.contains("oppo") -> intent.component = ComponentName(
                    "com.coloros.safecenter",
                    "com.coloros.safecenter.permission.startup.StartupAppListActivity"
                )
                manufacturer.contains("vivo") -> intent.component = ComponentName(
                    "com.vivo.permissionmanager",
                    "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"
                )
                else -> {
                    requestIgnoreBatteryOptimization()
                    return
                }
            }
            intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK
            context.startActivity(intent)
        } catch (_: Exception) {
            requestIgnoreBatteryOptimization()
        }
    }

    /** Standard Android request to exempt the app from battery optimization. */
    @ReactMethod
    fun requestIgnoreBatteryOptimization() {
        val context = reactApplicationContext
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = Uri.parse("package:" + context.packageName)
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK
                }
                context.startActivity(intent)
            } catch (_: Exception) {}
        }
    }

    // Required for NativeEventEmitter on the JS side.
    @ReactMethod
    fun addListener(eventName: String) {}

    @ReactMethod
    fun removeListeners(count: Int) {}
}
