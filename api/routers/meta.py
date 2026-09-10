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
    # "loaded" has to mean the stats pages have something to show, and that
    # needs plays. A season's schedule is published months before its first
    # snap, so rows in `schedules` alone mean only that the fixtures are known —
    # calling that loaded sends people to empty leaders and standings. Both
    # DISTINCTs are single-column scans DuckDB answers in a few ms.
    try:
        played = {r["season"] for r in query_to_dict("SELECT DISTINCT season FROM plays")}
        scheduled = {r["season"] for r in query_to_dict("SELECT DISTINCT season FROM schedules")}
    except Exception:
        played, scheduled = set(), set()

    def _state(year: int) -> str:
        if year in played:
            return "loaded"
        if year in scheduled:
            return "scheduled"
        return "available"

    return [
        {"season": year, "status": season_status.get(year, _state(year))}
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


# A stream this long-lived needs a ceiling. An ingest that hasn't emitted its
# terminal line within this window is not going to, and holding the connection
# open past that point only ties up a worker.
_PROGRESS_TIMEOUT_SECONDS = 900


@router.get("/seasons/{year}/progress")
def season_progress(year: int):
    # Refuse to open a stream when no ingest is in flight for this season.
    #
    # Without this the loop below waits forever on an `ingest_logs` entry that
    # will never be written — and since ingest moved out of the serving
    # container entirely, that is now every season, every day. Any anonymous
    # caller could open unlimited never-closing streams against a service with
    # a small instance cap, which is the cheapest possible way to reproduce the
    # 2026-09-09 "no available instance" outage on purpose.
    #
    # An ADMIN_TOKEN header gate isn't available here: EventSource cannot send
    # custom headers, so the frontend could not call it. Declining to open a
    # stream that has nothing to say is both the security fix and the more
    # honest behaviour — and the frontend only ever opens this immediately
    # after queueing a load, which sets the status synchronously.
    if season_status.get(year) not in ("queued", "loading"):
        raise HTTPException(status_code=409, detail=f"No ingest is running for season {year}.")

    async def event_stream():
        sent = 0
        deadline = asyncio.get_event_loop().time() + _PROGRESS_TIMEOUT_SECONDS
        while asyncio.get_event_loop().time() < deadline:
            logs = ingest_logs.get(year, [])
            while sent < len(logs):
                line = logs[sent]
                yield f"data: {line}\n\n"
                sent += 1
                if line.startswith("__DONE__") or line.startswith("__ERROR__"):
                    return
            await asyncio.sleep(0.5)
        yield "data: __ERROR__ progress stream timed out\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    })
