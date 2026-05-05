import logging
import os

import httpx
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

IMAGE_DESCRIPTION_PROMPT = """
You are a road infrastructure damage assessment assistant
for a municipal maintenance department.

Analyze this image and describe ONLY what you observe
related to road infrastructure condition. Be specific
and factual. Do not classify or assign severity —
only describe what you see.

Your description must cover:

1. DAMAGE VISIBLE
   - What type of damage is present (if any)
   - Physical dimensions if estimable (wide, deep,
     large, small)
   - Surface affected (asphalt, concrete, marking,
     signage, structure)

2. LOCATION CONTEXT
   - Road type visible (highway, residential,
     intersection, footpath, bridge)
   - Position of damage (center lane, road edge,
     sidewalk, junction, median)

3. CONDITION INDICATORS
   - How severe does the damage appear visually
   - Signs of deterioration (cracking pattern,
     water damage, rust, fading, bending, collapse)
   - Any immediate visible hazard (exposed rebar,
     standing water, missing cover, fallen sign)

4. SURROUNDING ENVIRONMENT
   - Traffic signals, signs, streetlights visible
     and their condition
   - Any secondary damage near the primary issue
   - Weather or environmental context if visible
     (flooding, debris, ice)

If the image is blurry, dark, or does not show road
infrastructure, state that clearly. Do not guess.

Respond in plain paragraph form. Be concise but complete.
Maximum 150 words.
"""


def _detect_mime_type(url: str) -> str:
    ext = url.split("?")[0].rsplit(".", 1)[-1].lower()
    return {
        "jpg":  "image/jpeg",
        "jpeg": "image/jpeg",
        "png":  "image/png",
        "webp": "image/webp",
        "gif":  "image/gif",
    }.get(ext, "image/jpeg")


def image_description_node(state: PipelineState) -> PipelineState:
    if not state.get("image_url"):
        log.info("image_description_skip report_id=%s no_image=true", state.get("report_id"))
        return {
            **state,
            "image_desc": None,
            "completed_nodes": state["completed_nodes"] + ["image_description"],
        }

    try:
        resp = httpx.get(
            state["image_url"], timeout=10.0, follow_redirects=True
        )
        resp.raise_for_status()
        image_bytes = resp.content
    except Exception as exc:
        log.warning("image_fetch_failed report_id=%s error=%s", state.get("report_id"), exc)
        return {
            **state,
            "image_desc": None,
            "completed_nodes": state["completed_nodes"] + ["image_description"],
        }

    try:
        model = genai.GenerativeModel(MODEL)
        response = model.generate_content([
            IMAGE_DESCRIPTION_PROMPT,
            {
                "mime_type": _detect_mime_type(state["image_url"]),
                "data": image_bytes,
            },
        ])
        log.info(
            "image_description_done report_id=%s desc_len=%s",
            state.get("report_id"),
            len(response.text.strip()),
        )
        return {
            **state,
            "image_desc": response.text.strip(),
            "completed_nodes": state["completed_nodes"] + ["image_description"],
        }
    except Exception as exc:
        log.warning("image_description_failed report_id=%s error=%s", state.get("report_id"), exc)
        return {
            **state,
            "image_desc": None,
            "completed_nodes": state["completed_nodes"] + ["image_description"],
        }
