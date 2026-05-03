"""
Step 1 — Image description  (vision model)
Step 2 — Classification      (language model, structured JSON)

describe_image(image_url)
    Sends the image to the vision model with the prompt from ARCHITECTURE.md.
    Returns a plain string appended to classification context in Step 2.
    Called only when image_url is present.

classify(text, image_desc, address)
    Sends combined report context to the language model using the exact
    system + user prompts from ARCHITECTURE.md.
    Returns a ClassificationResult dataclass.

Gate: confidence < 0.70 → needs_review = True on the returned result.
      S3 Worker reads this flag; S2 does not act on it.
"""

import json
import os
from dataclasses import dataclass, field

from google import genai
from google.genai import types

VISION_MODEL:   str = "gemini-2.5-flash"
CLASSIFY_MODEL: str = "gemini-2.5-flash"

_API_KEY_ENV: str = "GEMINI_API_KEY"

# ── Prompts — copied verbatim from ARCHITECTURE.md, do not modify ─────────────

_VISION_PROMPT = "Describe visible road damage in this photo. One paragraph."

_CLASSIFY_SYSTEM = """You are a municipal infrastructure classifier for a city maintenance department.
Classify the road issue report below. Respond ONLY with valid JSON — no explanation,
no markdown, no preamble. Match this exact schema:

{
  "issue_type": "pothole" | "flooding" | "sinkhole" | "crack" | "sign_damage" | "other",
  "severity": 1 | 2 | 3 | 4 | 5,
  "confidence": <float 0.0-1.0>,
  "reasoning": "<one sentence>"
}

Severity scale:
1 = cosmetic, no safety risk
2 = minor inconvenience
3 = moderate — affects traffic flow
4 = serious — safety risk to vehicles
5 = critical — immediate danger, possible injury"""

# ── Result type ───────────────────────────────────────────────────────────────

@dataclass
class ClassificationResult:
    issue_type:   str
    severity:     int
    confidence:   float
    reasoning:    str
    needs_review: bool = field(default=False)


# ── Internal helpers ──────────────────────────────────────────────────────────

def _make_client() -> genai.Client:
    return genai.Client(api_key=os.environ[_API_KEY_ENV])


# ── Public API ────────────────────────────────────────────────────────────────

def describe_image(image_url: str) -> str:
    """Return a one-paragraph description of road damage visible in the image.

    Downloads the image and sends it inline to the vision model.
    The returned string is passed as image_desc to classify() in Step 2.

    Raises:
        google.api_core.exceptions.GoogleAPIError on API failure.
    """
    image_bytes = _fetch_image_bytes(image_url)
    client = _make_client()
    response = client.models.generate_content(
        model=VISION_MODEL,
        contents=[
            types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg"),
            _VISION_PROMPT,
        ],
    )
    return response.text


def _fetch_image_bytes(url: str) -> bytes:
    """Download image bytes from a URL for Gemini inline data."""
    import urllib.request
    with urllib.request.urlopen(url) as resp:  # noqa: S310
        return resp.read()


def classify(
    text: str | None,
    image_desc: str | None,
    address: str | None,
) -> ClassificationResult:
    """Classify the road issue using the language model.

    Returns:
        ClassificationResult

    Raises:
        ValueError                              if the model response is not valid JSON.
        google.api_core.exceptions.GoogleAPIError on API failure.
    """
    user_content = (
        f"Location: {address}\n"
        f'Report text: "{text}"\n'
        f"{f'Image description: {image_desc}' if image_desc else ''}"
    )

    client = _make_client()
    response = client.models.generate_content(
        model=CLASSIFY_MODEL,
        contents=user_content,
        config=types.GenerateContentConfig(
            system_instruction=_CLASSIFY_SYSTEM,
        ),
    )

    raw_text = response.text
    try:
        # Strip markdown code fences if Gemini wraps the JSON
        cleaned = raw_text.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        raw = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Model returned invalid JSON: {raw_text!r}") from exc

    result = ClassificationResult(
        issue_type=raw["issue_type"],
        severity=int(raw["severity"]),
        confidence=float(raw["confidence"]),
        reasoning=raw["reasoning"],
    )
    if result.confidence < 0.70:
        result.needs_review = True

    return result
