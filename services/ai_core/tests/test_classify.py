"""
Unit tests for pipeline/classify.py.

All tests mock _make_client() so no real API key or network call is needed.
Run from services/ai_core/:
    pytest tests/test_classify.py
"""

import json
import sys
import os
from unittest.mock import MagicMock, patch

import pytest

# Ensure services/ai_core/ is on the path when run directly
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from pipeline.classify import ClassificationResult, classify


def _mock_client(response_payload: dict) -> MagicMock:
    """Return a mock Anthropic client whose messages.create returns response_payload."""
    content_block = MagicMock()
    content_block.text = json.dumps(response_payload)

    message = MagicMock()
    message.content = [content_block]

    client = MagicMock()
    client.messages.create.return_value = message
    return client


# ── Test 1: clear pothole report ──────────────────────────────────────────────

@patch("pipeline.classify._make_client")
def test_pothole_report(mock_make_client):
    mock_make_client.return_value = _mock_client({
        "issue_type": "pothole",
        "severity": 3,
        "confidence": 0.92,
        "reasoning": "Explicit mention of a pothole with moderate traffic impact.",
    })

    result = classify(
        text="There's a large pothole on Main St near the intersection with 5th Ave, cars are swerving around it",
        image_desc=None,
        address="Main St & 5th Ave",
    )

    assert isinstance(result, ClassificationResult)
    assert result.issue_type == "pothole"
    assert result.severity == 3
    assert result.confidence == 0.92
    assert result.needs_review is False


# ── Test 2: sinkhole report — expect high confidence, no review flag ──────────

@patch("pipeline.classify._make_client")
def test_sinkhole_high_confidence(mock_make_client):
    mock_make_client.return_value = _mock_client({
        "issue_type": "sinkhole",
        "severity": 5,
        "confidence": 0.97,
        "reasoning": "Report explicitly describes a sinkhole; immediate danger to vehicles.",
    })

    result = classify(
        text="A sinkhole has opened up on Oak Ave, part of the road collapsed, car almost fell in",
        image_desc=None,
        address="Oak Ave",
    )

    assert result.issue_type == "sinkhole"
    assert result.severity == 5
    assert result.confidence >= 0.90
    assert result.needs_review is False


# ── Test 3: ambiguous report — expect needs_review = True ─────────────────────

@patch("pipeline.classify._make_client")
def test_ambiguous_report_needs_review(mock_make_client):
    mock_make_client.return_value = _mock_client({
        "issue_type": "other",
        "severity": 2,
        "confidence": 0.55,
        "reasoning": "Report is vague; insufficient detail to confirm issue type.",
    })

    result = classify(
        text="Something looks wrong with the road surface near the park",
        image_desc=None,
        address="Park Rd",
    )

    assert result.confidence < 0.70
    assert result.needs_review is True
