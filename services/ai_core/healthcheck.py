"""
Health check script for Railway / Docker.
Called by HEALTHCHECK in Dockerfile every 30s.
Exit 0 = worker alive, Exit 1 = worker dead → Railway restarts container.
"""
import sys
from consumer import celery_app

try:
    inspect = celery_app.control.inspect(timeout=5)
    stats = inspect.stats()
    if stats:
        sys.exit(0)
    else:
        print("AI Core Celery worker did not respond", file=sys.stderr)
        sys.exit(1)
except Exception as e:
    print(f"Health check failed: {e}", file=sys.stderr)
    sys.exit(1)