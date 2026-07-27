/**
 * Captures YouTube tab audio and streams 16 kHz PCM to Gemini Live.
 *
 * The permanent Gemini key remains in the Worker. This document receives only
 * a short-lived Live API token, converts the tab's audio to the format Gemini
 * expects, and forwards transcript windows to the service worker.
 */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'OFFSCREEN_START_CAPTURE') {
    startCapture(msg.streamId, msg.geminiLiveToken, msg.geminiLiveModel);
    sendResponse({ ack: true });
  } else if (msg.type === 'OFFSCREEN_STOP_CAPTURE') {
    stopCapture();
    sendResponse({ ack: true });
  }
  return true;
});

let mediaStream = null;
let audioContext = null;
let sourceNode = null;
let processorNode = null;
let silentGain = null;
let geminiSocket = null;
let geminiModel = null;
let socketReady = false;
let captureActive = false;
let reconnectTimer = null;
let transcriptBuffer = '';
let lastFlushTime = Date.now();
let speechActive = false;
let speechDurationMs = 0;
let silenceDurationMs = 0;

const TARGET_SAMPLE_RATE = 16000;
const BUFFER_INTERVAL_MS = 5000;
const SPEECH_RMS_THRESHOLD = 0.006;
const MIN_SPEECH_DURATION_MS = 250;
const END_OF_SPEECH_SILENCE_MS = 700;
const MAX_SPEECH_TURN_MS = 12000;

async function startCapture(streamId, token, model) {
  try {
    if (!streamId) throw new Error('No tab audio stream was provided.');
    if (!token) throw new Error('No Gemini Live credential was provided.');

    captureActive = true;
    geminiModel = model || 'gemini-3.1-flash-live-preview';
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });

    audioContext = new AudioContext();
    sourceNode = audioContext.createMediaStreamSource(mediaStream);

    // tabCapture mutes the tab. Route the captured stream back to the speakers.
    sourceNode.connect(audioContext.destination);

    // ScriptProcessor remains available in extension offscreen documents and
    // avoids shipping a second AudioWorklet file for this small mono transform.
    processorNode = audioContext.createScriptProcessor(4096, 1, 1);
    silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    sourceNode.connect(processorNode);
    processorNode.connect(silentGain);
    silentGain.connect(audioContext.destination);
    processorNode.onaudioprocess = handleAudioProcess;

    if (audioContext.state === 'suspended') await audioContext.resume();
    connectGemini(token);
  } catch (err) {
    reportError(`Audio capture failed: ${err.message}`);
    stopCapture();
  }
}

function connectGemini(token) {
  if (geminiSocket?.readyState === WebSocket.OPEN) {
    geminiSocket.onclose = null;
    geminiSocket.close();
  }
  socketReady = false;
  speechActive = false;
  speechDurationMs = 0;
  silenceDurationMs = 0;
  const endpoint =
    'wss://generativelanguage.googleapis.com/ws/' +
    'google.ai.generativelanguage.v1alpha.GenerativeService.' +
    `BidiGenerateContentConstrained?access_token=${encodeURIComponent(token)}`;

  const socket = new WebSocket(endpoint);
  geminiSocket = socket;
  socket.onopen = () => {
    socket.send(JSON.stringify({
      setup: {
        model: `models/${geminiModel}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
        },
        inputAudioTranscription: {},
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: true,
          },
        },
      },
    }));
  };

  socket.onmessage = (event) => {
    if (geminiSocket !== socket) return;
    try {
      const message = JSON.parse(event.data);
      if (message.setupComplete) {
        socketReady = true;
        chrome.runtime.sendMessage({
          type: 'STATUS_UPDATE',
          status: 'Gemini Live connected. Listening for factual claims…',
          phase: 'youtube_live',
        });
      }

      const transcription = message.serverContent?.inputTranscription?.text?.trim();
      if (transcription) {
        transcriptBuffer += `${transcriptBuffer ? ' ' : ''}${transcription}`;
        if (Date.now() - lastFlushTime >= BUFFER_INTERVAL_MS) flushBuffer();
      }
      if (message.serverContent?.turnComplete) flushBuffer();
      if (message.goAway && captureActive) scheduleReconnect();
    } catch (err) {
      console.warn('[Aletheia Offscreen] Could not parse Gemini Live message:', err);
    }
  };

  socket.onerror = () => {
    if (geminiSocket === socket && captureActive) {
      reportError('Gemini Live rejected the transcription connection.');
    }
  };

  socket.onclose = () => {
    if (geminiSocket !== socket) return;
    socketReady = false;
    if (captureActive) scheduleReconnect();
  };
}

async function scheduleReconnect() {
  if (!captureActive || reconnectTimer) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_GEMINI_LIVE_TOKEN' });
      if (!response?.token) throw new Error(response?.error || 'No replacement token');
      connectGemini(response.token);
    } catch (err) {
      reportError(`Gemini Live reconnect failed: ${err.message}`);
    }
  }, 1000);
}

function handleAudioProcess(event) {
  if (!socketReady || geminiSocket?.readyState !== WebSocket.OPEN) return;
  const input = event.inputBuffer.getChannelData(0);
  const durationMs = (input.length / audioContext.sampleRate) * 1000;
  const isSpeech = calculateRms(input) >= SPEECH_RMS_THRESHOLD;

  if (!speechActive && !isSpeech) return;
  if (!speechActive) {
    sendRealtimeInput({ activityStart: {} });
    speechActive = true;
    speechDurationMs = 0;
    silenceDurationMs = 0;
  }

  const pcm = resampleToPcm16(input, audioContext.sampleRate, TARGET_SAMPLE_RATE);
  if (!pcm.length) return;

  sendRealtimeInput({
    audio: {
      data: bytesToBase64(new Uint8Array(pcm.buffer)),
      mimeType: `audio/pcm;rate=${TARGET_SAMPLE_RATE}`,
    },
  });

  speechDurationMs += durationMs;
  silenceDurationMs = isSpeech ? 0 : silenceDurationMs + durationMs;
  if (
    (silenceDurationMs >= END_OF_SPEECH_SILENCE_MS &&
      speechDurationMs >= MIN_SPEECH_DURATION_MS) ||
    speechDurationMs >= MAX_SPEECH_TURN_MS
  ) {
    endSpeechTurn();
  }
}

function calculateRms(input) {
  let sum = 0;
  for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
  return Math.sqrt(sum / Math.max(1, input.length));
}

function sendRealtimeInput(payload) {
  if (geminiSocket?.readyState !== WebSocket.OPEN) return;
  geminiSocket.send(JSON.stringify({ realtimeInput: payload }));
}

function endSpeechTurn() {
  if (!speechActive) return;
  sendRealtimeInput({ activityEnd: {} });
  speechActive = false;
  speechDurationMs = 0;
  silenceDurationMs = 0;
}

function resampleToPcm16(input, inputRate, outputRate) {
  const ratio = inputRate / outputRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Int16Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function flushBuffer() {
  const text = transcriptBuffer.trim();
  if (text.length >= 40) {
    chrome.runtime.sendMessage({ type: 'TRANSCRIPT_CHUNK', text });
  }
  transcriptBuffer = '';
  lastFlushTime = Date.now();
}

function reportError(error) {
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_ERROR', error });
}

function stopCapture() {
  captureActive = false;
  socketReady = false;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  endSpeechTurn();
  flushBuffer();

  if (geminiSocket?.readyState === WebSocket.OPEN) {
    sendRealtimeInput({ audioStreamEnd: true });
    geminiSocket.close();
  }
  geminiSocket = null;

  if (processorNode) processorNode.onaudioprocess = null;
  processorNode?.disconnect();
  silentGain?.disconnect();
  sourceNode?.disconnect();
  processorNode = null;
  silentGain = null;
  sourceNode = null;

  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
  audioContext?.close().catch(() => {});
  audioContext = null;
}
