import json
import pytest
from unittest.mock import MagicMock, patch

from pipeline.state import initial_state
from pipeline.nodes.classify import classify_node


def _make_state(**kwargs):
    s = initial_state(report_id="r1", text="large hole in road", image_url=None)
    s.update(kwargs)
    return s


def _mock_model(response_dict: dict) -> MagicMock:
    mock_response = MagicMock()
    mock_response.text = json.dumps(response_dict)
    mock_model = MagicMock()
    mock_model.generate_content.return_value = mock_response
    return mock_model


_VALID_RESPONSE = {
    "category_code": "RD",
    "category_name": "Road Surface",
    "subcategory_code": "RD-001",
    "subcategory_name": "Pothole",
    "severity": 3,
    "confidence": 0.92,
    "reasoning": "Report describes a hole in the road surface.",
    "image_text_conflict": False,
    "image_classification_hint": "",
}


# ── Test 1 ─────────────────────────────────────────────────────────────────────

def test_pothole_classified_correctly():
    state = _make_state(text="large hole in road")
    with patch("pipeline.nodes.classify.genai.GenerativeModel",
               return_value=_mock_model(_VALID_RESPONSE)):
        result = classify_node(state)

    assert result["subcategory_code"] == "RD-001"
    assert result["needs_review"] is False
    assert result["image_text_conflict"] is False
    assert result["fallback_used"] is False
    assert "classify" in result["completed_nodes"]


# ── Test 2 ─────────────────────────────────────────────────────────────────────

def test_low_confidence_sets_needs_review():
    state = _make_state()
    with patch("pipeline.nodes.classify.genai.GenerativeModel",
               return_value=_mock_model({**_VALID_RESPONSE, "confidence": 0.55})):
        result = classify_node(state)

    assert result["needs_review"] is True


# ── Test 3 ─────────────────────────────────────────────────────────────────────

def test_image_text_conflict_sets_needs_review():
    state = _make_state()
    with patch("pipeline.nodes.classify.genai.GenerativeModel",
               return_value=_mock_model({
                   **_VALID_RESPONSE,
                   "image_text_conflict": True,
                   "image_classification_hint": "drainage blockage",
                   "confidence": 0.80,
               })):
        result = classify_node(state)

    assert result["needs_review"] is True
    assert result["image_text_conflict"] is True
    assert result["image_classification_hint"] == "drainage blockage"


# ── Test 4 ─────────────────────────────────────────────────────────────────────

def test_invalid_code_falls_back_to_OT005():
    state = _make_state()
    with patch("pipeline.nodes.classify.genai.GenerativeModel",
               return_value=_mock_model({**_VALID_RESPONSE, "subcategory_code": "INVALID"})):
        result = classify_node(state)

    assert result["subcategory_code"] == "OT-005"
    assert result["fallback_used"] is True
    assert result["needs_review"] is True


# ── Test 5 ─────────────────────────────────────────────────────────────────────

def test_malformed_json_handled():
    mock_response = MagicMock()
    mock_response.text = "not json {{{"
    mock_model = MagicMock()
    mock_model.generate_content.return_value = mock_response

    state = _make_state()
    with patch("pipeline.nodes.classify.genai.GenerativeModel",
               return_value=mock_model):
        result = classify_node(state)

    assert result["subcategory_code"] == "OT-005"
    assert result["confidence"] == 0.0
    assert result["needs_review"] is True
    assert result["fallback_used"] is True
    assert result["pipeline_error"] is not None


# ── Test 6 ─────────────────────────────────────────────────────────────────────

def test_sinkhole_severity_5():
    state = _make_state(text="large sinkhole opened in the road")
    with patch("pipeline.nodes.classify.genai.GenerativeModel",
               return_value=_mock_model({
                   **_VALID_RESPONSE,
                   "subcategory_code": "RD-006",
                   "subcategory_name": "Subsidence / sinkhole",
                   "severity": 5,
                   "confidence": 0.97,
                   "image_text_conflict": False,
                   "image_classification_hint": "",
               })):
        result = classify_node(state)

    assert result["subcategory_code"] == "RD-006"
    assert result["severity"] == 5
    assert result["needs_review"] is False
