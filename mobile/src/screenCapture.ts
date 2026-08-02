/**
 * screenCapture.ts: Screen recording session management (Phase 2).
 *
 * This module handles screen recording via MediaProjection (Android) or
 * RPScreenRecorder/ReplayKit (iOS) to capture on screen text (captions,
 * overlays) while the Listen session is active.
 *
 * PHASE 2 NOT IMPLEMENTED IN THE CURRENT BUILD.
 *
 * This file exists to define the interface and document the approach,
 * per the original build prompt requirement for src/screenCapture.ts.
 * The audio only path (Phase 1) provides the core verification value.
 *
 * Implementation notes for Phase 2:
 *   1. Android: Use MediaProjection API via a native module. Requires
 *      FOREGROUND_SERVICE_MEDIA_PROJECTION permission and user consent
 *      via Activity.startActivityForResult().
 *   2. iOS: Use RPScreenRecorder.shared().startCapture(). Permission is
 *      per session (no persistent grant). The recording indicator (red
 *      status bar) is mandatory OS behavior do not suppress it.
 *   3. Extract one frame every 3 to 5 seconds, not every frame.
 *   4. Send each frame to the PaddleOCR microservice (see ocrClient.ts).
 *   5. DRM protected content may render black this is expected OS behavior.
 */

export interface ScreenCaptureCallbacks {
  onFrameExtracted: (frameBase64: string, timestamp: number) => void;
  onError: (error: string) => void;
}

/**
 * Start screen capture. Phase 2 currently a no op.
 */
export async function startScreenCapture(
  _callbacks: ScreenCaptureCallbacks,
): Promise<void> {
  console.warn(
    '[Aletheia] Screen capture is Phase 2 and not yet implemented. ' +
      'The verification pipeline will run on audio transcript only.',
  );
}

/**
 * Stop screen capture. Phase 2 currently a no op.
 */
export async function stopScreenCapture(): Promise<void> {
  // No op in Phase 1
}

/**
 * Check if screen capture is supported on this device/OS version.
 */
export function isScreenCaptureSupported(): boolean {
  // Phase 2: check for MediaProjection (Android 5+) or RPScreenRecorder (iOS 11+)
  return false;
}
