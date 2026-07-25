# <img src="icons/Aletheia-Logo.png" width="40" height="40" alt="Aletheia logo" align="center"> Aletheia

**Aletheia is an AI Powered Real Time Fact Checking for News Videos and Web Articles.**

Built for the **UNESCO Youth Hackathon 2026**, AI and Media & Information Literacy track.

> *Aletheia (ancient Greek: disclosure, unconcealment of truth)* is the philosophical concept of truth as something revealed rather than constructed.

---

## What It Does

Aletheia is a Chrome extension that helps audiences verify claims **while they're reading or watching**, directly on the page:

1. **Extracts** verifiable factual claims from article text or live YouTube video audio.
2. **Searches** for credible evidence using web search APIs (Tavily).
3. **Generates** grounded verdicts: True, False, Misleading, or Unverified powered by **NVIDIA NIM (MiniMax M3)**.
4. **Displays** results in a floating, draggable Neobrutalist overlay with source links users can check themselves.

### Who It's For

Indonesian youth, first-time voters, students, and general audiences navigating political and health news. Anyone who wants to verify before they share.

---

## Features

| Feature | Description |
|---------|-------------|
| **Web Article Mode** | Reads article text directly from any news site DOM (BBC, CNN, Kompas, Medium, Wikipedia, etc.) |
| **YouTube Mode** | Captures tab audio, transcribes live via Deepgram, and streams live speech feedback |
| **NVIDIA NIM Engine** | Powered by `minimaxai/minimax-m3` on NVIDIA NIM API for fast, grounded reasoning |
| **Neobrutalist UI** | High-contrast dark & light themes, crisp 2px borders, hard offset shadows, draggable header |
| **Grounded Verdicts** | Verdicts are strictly grounded in retrieved Tavily search evidence |
| **Rate-Limit Resilience** | Exponential backoff retries, JSON regex fallback parser, and throttled 15s audio windows |
| **Local Environment Config** | Centralized `config.js` & `.env` support with zero exposed production secrets |
| **Claim Caching** | SHA-256 hashed verdict caching in `chrome.storage.local` to prevent duplicate API calls |

---

## Architecture

```
+------------------------------------------------------------------+
|                        Chrome Extension                           |
|                                                                   |
|  +-------------------+    messages    +--------------------------+|
|  |  Content Scripts   |<------------>|    Service Worker          ||
|  |                   |               |    (Background)            ||
|  |  * Page detection |               |                            ||
|  |  * Article text   |               |  +----------------------+ ||
|  |    extraction     |               |  |   Pipeline           | ||
|  |  * Floating UI    |               |  |  1. Extract claims   | ||
|  |    (Shadow DOM)   |               |  |     (NVIDIA NIM)     | ||
|  |  * Draggable panel|               |  |  2. Search evidence  | ||
|  +-------------------+               |  |     (Tavily)         | ||
|                                      |  |  3. Grounded Verdict | ||
|  +-------------------+               |  |     (NVIDIA NIM)     | ||
|  | Offscreen Doc     |               |  +----------------------+ ||
|  | (YouTube mode)    |<------------>|                            ||
|  |                   |               |  +----------------------+ ||
|  |  * Tab audio      |               |  |   Cache              | ||
|  |    capture        |               |  |  chrome.storage.local| ||
|  |  * Deepgram WS    |               |  +----------------------+ ||
|  +-------------------+               +--------------------------+||
|                                                                   |
|  +-------------------+                                            |
|  |  Popup            |  Settings: API keys & Theme stored via     |
|  |  (chrome.storage  |  chrome.storage.sync                       |
|  |   .sync)          |                                            |
|  +-------------------+                                            |
+------------------------------------------------------------------+
```

---

## Quick Start

### Prerequisites

- Google Chrome (or any Chromium-based browser)
- API keys from the services below

### 1. Get API Keys

| Service | Purpose | Free Tier | Link |
|---------|---------|-----------|------|
| **NVIDIA NIM** | LLM engine (`minimaxai/minimax-m3`) for claim extraction & verdicts | Free Developer Credits | [build.nvidia.com](https://build.nvidia.com/) |
| **Tavily** | Web search for evidence retrieval | 1,000 free searches/mo | [app.tavily.com](https://app.tavily.com/) |
| **Deepgram** | Live audio transcription (YouTube mode) | $200 free credit | [console.deepgram.com](https://console.deepgram.com/) |

---

### 2. Install the Extension

1. Clone or download this repository:
   ```bash
   git clone https://github.com/bit-loi/Aletheia.git
   ```
2. Open Chrome and navigate to `chrome://extensions`
3. Enable **Developer mode** (toggle in top-right corner)
4. Click **Load unpacked**
5. Select the `Aletheia/` folder
6. The Aletheia icon will appear in your toolbar!

---

### 3. Configure API Keys & Environment

1. Click the **Aletheia icon** in the Chrome toolbar.
2. Enter your **NVIDIA API Key** and **Tavily API Key**.
3. Enter your **Deepgram API Key** (required for YouTube audio mode).
4. Click **Save Settings**.

> **Developer Note:** Copy `.env.example` to `.env` for local reference. Production keys are stored securely per user in Chrome's encrypted `chrome.storage.sync` and are never committed to Git repository.

---

### 4. Start Fact-Checking

#### **A. On Web News Articles (BBC, CNN, Kompas, Medium, Wikipedia, etc.):**
1. Open any news article page in your browser.
2. A floating **`CHECK FACTS`** button appears in the bottom-right corner.
3. Click it (or press **Start Fact-Check** from the popup).
4. Aletheia reads the article, extracts factual claims, searches Tavily for ground truth, and renders verdict cards directly on the page!

#### **B. On YouTube Videos (`youtube.com/watch`):**
1. Open a YouTube video with English speech.
2. Click **Start Fact-Check** from the Aletheia extension popup.
3. Aletheia streams live speech feedback (`Transcribing: "..."`) and checks claims in 15-second windows.
4. Grounded verdict cards appear in the floating, draggable overlay panel!

---

## Project Structure

```
aletheia/
|-- manifest.json                 # Chrome MV3 manifest
|-- service-worker.js             # Background orchestrator & messaging
|-- config.js                     # Centralized configuration & defaults
|-- .env.example                  # Environment template file
|
|-- modules/
|   |-- pipeline.js               # 3-stage fact-checking pipeline (NVIDIA NIM + Tavily)
|   +-- cache.js                  # SHA-256 verdict caching (chrome.storage.local)
|
|-- content/
|   |-- styles.js                 # Shadow DOM Neobrutalist design system & themes
|   |-- extractor.js              # Article DOM extraction & page detection
|   |-- overlay.js                # AletheiaOverlay UI (floating, draggable panel)
|   |-- content.js                # Entry point: trigger button & status listeners
|   +-- content.css               # Host element positioning
|
|-- offscreen/
|   |-- offscreen.html            # Audio capture shell
|   +-- offscreen.js              # MediaRecorder & Deepgram WebSocket stream
|
|-- popup/
|   |-- popup.html                # Neobrutalist settings UI shell
|   |-- popup.js                  # Settings persistence & theme handler
|   |-- popup.css                 # Main CSS entry point
|   +-- styles/
|       |-- base.css              # Layout resets & CSS custom properties
|       |-- header.css            # Header & theme toggle switch
|       +-- form.css              # Input fields, engine cards & buttons
|
+-- icons/                        # Extension brand assets (16, 48, 128, logo)
```

---

## License

This project is open-source under the **MIT License**.
