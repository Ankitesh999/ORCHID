from __future__ import annotations

import argparse
import base64
import json
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import requests


DEFAULT_IMAGE_BASE64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1QAAAAASUVORK5CYII="
)

DEFAULT_IMAGE_MIME_TYPE = "image/png"


def iso_now() -> str:
    return datetime.now(tz=timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def infer_mime_type(image_path: str | None) -> str:
    if not image_path:
        return DEFAULT_IMAGE_MIME_TYPE

    suffix = Path(image_path).suffix.lower()
    if suffix == ".png":
        return "image/png"
    if suffix in {".jpg", ".jpeg"}:
        return "image/jpeg"
    if suffix == ".webp":
        return "image/webp"
    return "application/octet-stream"


def load_image_base64(image_path: str | None) -> str:
    if not image_path:
        return DEFAULT_IMAGE_BASE64
    data = Path(image_path).read_bytes()
    return base64.b64encode(data).decode("utf-8")


def send_event(
    *,
    ingest_url: str,
    camera_id: str,
    mock_label: str,
    image_b64: str,
    image_mime_type: str,
    location: dict[str, float],
) -> None:
    request_id = f"{camera_id}-{int(time.time())}-{uuid.uuid4().hex[:8]}"
    payload = {
        "requestId": request_id,
        "cameraId": camera_id,
        "timestamp": iso_now(),
        "mockLabel": mock_label,
        "imageBase64": image_b64,
        "imageMimeType": image_mime_type,
        "location": location,
    }
    response = requests.post(ingest_url, json=payload, timeout=30)
    print("HTTP", response.status_code)
    print(json.dumps(response.json(), indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description="ORCHID mock edge camera")
    parser.add_argument("--ingest-url", required=True, help="Cloud Function URL for ingest_incident")
    parser.add_argument("--camera-id", default="cam-lobby-01")
    parser.add_argument("--mock-label", default="possible_medical_distress")
    parser.add_argument("--image-path", default=None, help="Optional image file path")
    parser.add_argument("--lat", type=float, default=12.9717)
    parser.add_argument("--lng", type=float, default=77.5947)
    args = parser.parse_args()

    image_b64 = load_image_base64(args.image_path)
    image_mime_type = infer_mime_type(args.image_path)
    send_event(
        ingest_url=args.ingest_url,
        camera_id=args.camera_id,
        mock_label=args.mock_label,
        image_b64=image_b64,
        image_mime_type=image_mime_type,
        location={"lat": args.lat, "lng": args.lng},
    )


if __name__ == "__main__":
    main()
