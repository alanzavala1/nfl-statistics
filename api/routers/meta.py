"""Health check and season ingest endpoints."""
import asyncio
import os

from fastapi import APIRouter, Header, HTTPException, Request, Response
from fastapi.responses import StreamingResponse

from config import CURRENT_SEASON, FIRST_SEASON
from database import query_to_dict
from ingest_queue import ingest_logs, queue_season, season_status
from rate_limit import RateLimiter
from schemas.meta import HealthResponse, LoadSeasonResponse, SeasonStatus

router = APIRouter()

# Ingest trigger: generous enough for a legitimate lazy-load burst (a whole
# career of seasons queued at once from a cold DB) but caps enqueue-spam.
_limiter = RateLimiter(max_hits=40)


@router.get("/health", response_model=HealthResponse)
def health():
    return {"status": "ok"}


@router.get("/seasons", response_model=list[SeasonStatus])
def get_seasons(response: Response):
    # Live load-status — caching it makes the season picker lie mid-ingest.
    response.headers["Cache-Control"] = "no-store"
    try:
        loaded = {r["season"] for r in query_to_dict("SELECT DISTINCT season FROM schedules")}
    except Exception:
        loaded = set()
    return [
        {
            "season": year,
            "status": season_status.get(year, "loaded" if year in loaded else "available"),
        }
        for year in range(CURRENT_SEASON, FIRST_SEASON - 1, -1)
    ]


@router.post("/seasons/{year}/load", response_model=LoadSeasonResponse)
def load_season(
    year: int,
    force: bool = False,
    request: Request = None,
    x_admin_token: str | None = Header(default=None),
):
    if year < FIRST_SEASON or year > CURRENT_SEASON:
        raise HTTPException(status_code=400, detail=f"Season must be between {FIRST_SEASON} and {CURRENT_SEASON}")
    ip = request.client.host if request and request.client else "unknown"
    if _limiter.limited(ip):
        raise HTTPException(status_code=429, detail="Too many load requests — give it a minute.")
    # Every ingest is now admin-only, not just force=true. Ingest is a heavy,
    # single-writer job that has no business running inside a container serving
    # traffic; production ships a rebuilt database instead (see api/jobs/). This
    # endpoint survives for local rebuilds and one-off repairs.
    admin = os.environ.get("ADMIN_TOKEN")
    if not admin or x_admin_token != admin:
        raise HTTPException(status_code=403, detail="Ingest requires a valid admin token")
    status = queue_season(year, force=force)
    return {"season": year, "status": status}


@router.get("/seasons/{year}/progress")
def season_progress(year: int):
    async def event_stream():
        sent = 0
        while True:
            logs = ingest_logs.get(year, [])
            while sent < len(logs):
                line = logs[sent]
                yield f"data: {line}\n\n"
                sent += 1
                if line.startswith("__DONE__") or line.startswith("__ERROR__"):
                    return
            await asyncio.sleep(0.5)

    return StreamingResponse(event_stream(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    })
