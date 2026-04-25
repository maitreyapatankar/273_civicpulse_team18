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

import anthropic

# TODO: set your chosen model names here
VISION_MODEL:   str = "TODO"   # e.g. "claude-haiku-4-5"
CLASSIFY_MODEL: str = "TODO"   # e.g. "claude-sonnet-4-5"

# TODO: set the environment variable name that holds your Anthropic API key
_API_KEY_ENV: str = "TODO"     # e.g. "ANTHROPIC_API_KEY"

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

def _make_client() -> anthropic.Anthropic:
    return anthropic.Anthropic(api_key=os.environ[_API_KEY_ENV])


# ── Public API ────────────────────────────────────────────────────────────────

def describe_image(image_url: str) -> str:
    """Return a one-paragraph description of road damage visible in the image.

    Sends the image at image_url to the vision model.
    The returned string is passed as image_desc to classify() in Step 2.

    Raises:
        anthropic.APIError on API failure.
    """
    message = _make_client().messages.create(
        model=VISION_MODEL,
        max_tokens=256,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {"type": "url", "url": image_url},
                    },
                    {
                        "type": "text",
                        "text": _VISION_PROMPT,
                    },
                ],
            }
        ],
    )
    return message.content[0].text


def classify(
    text: str | None,
    image_desc: str | None,
    address: str | None,
) -> ClassificationResult:
    """Classify the road issue using the language model.

    Constructs the user prompt using the template from ARCHITECTURE.md,
    calls the model, parses the JSON response, and sets needs_review when
    confidence < 0.70.

    Returns:
        ClassificationResult

    Raises:
        ValueError         if the model response is not valid JSON.
        anthropic.APIError on API failure.
    """
    user_content = (
        f"Location: {address}\n"
        f'Report text: "{text}"\n'
        f"{f'Image description: {image_desc}' if image_desc else ''}"
    )

    message = _make_client().messages.create(
        model=CLASSIFY_MODEL,
        max_tokens=256,
        system=_CLASSIFY_SYSTEM,
        messages=[{"role": "user", "content": user_content}],
    )

    raw_text = message.content[0].text
    try:
        raw = json.loads(raw_text)
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
