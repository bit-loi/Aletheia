# <img src="icons/Aletheia-Logo.png" width="40" height="40" alt="Aletheia logo" align="center"> Aletheia

**AI-powered real-time fact-checking for news articles and YouTube videos.**

Built for the **UNESCO Youth Hackathon 2026**, AI and Media & Information Literacy track.

> *Aletheia (ancient Greek: disclosure, unconcealment of truth)* is the philosophical concept of truth as something revealed rather than constructed.

---

## What It Does

Aletheia is a Chrome extension that helps audiences verify claims **while they're reading or watching**, directly on the page:

1. **Extracts** verifiable factual claims from article text or video audio
2. **Searches** for credible evidence using web search APIs
3. **Generates** a grounded verdict: True, False, Misleading, or Unverified
4. **Displays** results in a floating overlay with source links users can check themselves

### Who It's For

Indonesian youth, first-time voters, students, and general audiences navigating political and health news. Anyone who wants to verify before they share.

---

## Features

| Feature | Description |
|---------|-------------|
| **Article Mode** | Reads article text directly from the page DOM, no copy-pasting URLs |
| **YouTube Mode** | Captures live tab audio, transcribes via Deepgram, checks claims in near-real-time |
| **Floating Overlay** | Glassmorphic panel injected into the page, minimizable, doesn't block content |
| **Grounded Verdicts** | Verdicts are strictly based on retrieved evidence, not the LLM's training data |
| **Claim Caching** | Repeated/viral claims get instant results without re-running the pipeline |
| **Your Own Keys** | API keys stored locally in your browser, never sent anywhere except the API endpoints |
| **Model Flexibility** | Choose from 15+ models across Anthropic, Google, OpenAI, Meta, and DeepSeek |

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
|  |    extraction     |               |  |   Pipeline            | ||
|  |  * Overlay UI     |               |  |                       | ||
|  |    (Shadow DOM)   |               |  |  1. Extract claims    | ||
|  |                   |               |  |     (OpenRouter LLM)  | ||
|  +-------------------+               |  |  2. Search evidence   | ||
|                                      |  |     (Tavily)          | ||
|  +-------------------+               |  |  3. Verdict           | ||
|  | Offscreen Doc     |               |  |     (OpenRouter LLM)  | ||
|  | (YouTube only)    |<------------>|  +----------------------+ ||
|  |                   |               |                            ||
|  |  * Tab audio      |               |  +----------------------+ ||
|  |    capture        |               |  |   Cache               | ||
|  |  * Deepgram       |               |  |  chrome.storage.local | ||
|  |    WebSocket      |               |  +----------------------+ ||
|  +-------------------+               +--------------------------+||
|                                                                   |
|  +-------------------+                                            |
|  |  Popup            |  Settings: API keys, model selection       |
|  |  (chrome.storage  |  stored via chrome.storage.sync            |
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
| OpenRouter | LLM for claim extraction and verdicts | $5 free credit | [openrouter.ai/keys](https://openrouter.ai/keys) |
| Tavily | Web search for evidence retrieval | 1,000 free searches/mo | [app.tavily.com](https://app.tavily.com/) |
| Deepgram | Live audio transcription (YouTube mode only) | $200 free credit | [console.deepgram.com](https://console.deepgram.com/) |

### 2. Install the Extension

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions`
3. Enable **Developer mode** (toggle in top-right corner)
4. Click **Load unpacked**
5. Select the `Aletheia/` folder
6. The Aletheia icon should appear in your toolbar

### 3. Configure API Keys

1. Click the **Aletheia icon** in the Chrome toolbar
2. Enter your **OpenRouter** and **Tavily** API keys (required)
3. Optionally enter your **Deepgram** API key (for YouTube mode)
4. Choose your preferred LLM model (default: Claude Sonnet 4)
5. Click **Save Settings**

### 4. Start Fact-Checking

**On a news article:**
1. Navigate to any news article (BBC, Reuters, Kompas, Detik, etc.)
2. If the page has enough text content, a floating **Check Facts** button appears in the top-right
3. Click it. Aletheia extracts claims, searches for evidence, and displays verdicts in an overlay panel

**On YouTube (requires Deepgram key):**
1. Navigate to a YouTube video
2. Aletheia automatically starts capturing audio and transcribing
3. Every ~20 seconds, claims from the transcript are extracted and checked
4. Results appear in the same overlay panel

---

## Project Structure

```
aletheia/
|-- manifest.json                 # Chrome MV3 manifest
|-- service-worker.js             # Background orchestrator
|
|-- modules/
|   |-- pipeline.js               # 3-stage fact-checking pipeline
|   |                             #   extractClaims > retrieveEvidence > generateVerdict
|   +-- cache.js                  # Claim-level verdict caching (SHA-256 + TTL)
|
|-- content/
|   |-- styles.js                 # Theme constants + Shadow DOM stylesheet
|   |-- extractor.js              # Page detection + article text extraction
|   |-- overlay.js                # AletheiaOverlay class (floating panel UI)
|   |-- content.js                # Entry point: init, messaging, trigger button
|   +-- content.css               # Host element positioning
|
|-- popup/
|   |-- popup.html                # Settings UI
|   |-- popup.js                  # Settings persistence
|   +-- popup.css                 # Popup styling
|
|-- offscreen/
|   |-- offscreen.html            # Offscreen document shell (MV3 requirement)
|   +-- offscreen.js              # Tab audio capture + Deepgram WebSocket
|
|-- icons/
|   |-- Aletheia-Logo.png         # Master logo asset
|   |-- icon16.png                # Chrome extension 16x16 icon
|   |-- icon48.png                # Chrome extension 48x48 icon
|   +-- icon128.png               # Chrome extension 128x128 icon
|
+-- README.md
```

---

## How the Pipeline Works

```
Article text / Transcript chunk
        |
        v
+-------------------------------+
|  Stage 1: Claim Extraction    |  1x OpenRouter API call
|                               |
|  LLM identifies 5 to 8       |  Prompt: "Extract specific,
|  falsifiable factual claims   |  falsifiable claims only..."
|  from the text                |
+---------------+---------------+
                |
                v  (for each claim)
+-------------------------------+
|  Cache Check                  |  SHA-256(normalized claim)
|  Hit? Skip to display         |  TTL: 24 hours
|  Miss? Continue below         |
+---------------+---------------+
                |
                v
+-------------------------------+
|  Stage 2: Evidence Search     |  1x Tavily API call per claim
|                               |
|  Web search for credible      |  Returns: title, URL, snippet
|  sources (top 5 results)      |  for each result
+---------------+---------------+
                |
                v
+-------------------------------+
|  Stage 3: Verdict             |  1x OpenRouter API call per claim
|                               |
|  LLM evaluates claim          |  Grounded ONLY in retrieved
|  against retrieved evidence   |  evidence, not training data
|                               |
|  Output:                      |  Verdicts:
|  - verdict                    |  True, False,
|  - explanation                |  Misleading, Unverified
|  - confidence (H/M/L)        |
|  - source URLs                |
+---------------+---------------+
                |
                v
    Display in overlay
    + cache the verdict
```

**API calls per article:** 1 (extraction) + N x 2 (evidence + verdict per claim), where N = 5 to 8 claims typically. A typical article costs 11 to 17 API calls total.

---

## Supported Models

All models are accessed through OpenRouter's unified API. Multimodal models can process both text and images.

### Anthropic (Multimodal)

| Model | Speed | Relative Cost | Notes |
|-------|-------|---------------|-------|
| Claude Sonnet 4 | Medium | $$ | **Default.** Best accuracy for fact-checking |
| Claude 3.5 Sonnet | Medium | $$ | Strong all-rounder |
| Claude 3 Haiku | Fast | $ | Good for quick demos |

### Google (Multimodal)

| Model | Speed | Relative Cost | Notes |
|-------|-------|---------------|-------|
| Gemini 2.5 Pro | Medium | $$ | Best reasoning in the Gemini family |
| Gemini 2.5 Flash | Fast | $ | Great speed/quality tradeoff |
| Gemini 2.0 Flash | Fast | $ | Previous gen, still capable |

### OpenAI (Multimodal)

| Model | Speed | Relative Cost | Notes |
|-------|-------|---------------|-------|
| GPT-4o | Medium | $$ | Full-size multimodal flagship |
| GPT-4o Mini | Fast | $ | Smaller, budget-friendly |
| GPT-4.1 | Medium | $$ | Latest generation |
| GPT-4.1 Mini | Fast | $ | Balanced cost/performance |
| GPT-4.1 Nano | Very fast | cents | Cheapest option available |

### Meta (Multimodal)

| Model | Speed | Relative Cost | Notes |
|-------|-------|---------------|-------|
| Llama 4 Maverick | Medium | $ | Open-weight, strong multilingual |
| Llama 4 Scout | Fast | $ | Lighter variant |

### DeepSeek (Text only)

| Model | Speed | Relative Cost | Notes |
|-------|-------|---------------|-------|
| DeepSeek R1 | Slow | $ | Chain-of-thought reasoning |
| DeepSeek V3 | Medium | $ | General purpose |

---

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Extension | Chrome Manifest V3 | Modern extension platform, required for new extensions |
| UI Isolation | Shadow DOM | Prevents host page CSS from breaking the overlay |
| LLM | OpenRouter (OpenAI-compatible API) | Model-agnostic: switch between Claude, GPT, Gemini, Llama |
| Evidence Search | Tavily API | Purpose-built for AI search, returns clean snippets |
| Transcription | Deepgram Nova-2 | Real-time streaming ASR, free tier available |
| Audio Capture | chrome.tabCapture + Offscreen API | MV3-compliant audio access |
| Caching | chrome.storage.local | Persistent, 5MB limit, no external dependencies |
| Settings | chrome.storage.sync | Syncs across devices via Chrome account |

---

## Privacy and Security

- **No data collection.** Aletheia does not collect, store, or transmit any user data beyond the API calls needed to check facts.
- **API keys stay local.** Keys are stored in `chrome.storage.sync` (encrypted by Chrome) and only sent to their respective API endpoints.
- **No tracking.** No analytics, no telemetry, no cookies.
- **Open source.** All code is inspectable in this repository.

---

## Permissions Explained

| Permission | Why It's Needed |
|-----------|-----------------|
| `storage` | Save API keys and cached verdicts locally |
| `activeTab` | Read the current tab's URL and page content |
| `tabCapture` | Capture tab audio for YouTube transcription |
| `offscreen` | Create an offscreen document for audio processing (MV3 requirement) |
| Host permissions (OpenRouter, Tavily, Deepgram) | Make API calls to these services |

---

## Team

Built by **Team Aletheia** for the UNESCO Youth Hackathon 2026.

---

## License

MIT. See [LICENSE](LICENSE) for details.
