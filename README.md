# <img src="icons/Aletheia-Logo.png" width="40" height="40" alt="Aletheia logo" align="center"> Aletheia

**Aletheia: Real-Time AI Agent for Fact-Checking News Videos and Web Articles**

Built for the **UNESCO Youth Hackathon 2026** — *Artificial Intelligence (AI) and Media & Information Literacy (MIL)* track.  
*Theme: "Play Your Part: Youth Designing the Future of Media and Information Literacy"*

> **Aletheia** *(ancient Greek: disclosure, unconcealment of truth)* is the philosophical concept of truth as something revealed rather than constructed.

---

## 1. Team Information

* **Jason Brandon Loi** — Project Lead
* **Rizky Mirzaviandy Priambodo** — AI & Technical Development
* **Nadya Angelie Lislie** — Media and Information Literacy Specialist
* **Britney Angeline Soeseno** — Product & UX Design

> *Note: Team member names and roles subject to finalization before submission.*

---

## 2. Project Information

* **Project Title:** Aletheia
* **Category:** B. Applications / Websites
* **Challenge Track:** Artificial Intelligence (AI) and Media and Information Literacy (MIL)

### Brief Introduction
**Aletheia** is an autonomous AI agent application designed for real-time fact-checking while users watch YouTube news videos or read online news articles. Operating directly within the browser, Aletheia leverages an agentic pipeline to capture live video audio or web text, extract verifiable factual claims, retrieve empirical evidence from credible sources via automated search tools, and present grounded verdicts (True, False, or Misleading) alongside transparent source citations. 

While architected to be globally scalable and language-agnostic, Aletheia is launching first in Indonesia to address the rapid spread of digital misinformation among its vast youth demographic, where fast-moving news cycles and established local fact-checking data sources provide an ideal ecosystem for impact.

---

## 3. Problem Statement

Online news consumption increasingly occurs through YouTube streams and digital web articles that blur the line between verified journalism, speculation, and outright misinformation. Viewers and readers lack frictionless tools to verify claims in real time. 

By the time professional fact-checkers release a debunking report, false narratives have already circulated to thousands of users. This gap is particularly dangerous during high-stakes, fast-moving events like elections or breaking news, where emotional framing and speed outpace accuracy. In Indonesia, this challenge is acute due to a massive, mobile-first youth population navigating a crowded media landscape where hoaxes and credible reporting share the exact same channels.

---

## 4. Objectives

* **Lower Barriers to Verification:** Enable any user, regardless of technical background or digital literacy level, to fact-check claims within seconds at the point of consumption.
* **Shift to Proactive Verification:** Move fact-checking from a reactive, post-viral correction process to an inline, real-time experience as content is actively consumed.
* **Mitigate Misinformation Spread:** Provide an accessible, evidence-grounded AI agent that stops false narratives before they go viral.
* **Cultivate Media & Information Literacy (MIL):** Display the explicit reasoning, chain of thought, and underlying sources behind every verdict, empowering users to critically analyze news claims independently over time.

---

## 5. Target Audience

* **Primary Users:** YouTube news viewers, social media consumers, first-time voters, and students seeking to verify political, health, or social claims on the fly.
* **Secondary Beneficiaries:** Digital literacy educators using Aletheia as an interactive teaching tool, as well as newsrooms and platforms striving to reinforce public trust in journalism.
* **Geographic Focus:** Initial deployment focuses on Indonesian digital audiences, but the underlying multi-agent architecture—spanning speech recognition, claim extraction, evidence search, and reasoning—is language-agnostic and scalable across global news markets.

---

## 6. Prototype & Concept (Core Agentic Pipeline)

Aletheia functions as an autonomous **Agentic Multi-Step System** operating through a lightweight browser overlay. For YouTube news videos, it listens to the active tab's stream, transcribes spoken content in real-time, isolates verifiable factual statements, and cross-examines them against web evidence. For web articles, it parses readable DOM text to surface inline verdicts directly alongside news paragraphs.

```
+--------------------------------------------------------------------+
|                         Chrome Extension                           |
|                                                                    |
|  +-------------------+     messages     +------------------------+ |
|  |  Content Scripts  |<---------------->|    Service Worker      | |
|  |                   |                  |    (Background)        | |
|  |  * DOM extraction |                  |                        | |
|  |  * Neobrutalist UI|                  |  +-------------------+ | |
|  |    (Shadow DOM)   |                  |  |  Agentic Pipeline | | |
|  |  * Draggable panel|                  |  |  1. Claim Extract | | |
|  +-------------------+                  |  |     (NVIDIA NIM)  | | |
|                                         |  |  2. Search Tool   | | |
|  +-------------------+                  |  |     (Tavily)      | | |
|  | Offscreen Doc     |                  |  |  3. Grounded RAG  | | |
|  | (YouTube mode)    |<---------------->|  |     (NVIDIA NIM)  | | |
|  |                   |                  |  +-------------------+ | |
|  |  * Tab audio      |                  |                        | |
|  |  * Deepgram WS    |                  |  +-------------------+ | |
|  +-------------------+                  |  |  Verdict Cache    | | |
|                                         |  |  chrome.storage   | | |
|                                         |  +-------------------+ | |
|                                         +------------------------+ |
+--------------------------------------------------------------------+
```

### Key Stages
1. **Perception & Ingestion:** Captures live audio streams from video tabs or extracts structured text blocks from active web articles.
2. **Streaming Speech-to-Text:** Converts live tab audio into text chunks in low-latency real-time via WebSocket connections (Deepgram).
3. **Decomposition & Claim Extraction:** An AI extraction agent evaluates incoming text chunks to identify discrete, empirical, and verifiable claims (filtering out opinions and subjective framing) powered by **NVIDIA NIM (`minimaxai/minimax-m3`)**.
4. **Tool Use & Evidence Retrieval:** An automated search agent crafts targeted search queries and queries trusted search APIs (**Tavily**) to gather real-world context.
5. **Grounded Verdict Generation:** A reasoning LLM evaluates the retrieved search context against the extracted claim to generate a verdict (True, False, or Misleading) along with an auditable explanation strictly constrained to the retrieved evidence to eliminate hallucinations.
6. **Dynamic Overlay UI:** Displays color-coded badges, concise explanations, and direct source links on a non-intrusive Neobrutalist overlay on top of the media content.

---

## 7. Creativity & Differentiation

Unlike traditional fact-checking tools that rely on manual human review or post-publication database lookups, Aletheia operates **at the point of consumption in real time**.

Furthermore, Aletheia distinguishes itself from generic LLM chatbots by employing a **Grounded Agentic RAG Architecture**. Instead of relying on the static, potentially outdated training memory of a language model, Aletheia forces the AI to ground every verdict exclusively in freshly retrieved, verifiable web sources. By making these sources and the reasoning path visible on the screen, Aletheia actively teaches critical thinking rather than imposing an opaque automated judgment.

---

## 8. Feasibility & Technical Implementation

The technical feasibility of Aletheia is proven through a functional Chrome Extension (Manifest V3) prototype, enabling live overlays without interrupting the user's viewing or reading experience.

* **Real-Time Audio Capture & Transcription:** Utilizes Chrome’s native `tabCapture` API routed through a background Offscreen Document to stream live tab audio directly to a Deepgram WebSocket API. This architecture achieves low-latency speech-to-text conversion for live YouTube playback.
* **High-Throughput Agentic Pipeline:** Transcribed chunks are ingested by high-speed LLM endpoints (**NVIDIA NIM `minimaxai/minimax-m3`** / Google Gemini 2.0 Flash) configured with structured JSON outputs for reliable claim extraction.
* **Evidence Search Integration:** Claims are routed through automated retrieval agents powered by APIs like **Tavily Search** to gather real-time web evidence.
* **Optimization for Scale & Rate Limits:** Implements client-side claim batching, exponential backoff handling (`delay *= 2`), throttled 15-second audio buffering, and an in-memory SHA-256 caching layer for viral news claims to optimize API token usage and keep latency low for end-users.

---

## 9. Sustainability and Future Development

* **Cross-Platform Expansion:** Evolve the working Manifest V3 Chrome Extension into a cross-browser extension (Firefox, Edge, Safari), followed by mobile-first PWA integrations and messaging app bots (e.g., WhatsApp/Telegram) to check forwarded video clips and text links instantly.
* **Multilingual & Dialect Support:** Expand native language models from Bahasa Indonesia to regional dialects (Javanese, Sundanese) and broader Southeast Asian languages.
* **Institutional & Educational Partnerships:** Partner with media literacy programs, university journalism departments, and local fact-checking coalitions (e.g., CekFakta) to continuously refine domain-whitelisting algorithms and deploy Aletheia as a classroom tool for MIL education.

---

## 10. Alignment with Challenge Track

Aletheia aligns directly with the **Artificial Intelligence (AI) and Media and Information Literacy (MIL)** track of the UNESCO Youth Hackathon 2026. Rather than treating AI solely as a generator of synthetic misinformation, Aletheia repurposed AI into a defensive, educational agent that safeguards information integrity. 

By revealing source provenance, logic pathways, and underlying evidence for every claim, Aletheia shifts users from passive media consumers to active, critical evaluators—embodying the hackathon theme: **“Play Your Part: Youth Designing the Future of Media and Information Literacy.”**

---

## Developer Quick Start

### 1. Prerequisites
- Google Chrome (or any Chromium-based browser)
- No API keys are required for article fact-checking. The hosted proxy provides
  Gemini and Tavily on a shared, rate-limited quota.
- No user API keys are required. The hosted proxy supplies Gemini, Tavily, and
  a short-lived Deepgram token for YouTube audio mode.

### 2. Installation
1. Clone or download this repository:
   ```bash
   git clone https://github.com/bit-loi/Aletheia.git
   ```
2. Open Chrome and navigate to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the `Aletheia/` folder.

### 3. Start Fact-Checking
1. Open a news article and click the **Aletheia icon**.
2. Click **Check this page**. No setup is required.
3. On a playing YouTube video, click **Listen to this video** to check spoken
   claims as they arrive.

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
|   |-- pipeline.js               # 3-stage fact-checking pipeline (Gemini + Tavily)
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
|   |-- popup.html                # One-click launch panel
|   |-- popup.js                  # Page-mode detection, launch & theme handler
|   |-- popup.css                 # Main CSS entry point
|   +-- styles/
|       |-- base.css              # Layout resets & CSS custom properties
|       |-- header.css            # Header & theme toggle switch
|       +-- form.css              # Connection status, mode card & action button
|
+-- icons/                        # Extension brand assets (16, 48, 128, logo)
```

---

## License

This project is open-source under the **MIT License**.
