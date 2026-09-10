"""Live scoreboard endpoint.

Thin on purpose: the caching, pacing and fallback all live in live.scoreboard,
which is testable without a web server.
"""
from fastapi import APIRouter, Response

from live.scoreboard import scoreboard
from schemas.live import Scoreboard

router = APIRouter()


@router.get("/live/scoreboard", response_model=Scoreboard)
def get_scoreboard(response: Response):
    payload = scoreboard()

    # Never let a CDN or browser hold a score. The server-side cache is what
    # protects the upstream; this response is meant to be as fresh as that
    # cache is, and `poll_after` tells the client when to ask again.
    response.headers["Cache-Control"] = "no-store"
    return payload
