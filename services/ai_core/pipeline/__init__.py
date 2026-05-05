"""
AI pipeline — 4-node LangGraph graph built in graph.py, wired up in consumer.py.

Node order:
  image_description → classify → [flag_review →] dedup → urgency_score

Nodes live in pipeline/nodes/; state contract is in pipeline/state.py.
"""
