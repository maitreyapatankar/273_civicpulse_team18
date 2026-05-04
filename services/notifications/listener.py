"""
Service 5 — Notifications

Plain Python Redis pub-sub loop. No HTTP server, no framework.
Subscribes to two channels, fetches ticket details from S1, fires Twilio SMS.

Environment
-----------
    REDIS_URL           redis://...
    API_BASE_URL        http://api:8000
    TWILIO_ACCOUNT_SID
    TWILIO_AUTH_TOKEN
    TWILIO_FROM_NUMBER  +1...
"""

import json
import os

import httpx
import redis
from twilio.rest import Client as TwilioClient

REDIS_URL          = os.environ["REDIS_URL"]
API_BASE_URL       = os.environ["API_BASE_URL"]
TWILIO_FROM_NUMBER = os.environ["TWILIO_FROM_NUMBER"]

twilio_client = TwilioClient(
    os.environ["TWILIO_ACCOUNT_SID"],
    os.environ["TWILIO_AUTH_TOKEN"],
)

r      = redis.Redis.from_url(REDIS_URL)
pubsub = r.pubsub()
pubsub.subscribe("notify:ticket_ready", "notify:ticket_resolved")


def _extract_ticket_id(raw: bytes) -> str:
    """S3 Worker now publishes JSON {ticket_id, report_id}; older format was a bare id string."""
    text = raw.decode()
    try:
        return json.loads(text).get("ticket_id", text)
    except json.JSONDecodeError:
        return text


for message in pubsub.listen():
    if message["type"] != "message":
        continue

    ticket_id = _extract_ticket_id(message["data"])
    ticket = httpx.get(f"{API_BASE_URL}/tickets/{ticket_id}/status").json()

    if not ticket.get("reporter_phone"):
        continue

    urgency = ticket.get("urgency_score") or 0
    templates = {
        "notify:ticket_ready":
            f"CivicPulse: Report #{ticket_id[:8]} received. "
            f"Priority: {urgency:.0f}/5. We'll keep you updated.",
        "notify:ticket_resolved":
            f"CivicPulse: Report #{ticket_id[:8]} has been resolved. Thank you.",
    }

    channel = message["channel"].decode()
    if channel not in templates:
        continue

    twilio_client.messages.create(
        to=ticket["reporter_phone"],
        from_=TWILIO_FROM_NUMBER,
        body=templates[channel],
    )
