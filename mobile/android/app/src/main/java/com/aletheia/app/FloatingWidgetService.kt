package com.aletheia.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import androidx.core.app.NotificationCompat

/**
 * FloatingWidgetService — the Shazam-style bubble over any app.
 *
 * Architecture (per the build prompt):
 *   - The COLLAPSED state is a native circular bubble (a TextView with a
 *     rounded background; no layout XML, built programmatically).
 *   - The EXPANDED state is a WebView loading assets/overlay.html — the
 *     browser extension's verdict card UI ported verbatim (tokens + card CSS
 *     + card renderer). The widget never re-implements the verdict card
 *     natively, so there is no visual drift from the extension.
 *   - Dragging: the bubble is dragged natively; the card is dragged from its
 *     chrome header, which reports deltas through a @JavascriptInterface.
 *   - Tapping the bubble notifies React Native (FloatingWidgetController
 *     tap callback) so the EXISTING Listen flow in useListenSession runs —
 *     this service does not record audio.
 *
 * Runs as a foreground service (specialUse on API 34+) so the overlay
 * survives app backgrounding. The persistent notification is mandatory OS
 * behavior for any foreground service.
 */
class FloatingWidgetService : Service() {

    companion object {
        const val TAG = "AletheiaWidget"
        const val CHANNEL_ID = "aletheia_widget"
        const val NOTIFICATION_ID = 2
        const val ACTION_START = "com.aletheia.app.START_WIDGET"
        const val ACTION_STOP = "com.aletheia.app.STOP_WIDGET"
    }

    private var windowManager: WindowManager? = null
    private var container: FrameLayout? = null
    private var wmParams: WindowManager.LayoutParams? = null
    private var bubbleView: View? = null
    private var bubbleClose: TextView? = null
    private var cardContainer: FrameLayout? = null
    private var webView: WebView? = null
    private var dragBar: View? = null
    private var density = 1f

    // Shared drag state for the native bubble and card header drag.
    private var initialX = 0
    private var initialY = 0
    private var initialTouchX = 0f
    private var initialTouchY = 0f
    private var isClick = true

    // Pinch-to-minimize state for the expanded card.
    private var scaleDetector: ScaleGestureDetector? = null
    private var cumulativeScale = 1.0f

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        density = resources.displayMetrics.density
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(this)) {
                    stopSelf()
                    return START_NOT_STICKY
                }
                startAsForeground()
                if (container == null) {
                    showOverlay()
                }
            }
            ACTION_STOP -> dismiss()
        }
        return START_NOT_STICKY
    }

    // ── Foreground service ─────────────────────────────────────────────────

    private fun startAsForeground() {
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(
                NOTIFICATION_ID,
                buildNotification(),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            )
        } else if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, buildNotification(), 0)
        } else {
            @Suppress("DEPRECATION")
            startForeground(NOTIFICATION_ID, buildNotification())
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Aletheia Floating Widget",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Keeps the Aletheia fact-check bubble available over other apps"
                setShowBadge(false)
            }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        val contentIntent = launchIntent?.let {
            PendingIntent.getActivity(this, 1, it, flags)
        }
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Aletheia widget is on")
            .setContentText("Tap the bubble to fact-check what you're hearing.")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
        if (contentIntent != null) builder.setContentIntent(contentIntent)
        return builder.build()
    }

    // ── Overlay UI ─────────────────────────────────────────────────────────

    private fun showOverlay() {
        try {
            FloatingWidgetController.attachService(this)
            windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager

            val overlayType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            } else {
                @Suppress("DEPRECATION")
                WindowManager.LayoutParams.TYPE_PHONE
            }

            wmParams = WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                overlayType,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT
            ).apply {
                gravity = Gravity.TOP or Gravity.START
                x = (24 * density).toInt()
                y = (200 * density).toInt()
            }

            val root = FrameLayout(this)
            container = root

            // 1. Collapsed bubble: circular logo button, natively draggable.
            val bubble = ImageView(this).apply {
                setImageResource(R.drawable.logo)
                scaleType = ImageView.ScaleType.CENTER_CROP
                setBackground(circle("#121216", 1, "#2A2A32"))
                clipToOutline = true
            }
            root.addView(
                bubble,
                FrameLayout.LayoutParams((56 * density).toInt(), (56 * density).toInt())
            )
            bubbleView = bubble

            // Tiny ✕ badge on the bubble corner → dismiss the widget entirely.
            val closeBadge = TextView(this).apply {
                text = "✕"
                textSize = 10f
                gravity = Gravity.CENTER
                setTextColor(Color.WHITE)
                setBackground(circle("#3A3A44", 1, "#52525B"))
                setOnClickListener { dismiss() }
            }
            val badgeLp = FrameLayout.LayoutParams(
                (20 * density).toInt(),
                (20 * density).toInt(),
                Gravity.TOP or Gravity.END
            ).apply {
                topMargin = (4 * density).toInt()
                rightMargin = (4 * density).toInt()
            }
            root.addView(closeBadge, badgeLp)
            bubbleClose = closeBadge

            // 2. Expanded card: WebView hosting the ported extension UI.
            //    Custom FrameLayout that intercepts multi-finger touches before
            //    the WebView can consume them for zoom. Single-finger touches
            //    pass through normally so the WebView's scroll, tap, and close
            //    button all keep working.
            val card = object : FrameLayout(this@FloatingWidgetService) {
                override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
                    if (ev.pointerCount >= 2) {
                        scaleDetector?.onTouchEvent(ev)
                        return true
                    }
                    return super.dispatchTouchEvent(ev)
                }
            }
            card.visibility = View.GONE
            val cardW = (340 * density).toInt()
            val cardH = (460 * density).toInt()
            root.addView(card, FrameLayout.LayoutParams(cardW, cardH))
            cardContainer = card

            // ScaleGestureDetector for two-finger pinch-to-minimize.
            // Tracks CUMULATIVE scale (multiplying each incremental factor)
            // and triggers collapse when the total scale drops below 0.7.
            scaleDetector = ScaleGestureDetector(
                this,
                object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
                    override fun onScaleBegin(detector: ScaleGestureDetector): Boolean {
                        cumulativeScale = 1.0f
                        return true
                    }

                    override fun onScale(detector: ScaleGestureDetector): Boolean {
                        cumulativeScale *= detector.scaleFactor
                        if (cumulativeScale < 0.7f) {
                            collapse()
                            cumulativeScale = 1.0f
                        }
                        return true
                    }

                    override fun onScaleEnd(detector: ScaleGestureDetector) {
                        cumulativeScale = 1.0f
                    }
                }
            )

            // Native drag bar — added to ROOT (not card) so it sits ABOVE the
            // WebView in z-order. The WebView cannot consume touches from a
            // sibling view drawn on top of it.
            // Covers the left48dp × 48dp at the top (the grip area), leaving
            // the right side free so the WebView's close button keeps working.
            val bar = View(this).apply {
                setBackgroundColor(Color.parseColor("#01000000"))
            }
            val barLp = FrameLayout.LayoutParams((48 * density).toInt(), (48 * density).toInt()).apply {
                gravity = Gravity.TOP or Gravity.START
            }
            root.addView(bar, barLp)
            this@FloatingWidgetService.dragBar = bar

            bar.setOnTouchListener { _, event ->
                when (event.action) {
                    MotionEvent.ACTION_DOWN -> {
                        initialX = wmParams?.x ?: 0
                        initialY = wmParams?.y ?: 0
                        initialTouchX = event.rawX
                        initialTouchY = event.rawY
                        true
                    }
                    MotionEvent.ACTION_MOVE -> {
                        val dx = (event.rawX - initialTouchX).toInt()
                        val dy = (event.rawY - initialTouchY).toInt()
                        moveWindow(initialX + dx, initialY + dy)
                        true
                    }
                    MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> true
                    else -> false
                }
            }

            // Bubble drag + tap. The close badge is a sibling on top, so its
            // own click handler wins and never conflicts with drag logic.
            bubble.setOnTouchListener { _, event ->
                when (event.action) {
                    MotionEvent.ACTION_DOWN -> {
                        initialX = wmParams?.x ?: 0
                        initialY = wmParams?.y ?: 0
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
                        moveWindow(initialX + dx, initialY + dy)
                        true
                    }
                    MotionEvent.ACTION_UP -> {
                        if (isClick) {
                            // Start the existing Listen flow + expand the card.
                            FloatingWidgetController.notifyTap()
                            showCard()
                        }
                        true
                    }
                    else -> false
                }
            }

            windowManager?.addView(root, wmParams)
        } catch (e: Exception) {
            e.printStackTrace()
            stopSelf()
        }
    }

    private fun circle(fill: String, stroke: Int, strokeColor: String): GradientDrawable =
        GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(Color.parseColor(fill))
            if (stroke > 0) setStroke(stroke, Color.parseColor(strokeColor))
        }

    private fun moveWindow(x: Int, y: Int) {
        val maxX = (resources.displayMetrics.widthPixels - (container?.width ?: 0))
        val maxY = (resources.displayMetrics.heightPixels - (container?.height ?: 0))
        wmParams?.x = x.coerceIn(0, maxX.coerceAtLeast(0))
        wmParams?.y = y.coerceIn(0, maxY.coerceAtLeast(0))
        try {
            windowManager?.updateViewLayout(container, wmParams)
        } catch (_: Exception) {}
    }

    /** Expand the WebView card with a smooth grow animation. */
    fun showCard() {
        Handler(Looper.getMainLooper()).post {
            if (webView == null) {
                buildWebView()
            }
            bubbleView?.visibility = View.GONE
            bubbleClose?.visibility = View.GONE

            val card = cardContainer
            val bar = dragBar

            // Start scaled down + transparent, then animate to full size.
            if (card != null) {
                card.scaleX = 0.3f
                card.scaleY = 0.3f
                card.alpha = 0f
                card.visibility = View.VISIBLE
                card.animate()
                    .scaleX(1f)
                    .scaleY(1f)
                    .alpha(1f)
                    .setDuration(280L)
                    .setInterpolator(android.view.animation.DecelerateInterpolator(2f))
                    .start()
            }

            // Fade the drag bar in.
            bar?.alpha = 0f
            bar?.visibility = View.VISIBLE
            bar?.animate()
                ?.alpha(1f)
                ?.setDuration(200L)
                ?.setInterpolator(android.view.animation.DecelerateInterpolator(2f))
                ?.start()

            wmParams?.let { p ->
                try { windowManager?.updateViewLayout(container, wmParams) } catch (_: Exception) {}
                moveWindow(p.x, p.y)
            }
        }
    }

    /** Collapse back to the bubble with a smooth shrink animation. */
    fun collapse() {
        Handler(Looper.getMainLooper()).post {
            val card = cardContainer ?: return@post
            val bar = dragBar

            // Animate: scale down to 0 + fade out simultaneously.
            card.animate()
                .scaleX(0.3f)
                .scaleY(0.3f)
                .alpha(0f)
                .setDuration(250L)
                .setInterpolator(android.view.animation.DecelerateInterpolator(2f))
                .withEndAction {
                    card.animate().setListener(null)  // clear to avoid leaks
                    card.scaleX = 1f
                    card.scaleY = 1f
                    card.alpha = 1f
                    card.visibility = View.GONE
                    bar?.visibility = View.GONE
                    bubbleView?.visibility = View.VISIBLE
                    bubbleClose?.visibility = View.VISIBLE
                    try { windowManager?.updateViewLayout(container, wmParams) } catch (_: Exception) {}
                    wmParams?.let { moveWindow(it.x, it.y) }
                }
                .start()

            // Fade the drag bar out slightly faster.
            bar?.animate()
                ?.alpha(0f)
                ?.setDuration(200L)
                ?.setInterpolator(android.view.animation.DecelerateInterpolator(2f))
                ?.start()
        }
    }

    private fun buildWebView() {
        val card = cardContainer ?: return
        val wv = WebView(this)
        wv.settings.javaScriptEnabled = true
        wv.settings.domStorageEnabled = true
        wv.settings.setSupportZoom(false)
        wv.settings.builtInZoomControls = false
        wv.settings.displayZoomControls = false
        wv.settings.cacheMode = WebSettings.LOAD_NO_CACHE
        wv.setBackgroundColor(Color.TRANSPARENT)
        wv.isVerticalScrollBarEnabled = false
        wv.isHorizontalScrollBarEnabled = false
        // Without this, a JS error inside the card is completely silent: the
        // button simply does nothing and there is no trace anywhere. That is
        // how a bridge call to a method the bridge does not expose shipped.
        wv.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
                Log.d(TAG, "overlay console: ${msg.message()} @${msg.lineNumber()}")
                return true
            }
        }
        wv.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                FloatingWidgetController.onPageLoaded()
            }

            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?
            ): Boolean {
                val url = request?.url?.toString() ?: return false
                if (url.startsWith("http")) {
                    try {
                        val i = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        }
                        startActivity(i)
                    } catch (_: Exception) {}
                    return true
                }
                return false
            }
        }
        wv.addJavascriptInterface(WidgetBridge(), "AletheiaNative")
        FloatingWidgetController.attach(wv)
        card.addView(wv, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ))
        webView = wv
        wv.loadUrl("file:///android_asset/overlay.html")
    }

    /** Dismiss the whole widget and stop the service. */
    fun dismiss() {
        FloatingWidgetController.detachService()
        FloatingWidgetController.detach()
        webView?.let {
            (it.parent as? android.view.ViewGroup)?.removeView(it)
            it.removeJavascriptInterface("AletheiaNative")
            it.destroy()
        }
        webView = null
        container?.let { view ->
            try { windowManager?.removeView(view) } catch (_: Exception) {}
            container = null
        }
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        dismiss()
        super.onDestroy()
    }

    // ── JS → native bridge for card dragging / collapsing ──────────────────
    // The ported overlay.html chrome header calls these; they run on a
    // WebView background thread, so every mutation posts to the main looper.
    private inner class WidgetBridge {
        @JavascriptInterface
        fun onDragStart(x: Float, y: Float) {
            Handler(Looper.getMainLooper()).post {
                initialX = wmParams?.x ?: 0
                initialY = wmParams?.y ?: 0
                initialTouchX = x
                initialTouchY = y
            }
        }

        @JavascriptInterface
        fun onDragMove(dx: Float, dy: Float) {
            Handler(Looper.getMainLooper()).post {
                moveWindow(initialX + dx.toInt(), initialY + dy.toInt())
            }
        }

        @JavascriptInterface
        fun onDragEnd() {
            // No-op: position already updated during move.
        }

        @JavascriptInterface
        fun onCollapse() {
            Handler(Looper.getMainLooper()).post { collapse() }
        }
    }
}
