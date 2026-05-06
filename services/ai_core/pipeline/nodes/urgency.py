"""
Step 4 — Urgency scoring

Two-tier strategy to keep critical reports deterministic and fast:

Tier 1 — P1 override (zero LLM tokens, checked in order):
  1a. Subcategory-code check — certain subcategories are always P1 regardless of text
      (e.g. missing manhole cover, signal fully dark, sinkhole).
  1b. Keyword scan — scanned across BOTH report text and image description so a
      photo of a missing cover with a bland text still fires P1.
  1c. Rate threshold — a cluster growing faster than 3 reports/hour signals rapid
      deterioration; always P1 regardless of issue type.

Tier 2 — LLM scoring (only when no P1 trigger fires)
  Model   : gemini-2.5-flash-lite
  Context : subcategory, severity, confidence, cluster_count, cluster_rate_per_hour,
            address, text, image_desc, classify reasoning, image/text conflict flag
  Factors : safety_risk (0.45), traffic_impact (0.30),
            cluster_volume (0.20), low_confidence (0.05)

Post-processing (applied even to LLM output):
  - Severity floor : classifier severity=5 → urgency_score >= 4
  - Review cap     : needs_review=True → urgency_score <= 4 (unless P1 triggered)
"""

import json
import logging
import os
import re

import google.generativeai as genai

from ..state import PipelineState

log = logging.getLogger(__name__)

MODEL = "gemini-2.5-flash-lite"

_api_key = os.environ.get("GEMINI_API_KEY")
if not _api_key:
    raise EnvironmentError("GEMINI_API_KEY is not set.")
genai.configure(api_key=_api_key)


# ── P1 subcategory codes ──────────────────────────────────────────────────────
# Derived from taxonomy.json. These subcategories are unconditionally P1
# because the physical hazard is severe regardless of how the citizen described it.

P1_SUBCATEGORY_CODES: frozenset[str] = frozenset({
    "RD-006",  # Subsidence / sinkhole          — vehicle drop risk
    "TF-002",  # Signal fully dark               — uncontrolled intersection
    "TF-003",  # Signal knocked down             — structural + no traffic control
    "ST-004",  # Manhole cover missing           — fall / tyre trap
    "DR-003",  # Missing drain cover             — fall / vehicle trap
    "ST-001",  # Bridge surface damage           — structural integrity risk
    "ST-002",  # Guardrail damaged / missing     — no barrier at drop edge
    "SL-004",  # Exposed wiring                 — electrocution risk
    "OT-004",  # Fallen tree on road             — road blocked
})

# ── P1 keywords — scanned across text AND image_desc ─────────────────────────

P1_KEYWORDS: frozenset[str] = frozenset({
    # structural collapse
    "sinkhole", "collapse", "collapsed", "subsidence", "cave in", "caved in",
    # flooding
    "flooding", "flood", "road flooded", "flooded road",
    # electrical
    "live wire", "exposed wire", "exposed wiring", "sparking", "electri",
    # gas
    "gas leak", "gas smell",
    # structural barriers gone
    "guardrail", "guard rail", "bridge damage", "bridge crack",
    # missing covers — vehicle / pedestrian trap
    "manhole", "open hole", "missing cover", "no cover", "drain cover missing",
    "cover missing", "no drain cover",
    # traffic control loss
    "signal out", "traffic light out", "lights out", "dark intersection",
    "signal down", "no signal", "signal knocked",
    # road blockage / emergency access
    "tree down", "tree fallen", "fallen tree", "road blocked", "road closure",
    "car fell", "fell in", "vehicle fell",
    "ambulance blocked", "emergency vehicle", "fire truck",
    # injury / imminent harm
    "injury", "injured", "accident", "emergency",
    # spills
    "oil spill", "fuel spill", "chemical spill",
})

# A cluster growing faster than this rate signals active, rapid deterioration.
P1_RATE_THRESHOLD: float = 3.0  # reports per hour


# ── P1 result builder ─────────────────────────────────────────────────────────

def _p1_result(reasoning: str) -> dict:
    return {
        "score": 5,
        "factors": {
            "safety_risk":    1.0,
            "traffic_impact": 1.0,
            "cluster_volume": 1.0,
            "low_confidence": 0.0,
        },
        "reasoning": reasoning,
        "p1_override": True,
    }


# ── Prompt — built once at module load ───────────────────────────────────────

_SYSTEM = """You are an urgency scorer for a municipal road maintenance team.

Score the urgency of a road issue 1–5 for dispatcher prioritisation.

SCORE DEFINITIONS:
5 = immediate danger to life — respond within 1 hour
4 = significant safety risk — respond within 4 hours
3 = traffic disruption or active cluster growth — respond within 24 hours
2 = minor inconvenience — schedule within 1 week
1 = cosmetic — schedule in next maintenance cycle

OUTPUT FACTORS (each 0.0–1.0):
  safety_risk    — physical danger to road users from this specific issue
  traffic_impact — disruption to traffic flow and emergency access
  cluster_volume — urgency of the reporting cluster; weight using BOTH count and rate:
                   a high rate (>1/hour) matters more than a high count alone
  low_confidence — set toward 1.0 when AI classification confidence is below 70%

SCORING WEIGHTS:
  safety_risk×0.45 + traffic_impact×0.30 + cluster_volume×0.20 + low_confidence×0.05

SCORING GUIDANCE:
- A reporting rate above 1 report/hour signals active deterioration; push cluster_volume high.
- When image description and report text conflict, trust the image description for scoring.
- When low_confidence is high (≥ 0.5), cap your score at 4.
- The classifier severity (1–5) anchors the score; deviate by at most 1 point without
  clear supporting evidence in the image or text.
- reasoning must be one sentence, written for a dispatcher, not a data scientist.
- Base your reasoning on the classification, severity, and evidence in the report or image.
- Do NOT mention multiple reports, clusters, or reporting rate unless "Reports in cluster" is provided and > 1.

Respond ONLY with valid JSON. No explanation. No markdown. No preamble.
{
  "score": <1-5>,
  "factors": {
    "safety_risk":    <0.0-1.0>,
    "traffic_impact": <0.0-1.0>,
    "cluster_volume": <0.0-1.0>,
    "low_confidence": <0.0-1.0>
  },
  "reasoning": "<one sentence for the dispatcher>"
}"""


def _build_user_msg(state: PipelineState) -> str:
    cluster_count = state.get("cluster_count", 1)
    rate = state.get("cluster_rate_per_hour") or 0.0
    lines = [
        f'Category: {state.get("category_name")} ({state.get("category_code")})',
        f'Subcategory: {state.get("subcategory_name")} ({state.get("subcategory_code")})',
        f'Severity (classifier): {state.get("severity")}/5',
        f'Classifier confidence: {(state.get("confidence") or 0.0):.0%}',
        f'Location: {state.get("address") or "coordinates only"}',
        "",
        f'Citizen report: "{state.get("text")}"',
    ]
    if cluster_count > 1:
        lines.insert(4, f'Reporting rate: {rate:.1f} reports/hour')
        lines.insert(4, f'Reports in cluster: {cluster_count}')
    if state.get("image_desc"):
        lines.append(f'Image description: {state["image_desc"]}')
    else:
        lines.append("No image provided.")
    if state.get("reasoning"):
        lines.append(f'Classifier reasoning: {state["reasoning"]}')
    if state.get("image_text_conflict"):
        hint = state.get("image_classification_hint", "")
        lines.append(f"⚠ Image/text conflict — trust image. Image suggests: {hint}")
    if state.get("needs_review"):
        lines.append("⚠ Classification flagged for human review (confidence < 70%).")
    return "\n".join(lines)


# ── P1 check ─────────────────────────────────────────────────────────────────

def _check_p1(state: PipelineState) -> dict | None:
    """Return a P1 result dict if any tier-1 trigger fires, else None."""

    # 1a — subcategory code
    if state.get("subcategory_code") in P1_SUBCATEGORY_CODES:
        name = state.get("subcategory_name") or state.get("subcategory_code", "Critical infrastructure issue")
        return _p1_result(f"{name} — structural hazard, immediate crew dispatch required.")

    # 1b — keyword scan across text + image_desc
    combined = " ".join(filter(None, [
        (state.get("text") or "").lower(),
        (state.get("image_desc") or "").lower(),
    ]))
    issue_name = state.get("subcategory_name") or state.get("category_name") or "Issue"
    for kw in P1_KEYWORDS:
        if re.search(r'\b' + re.escape(kw) + r'\b', combined):
            label = kw.capitalize()
            return _p1_result(
                f"{issue_name} — {label} detected, critical safety hazard, immediate response required."
            )

    # 1c — rate threshold
    rate = state.get("cluster_rate_per_hour") or 0.0
    if rate >= P1_RATE_THRESHOLD:
        return _p1_result(
            f"Incident cluster growing at {rate:.1f} reports/hour — rapidly worsening, immediate crew dispatch required."
        )

    return None


# ── LangGraph node ────────────────────────────────────────────────────────────

def urgency_node(state: PipelineState) -> PipelineState:
    p1 = _check_p1(state)

    if p1:
        log.info(
            "urgency_p1 report_id=%s reasoning=%s",
            state.get("report_id"),
            p1.get("reasoning"),
        )
        scored = p1
    else:
        try:
            model = genai.GenerativeModel(
                MODEL,
                generation_config=genai.GenerationConfig(
                    response_mime_type="application/json"
                ),
            )
            response = model.generate_content(
                [_SYSTEM, _build_user_msg(state)],
                request_options={"timeout": 30},
            )
            raw = json.loads(response.text)
            scored = {
                "score":       max(1, min(5, int(raw["score"]))),  # B5: clamp to valid 1-5 range
                "factors":     raw.get("factors") or {},
                "reasoning":   raw.get("reasoning") or "",
                "p1_override": False,
            }
            log.info(
                "urgency_llm report_id=%s score=%s low_confidence=%s",
                state.get("report_id"),
                scored["score"],
                scored["factors"].get("low_confidence"),
            )
        except Exception as exc:
            log.warning("urgency LLM failed for report %s: %s", state["report_id"], exc)
            # Fail safe: score=3 keeps the report visible to dispatchers without
            # falsely elevating it to an urgent state.
            scored = {
                "score": 3,
                "factors": {
                    "safety_risk":    0.5,
                    "traffic_impact": 0.5,
                    "cluster_volume": 0.0,
                    "low_confidence": 1.0,
                },
                "reasoning": "Urgency scoring unavailable — defaulted to medium priority for human review.",
                "p1_override": False,
            }

    score        = scored["score"]
    p1_triggered = scored.get("p1_override", False)

    # Severity floor: a classifier severity=5 is never lower than dispatch-level 4.
    if (state.get("severity") or 0) == 5 and not p1_triggered:
        score = max(score, 4)

    # Review cap: uncertain classifications shouldn't auto-trigger immediate dispatch.
    if state.get("needs_review") and not p1_triggered:
        score = min(score, 4)

    return {
        **state,
        "urgency_score":     score,
        "urgency_factors":   scored["factors"],
        "urgency_reasoning": scored["reasoning"],
        "p1_override":       p1_triggered,
        "completed_nodes":   state["completed_nodes"] + ["urgency_score"],
    }
