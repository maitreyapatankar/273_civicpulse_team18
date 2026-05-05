import logging

from langgraph.graph import StateGraph, END
from langgraph.checkpoint.postgres import PostgresSaver

from .state import PipelineState
from .nodes.image_description import image_description_node
from .nodes.classify import classify_node
from .nodes.dedup import dedup_node
from .nodes.urgency import urgency_node

log = logging.getLogger(__name__)


def flag_review_node(state: PipelineState) -> PipelineState:
    log.info("flag_review report_id=%s", state.get("report_id"))
    return {
        **state,
        "needs_review": True,
        "completed_nodes": state["completed_nodes"] + ["flag_review"],
    }


def route_after_classify(state: PipelineState) -> str:
    if state.get("needs_review") or state.get("image_text_conflict"):
        return "flag_review"
    return "dedup"


def build_graph(checkpointer: PostgresSaver):
    """Build and compile the pipeline graph. checkpointer is created in consumer.py."""
    graph = StateGraph(PipelineState)

    graph.add_node("image_description", image_description_node)
    graph.add_node("classify",          classify_node)
    graph.add_node("flag_review",       flag_review_node)
    graph.add_node("dedup",             dedup_node)
    graph.add_node("urgency_score",     urgency_node)

    graph.set_entry_point("image_description")

    graph.add_edge("image_description", "classify")

    graph.add_conditional_edges(
        "classify",
        route_after_classify,
        {
            "flag_review": "flag_review",
            "dedup":       "dedup",
        },
    )

    graph.add_edge("flag_review",   "dedup")
    # Duplicates also run through urgency so the master ticket's urgency score
    # gets updated with the new cluster count and rate.
    graph.add_edge("dedup",         "urgency_score")
    graph.add_edge("urgency_score", END)

    return graph.compile(checkpointer=checkpointer)
