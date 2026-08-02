"""
Standalone PaddleOCR Microservice for Aletheia Mobile.

Endpoints:
  POST /ocr     Extract text from a base64-encoded image frame.
  GET  /health  Service health check.
"""

import base64
import io
import logging
from typing import List
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from PIL import Image
import numpy as np

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("aletheia_ocr")

# Lazy/global initialization of PaddleOCR model
try:
    from paddleocr import PaddleOCR
    ocr_engine = PaddleOCR(use_angle_cls=True, lang='en', show_log=False)
    logger.info("PaddleOCR initialized successfully.")
except Exception as e:
    logger.warning(f"PaddleOCR initialisation warning: {e}")
    ocr_engine = None

app = FastAPI(title="Aletheia PaddleOCR Service", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class OcrRequest(BaseModel):
    image: str


class OcrResponse(BaseModel):
    text: str
    regions: List[str]


@app.get("/health")
def health_check():
    return {
        "status": "ok",
        "ocr_engine": ocr_engine is not None,
    }


@app.post("/ocr", response_model=OcrResponse)
def process_ocr(payload: OcrRequest):
    if not payload.image:
        raise HTTPException(status_code=400, detail="Base64 image string is required")

    base64_str = payload.image.strip()
    # Strip data URI prefix if caller mistakenly included it
    if "," in base64_str:
        base64_str = base64_str.split(",", 1)[1]

    try:
        image_bytes = base64.b64decode(base64_str)
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        img_np = np.array(img)
    except Exception as err:
        raise HTTPException(status_code=400, detail=f"Invalid base64 image data: {str(err)}")

    if ocr_engine is None:
        raise HTTPException(
            status_code=503, detail="PaddleOCR engine failed to initialize"
        )

    try:
        results = ocr_engine.ocr(img_np, cls=True)
        regions: List[str] = []

        if results and isinstance(results, list):
            for res in results:
                if not res:
                    continue
                for line in res:
                    if line and len(line) >= 2:
                        text_tuple = line[1]
                        if isinstance(text_tuple, (tuple, list)) and len(text_tuple) > 0:
                            extracted_line = str(text_tuple[0]).strip()
                            if extracted_line:
                                regions.append(extracted_line)

        combined_text = "\n".join(regions)
        return OcrResponse(text=combined_text, regions=regions)
    except Exception as err:
        logger.error(f"OCR execution failed: {err}")
        raise HTTPException(status_code=500, detail=f"OCR processing failed: {str(err)}")
