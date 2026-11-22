"""Local receipt read: Mirage OCR, then Needle extract on that text.

Stdio worker. Each stdin line is {"id", "path"}. Each stdout line is
{"id", "ok", "text", "fields"} or {"ok": false, "fatal": true}.

Mirage reads the image on this machine (no vision API). Needle copies fields
only when they are grounded in that transcript. Install once:

    pip install -U cactus-compute
"""

from __future__ import annotations

import json
import os
import sys

os.environ.setdefault("CACTUS_TELEMETRY", "0")

RECEIPT_TOOL = {
    "name": "receipt",
    "description": (
        "Copy receipt fields that are printed in the OCR text. "
        "Omit every field that is not written there."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "merchant": {
                "type": "string",
                "description": "Brand or payee name printed on the receipt",
            },
            "grand_total": {
                "type": "number",
                "description": "Final amount paid or payable",
            },
            "currency": {
                "type": "string",
                "description": "ISO currency code such as INR or USD",
            },
            "date": {"type": "string", "description": "Date as printed"},
            "time": {"type": "string", "description": "Time as printed"},
            "payment_status": {
                "type": "string",
                "enum": ["success", "failed", "pending"],
            },
            "transaction_type": {
                "type": "string",
                "enum": ["expense", "income", "transfer"],
            },
            "payment_method": {"type": "string"},
            "description": {"type": "string"},
            "notes": {"type": "string"},
        },
        "required": ["grand_total"],
    },
}

_extract_broken = False


def _box_origin(item: dict) -> tuple[float, float]:
    bbox = item.get("bbox") or item.get("box") or item.get("rect")
    if isinstance(bbox, (list, tuple)) and len(bbox) >= 2:
        return float(bbox[0]), float(bbox[1])
    if isinstance(bbox, dict):
        return (
            float(bbox.get("x") or bbox.get("x1") or 0),
            float(bbox.get("y") or bbox.get("y1") or 0),
        )
    return 0.0, 0.0


def _line_text(item) -> str:
    if isinstance(item, str):
        return item.strip()
    if not isinstance(item, dict):
        return ""
    score = item.get("score", item.get("text_conf", item.get("conf")))
    try:
        if score is not None and float(score) < 0.25:
            return ""
    except (TypeError, ValueError):
        pass
    for key in ("text", "content", "value", "line"):
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def flatten_text(result) -> str:
    """OCR lines only. Scene captions and reasoning are not evidence."""
    if isinstance(result, str):
        return result.strip()
    if not isinstance(result, dict):
        return ""
    raw = result.get("text")
    if raw is None:
        raw = result.get("texts") or result.get("lines") or []
    if isinstance(raw, str):
        return raw.strip()
    if not isinstance(raw, list):
        return ""

    placed: list[tuple[float, float, str]] = []
    for item in raw:
        text = _line_text(item)
        if not text:
            continue
        x, y = _box_origin(item) if isinstance(item, dict) else (0.0, 0.0)
        placed.append((y, x, text))
    placed.sort(key=lambda row: (round(row[0] / 28), row[1]))

    lines: list[str] = []
    bucket: list[str] = []
    bucket_y: float | None = None
    for y, _x, text in placed:
        if bucket_y is None or abs(y - bucket_y) <= 18:
            bucket.append(text)
            bucket_y = y if bucket_y is None else bucket_y
        else:
            lines.append(" ".join(bucket))
            bucket = [text]
            bucket_y = y
    if bucket:
        lines.append(" ".join(bucket))
    return "\n".join(lines).strip()


def _as_fields(extracted) -> dict | None:
    data = extracted
    if hasattr(extracted, "model_dump"):
        data = extracted.model_dump()
    elif not isinstance(extracted, dict):
        return None
    if isinstance(data, dict) and data.get("function_calls"):
        calls = data["function_calls"]
        data = calls[0].get("arguments") if calls else None
    elif isinstance(data, dict) and isinstance(data.get("arguments"), dict):
        data = data["arguments"]
    if not isinstance(data, dict):
        return None
    cleaned = {
        key: value
        for key, value in data.items()
        if value not in (None, "", [])
    }
    return cleaned or None


def extract_fields(text: str) -> dict | None:
    """Needle copies fields only when the engine can ground them in the OCR."""
    global _extract_broken
    if _extract_broken or len(text) < 12:
        return None
    try:
        import cactus

        extracted = cactus.extract(
            text,
            RECEIPT_TOOL,
            system="Copy only numbers and names that appear in the receipt text.",
            strict=True,
            max_new_tokens=256,
        )
    except Exception as exc:
        name = type(exc).__name__
        if name == "ExtractionValidationError":
            return None
        message = str(exc).lower()
        if name in ("TypeError", "ValueError") or "schema" in message or "tool" in message:
            _extract_broken = True
        return None
    if extracted is None:
        return None
    return _as_fields(extracted)


def read_image(cactus, vision, path: str) -> dict:
    if vision[0] is None:
        vision[0] = cactus.Mirage()
    described = vision[0].describe(
        path,
        sections=["text"],
        fields=["bbox", "score"],
        max_text_lines=80,
        max_tokens=64,
    )
    text = flatten_text(described)
    return {"ok": True, "text": text, "fields": extract_fields(text)}


def main() -> int:
    try:
        import cactus
    except Exception as exc:
        sys.stdout.write(
            json.dumps(
                {
                    "ok": False,
                    "fatal": True,
                    "error": f"cactus unavailable: {exc}",
                }
            )
            + "\n"
        )
        sys.stdout.flush()
        return 1

    vision = [None]
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            req = json.loads(line)
            request_id = req.get("id")
            path = req.get("path")
            if not path:
                raise ValueError("missing path")
            payload = read_image(cactus, vision, path)
        except Exception as exc:
            payload = {"ok": False, "error": str(exc)}
        if request_id is not None:
            payload["id"] = request_id
        sys.stdout.write(json.dumps(payload) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
