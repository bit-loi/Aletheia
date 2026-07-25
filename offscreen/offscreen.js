/**
 * offscreen.js: Audio capture + Deepgram streaming for YouTube mode.
 *
 * Phase 5 implementation. This offscreen document:
 * 1. Receives a tabCapture stream ID from the service worker
 * 2. Captures audio via getUserMedia with the tab stream
 * 3. Opens a WebSocket to Deepgram's streaming API
 * 4. Sends audio chunks and receives transcript results
 * 5. Posts transcript text back to the service worker
 */

// ─── Message handling from service worker ─────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'OFFSCREEN_START_CAPTURE') {
    startCapture(msg.streamId, msg.deepgramKey);
    sendResponse({ ack: true });
  } else if (msg.type === 'OFFSCREEN_STOP_CAPTURE') {
    stopCapture();
    sendResponse({ ack: true });
  }
  return true;
});

// ─── State ────────────────────────────────────────────────────────────────────

let mediaStream = null;
let mediaRecorder = null;
let deepgramSocket = null;
let transcriptBuffer = '';
let lastFlushTime = Date.now();
const BUFFER_INTERVAL_MS = 20000; // 20-second windows

// ─── Capture logic ────────────────────────────────────────────────────────────

async function startCapture(streamId, deepgramKey) {
  try {
    // Get the tab's audio stream
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
    });

    // Open Deepgram WebSocket
    const dgUrl =
      'wss://api.deepgram.com/v1/listen?' +
      'model=nova-2&' +
      'language=en&' + // Can be changed to 'multi' for multilingual
      'smart_format=true&' +
      'interim_results=false&' +
      'punctuate=true';

    deepgramSocket = new WebSocket(dgUrl, ['token', deepgramKey]);

    deepgramSocket.onopen = () => {
      console.log('[Aletheia Offscreen] Deepgram WebSocket connected.');

      // Start recording audio and sending to Deepgram
      mediaRecorder = new MediaRecorder(mediaStream, {
        mimeType: 'audio/webm;codecs=opus',
      });

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0 && deepgramSocket.readyState === WebSocket.OPEN) {
          deepgramSocket.send(event.data);
        }
      };

      // Send audio chunks every 250ms for near-real-time
      mediaRecorder.start(250);

      // Start the buffer flush interval
      lastFlushTime = Date.now();
    };

    deepgramSocket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const transcript = data.channel?.alternatives?.[0]?.transcript;
        if (transcript && transcript.trim().length > 0) {
          transcriptBuffer += ' ' + transcript.trim();

          // Flush buffer every ~20 seconds
          if (Date.now() - lastFlushTime >= BUFFER_INTERVAL_MS) {
            flushBuffer();
          }
        }
      } catch (err) {
        console.warn('[Aletheia Offscreen] Error parsing Deepgram message:', err);
      }
    };

    deepgramSocket.onerror = (err) => {
      console.error('[Aletheia Offscreen] Deepgram WebSocket error:', err);
      chrome.runtime.sendMessage({
        type: 'OFFSCREEN_ERROR',
        error: 'Deepgram connection error. Check your API key.',
      });
    };

    deepgramSocket.onclose = () => {
      console.log('[Aletheia Offscreen] Deepgram WebSocket closed.');
      // Flush any remaining buffer
      if (transcriptBuffer.trim().length > 0) {
        flushBuffer();
      }
    };
  } catch (err) {
    console.error('[Aletheia Offscreen] Failed to start capture:', err);
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_ERROR',
      error: `Audio capture failed: ${err.message}`,
    });
  }
}

function flushBuffer() {
  const text = transcriptBuffer.trim();
  if (text.length > 50) {
    // Only send if there's meaningful content
    chrome.runtime.sendMessage({
      type: 'TRANSCRIPT_CHUNK',
      text: text,
    });
  }
  transcriptBuffer = '';
  lastFlushTime = Date.now();
}

function stopCapture() {
  // Flush remaining buffer
  if (transcriptBuffer.trim().length > 0) {
    flushBuffer();
  }

  // Clean up media
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  mediaRecorder = null;

  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
  }
  mediaStream = null;

  // Close Deepgram
  if (deepgramSocket && deepgramSocket.readyState === WebSocket.OPEN) {
    deepgramSocket.close();
  }
  deepgramSocket = null;
}
