package com.aletheia.app

import android.webkit.WebView

/**
 * FloatingWidgetController: singleton direct bridge between React Native
 * (via OverlayPermissionModule) and the floating widget UI, running in the
 * same process. No broadcasts, no messenger — just an object the module and
 * the service both touch.
 *
 * Status / verdict payloads are pushed into the WebView with
 * evaluateJavascript, reusing the exact render functions the extension's
 * overlay.js already defines (updateStatus / renderVerdict in overlay.html).
 */
object FloatingWidgetController {

    // Written from the service's main thread (attach/onPageLoaded), read from
    // the RN native-module thread (updateStatus/updateVerdict), so the shared
    // state is @Volatile to avoid tearing on the JMM memory model.
    @Volatile private var webView: WebView? = null
    @Volatile private var pageLoaded = false
    @Volatile private var pendingStatus: String? = null
    @Volatile private var pendingVerdict: String? = null

    @Volatile private var tapCallback: (() -> Unit)? = null
    @Volatile private var service: FloatingWidgetService? = null

    /** The service attaches its card WebView here after inflating it. */
    fun attach(view: WebView) {
        webView = view
        pageLoaded = false
    }

    fun detach() {
        webView = null
        pageLoaded = false
        pendingStatus = null
        pendingVerdict = null
    }

    /** Called from WebViewClient.onPageFinished so early updates are queued. */
    fun onPageLoaded() {
        pageLoaded = true
        pendingStatus?.let { updateStatus(it) }
        pendingVerdict?.let { updateVerdict(it) }
        pendingStatus = null
        pendingVerdict = null
    }

    /** RN registers this so a bubble tap can start the existing Listen flow. */
    fun setTapCallback(cb: (() -> Unit)?) {
        tapCallback = cb
    }

    /** Called by the service when the bubble is tapped (not dragged). */
    fun notifyTap() {
        tapCallback?.invoke()
    }

    fun attachService(s: FloatingWidgetService) {
        service = s
    }

    fun detachService() {
        service = null
    }

    fun isWidgetActive(): Boolean = service != null

    /** Push a live status string ("Mendengarkan…", "Memeriksa klaim…"). */
    fun updateStatus(statusText: String) {
        val view = webView
        if (view == null || !pageLoaded) {
            pendingStatus = statusText
            return
        }
        val escaped = statusText
            .replace("\\", "\\\\")
            .replace("'", "\\'")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
        view.post {
            view.evaluateJavascript("updateStatus('$escaped')", null)
        }
    }

    /**
     * Push a verdict JSON object (same shape as the extension's claim card:
     * { claim, verdict, explanation, confidence, key_sources }) so the
     * WebView's renderVerdict paints the extension card.
     */
    fun updateVerdict(verdictJson: String) {
        val view = webView
        if (view == null || !pageLoaded) {
            pendingVerdict = verdictJson
            return
        }
        view.post {
            view.evaluateJavascript("renderVerdict($verdictJson)", null)
        }
    }

    /** Expand from bubble to the WebView card (used on bubble tap). */
    fun expandCard() {
        service?.showCard()
    }

    /** Collapse the card back to the bubble; widget stays alive. */
    fun collapseToBubble() {
        service?.collapse()
    }

    /** Dismiss the widget entirely and stop the foreground service. */
    fun closeWidget() {
        service?.dismiss()
    }
}
