import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=LOG_LEVEL,
    format="%(asctime)s %(levelname)s %(name)s - %(message)s",
)

from routers import auth, reports, tickets, admin, events, schedule, crews

app = FastAPI(title="CivicPulse API", version="1.0.0")

# In production set ALLOWED_ORIGINS=https://your-app.vercel.app
# Leave as * for local dev
ALLOWED_ORIGINS = os.environ.get("ALLOWED_ORIGINS", "*").split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(reports.router)
app.include_router(tickets.router)
app.include_router(admin.router)
app.include_router(events.router)
app.include_router(schedule.router)
app.include_router(crews.router)


@app.get("/health", tags=["health"])
async def health():
    return {"status": "ok"}