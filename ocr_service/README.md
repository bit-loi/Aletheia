# Aletheia PaddleOCR Microservice

Standalone FastAPI microservice for extracting text from screen frames captured by the Aletheia mobile application.

## Endpoints

- `GET /health` : Liveness check
- `POST /ocr` : Extract text from base64 image
  - **Body**: `{ "image": "<base64_encoded_string_without_prefix>" }`
  - **Response**: `{ "text": "Extracted text line 1\nLine 2", "regions": ["Extracted text line 1", "Line 2"] }`

## Prerequisites

- Python 3.9+ installed
- `pip` / `virtualenv`

## Local Setup & Execution

1. **Navigate to microservice directory**:
   ```bash
   cd ocr_service
   ```

2. **Create and activate virtual environment**:
   ```bash
   python -m venv venv
   # On Windows:
   .\venv\Scripts\activate
   # On macOS/Linux:
   source venv/bin/activate
   ```

3. **Install Dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

4. **Run Uvicorn Dev Server**:
   ```bash
   uvicorn ocr_service:app --host 0.0.0.0 --port 8000 --reload
   ```

## Exposing for Mobile Demo Testing (ngrok)

To test from physical iOS/Android devices or local emulators on the same network, expose port 8000 using ngrok:

```bash
ngrok http 8000
```

Copy the generated HTTPS URL (e.g. `https://xxxx.ngrok-free.app`) and set it in your mobile app's `CONFIG.OCR_SERVICE_URL` in `src/config.ts`.
