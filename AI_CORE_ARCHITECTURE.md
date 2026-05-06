# AI Core (S2) Architecture

LangGraph-based AI pipeline for ticket classification, deduplication, and urgency scoring.

---

## Service Overview

```
┌────────────────────────────────────────────────────────────────┐
│                    S2: AI Core Service                         │
│                                                                │
│  Role: Stateless AI classification worker                     │
│  Runtime: Celery consumer (concurrency=4)                     │
│  No HTTP server, no database writes                           │
│                                                                │
│  Input:  Redis Queue (ai_core:process)                        │
│  Output: Redis Queue (ai_core:results OR ai_core:failed)      │
│                                                                │
│  External APIs: Google Gemini (vision + LLM)                  │
│  Database Access: Read-only Postgres (dedup query)            │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

---

## LangGraph Pipeline: 4-Node Architecture

### High-Level Flow

```
Input Payload
    │
    ▼
┌──────────────────────────────────────────┐
│  Node 1: Image Description               │
│  Gemini Vision → image_description       │
│  (Extracts visual features from photo)   │
└────────────┬─────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────┐
│  Node 2: Classification                  │
│  Gemini LLM → category, severity,        │
│  confidence, conflict detection          │
└────────────┬─────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────┐
│  Node 3: Deduplication                   │
│  Postgres (read-only) + Geo-spatial      │
│  → master_ticket_id (if duplicate)       │
└────────────┬─────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────┐
│  Node 4: Urgency Scoring                 │
│  P1 Override + LLM → urgency_score (1-5) │
│  + urgency_factors breakdown              │
└────────────┬─────────────────────────────┘
             │
             ▼
    Output Payload
```

---

## Node 1: Image Description

**Purpose:** Extract visual information from citizen photos using vision AI

**Input:**
```python
{
    "raw_report_id": "UUID",
    "image_url": "s3://bucket/image.jpg",  # or None
    "text": "Pothole on Main Street",
    "lat": 37.7749,
    "lng": -122.4194,
    # ... other fields
}
```

**Processing:**
```python
async def image_description_node(state: PipelineState) -> PipelineState:
    """Extract image text using Gemini vision model."""
    
    if not state.get("image_url"):
        state["image_description"] = None
        return state
    
    # Call Gemini vision API
    response = await gemini_vision_client.describe_image(
        image_url=state["image_url"],
        prompt="""Describe what you see in this infrastructure photo:
        - What type of damage/issue is visible?
        - Location specifics (street, corner, etc)?
        - Severity assessment
        - Safety concerns?
        Keep response concise (1-2 sentences)."""
    )
    
    state["image_description"] = response.text
    return state
```

**Output:**
```python
state["image_description"] = "Pothole approximately 6 inches deep on Main Street between 5th and 6th Ave"
```

**Error Handling:**
- If image_url is None: skip (return None description)
- If Gemini API fails: propagate error to ai_core:failed queue

---

## Node 2: Classification

**Purpose:** Categorize issue type and assess severity/confidence

**Input:**
```python
{
    "text": "Pothole on Main Street",
    "image_description": "Pothole approximately 6 inches deep...",
    "lat": 37.7749,
    "lng": -122.4194,
}
```

**Processing:**
```python
async def classify_node(state: PipelineState) -> PipelineState:
    """Classify ticket using text + image description."""
    
    combined_text = state.get("text", "")
    if state.get("image_description"):
        combined_text += f"\n[Image]: {state['image_description']}"
    
    # Call Gemini LLM with classification prompt
    response = await gemini_llm.classify(
        text=combined_text,
        prompt="""Classify this infrastructure issue:
        
        Categories: {taxonomy.categories}
        
        Respond with JSON:
        {
            "category_code": "RD",
            "category_name": "Road Surface",
            "subcategory_code": "POT",
            "subcategory_name": "Pothole",
            "severity": 3,
            "confidence": 0.92,
            "image_text_conflict": false,
            "image_classification_hint": null
        }"""
    )
    
    result = json.loads(response.text)
    state.update(result)
    
    # Detect conflicts
    if image_suggests_different_issue(state):
        state["image_text_conflict"] = True
        state["image_classification_hint"] = "Image suggests: Crack/damage"
    
    return state
```

**Output:**
```python
{
    "category_code": "RD",
    "category_name": "Road Surface",
    "subcategory_code": "POT",
    "subcategory_name": "Pothole",
    "severity": 3,  # 1-5 scale
    "confidence": 0.92,  # 0.0-1.0
    "image_text_conflict": false,
    "image_classification_hint": null
}
```

**Key Decisions:**
- **Taxonomy-driven:** Category codes from `taxonomy.json` (9 categories, 59 subcodes)
- **Confidence score:** How confident is Gemini? (0.0 = no confidence, 1.0 = certain)
- **Conflict detection:** Does image suggest something different from text?
  - If yes → flag for officer review (`needs_review=true`)

**Error Handling:**
- JSON parse failure → ai_core:failed
- Gemini API timeout → ai_core:failed with retry

---

## Node 3: Deduplication

**Purpose:** Detect duplicate reports and return master ticket ID

**Input:**
```python
{
    "raw_report_id": "UUID",
    "subcategory_code": "POT",
    "lat": 37.7749,
    "lng": -122.4194,
    # ... other fields from classification
}
```

**Processing:**
```python
def dedup_node(state: PipelineState) -> PipelineState:
    """Check for duplicate reports using Postgres + geo-spatial query."""
    
    subcategory = state["subcategory_code"]
    lat = state["lat"]
    lng = state["lng"]
    
    # Read-only query: find tickets with same subcategory within 100m
    with get_db() as db:
        query = db.query(Ticket).filter(
            Ticket.subcategory_code == subcategory,
            # Postgres PostGIS distance query
            func.ST_Distance(
                func.ST_GeomFromText(f'POINT({lng} {lat})', 4326),
                func.ST_GeomFromText(
                    f'POINT({Ticket.lng} {Ticket.lat})', 4326
                )
            ) < 100  # meters
        ).filter(
            Ticket.duplicate_of.is_(None)  # Only find masters
        ).order_by(
            Ticket.urgency_score.desc()  # Most recent/urgent first
        ).first()
    
    if query:
        # Found a master ticket
        state["is_duplicate"] = True
        state["master_ticket_id"] = str(query.id)
        state["cluster_count"] = query.cluster_count + 1
        
        # Re-calculate urgency for cluster
        state["urgency_score"] = recalc_cluster_urgency(
            master=query,
            new_score=state.get("urgency_score", 3)
        )
    else:
        # No duplicate found
        state["is_duplicate"] = False
        state["master_ticket_id"] = None
        state["cluster_count"] = 1
    
    return state
```

**Output:**
```python
# Case 1: No duplicate found
{
    "is_duplicate": false,
    "master_ticket_id": null,
    "cluster_count": 1
}

# Case 2: Duplicate found
{
    "is_duplicate": true,
    "master_ticket_id": "master-uuid-123",
    "cluster_count": 3  # Now 3 reports of same issue
}
```

**Database Optimization:**
- Uses PostGIS spatial index for fast geo-queries
- Only queries unresolved tickets (resolved_at IS NULL)
- Reads from replica if available (read-only workload)
- Caches taxonomy in memory (60-second TTL)

**Cluster Update Logic:**
- When duplicate found: update master's `cluster_count` and `urgency_score`
- Urgency re-calculated: `new_score = avg(master_score, new_score) * cluster_multiplier`
- Citizens can see: "This issue reported X times in your area"

---

## Node 4: Urgency Scoring

**Purpose:** Calculate P1-P5 priority and breakdown factors

**Input:**
```python
{
    "text": "Pothole on Main Street",
    "category_code": "RD",
    "subcategory_code": "POT",
    "severity": 3,
    "lat": 37.7749,
    "lng": -122.4194,
    "is_duplicate": false,
    "cluster_count": 1,
}
```

**Processing:**
```python
async def urgency_node(state: PipelineState) -> PipelineState:
    """Calculate urgency score (1-5) and factors breakdown."""
    
    factors = {}
    base_score = state.get("severity", 3)  # Start with severity (1-5)
    
    # ── P1 OVERRIDE RULES (check first) ──
    if is_p1_keyword(state["text"]):
        # Keywords: "child", "injury", "accident", "death", etc.
        base_score = 5
        factors["p1_keyword"] = True
    
    if is_p1_subcode(state["subcategory_code"]):
        # Subcodes: TF01 (blocked traffic signal), etc.
        base_score = max(base_score, 5)
        factors["p1_subcode"] = True
    
    if state.get("high_rate_area"):
        # Historical rate of issues in this location > threshold
        base_score = min(base_score + 1, 5)
        factors["high_incident_area"] = True
    
    # ── LLM URGENCY SCORING ──
    llm_prompt = f"""
    Given this infrastructure issue, calculate urgency (1-5):
    
    Text: {state['text']}
    Category: {state['subcategory_name']}
    Severity: {state['severity']}/5
    
    Consider:
    - Public safety risk (P1 = immediate danger)
    - Traffic/accessibility impact
    - Weather vulnerability
    - Cluster size: {state['cluster_count']} reports
    - Location type (highway vs side street)
    
    Respond with JSON:
    {
        "urgency_score": 4,
        "reasoning": "...",
        "factors": {
            "safety_risk": 0.9,
            "traffic_impact": 0.7,
            "cluster_effect": 0.5
        }
    }
    """
    
    response = await gemini_llm.score_urgency(llm_prompt)
    llm_result = json.loads(response.text)
    
    # Combine P1 rules + LLM score
    final_score = max(base_score, llm_result["urgency_score"])
    
    state.update({
        "urgency_score": final_score,
        "urgency_reasoning": llm_result["reasoning"],
        "urgency_factors": {
            **factors,
            **llm_result["factors"],
            "cluster_size": state["cluster_count"]
        }
    })
    
    return state
```

**Output:**
```python
{
    "urgency_score": 4,
    "urgency_reasoning": "High-traffic area with multiple reports; pothole poses safety risk",
    "urgency_factors": {
        "p1_keyword": false,
        "p1_subcode": false,
        "high_incident_area": true,
        "safety_risk": 0.85,
        "traffic_impact": 0.80,
        "cluster_effect": 0.6,
        "cluster_size": 1
    }
}
```

**Score Mapping:**
```
P1 (5): Immediate danger (injury risk, blocked traffic signal, etc.)
P2 (4): High impact (multiple reports, dangerous pothole, flooding)
P3 (3): Moderate impact (noticeable issue, some safety concern)
P4 (2): Low impact (cosmetic, minor inconvenience)
P5 (1): Minimal impact (very minor damage)
```

**Special Cases:**
- **Cluster multiplier:** Urgency +0.5 if duplicate or cluster_count > 3
- **Time decay:** Recent reports weighted higher than old ones
- **Weather factor:** Rain/ice increases pothole urgency; dry roads decrease it

---

## Pipeline State (TypedDict)

```python
class PipelineState(TypedDict, total=False):
    # Input fields
    raw_report_id: str
    text: str
    image_url: Optional[str]
    lat: float
    lng: float
    address: str
    submitted_at: str
    
    # Node 1 output
    image_description: Optional[str]
    
    # Node 2 output
    category_code: str
    category_name: str
    subcategory_code: str
    subcategory_name: str
    severity: int  # 1-5
    confidence: float  # 0.0-1.0
    image_text_conflict: bool
    image_classification_hint: Optional[str]
    
    # Node 3 output
    is_duplicate: bool
    master_ticket_id: Optional[str]
    cluster_count: int
    
    # Node 4 output
    urgency_score: int  # 1-5 (P1-P5)
    urgency_reasoning: str
    urgency_factors: Dict[str, float]
    
    # Metadata
    attempt: int  # Retry attempt (0, 1, 2, 3)
    is_edit: bool  # Is this a re-process of existing ticket?
    existing_ticket_id: Optional[str]  # If re-processing
    error: Optional[str]  # If failed
```

---

## Celery Task Wrapper

```python
@celery_app.task(
    bind=True,
    name="ai_core.consumer.run_pipeline",
    queue="ai_core:process",
    max_retries=0,  # ← NO RETRIES (Worker S3 handles retries)
    soft_time_limit=30,  # seconds
    time_limit=60  # hard timeout
)
async def run_pipeline(self, report_id: str, payload: dict) -> dict:
    """Execute the LangGraph pipeline."""
    
    try:
        state = PipelineState(**payload)
        
        # Run the graph
        result = await pipeline_graph.ainvoke(
            state,
            {"recursion_limit": 25}  # LangGraph recursion limit
        )
        
        # Publish success
        celery_app.send_task(
            "worker.tasks.handle_ai_result",
            args=[report_id, result],
            queue="ai_core:results"
        )
        
        return {"status": "success", "ticket": result}
        
    except Exception as exc:
        # Publish failure (no retries here)
        celery_app.send_task(
            "worker.tasks.handle_ai_failure",
            args=[
                report_id,
                str(exc),
                payload.get("attempt", 0)
            ],
            queue="ai_core:failed"
        )
        
        raise exc  # Log the error
```

---

## Execution Flow: Detailed Timeline

```
T=0s:   Worker picks up task from ai_core:process queue
        ├─ Deserialize payload
        ├─ Initialize PipelineState
        └─ Start graph execution

T=0.1s: Node 1 (Image Description)
        ├─ Check if image_url exists
        ├─ Call Gemini Vision API
        ├─ Wait for response (~1-2s)
        └─ Store result in state

T=2.5s: Node 2 (Classification)
        ├─ Combine text + image description
        ├─ Call Gemini LLM with prompt
        ├─ Wait for response (~1-2s)
        ├─ Parse JSON result
        ├─ Detect text/image conflicts
        └─ Store result in state

T=5.0s: Node 3 (Deduplication)
        ├─ Query Postgres (geo-spatial)
        ├─ Calculate distance (PostGIS)
        ├─ Check for masters in 100m radius
        └─ Store is_duplicate, master_id, cluster_count

T=5.5s: Node 4 (Urgency Scoring)
        ├─ Check P1 keywords/subcodes
        ├─ Call Gemini for LLM scoring
        ├─ Wait for response (~1-2s)
        ├─ Combine P1 rules + LLM score
        └─ Store urgency_score, factors, reasoning

T=7.5s: Pipeline complete
        ├─ Serialize result
        ├─ Publish to ai_core:results queue
        └─ Task completed successfully
```

**Typical timing:** 5-8 seconds per ticket (depends on Gemini API latency)

---

## Error Handling & Failure Modes

### Failures Sent to ai_core:failed

| Error | Cause | Worker Action |
|-------|-------|---------------|
| Gemini API timeout | Network/API | Retry (attempt 0→1→2→3) |
| Gemini API invalid key | Config | DLQ (no retry, fix config) |
| Postgres connection error | DB unreachable | Retry (attempt 0→1→2→3) |
| JSON parse error | Bad API response | Retry (attempt 0→1→2→3) |
| Image URL unreachable | S3/CDN down | Retry (attempt 0→1→2→3) |

### No Retries in S2
- S2 has `max_retries=0` deliberately
- All retry logic handled by S3 Worker
- S2 publishes failure → S3 retries with backoff
- If S3 exhausts retries → DLQ + email alert

---

## Integration with Rest of System

### Input (from S3 Worker)

```
Redis Queue: ai_core:process
Payload: {
    "raw_report_id": "uuid-123",
    "text": "Pothole on Main Street",
    "image_url": "s3://civicpulse/reports/uuid-123.jpg",
    "lat": 37.7749,
    "lng": -122.4194,
    "address": "Main St & 5th Ave, San Jose CA",
    "attempt": 0,
    "is_edit": false,
    "existing_ticket_id": null
}
```

### Output Success (to S3 Worker)

```
Redis Queue: ai_core:results
Payload: {
    "raw_report_id": "uuid-123",
    "category_code": "RD",
    "category_name": "Road Surface",
    "subcategory_code": "POT",
    "subcategory_name": "Pothole",
    "severity": 3,
    "confidence": 0.92,
    "image_text_conflict": false,
    "urgency_score": 4,
    "urgency_reasoning": "...",
    "urgency_factors": {...},
    "is_duplicate": false,
    "master_ticket_id": null,
    "cluster_count": 1,
    "image_description": "Pothole 6 inches deep..."
}
```

### Output Failure (to S3 Worker)

```
Redis Queue: ai_core:failed
Payload: {
    "report_id": "uuid-123",
    "error": "Gemini API timeout after 30s",
    "attempt": 0
}
```

---

## Configuration & Environment

```env
# Gemini API
GEMINI_API_KEY=<required>
GEMINI_MODEL=gemini-pro  # or gemini-pro-vision
GEMINI_TIMEOUT=30        # seconds

# Database (read-only dedup queries)
DB_URL=postgresql://civic:civic@postgres:5432/civicpulse

# Redis (queue + pub-sub)
REDIS_URL=redis://redis:6379/0

# Celery
CELERY_BROKER_URL=redis://redis:6379/0
CELERY_BACKEND_URL=None  # (result storage not used)

# Logging
LOG_LEVEL=INFO
LANGCHAIN_TRACING_V2=false  # (optional: LangSmith tracing)
LANGCHAIN_API_KEY=         # (optional: LangSmith key)
```

---

## Performance Characteristics

### Throughput
- **Concurrency:** 4 workers (configurable)
- **Single ticket time:** 5-8 seconds
- **Max throughput:** ~2 tickets/sec with 4 workers
- **Bottleneck:** Gemini API response time (~2s per node)

### Resource Usage
- **CPU:** Minimal (API calls are I/O bound)
- **Memory:** ~200MB per worker (LangGraph state)
- **Network:** ~2KB per ticket (API requests)

### Cost (Gemini API)
- **Node 1 (vision):** ~$0.01 per image
- **Node 2 (classify):** ~$0.0001 per text
- **Node 4 (urgency):** ~$0.0001 per text
- **Total:** ~$0.011 per ticket

---

## Testing & Debugging

### Local Testing
```bash
# Test pipeline directly
python -m pytest tests/ai_core/test_pipeline.py -v

# Test individual nodes
python -m pytest tests/ai_core/test_nodes.py::test_classify_node -v

# Mock Gemini responses
pytest tests/ai_core/ -k "mock_gemini" -v
```

### Monitoring
```bash
# Check queue depth
redis-cli LLEN "celery|ai_core:process"    # Pending tasks
redis-cli LLEN "celery|ai_core:results"    # Successful results
redis-cli LLEN "celery|ai_core:failed"     # Failed tasks

# Watch logs
docker compose logs -f ai_core
```

### Manual Test
```bash
# Publish a test task
python -c "
from celery import Celery
app = Celery(broker='redis://localhost:6379/0')
app.send_task('ai_core.consumer.run_pipeline', args=[
    'test-uuid-123',
    {
        'raw_report_id': 'test-uuid-123',
        'text': 'Pothole on Main Street',
        'image_url': None,
        'lat': 37.7749,
        'lng': -122.4194,
        'attempt': 0,
        'is_edit': False
    }
], queue='ai_core:process')
"

# Watch results
docker compose logs -f ai_core | grep test-uuid-123
```

---

## Design Rationale

### Why LangGraph?
- **Structured workflow:** Each node has clear input/output
- **State management:** Central state dict prevents bugs
- **Conditional routing:** Can skip nodes (e.g., no image)
- **Observability:** Each node's input/output logged
- **Testability:** Mock nodes independently

### Why No Database Writes?
- **Horizontal scalability:** Can add 100 workers without contention
- **Fault isolation:** Failed S2 doesn't block S3 writes
- **Simple recovery:** No cleanup needed if S2 crashes

### Why Postgres for Dedup?
- **Accuracy:** Real coordinates, not approximate clustering
- **Recency:** Can find duplicates reported minutes ago
- **Geo-spatial:** PostGIS spatial index is fast (~10ms)
- **Fallback:** Works even if clustering service down

### Why Multiple LLM Calls?
- **Separation of concerns:** Vision != classification != scoring
- **Cost control:** Cheaper than one large prompt
- **Accuracy:** Specialized prompts → better results
- **Modularity:** Can swap vision provider later

---

**Last Updated:** May 2026  
**Architecture Pattern:** LangGraph + Celery  
**External Dependencies:** Google Gemini, Postgres PostGIS
