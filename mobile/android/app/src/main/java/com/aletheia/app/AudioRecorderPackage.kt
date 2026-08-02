package com.aletheia.app

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * Registers the native modules with React Native:
 *   - AudioRecorderModule: microphone recording (foreground service)
 *   - OverlayPermissionModule: floating widget + overlay permission flow
 */
class AudioRecorderPackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
        return listOf(
            AudioRecorderModule(reactContext),
            OverlayPermissionModule(reactContext)
        )
    }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
        return emptyList()
    }
}
