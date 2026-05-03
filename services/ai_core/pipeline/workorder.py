"""
Step 5 — Work order generation

Generates a structured work order that municipal dispatchers use to assign
the right crew and materials to the job.

generate(issue_type, severity, urgency_score, text)
    Calls the model with the issue context and returns a parsed work order dict.

    Returns dict:
        crew_type    str        e.g. "pothole-repair", "drainage", "crack-sealing"
        materials    list[str]  e.g. ["cold-patch asphalt", "cones", "reflectors"]
        est_hours    float      estimated crew-hours to resolve
        notes        str        any special instructions or safety precautions

    Stored as JSONB in tickets.work_order. Dispatcher can append
    dispatcher_notes via PATCH /tickets/:id without overwriting these fields.
"""

import json
import os

from google import genai
from google.genai import types

WORKORDER_MODEL: str = "gemini-2.5-flash"

_API_KEY_ENV: str = "GEMINI_API_KEY"

# ── Prompts ───────────────────────────────────────────────────────────────────
# Architecture does not specify a work-order prompt; this prompt is designed to
# match the output schema defined in ARCHITECTURE.md (tickets.work_order JSONB).

_WORKORDER_SYSTEM = """You are a municipal works planning assistant.
Given a classified road issue, generate a work order for the repair crew.
Respond ONLY with valid JSON — no explanation, no markdown, no preamble.
Match this exact schema:

{
  "crew_type": "<string>",
  "materials": ["<string>", ...],
  "est_hours": <float>,
  "notes": "<string>"
}

crew_type examples: "pothole-repair", "drainage", "crack-sealing",
                    "sign-repair", "emergency-response", "general-maintenance"
est_hours: realistic crew-hours as a float (e.g. 2.5)
notes: safety precautions or special instructions for the crew"""

_WORKORDER_USER_TMPL = """Issue type: {issue_type}
Severity: {severity}/5
Urgency score: {urgency_score}/5
Report text: "{text}" """


# ── Internal helpers ──────────────────────────────────────────────────────────

def _make_client() -> genai.Client:
    return genai.Client(api_key=os.environ[_API_KEY_ENV])


# ── Public API ────────────────────────────────────────────────────────────────

def generate(
    issue_type: str,
    severity: int,
    urgency_score: float,
    text: str,
) -> dict:
    """Generate a work order for the given classified road issue.

    Returns:
        {
            "crew_type":  str,
            "materials":  list[str],
            "est_hours":  float,
            "notes":      str,
        }

    Raises:
        anthropic.APIError if the API call fails.
        ValueError         if the model response is not valid JSON.
    """
    user_content = _WORKORDER_USER_TMPL.format(
        issue_type=issue_type,
        severity=severity,
        urgency_score=urgency_score,
        text=text,
    )

    client = _make_client()
    response = client.models.generate_content(
        model=WORKORDER_MODEL,
        contents=user_content,
        config=types.GenerateContentConfig(
            system_instruction=_WORKORDER_SYSTEM,
        ),
    )

    raw_text = response.text
    try:
        cleaned = raw_text.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        raw = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Model returned invalid JSON: {raw_text!r}") from exc

    return {
        "crew_type": raw["crew_type"],
        "materials": raw["materials"],
        "est_hours": float(raw["est_hours"]),
        "notes":     raw["notes"],
    }
