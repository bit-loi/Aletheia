/**
 * ocrClient.ts: Client for the standalone PaddleOCR microservice (Phase 2).
 *
 * PHASE 2 NOT IMPLEMENTED IN THE CURRENT BUILD.
 *
 * This module calls the PaddleOCR FastAPI service with a single image frame
 * and returns the extracted text. The service is hosted separately from the
 * Cloudflare Worker (Workers cannot run Python).
 *
 * Expected endpoint: POST /ocr
 * Request body: { "image": "<base64-encoded image>" }
 * Response: { "text": "extracted text", "regions": [...] }
 */

import { CONFIG } from './config';

export interface OcrRegionDetail {
  text: string;
  confidence?: number;
  bbox?: [number, number, number, number];
}

export interface OcrResult {
  text: string;
  regions: string[] | OcrRegionDetail[];
}

/**
 * Send a single frame to the PaddleOCR service and get extracted text back.
 *
 * Phase 2 returns empty result in Phase 1.
 */
export async function extractTextFromFrame(
  frameBase64: string,
): Promise<OcrResult> {
  if (!CONFIG.OCR_SERVICE_URL) {
    return { text: '', regions: [] };
  }

  const base = CONFIG.OCR_SERVICE_URL.replace(/\/$/, '');
  const res = await fetch(`${base}/ocr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: frameBase64 }),
  });

  if (!res.ok) {
    console.warn(`[Aletheia] OCR service returned ${res.status}`);
    return { text: '', regions: [] };
  }

  return res.json();
}
