"""Response schemas for /live/scoreboard."""
from typing import Literal

from pydantic import BaseModel


class LiveLeaderOut(BaseModel):
    """A game leader. `detail` is the source's own phrasing, passed through."""
    category: Literal["passing", "rushing", "receiving"]
    player: str
    team: str | None
    detail: str


class LiveGameOut(BaseModel):
    """A game as the live tier reports it.

    Deliberately an overlay rather than a second copy of `Game`: it carries
    `game_id`, so the client merges it onto the cards it already has instead of
    learning a parallel vocabulary for the same fixture.
    """
    game_id: str | None
    away_team: str
    home_team: str
    gameday: str
    state: Literal["pre", "in", "post"]
    away_score: int | None
    home_score: int | None
    period: int | None
    clock: str | None
    possession: str | None
    detail: str | None
    # Enough for a game page to show something true before anything is charted.
    away_periods: list[int]
    home_periods: list[int]
    down_distance: str | None
    red_zone: bool
    last_play: str | None
    away_timeouts: int | None
    home_timeouts: int | None
    leaders: list[LiveLeaderOut]


class Scoreboard(BaseModel):
    games: list[LiveGameOut]
    # "live" straight from the upstream, "stale" from the last good response
    # after a failure, "schedule" from our own database.
    source: Literal["live", "stale", "schedule"]
    # Seconds until the client should ask again; null means stop polling.
    poll_after: int | None
    fetched_at: str
