"""
Server-Sent Events (SSE) router.

Bridges the Redis pub/sub channels published by S3 Worker (and S1 admin
endpoint) to long-lived HTTP streams that the React frontend consumes via
EventSource.

Channels we listen on:
    notify:ticket_ready      — new ticket created from AI pipeline
    notify:ticket_updated    — officer override / assign / comment / AI re-run
    notify:ticket_resolved   — ticket marked resolved by officer

Endpoints
---------
GET /events/officer                — every event, all tickets (JWT required)
GET /events/citizen/{report_id}    — only events for the given report (public)

Auth note
---------
EventSource cannot send custom headers, so the officer stream accepts the JWT
as a `?token=` query string. We validate it with the same OFFICER_JWT_SECRET
used by the rest of the API.
"""

import asyncio
import json
import os
from functools import lru_cache
from typing import AsyncIterator
from uuid import UUID

import redis.asyncio as aioredis
from fastapi import APIRouter, HTTPException, Query, Request, status
from jose import jwt
from sse_starlette.sse import EventSourceResponse

router = APIRouter(prefix="/events", tags=["events"])

CHANNELS = (
    "notify:ticket_ready",
    "notify:ticket_updated",
    "notify:ticket_resolved",
)

_KEEPALIVE_SECONDS = 15


@lru_cache(maxsize=1)
def _redis_url() -> str:
    return os.environ["REDIS_URL"]


def _verify_officer_token(token: str) -> dict:
    try:
        payload = jwt.decode(
            token,
            os.environ["OFFICER_JWT_SECRET"],
            algorithms=["HS256"],
        )
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
        )
    if payload.get("role") not in {"officer", "admin"}:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Insufficient role",
        )
    return payload


async def _stream(
    request: Request,
    report_id_filter: str | None = None,
) -> AsyncIterator[dict]:
    """Open one Redis pubsub per HTTP connection and yield SSE messages.

    - Closes the pubsub when the client disconnects.
    - Sends keepalive comments every _KEEPALIVE_SECONDS so proxies don't
      kill an idle connection.
    """
    client = aioredis.from_url(_redis_url(), decode_responses=True)
    pubsub = client.pubsub()

    try:
        await pubsub.subscribe(*CHANNELS)
        # Initial hello so the client knows the stream is live.
        yield {"event": "ready", "data": json.dumps({"ok": True})}

        while True:
            if await request.is_disconnected():
                break

            message = await pubsub.get_message(
                ignore_subscribe_messages=True,
                timeout=_KEEPALIVE_SECONDS,
            )

            if message is None:
                # No message in the keepalive window — send a comment frame.
                yield {"event": "ping", "data": ""}
                continue

            channel = message.get("channel")
            raw_data = message.get("data")
            try:
                payload = json.loads(raw_data) if isinstance(raw_data, str) else {}
            except json.JSONDecodeError:
                # Backward-compat: S5 used to receive a bare ticket_id string.
                payload = {"ticket_id": str(raw_data)}

            if report_id_filter and payload.get("report_id") != report_id_filter:
                continue

            event_name = (channel or "ticket").split(":")[-1]
            yield {"event": event_name, "data": json.dumps(payload)}
    finally:
        try:
            await pubsub.unsubscribe(*CHANNELS)
            await pubsub.close()
        except Exception:
            pass
        try:
            await client.close()
        except Exception:
            pass


@router.get("/officer")
async def officer_stream(
    request: Request,
    token: str = Query(..., description="Officer/admin JWT"),
):
    _verify_officer_token(token)
    return EventSourceResponse(_stream(request))


@router.get("/citizen/{report_id}")
async def citizen_stream(report_id: UUID, request: Request):
    return EventSourceResponse(_stream(request, report_id_filter=str(report_id)))
