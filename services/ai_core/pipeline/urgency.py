"""
Step 4 — Urgency scoring

Two-tier strategy to keep critical reports deterministic and fast:

Tier 1 — P1 keyword override (zero tokens, zero latency)
    Scans the raw report text for safety-critical keywords.
    A match forces score=5 immediately, bypassing the LLM entirely.

Tier 2 — LLM scoring
    Used only when no keyword match is found.
    Weighted scoring: safety_risk 0.4, traffic_impact 0.3,
                      cluster_volume 0.2, days_unresolved 0.1

score(issue_type, severity, cluster_count, days_open, text)
    Returns dict:
        score      int    1–5
        factors    dict   {safety_risk, traffic_impact,
                           cluster_volume, days_unresolved}  each 0.0–1.0
        reasoning  str    one sentence (shown to dispatcher)
"""

import json
import os

import anthropic

# TODO: set your chosen model name
URGENCY_MODEL: str = "TODO"   # e.g. "claude-sonnet-4-5"

# TODO: set the environment variable name that holds your Anthropic API key
_API_KEY_ENV: str = "TODO"    # e.g. "ANTHROPIC_API_KEY"

# ── Prompts — copied verbatim from ARCHITECTURE.md, do not modify ─────────────

_URGENCY_SYSTEM = """You score road issue urgency for a city maintenance department.
Respond ONLY with valid JSON matching this schema:

{
  "score": 1 | 2 | 3 | 4 | 5,
  "factors": {
    "safety_risk":    <float 0-1>,
    "traffic_impact": <float 0-1>,
    "cluster_volume": <float 0-1>,
    "days_unresolved":<float 0-1>
  },
  "reasoning": "<one sentence shown to dispatcher>"
}

Scoring weights: safety_risk 0.4, traffic_impact 0.3,
                 cluster_volume 0.2, days_unresolved 0.1"""

_URGENCY_USER_TMPL = """Issue type: {issue_type}
Severity: {severity}/5
Reports in cluster: {cluster_count}
Days since first report: {days_open}
Report text: "{text}" """

# ── P1 keyword set — from ARCHITECTURE.md, do not modify ──────────────────────

P1_KEYWORDS: frozenset[str] = frozenset({
    "sinkhole", "collapse", "flooding", "live wire", "gas leak",
    "bridge", "guardrail", "car fell", "ambulance blocked",
})

_P1_RESULT: dict = {
    "score": 5,
    "factors": {
        "safety_risk":    1.0,
        "traffic_impact": 1.0,
        "cluster_volume": 1.0,
        "days_unresolved": 0.0,  # just reported
    },
    "reasoning": "P1 safety keyword detected — immediate danger, bypassing LLM scoring.",
}


# ── Internal helpers ──────────────────────────────────────────────────────────

def _make_client() -> anthropic.Anthropic:
    return anthropic.Anthropic(api_key=os.environ[_API_KEY_ENV])


def _is_p1(text: str) -> bool:
    """Return True if the report text contains a P1 safety-critical keyword."""
    lowered = text.lower()
    return any(kw in lowered for kw in P1_KEYWORDS)


# ── Public API ────────────────────────────────────────────────────────────────

def score(
    issue_type: str,
    severity: int,
    cluster_count: int,
    days_open: int,
    text: str,
) -> dict:
    """Score the urgency of a road issue.

    Tier 1: P1 keyword match → score=5 immediately, zero tokens consumed.
    Tier 2: LLM scoring via the model when no keyword matches.

    Returns:
        {
            "score":     int,    # 1–5
            "factors": {
                "safety_risk":     float,
                "traffic_impact":  float,
                "cluster_volume":  float,
                "days_unresolved": float,
            },
            "reasoning": str,
        }

    Raises:
        anthropic.APIError if LLM scoring is triggered and the API fails.
        ValueError         if the model response is not valid JSON.
    """
    if _is_p1(text):
        return _P1_RESULT

    user_content = _URGENCY_USER_TMPL.format(
        issue_type=issue_type,
        severity=severity,
        cluster_count=cluster_count,
        days_open=days_open,
        text=text,
    )

    message = _make_client().messages.create(
        model=URGENCY_MODEL,
        max_tokens=256,
        system=_URGENCY_SYSTEM,
        messages=[{"role": "user", "content": user_content}],
    )

    raw_text = message.content[0].text
    try:
        raw = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Model returned invalid JSON: {raw_text!r}") from exc

    return {
        "score":     int(raw["score"]),
        "factors":   raw["factors"],
        "reasoning": raw["reasoning"],
    }
