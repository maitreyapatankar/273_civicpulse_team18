"""
Unit tests for pipeline/dedup.py.

Both Pinecone and OpenAI clients are mocked — no credentials or network needed.
Run from services/ai_core/:
    pytest tests/test_dedup.py
"""

import sys
import os
from unittest.mock import MagicMock, call, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from pipeline.dedup import DedupResult, deduplicate

_FAKE_VECTOR = [0.1] * 1536


def _mock_openai(vector: list[float] = _FAKE_VECTOR) -> MagicMock:
    embedding = MagicMock()
    embedding.embedding = vector

    response = MagicMock()
    response.data = [embedding]

    client = MagicMock()
    client.embeddings.create.return_value = response
    return client


def _mock_index(matches: list[MagicMock]) -> MagicMock:
    query_result = MagicMock()
    query_result.matches = matches

    index = MagicMock()
    index.query.return_value = query_result
    return index


# ── Test 1: duplicate detected — upsert must NOT be called ───────────────────

@patch("pipeline.dedup._get_pinecone_index")
@patch("pipeline.dedup._make_openai_client")
def test_duplicate_detected(mock_openai, mock_pinecone):
    top_match = MagicMock()
    top_match.score = 0.95                      # above 0.88 threshold
    top_match.id    = "master-ticket-uuid-abc"

    mock_openai.return_value  = _mock_openai()
    mock_index                = _mock_index(matches=[top_match])
    mock_pinecone.return_value = mock_index

    result = deduplicate(
        report_id  = "new-report-uuid-001",
        text       = "Large pothole on Main St near the intersection with 5th Ave",
        lat        = 37.7749,
        lng        = -122.4194,
        issue_type = "pothole",
    )

    assert isinstance(result, DedupResult)
    assert result.is_duplicate is True
    assert result.master_ticket_id == "master-ticket-uuid-abc"
    mock_index.upsert.assert_not_called()   # duplicate → no upsert


# ── Test 2: no duplicate — vector must be upserted with correct metadata ─────

@patch("pipeline.dedup._get_pinecone_index")
@patch("pipeline.dedup._make_openai_client")
def test_no_duplicate_upserts_vector(mock_openai, mock_pinecone):
    mock_openai.return_value   = _mock_openai()
    mock_index                 = _mock_index(matches=[])   # empty result set
    mock_pinecone.return_value = mock_index

    result = deduplicate(
        report_id  = "new-report-uuid-002",
        text       = "Flooding on Oak Ave blocking two lanes",
        lat        = 37.7750,
        lng        = -122.4195,
        issue_type = "flooding",
    )

    assert isinstance(result, DedupResult)
    assert result.is_duplicate is False
    assert result.master_ticket_id is None

    mock_index.upsert.assert_called_once()
    upsert_call_args = mock_index.upsert.call_args
    vectors = upsert_call_args.kwargs.get("vectors") or upsert_call_args.args[0]
    report_id_arg, vec_arg, metadata_arg = vectors[0]

    assert report_id_arg == "new-report-uuid-002"
    assert vec_arg       == _FAKE_VECTOR
    assert metadata_arg["lat"]        == 37.7750
    assert metadata_arg["lng"]        == -122.4195
    assert metadata_arg["issue_type"] == "flooding"
    assert "created_epoch" in metadata_arg
