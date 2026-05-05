import httpx
import pytest
from unittest.mock import MagicMock, patch

from pipeline.state import initial_state
from pipeline.nodes.image_description import image_description_node


def _make_state(**kwargs):
    s = initial_state(report_id="r1", text="pothole", image_url=None)
    s.update(kwargs)
    return s


# ── Test 1 ─────────────────────────────────────────────────────────────────────

def test_no_image_skips_gracefully():
    state = _make_state(image_url=None)
    result = image_description_node(state)
    assert result["image_desc"] is None
    assert result["image_fetch_failed"] is False
    assert "image_description" in result["completed_nodes"]


# ── Test 2 ─────────────────────────────────────────────────────────────────────

def test_image_fetch_failure_handled():
    state = _make_state(image_url="https://example.com/img.jpg")
    with patch("pipeline.nodes.image_description.httpx.get") as mock_get:
        mock_get.side_effect = httpx.TimeoutException("timed out")
        result = image_description_node(state)

    assert result["image_desc"] is None
    assert result["image_fetch_failed"] is True
    assert "image_description" in result["completed_nodes"]


# ── Test 3 ─────────────────────────────────────────────────────────────────────

def test_successful_description():
    state = _make_state(image_url="https://example.com/road.jpg")

    mock_http_response = MagicMock()
    mock_http_response.content = b"fakeimagebytes"
    mock_http_response.raise_for_status = MagicMock()

    mock_genai_response = MagicMock()
    mock_genai_response.text = "  Large pothole visible...  "

    mock_model = MagicMock()
    mock_model.generate_content.return_value = mock_genai_response

    with patch("pipeline.nodes.image_description.httpx.get",
               return_value=mock_http_response), \
         patch("pipeline.nodes.image_description.genai.GenerativeModel",
               return_value=mock_model):
        result = image_description_node(state)

    assert result["image_desc"] == "Large pothole visible..."
    assert result["image_fetch_failed"] is False
    assert "image_description" in result["completed_nodes"]


# ── Test 4 ─────────────────────────────────────────────────────────────────────

def test_gemini_api_error_handled():
    state = _make_state(image_url="https://example.com/road.jpg")

    mock_http_response = MagicMock()
    mock_http_response.content = b"fakeimagebytes"
    mock_http_response.raise_for_status = MagicMock()

    mock_model = MagicMock()
    mock_model.generate_content.side_effect = Exception("API error")

    with patch("pipeline.nodes.image_description.httpx.get",
               return_value=mock_http_response), \
         patch("pipeline.nodes.image_description.genai.GenerativeModel",
               return_value=mock_model):
        result = image_description_node(state)

    assert isinstance(result, dict)
    assert "report_id" in result
    assert "image_description" in result["completed_nodes"]
