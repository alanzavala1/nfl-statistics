"""Response schemas for the meta router (health, seasons)."""
from typing import Literal

from pydantic import BaseModel


class HealthResponse(BaseModel):
    status: Literal["ok"]


# "scheduled" is the gap between a season's fixtures being published and its
# first game being charted: we know who plays whom, but there are no plays to
# build stats from. Distinct from "available" (we hold nothing) and "loaded"
# (stats exist), so pages that need stats can exclude it.
SeasonState = Literal["loaded", "scheduled", "queued", "loading", "error", "available"]


class SeasonStatus(BaseModel):
    season: int
    status: SeasonState


class LoadSeasonResponse(BaseModel):
    season: int
    status: SeasonState
