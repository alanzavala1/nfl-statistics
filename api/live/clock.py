"""When is football happening?

Answered in two levels, cheapest first, because the expensive one should only
run when the free one says it might matter.

The **schedule** is the free level. We already hold every fixture, so working
out whether a game could plausibly be under way right now is a small SQL query
and some arithmetic — no network, and correct in June as well as in September.

The **live source** is the expensive level, and it is the authority on what is
actually happening: kickoffs slip, games run to overtime, weather stops play.
This module never calls it. It decides *whether* and *how often* to ask, and it
takes the answers back as plain state strings, so the whole thing is testable
against a frozen clock with no network and no database.

The two levels disagree in a way that matters. The schedule can only ever say a
game *should* have finished by now; only the live source knows it hasn't. So a
game reported in progress outranks the schedule entirely — we stop polling when
the source says the game is over, not when the clock says it ought to be.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

# nflverse publishes `gametime` in US Eastern, without a zone marker — the
# 2026 opener reads 20:20, and ESPN independently reports it as 00:20Z. Using a
# fixed offset instead would be wrong for roughly half the season: the Super
# Bowl is played in EST, the season opener in EDT.
KICKOFF_TZ = ZoneInfo("America/New_York")

# Open the window a little before kickoff so the scoreboard is warm when people
# arrive for it, and hold it open well past the ~3h05m an average game takes.
# This is only a lower bound on when to start looking — see `poll_interval`.
LEAD_IN = timedelta(minutes=15)
NOMINAL_LENGTH = timedelta(hours=4)

# Poll intervals, in seconds. `None` means don't poll at all.
IDLE = None
PRE = 60      # in the window, waiting for kickoff
LIVE = 15     # a game is actually being played
POST = 300    # everything in the window has finished; wind down


def kickoff_utc(gameday: str | None, gametime: str | None) -> datetime | None:
    """Combine a schedule row's date and Eastern kickoff time into UTC.

    Returns None for fixtures with no time set yet — the schedule carries games
    months ahead, and flex scheduling leaves some without a kickoff.
    """
    if not gameday or not gametime:
        return None
    try:
        hh, mm = (int(p) for p in gametime.split(":")[:2])
        day = datetime.strptime(gameday, "%Y-%m-%d")
    except (ValueError, TypeError):
        return None
    local = datetime(day.year, day.month, day.day, hh, mm, tzinfo=KICKOFF_TZ)
    return local.astimezone(timezone.utc)


def games_near(now: datetime) -> list[dict]:
    """Schedule rows within a day of `now` in either direction.

    A day either side is enough to bridge the gap between a UTC instant and an
    Eastern calendar date without scanning a season. Imported here rather than
    at module scope so the rest of this module stays usable without a database.
    """
    from database import query_to_dict

    lo = (now - timedelta(days=1)).date().isoformat()
    hi = (now + timedelta(days=1)).date().isoformat()
    return query_to_dict(
        """
        SELECT game_id, season, week, gameday, gametime, away_team, home_team
        FROM schedules
        WHERE gameday BETWEEN ? AND ?
        ORDER BY gameday, gametime
        """,
        [lo, hi],
    )


def live_window(now: datetime | None = None, games: list[dict] | None = None) -> list[dict]:
    """Games whose scheduled window contains `now`, each with its kickoff.

    `games` is injectable so this can be exercised against a frozen clock with
    no database behind it.
    """
    now = now or datetime.now(timezone.utc)
    rows = games_near(now) if games is None else games

    out = []
    for g in rows:
        kickoff = kickoff_utc(g.get("gameday"), g.get("gametime"))
        if kickoff and kickoff - LEAD_IN <= now <= kickoff + NOMINAL_LENGTH:
            out.append({**g, "kickoff": kickoff})
    return out


def poll_interval(
    now: datetime | None = None,
    states: list[str] | None = None,
    games: list[dict] | None = None,
) -> int | None:
    """Seconds until the next live poll, or None to not poll at all.

    `states` is what the live source last reported for the games on screen —
    "pre", "in" or "post". Pass None when nothing has been asked yet.
    """
    # A game in progress outranks the schedule. Overtime and weather delays both
    # run a game past any window the calendar would draw, and cutting the
    # scoreboard off mid-game is far worse than a few extra polls.
    if states and any(s == "in" for s in states):
        return LIVE

    window = live_window(now, games)
    if not window:
        return IDLE

    if states and all(s == "post" for s in states):
        return POST
    return PRE


def is_game_window(now: datetime | None = None, games: list[dict] | None = None) -> bool:
    """Whether any game could plausibly be under way. The free check."""
    return bool(live_window(now, games))
