from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routers import auth, reports, tickets, admin, events

app = FastAPI(title="CivicPulse API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(reports.router)
app.include_router(tickets.router)
app.include_router(admin.router)
app.include_router(events.router)


@app.get("/health", tags=["health"])
async def health():
    return {"status": "ok"}
