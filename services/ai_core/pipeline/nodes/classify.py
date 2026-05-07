import json
import logging
import os
from pathlib import Path

import google.generativeai as genai

from ..state import PipelineState

log = logging.getLogger(__name__)

MODEL = "gemini-2.5-flash-lite"

_api_key = os.environ.get("GEMINI_API_KEY")
if not _api_key:
    raise EnvironmentError(
        "GEMINI_API_KEY is not set. "
        "AI Core cannot start without a Gemini API key."
    )
genai.configure(api_key=_api_key)

# ── Taxonomy — loaded once at import ──────────────────────────────────────────

_taxonomy_path = Path(__file__).parent.parent.parent / "taxonomy.json"
if not _taxonomy_path.exists():
    raise FileNotFoundError(
        f"taxonomy.json not found at {_taxonomy_path}. "
        "AI Core cannot start without the taxonomy file."
    )

_taxonomy = json.loads(_taxonomy_path.read_text())

VALID_CODES: dict[str, str] = {
    sub["code"]: sub["name"]
    for cat in _taxonomy["categories"]
    for sub in cat["subcategories"]
}

VALID_CATEGORY_CODES: dict[str, str] = {
    cat["code"]: cat["name"]
    for cat in _taxonomy["categories"]
}

TAXONOMY_PROMPT_STRING = "\n".join(
    f"{cat['code']} - {cat['name']}:\n"
    + "\n".join(f"  {sub['code']} {sub['name']}" for sub in cat["subcategories"])
    for cat in _taxonomy["categories"]
)

# ── Prompts — built once at module load ───────────────────────────────────────

CLASSIFIER_SYSTEM_PROMPT = f"""
You are a road infrastructure issue classifier for a
municipal maintenance department.

You will receive:
- A citizen report text
- Optionally: an image description from a vision model

Classify into exactly one category and subcategory
from the taxonomy below.

TAXONOMY:
{TAXONOMY_PROMPT_STRING}

CONFLICT RESOLUTION RULES:
- If image description and report text suggest different
  issue types, trust the image description and set
  image_text_conflict = true.
- If no image or image description is absent, trust
  the report text and set image_text_conflict = false.
- If the issue spans two categories, pick the more
  safety-critical one.
- If truly unclassifiable, use OT-005.
- When image_text_conflict = true, populate
  image_classification_hint with what the image
  suggests in plain English (one short phrase).

SEVERITY SCALE:
1 = cosmetic, no safety risk
2 = minor inconvenience
3 = moderate, affects traffic flow
4 = serious, safety risk to vehicles
5 = critical, immediate danger, possible injury

Respond ONLY with valid JSON.
No explanation. No markdown. No preamble.
Match this exact schema:
{{
  "category_code": "<2-letter code>",
  "category_name": "<full category name>",
  "subcategory_code": "<XX-000>",
  "subcategory_name": "<full subcategory name>",
  "severity": <integer 1-5>,
  "confidence": <float 0.0-1.0>,
  "reasoning": "<one sentence>",
  "image_text_conflict": <true or false>,
  "image_classification_hint": "<string, empty if no conflict>"
}}
"""


# ── Code validation ────────────────────────────────────────────────────────────

def _validate_code(raw: str) -> tuple[str, bool]:
    """
    Returns (validated_code, fallback_used).
    Tries: raw as-is, uppercased, hyphen-inserted, then OT-005.
    fallback_used=True only if OT-005 was reached.
    """
    candidate = raw.strip()
    if candidate in VALID_CODES:
        return candidate, False

    upper = candidate.upper()
    if upper in VALID_CODES:
        return upper, False

    if len(upper) >= 3 and "-" not in upper:
        with_hyphen = upper[:2] + "-" + upper[2:]
        if with_hyphen in VALID_CODES:
            return with_hyphen, False

    return "OT-005", True


# ── Node ──────────────────────────────────────────────────────────────────────

def classify_node(state: PipelineState) -> PipelineState:
    try:
        log.info(
            "classify_start report_id=%s has_image_desc=%s",
            state.get("report_id"),
            bool(state.get("image_desc")),
        )
        user_msg = f'Report text: "{state["text"]}"'
        if state.get("image_desc"):
            user_msg += f'\nImage description: {state["image_desc"]}'
        else:
            user_msg += '\nNo image provided.'

        model = genai.GenerativeModel(
            MODEL,
            generation_config=genai.GenerationConfig(
                response_mime_type="application/json"
            ),
        )
        response = model.generate_content(
            [CLASSIFIER_SYSTEM_PROMPT, user_msg],
            request_options={"timeout": 30},
        )

        try:
            raw = json.loads(response.text)
        except json.JSONDecodeError as e:
            log.warning("classify_parse_failed report_id=%s error=%s", state.get("report_id"), e)
            return {
                **state,
                "category_code":             "OT",
                "category_name":             "Other",
                "subcategory_code":          "OT-005",
                "subcategory_name":          "Unclear / unidentifiable",
                "severity":                  None,
                "confidence":                0.0,
                "reasoning":                 None,
                "image_text_conflict":       False,
                "image_classification_hint": "",
                "needs_review":              True,
                "pipeline_error":            f"JSON parse failed: {e}",
                "completed_nodes":           state["completed_nodes"] + ["classify"],
            }

        # B3: use .get() for every key — missing fields fall back gracefully
        raw_subcode   = raw.get("subcategory_code") or ""
        raw_catcode   = raw.get("category_code") or ""
        raw_conf      = raw.get("confidence", 0.0)
        raw_severity  = raw.get("severity")
        raw_conflict  = raw.get("image_text_conflict", False)

        validated_code, _ = _validate_code(raw_subcode)

        # B4: validate category_code against taxonomy; fall back to the prefix
        # derived from the validated subcategory code so auto-assign still works.
        raw_catcode_upper = raw_catcode.strip().upper()
        if raw_catcode_upper in VALID_CATEGORY_CODES:
            category_code = raw_catcode_upper
            category_name = VALID_CATEGORY_CODES[category_code]
        else:
            # Derive category from validated subcategory prefix (e.g. "RD-001" → "RD")
            derived = validated_code.split("-")[0]
            category_code = derived if derived in VALID_CATEGORY_CODES else "OT"
            category_name = VALID_CATEGORY_CODES.get(category_code, "Other")
            log.warning(
                "classify_invalid_category report_id=%s raw=%s derived=%s",
                state.get("report_id"), raw_catcode, category_code,
            )

        needs_review = (
            float(raw_conf) < 0.70
            or bool(raw_conflict)
        )

        log.info(
            "classify_done report_id=%s category=%s subcategory=%s confidence=%.2f needs_review=%s image_text_conflict=%s",
            state.get("report_id"),
            category_code,
            validated_code,
            float(raw_conf),
            needs_review,
            bool(raw_conflict),
        )
        return {
            **state,
            "category_code":             category_code,
            "category_name":             category_name,
            "subcategory_code":          validated_code,
            "subcategory_name":          VALID_CODES.get(
                                             validated_code,
                                             raw.get("subcategory_name", ""),
                                         ),
            "severity":                  int(raw_severity) if raw_severity is not None else None,
            "confidence":                float(raw_conf),
            "reasoning":                 raw.get("reasoning"),
            "image_text_conflict":       bool(raw_conflict),
            "image_classification_hint": raw.get("image_classification_hint", ""),
            "needs_review":              needs_review,
            "completed_nodes":           state["completed_nodes"] + ["classify"],
        }

    except Exception as exc:
        log.warning("classify_failed report_id=%s error=%s", state.get("report_id"), exc)
        return {
            **state,
            "category_code":             "OT",
            "category_name":             "Other",
            "subcategory_code":          "OT-005",
            "subcategory_name":          "Unclear / unidentifiable",
            "severity":                  None,
            "confidence":                0.0,
            "reasoning":                 None,
            "image_text_conflict":       False,
            "image_classification_hint": "",
            "needs_review":              True,
            "pipeline_error":            str(exc),
            "completed_nodes":           state["completed_nodes"] + ["classify"],
        }
