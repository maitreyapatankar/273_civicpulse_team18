import os
import sys

# Make pipeline importable the same way Celery does (cwd = services/ai_core/)
sys.path.insert(
    0,
    os.path.join(os.path.dirname(__file__), "../../services/ai_core"),
)

# Satisfy the module-level env-var guard before any pipeline module is imported
os.environ.setdefault("GEMINI_API_KEY", "test-key-for-pytest")
